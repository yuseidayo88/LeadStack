import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompanyCandidateRow, Database } from "@/lib/database.types";
import { AppError, databaseError } from "@/lib/errors";
import {
  GbizError,
  getGbizCompany,
  searchGbizCompanies,
} from "@/lib/gbiz/client";
import {
  candidateFromGbiz,
  CandidateProvenanceTooLargeError,
  object,
} from "./mapping";
import type { ScanCriteria, ScanEvent } from "./contracts";
import { openScanCursor, signScanCursor } from "./scan-cursor";
import { reserveRequest } from "./service";

type DB = SupabaseClient<Database>;
type Input = { criteria: ScanCriteria; resumeToken?: string };
const CHUNK_MS = 25_000;
const START_NEXT_CALL_MS = 20_000;

export function candidateMatchesScan(
  row: CompanyCandidateRow,
  criteria: ScanCriteria,
) {
  if (criteria.prefecture && row.prefecture_code !== criteria.prefecture)
    return false;
  if (
    criteria.corporateNumber &&
    row.corporate_number !== criteria.corporateNumber
  )
    return false;
  if (
    criteria.name &&
    !row.name.toLocaleLowerCase().includes(criteria.name.toLocaleLowerCase())
  )
    return false;
  if (criteria.industry) {
    const unknown = row.industry_codes.length === 0;
    if (
      criteria.industry === "unknown"
        ? !unknown
        : !row.industry_codes.includes(criteria.industry) &&
          !(criteria.includeUnknownIndustry && unknown)
    )
      return false;
  }
  if (
    criteria.employeeMin !== undefined ||
    criteria.employeeMax !== undefined
  ) {
    if (row.employee_number === null) {
      if (!criteria.includeUnknownEmployees) return false;
    } else if (
      (criteria.employeeMin !== undefined &&
        row.employee_number < criteria.employeeMin) ||
      (criteria.employeeMax !== undefined &&
        row.employee_number > criteria.employeeMax)
    )
      return false;
  }
  if (criteria.hasPhone && !row.phone) return false;
  if (criteria.hasWebsite && !row.website_url) return false;
  if (criteria.hasEmployees && row.employee_number === null) return false;
  const keywords = criteria.businessKeywords?.split(" ").filter(Boolean) ?? [];
  if (keywords.length) {
    const summary = object(row.provenance).businessSummary;
    const text =
      `${row.name}\n${typeof summary === "string" ? summary : ""}`.toLocaleLowerCase();
    if (!keywords.some((term) => text.includes(term.toLocaleLowerCase())))
      return false;
  }
  return true;
}

async function currentCandidates(
  db: DB,
  organization: string,
  numbers: string[],
  signal: AbortSignal,
) {
  const result = await db
    .from("company_candidates")
    .select("*")
    .eq("organization_id", organization)
    .in("corporate_number", numbers)
    .abortSignal(signal);
  if (result.error) databaseError(result.error);
  return new Map((result.data ?? []).map((row) => [row.corporate_number, row]));
}

async function saveCandidate(
  db: DB,
  organization: string,
  data: ReturnType<typeof candidateFromGbiz>,
  previous: CompanyCandidateRow | undefined,
  signal: AbortSignal,
) {
  const query = previous
    ? db
        .from("company_candidates")
        .update(data)
        .eq("organization_id", organization)
        .eq("id", previous.id)
        .eq("updated_at", previous.updated_at)
    : db.from("company_candidates").upsert(
        { ...data, organization_id: organization },
        {
          onConflict: "organization_id,corporate_number",
          ignoreDuplicates: true,
        },
      );
  const result = await query.select("*").abortSignal(signal);
  if (result.error) {
    if (["P0500", "P0429"].includes(result.error.code))
      throw new AppError(
        409,
        "candidate_limit",
        "保存できる候補の上限（5,000社）に達しました。",
      );
    databaseError(result.error);
  }
  if (result.data?.[0]) return { row: result.data[0], saved: true };
  // Concurrent manual editing or another acquisition wins. Match the saved
  // values rather than counting provider data that was never committed.
  const current = await db
    .from("company_candidates")
    .select("*")
    .eq("organization_id", organization)
    .eq("corporate_number", data.corporate_number)
    .abortSignal(signal)
    .maybeSingle();
  if (current.error) databaseError(current.error);
  if (!current.data)
    throw new AppError(
      409,
      "candidate_changed",
      "候補が変更されました。同じ位置から再開してください。",
    );
  return { row: current.data, saved: false };
}

function message(error: unknown) {
  if (error instanceof GbizError || error instanceof AppError)
    return error.message;
  return "企業情報の取得を中断しました。保存済みの結果から再開できます。";
}

export async function startCompanyScan(
  db: DB,
  organization: string,
  input: Input,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const started = Date.now();
  const cursor = openScanCursor(
    organization,
    input.criteria,
    input.resumeToken,
    started,
  );
  await reserveRequest(db, organization, "acquire");
  const nextAllowedAt = new Date(Date.now() + 30_100).toISOString();
  const stopped = new AbortController();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    Math.max(0, CHUNK_MS - (Date.now() - started)),
  );
  const signal = AbortSignal.any([
    stopped.signal,
    deadline.signal,
    ...(requestSignal ? [requestSignal] : []),
  ]);
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (
        type: ScanEvent["type"],
        reason?: ScanEvent["reason"],
        text?: string,
      ) => {
        if (closed) return;
        const terminal = reason === "exhausted" || reason === "scan_limit";
        const checkpoint = { ...cursor, completedTarget: reason === "target" };
        const event: ScanEvent = {
          type,
          scanned: cursor.scanned,
          matched: cursor.matchedIds.length,
          target: cursor.target,
          saved: cursor.saved,
          detailsFailed: cursor.detailsFailed,
          unknownEmployees: cursor.unknownEmployees,
          unknownIndustry: cursor.unknownIndustry,
          matchedIds: [...cursor.matchedIds],
          resumeToken: terminal ? null : signScanCursor(checkpoint),
          nextAllowedAt,
          ...(reason ? { reason } : {}),
          ...(text ? { message: text } : {}),
        };
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
          stopped.abort();
        }
      };
      const finish = (reason: "target" | "scan_limit" | "exhausted") => {
        emit(
          "complete",
          reason,
          reason === "target"
            ? "条件に合う企業が見つかりました。さらに探すこともできます。"
            : reason === "scan_limit"
              ? "この検索では200社を確認しました。条件を変えて新しい検索を開始できます。"
              : "取得できた検索範囲を最後まで確認しました。",
        );
      };
      const advance = (number: string) => {
        cursor.offset++;
        cursor.scanned++;
        if (!cursor.seen.includes(number)) cursor.seen.push(number);
      };
      const run = async () => {
        emit("progress");
        let current = new Map<string, CompanyCandidateRow>();
        let loadedPage = false;
        while (!signal.aborted) {
          if (cursor.scanned >= 200 || cursor.page > 10) {
            finish("scan_limit");
            return;
          }
          if (cursor.matchedIds.length >= cursor.target) {
            finish("target");
            return;
          }
          if (Date.now() - started >= START_NEXT_CALL_MS) {
            emit(
              "paused",
              "time_limit",
              "保存済みの結果を表示し、続きの企業を確認します。",
            );
            return;
          }
          if (cursor.numbers.length && cursor.offset >= cursor.numbers.length) {
            if (cursor.lastPage) {
              finish("exhausted");
              return;
            }
            cursor.page++;
            cursor.offset = 0;
            cursor.numbers = [];
            cursor.lastPage = false;
            loadedPage = false;
            if (cursor.page > 10) {
              finish("scan_limit");
              return;
            }
          }
          if (!cursor.numbers.length) {
            // Unknown employee counts must stay eligible. Provider bounds are
            // used only when the caller explicitly excludes unknown values.
            const result = await searchGbizCompanies(
              {
                prefecture: input.criteria.prefecture,
                name: input.criteria.name,
                corporateNumber: input.criteria.corporateNumber,
                page: cursor.page,
                limit: 20,
                ...(input.criteria.includeUnknownEmployees &&
                !input.criteria.hasEmployees
                  ? {}
                  : {
                      employeeMin: input.criteria.employeeMin,
                      employeeMax: input.criteria.employeeMax,
                    }),
              },
              { signal, allowUnfiltered: true },
            );
            if (!result.companies.length) {
              finish("exhausted");
              return;
            }
            cursor.numbers = result.companies.map(
              (company) => company.corporateNumber,
            );
            cursor.lastPage = cursor.numbers.length < 20;
            cursor.offset = 0;
            emit("progress");
          }
          if (!loadedPage) {
            current = await currentCandidates(
              db,
              organization,
              cursor.numbers.slice(cursor.offset),
              signal,
            );
            loadedPage = true;
          }
          const number = cursor.numbers[cursor.offset];
          if (cursor.seen.includes(number)) {
            advance(number);
            emit("progress");
            continue;
          }
          let detail;
          try {
            // The provider requests sequential API calls. No parallel detail
            // workers: streaming keeps already saved matches visible meanwhile.
            detail = await getGbizCompany(number, { signal });
          } catch (error) {
            if (signal.aborted) throw error;
            cursor.detailsFailed++;
            // Transient outages retain this exact position for a deliberate
            // retry. Only a confirmed malformed individual record is skipped.
            if (
              !(error instanceof GbizError) ||
              error.code !== "invalid_response"
            )
              throw error;
            advance(number);
            emit("progress");
            continue;
          }
          if (
            !detail ||
            !detail.name ||
            detail.name.length > 200 ||
            (detail.location?.length ?? 0) > 2000
          ) {
            cursor.detailsFailed++;
            advance(number);
            emit("progress");
            continue;
          }
          let mapped;
          try {
            mapped = candidateFromGbiz(detail, current.get(number));
          } catch (error) {
            if (!(error instanceof CandidateProvenanceTooLargeError))
              throw error;
            cursor.detailsFailed++;
            advance(number);
            emit("progress");
            continue;
          }
          const persisted = await saveCandidate(
            db,
            organization,
            mapped,
            current.get(number),
            signal,
          );
          if (signal.aborted) throw new GbizError("cancelled");
          current.set(number, persisted.row);
          if (persisted.saved) cursor.saved++;
          if (detail.employeeNumber === null) cursor.unknownEmployees++;
          if (!detail.industry?.length) cursor.unknownIndustry++;
          if (
            candidateMatchesScan(persisted.row, input.criteria) &&
            !cursor.matchedIds.includes(persisted.row.id)
          )
            cursor.matchedIds.push(persisted.row.id);
          advance(number);
          emit("progress");
        }
        emit("paused", deadline.signal.aborted ? "time_limit" : "cancelled");
      };
      void run()
        .catch((error: unknown) => {
          if (signal.aborted)
            emit(
              "paused",
              deadline.signal.aborted ? "time_limit" : "cancelled",
            );
          else emit("error", "upstream_error", message(error));
        })
        .finally(() => {
          clearTimeout(timer);
          if (!closed) {
            closed = true;
            controller.close();
          }
        });
    },
    cancel() {
      closed = true;
      stopped.abort();
      clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
