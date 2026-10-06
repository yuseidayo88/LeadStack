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
import {
  authorizeScanStep,
  commitScanCandidate,
  finishScanRun,
  ScanRunStopped,
  startScanRun,
} from "./scan-jobs";

type DB = SupabaseClient<Database>;
type Input = {
  criteria: ScanCriteria;
  resumeToken?: string;
  runId: string;
  issuedAt: string;
};
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
  // Every HTTP chunk gets its own durable lease. Creating the lease before
  // reserving the quota also supersedes old work when a newer search starts.
  let runStarted = false;
  let cleanup: Promise<void> | undefined;
  const finishRun = () => {
    if (!runStarted) return Promise.resolve();
    cleanup ??= finishScanRun(db, organization, input.runId).then(
      () => undefined,
      () => {
        // No secrets/request bodies in logs; the DB deadline remains binding.
        console.error("Discovery scan cleanup could not be acknowledged");
      },
    );
    return cleanup;
  };
  const onAbort = () => {
    void finishRun();
  };
  try {
    if (signal.aborted) throw new ScanRunStopped("cancelled");
    await startScanRun(
      db,
      organization,
      input.runId,
      input.issuedAt,
      new Date(started + CHUNK_MS).toISOString(),
      signal,
    );
    runStarted = true;
    // A transport may ignore abort while a provider request is in flight.
    // Close the durable lease immediately rather than awaiting that response.
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      throw new ScanRunStopped("cancelled");
    }
    await reserveRequest(db, organization, "acquire", signal);
    if (signal.aborted) throw new ScanRunStopped("cancelled");
  } catch (error) {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    await finishRun();
    if (error instanceof ScanRunStopped)
      throw new AppError(
        409,
        "scan_cancelled",
        "検索は停止済みです。続きから再開してください。",
      );
    throw error;
  }
  const nextAllowedAt = new Date(Date.now() + 30_100).toISOString();
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
            await authorizeScanStep(
              db,
              organization,
              input.runId,
              "search",
              signal,
            );
            if (signal.aborted) throw new ScanRunStopped("cancelled");
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
          await authorizeScanStep(
            db,
            organization,
            input.runId,
            "detail",
            signal,
          );
          if (signal.aborted) throw new ScanRunStopped("cancelled");
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
          if (signal.aborted) throw new ScanRunStopped("cancelled");
          const persisted = await commitScanCandidate(
            db,
            organization,
            input.runId,
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
          if (error instanceof ScanRunStopped) emit("paused", error.reason);
          else if (signal.aborted)
            emit(
              "paused",
              deadline.signal.aborted ? "time_limit" : "cancelled",
            );
          else emit("error", "upstream_error", message(error));
        })
        .finally(async () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          await finishRun();
          if (!closed) {
            closed = true;
            controller.close();
          }
        });
    },
    async cancel() {
      closed = true;
      stopped.abort();
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      await finishRun();
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
