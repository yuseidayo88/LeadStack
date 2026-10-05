import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, CompanyCandidateRow, Json } from "@/lib/database.types";
import { AppError, databaseError } from "@/lib/errors";
import {
  GbizError,
  getGbizCompany,
  searchGbizCompanies,
} from "@/lib/gbiz/client";
import {
  candidateFromGbiz,
  discoverySearch,
  discoveryBusinessSearch,
  CandidateProvenanceTooLargeError,
  boundedCandidateProvenance,
  object,
} from "./mapping";
import { industryOptions } from "./industries";
import { enrichOfficialWebsite } from "./website-enrichment";
import type {
  Candidate,
  DiscoveryListResponse,
  AcquireResponse,
} from "./contracts";
import type { DiscoveryInput, DiscoveryQuery } from "./schemas";

type DB = SupabaseClient<Database>;
function candidate(row: CompanyCandidateRow): Candidate {
  const summary = object(row.provenance).businessSummary;
  return {
    ...row,
    business_summary:
      typeof summary === "string" && summary.trim()
        ? Array.from(summary.trim()).slice(0, 10_000).join("")
        : null,
    business_summary_truncated:
      object(row.provenance).businessSummaryTruncated === true,
  } as Candidate;
}
export const gbizConfigured = () => Boolean(process.env.GBIZ_API_TOKEN?.trim());

export async function listCandidates(
  db: DB,
  org: string,
  input: DiscoveryQuery,
): Promise<DiscoveryListResponse> {
  const summaryView = input.view === "summary";
  // Keep evidence and enrichment payloads off the table response. The detail
  // endpoint loads them only when a candidate is opened. JSON path projection
  // also avoids sending the full provenance object across the DB connection.
  const projection = summaryView
    ? "id,organization_id,corporate_number,name,prefecture_code,prefecture,location,industry_codes,industry_labels,phone,website_url,employee_number,source_updated_at,fetched_at,updated_at,created_at,company_id,enrichment_status,enrichment_error,enrichment_checked_at,business_summary:provenance->>businessSummary,business_summary_truncated:provenance->businessSummaryTruncated"
    : "*";
  function filtered(head = false) {
    let q = db
      .from("company_candidates")
      .select(projection, { count: "exact", head })
      .eq("organization_id", org);
    if (input.search) q = q.or(discoverySearch(input.search));
    if (input.businessKeywords.length)
      q = q.or(discoveryBusinessSearch(input.businessKeywords));
    if (input.prefecture) q = q.eq("prefecture_code", input.prefecture);
    if (input.industry)
      q =
        input.industry === "unknown"
          ? q.containedBy("industry_codes", [])
          : input.includeUnknownIndustry === "true"
            ? q.or(`industry_codes.cs.{${input.industry}},industry_codes.cd.{}`)
            : q.contains("industry_codes", [input.industry]);
    const employeeFilters = [
      ...(input.employeeMin === undefined
        ? []
        : [`employee_number.gte.${input.employeeMin}`]),
      ...(input.employeeMax === undefined
        ? []
        : [`employee_number.lte.${input.employeeMax}`]),
    ];
    if (employeeFilters.length && input.includeUnknownEmployees === "true") {
      q = q.or(`employee_number.is.null,and(${employeeFilters.join(",")})`);
    } else {
      if (input.employeeMin !== undefined)
        q = q.gte("employee_number", input.employeeMin);
      if (input.employeeMax !== undefined)
        q = q.lte("employee_number", input.employeeMax);
    }
    if (input.hasPhone === "true")
      q = q.not("phone", "is", null).neq("phone", "");
    if (input.hasWebsite === "true")
      q = q.not("website_url", "is", null).neq("website_url", "");
    if (input.hasEmployees === "true") q = q.not("employee_number", "is", null);
    return q
      .order(input.sort, {
        ascending: input.direction === "asc",
        nullsFirst: false,
      })
      .order("id");
  }
  const start = (input.page - 1) * input.pageSize;
  const [initial, total, latest] = await Promise.all([
    filtered().range(start, start + input.pageSize - 1),
    db
      .from("company_candidates")
      .select("id", { head: true, count: "exact" })
      .eq("organization_id", org),
    db
      .from("company_candidates")
      .select("fetched_at")
      .eq("organization_id", org)
      .order("fetched_at", { ascending: false })
      .limit(1),
  ]);
  for (const result of [total, latest])
    if (result.error) databaseError(result.error);
  if (initial.error && initial.error.code !== "PGRST103")
    databaseError(initial.error);
  let count = initial.count ?? 0;
  if (initial.error?.code === "PGRST103") {
    const matched = await filtered(true);
    if (matched.error) databaseError(matched.error);
    count = matched.count ?? 0;
  }
  let page = Math.min(
    input.page,
    Math.max(1, Math.ceil(count / input.pageSize)),
  );
  let rows = initial.data ?? [];
  if (initial.error || page !== input.page) {
    let result = await filtered().range(
      (page - 1) * input.pageSize,
      page * input.pageSize - 1,
    );
    // A concurrent deletion may change the last page between count and fetch.
    // Fall back once to the first page, which is also valid for an empty result.
    if (result.error?.code === "PGRST103") {
      page = 1;
      result = await filtered().range(0, input.pageSize - 1);
    }
    if (result.error) databaseError(result.error);
    count = result.count ?? count;
    rows = result.data ?? [];
  }
  const data: Candidate[] = (
    rows as unknown as (CompanyCandidateRow & {
      business_summary?: string | null;
      business_summary_truncated?: boolean;
    })[]
  ).map((row) => {
    if (!summaryView) return candidate(row);
    const summary = row.business_summary ?? "";
    const searchable = `${row.name} ${summary}`.toLocaleLowerCase("ja");
    return {
      ...row,
      list_summary: true,
      provenance: {},
      enrichment_result: null,
      business_summary: summary
        ? Array.from(summary).slice(0, 240).join("")
        : null,
      business_summary_truncated: row.business_summary_truncated === true,
      matched_business_keywords: input.businessKeywords.filter((term) =>
        searchable.includes(term.toLocaleLowerCase("ja")),
      ),
    };
  });
  if (data.length) {
    const matches = await db
      .from("companies")
      .select("id,corporate_number,name,phone")
      .eq("organization_id", org)
      .in(
        "corporate_number",
        data.map((c) => c.corporate_number),
      );
    if (matches.error) databaseError(matches.error);
    const ids = new Map(
      (matches.data ?? []).map((c) => [c.corporate_number, c]),
    );
    for (const row of data) {
      const linked = ids.get(row.corporate_number);
      row.company_id = linked?.id ?? null;
      row.crm_company_name = linked?.name ?? null;
      row.crm_company_phone = linked?.phone ?? null;
    }
  }
  return {
    data,
    count,
    page,
    pageSize: input.pageSize,
    configured: gbizConfigured(),
    totalCached: total.count ?? 0,
    lastFetchedAt: latest.data?.[0]?.fetched_at ?? null,
    industryOptions: [
      ...industryOptions,
      { value: "unknown", label: "業種未確認" },
    ],
  };
}

export async function reserveRequest(
  db: DB,
  org: string,
  operation: "acquire" | "enrich",
) {
  const { data, error } = await db.rpc("reserve_company_discovery_request", {
    org,
    operation,
  });
  if (error) databaseError(error);
  if (!data)
    throw new AppError(
      429,
      "discovery_rate_limited",
      operation === "acquire"
        ? "取得が集中しています。30秒ほど置いて再試行してください。"
        : "公式サイトの確認回数の上限です。時間をおいて再試行してください。",
    );
}

function upstreamError(error: unknown): never {
  if (error instanceof GbizError) {
    const status =
      error.code === "not_configured"
        ? 503
        : error.code === "rate_limited"
          ? 429
          : error.code === "invalid_parameters"
            ? 422
            : 502;
    throw new AppError(status, `gbiz_${error.code}`, error.message);
  }
  throw new AppError(
    502,
    "gbiz_unavailable",
    "企業情報の取得に失敗しました。時間をおいて再試行してください。",
  );
}

export async function acquireCandidates(
  db: DB,
  org: string,
  input: Extract<DiscoveryInput, { action: "acquire" }>,
): Promise<AcquireResponse> {
  if (!gbizConfigured())
    throw new AppError(
      503,
      "gbiz_not_configured",
      "企業情報の取得設定がまだ完了していません。保存済みの候補は検索できます。",
    );
  const started = Date.now();
  const signal = AbortSignal.timeout(25_000);
  await reserveRequest(db, org, "acquire");
  let result;
  try {
    result = await searchGbizCompanies(
      {
        prefecture: input.prefecture,
        name: input.name,
        corporateNumber: input.corporateNumber,
        page: input.page,
        limit: 20,
      },
      { signal },
    );
  } catch (error) {
    upstreamError(error);
  }
  const current = result.companies.length
    ? await db
        .from("company_candidates")
        .select("*")
        .eq("organization_id", org)
        .in(
          "corporate_number",
          result.companies.map((c) => c.corporateNumber),
        )
    : { data: [], error: null };
  if (current.error) databaseError(current.error);
  const old = new Map((current.data ?? []).map((c) => [c.corporate_number, c]));
  const details = [...result.companies];
  let cursor = 0,
    detailsFailed = 0;
  const deadline = started + 20_000;
  let stopDetails = false;
  await Promise.all(
    Array.from({ length: 1 }, async () => {
      while (cursor < details.length) {
        const index = cursor++;
        if (stopDetails || Date.now() >= deadline) {
          detailsFailed++;
          continue;
        }
        try {
          const detail = await getGbizCompany(details[index].corporateNumber, {
            signal,
          });
          if (detail) details[index] = detail;
          else detailsFailed++;
        } catch (error) {
          detailsFailed++;
          if (
            error instanceof GbizError &&
            ["unauthorized", "rate_limited", "cancelled"].includes(error.code)
          )
            stopDetails = true;
        }
      }
    }),
  );
  let fetched = 0;
  for (const company of details) {
    if (
      !company.name ||
      company.name.length > 200 ||
      (company.location?.length ?? 0) > 2000
    ) {
      detailsFailed++;
      continue;
    }
    const previous = old.get(company.corporateNumber);
    let data;
    try {
      data = candidateFromGbiz(company, previous);
    } catch (error) {
      if (!(error instanceof CandidateProvenanceTooLargeError)) throw error;
      detailsFailed++;
      continue;
    }
    if (previous) {
      const updated = await db
        .from("company_candidates")
        .update(data)
        .eq("organization_id", org)
        .eq("id", previous.id)
        .eq("updated_at", previous.updated_at)
        .select("id");
      if (updated.error) databaseError(updated.error);
      if (updated.data?.length) fetched++;
    } else {
      // A concurrent request that already inserted this company wins; never overwrite it.
      const inserted = await db
        .from("company_candidates")
        .upsert(
          { ...data, organization_id: org },
          {
            onConflict: "organization_id,corporate_number",
            ignoreDuplicates: true,
          },
        )
        .select("id");
      if (inserted.error) {
        if (["P0500", "P0429"].includes(inserted.error.code))
          throw new AppError(
            409,
            "candidate_limit",
            "保存できる候補の上限（5,000社）に達しました。",
          );
        databaseError(inserted.error);
      }
      fetched += inserted.data?.length ?? 0;
    }
  }
  return {
    fetched,
    detailsFailed,
    page: input.page,
    nextPage:
      result.companies.length === 20 && input.page < 10 ? input.page + 1 : null,
    message: `${result.companies.length}社の候補を確認しました。${detailsFailed ? `一部の詳細を取得・保存できませんでした（${detailsFailed}件）。以前の確認済み情報は保持しています。` : ""}業種・項目の有無による絞込みは取得済み候補に適用されます。`,
  };
}

async function getCandidate(db: DB, org: string, id: string) {
  const { data, error } = await db
    .from("company_candidates")
    .select("*")
    .eq("organization_id", org)
    .eq("id", id)
    .maybeSingle();
  if (error) databaseError(error);
  if (!data)
    throw new AppError(
      404,
      "candidate_not_found",
      "企業候補が見つかりません。",
    );
  return data;
}

async function linkedCandidate(db: DB, org: string, row: CompanyCandidateRow) {
  const { data, error } = await db
    .from("companies")
    .select("id,name,phone")
    .eq("organization_id", org)
    .eq("corporate_number", row.corporate_number)
    .maybeSingle();
  if (error) databaseError(error);
  return {
    ...candidate(row),
    company_id: data?.id ?? null,
    crm_company_name: data?.name ?? null,
    crm_company_phone: data?.phone ?? null,
  };
}

export async function getCandidateDetail(db: DB, org: string, id: string) {
  return linkedCandidate(db, org, await getCandidate(db, org, id));
}

export async function enrichCandidate(db: DB, org: string, id: string) {
  const row = await getCandidate(db, org, id);
  if (!row.website_url)
    throw new AppError(
      422,
      "website_missing",
      "確認済みの公式サイトURLを先に入力してください。",
    );
  await reserveRequest(db, org, "enrich");
  const pending = await db
    .from("company_candidates")
    .update({ enrichment_status: "pending", enrichment_error: null })
    .eq("organization_id", org)
    .eq("id", id)
    .eq("updated_at", row.updated_at)
    .select("*")
    .maybeSingle();
  if (pending.error) databaseError(pending.error);
  if (!pending.data)
    throw new AppError(
      409,
      "candidate_changed",
      "候補が更新されました。最新の内容を開き直してください。",
    );
  const proposal = await enrichOfficialWebsite(row.website_url);
  const saved = await db
    .from("company_candidates")
    .update({
      enrichment_result: proposal as unknown as Json,
      enrichment_status:
        proposal.status === "found"
          ? "complete"
          : proposal.status === "failed"
            ? "failed"
            : "unavailable",
      enrichment_error: proposal.message,
      enrichment_checked_at: proposal.checkedAt,
    })
    .eq("organization_id", org)
    .eq("id", id)
    .eq("updated_at", pending.data.updated_at)
    .select("*")
    .maybeSingle();
  if (saved.error) databaseError(saved.error);
  if (!saved.data)
    throw new AppError(
      409,
      "candidate_changed",
      "確認中に候補が更新されました。最新の内容で再実行してください。",
    );
  return { candidate: await linkedCandidate(db, org, saved.data) };
}

export async function updateCandidate(
  db: DB,
  org: string,
  userId: string,
  input: Extract<DiscoveryInput, { action: "update" }>,
) {
  const row = await getCandidate(db, org, input.id);
  const provenance = object(row.provenance);
  const overrides = Array.isArray(provenance.manualOverrides)
    ? provenance.manualOverrides
    : [];
  for (const field of ["phone", "website_url", "employee_number"] as const)
    if (row[field] !== input[field] && !overrides.includes(field))
      overrides.push(field);
  let updatedProvenance: Json;
  try {
    updatedProvenance = boundedCandidateProvenance(
      {
        ...provenance,
        manualOverrides: overrides,
        manual: {
          updatedAt: new Date().toISOString(),
          updatedBy: userId,
          evidence: row.enrichment_result,
        },
      },
      typeof provenance.businessSummary === "string"
        ? provenance.businessSummary
        : null,
      provenance.businessSummaryTruncated === true,
    );
  } catch (error) {
    if (!(error instanceof CandidateProvenanceTooLargeError)) throw error;
    throw new AppError(
      422,
      "candidate_evidence_too_large",
      "出典情報が保存上限を超えています。企業情報を再取得してから編集してください。",
    );
  }
  const { data, error } = await db
    .from("company_candidates")
    .update({
      phone: input.phone,
      website_url: input.website_url,
      employee_number: input.employee_number,
      ...(row.website_url !== input.website_url
        ? {
            enrichment_result: null,
            enrichment_status: null,
            enrichment_error: null,
            enrichment_checked_at: null,
          }
        : {}),
      provenance: updatedProvenance,
    })
    .eq("organization_id", org)
    .eq("id", input.id)
    .eq("updated_at", input.expectedUpdatedAt)
    .select("*")
    .maybeSingle();
  if (error) databaseError(error);
  if (!data)
    throw new AppError(
      409,
      "candidate_changed",
      "候補が更新されました。最新の内容を開き直してください。",
    );
  return { candidate: await linkedCandidate(db, org, data) };
}
