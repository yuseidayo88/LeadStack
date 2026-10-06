import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompanyCandidateRow, Database, Json } from "@/lib/database.types";
import { AppError, databaseError } from "@/lib/errors";
import type { candidateFromGbiz } from "./mapping";

type DB = SupabaseClient<Database>;
export type ScanRunStatus =
  "active" | "cancelled" | "finished" | "expired" | "missing" | "chunk_limit";
export type ScanRunState = {
  run_id: string;
  status: ScanRunStatus;
  expires_at?: string;
  started?: boolean;
  allowed?: boolean;
};

export class ScanRunStopped extends Error {
  constructor(
    public readonly reason: "cancelled" | "time_limit" | "chunk_limit",
  ) {
    super("Discovery scan is no longer authorized");
  }
}
function requireActive(state: ScanRunState) {
  if (state.status !== "active")
    throw new ScanRunStopped(
      state.status === "expired"
        ? "time_limit"
        : state.status === "chunk_limit"
          ? "chunk_limit"
          : "cancelled",
    );
}
function state(value: Json | null): ScanRunState {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.status !== "string" ||
    typeof value.run_id !== "string"
  )
    throw new AppError(
      500,
      "scan_state_unavailable",
      "検索状態を確認できません。再試行してください。",
    );
  return value as unknown as ScanRunState;
}

export async function startScanRun(
  db: DB,
  organization: string,
  runId: string,
  issuedAt: string,
  deadlineAt: string,
  signal: AbortSignal,
) {
  const result = await db
    .rpc("start_discovery_scan_run", {
      org: organization,
      run_id: runId,
      issued_at: issuedAt,
      deadline_at: deadlineAt,
    })
    .abortSignal(signal);
  if (result.error) databaseError(result.error);
  const run = state(result.data);
  requireActive(run);
  if (run.started !== true)
    throw new AppError(
      409,
      "scan_run_replayed",
      "同じ検索要求は再実行できません。続きから再開してください。",
    );
  return run;
}

export async function authorizeScanStep(
  db: DB,
  organization: string,
  runId: string,
  kind: "search" | "detail",
  signal: AbortSignal,
) {
  const result = await db
    .rpc("authorize_discovery_scan_step", {
      org: organization,
      run_id: runId,
      kind,
    })
    .abortSignal(signal);
  if (result.error) databaseError(result.error);
  const run = state(result.data);
  requireActive(run);
  if (run.allowed !== true) throw new ScanRunStopped("cancelled");
}

export async function commitScanCandidate(
  db: DB,
  organization: string,
  runId: string,
  candidate: ReturnType<typeof candidateFromGbiz>,
  previous: CompanyCandidateRow | undefined,
  signal: AbortSignal,
): Promise<{ row: CompanyCandidateRow; saved: boolean }> {
  const result = await db
    .rpc("commit_discovery_scan_candidate", {
      org: organization,
      run_id: runId,
      // The SQL function owns enrichment invalidation. Provider payloads can
      // never replace a phone, CRM link, or enrichment evidence.
      candidate: {
        corporate_number: candidate.corporate_number,
        name: candidate.name,
        prefecture_code: candidate.prefecture_code,
        prefecture: candidate.prefecture,
        location: candidate.location,
        industry_codes: candidate.industry_codes,
        industry_labels: candidate.industry_labels,
        website_url: candidate.website_url,
        employee_number: candidate.employee_number,
        source_updated_at: candidate.source_updated_at,
        fetched_at: candidate.fetched_at,
        provenance: candidate.provenance,
      },
      expected_updated_at: previous?.updated_at ?? null,
    })
    .abortSignal(signal);
  if (result.error) {
    // A transaction that could not establish a valid lease is a manual
    // interruption; never automatically revive a potentially cancelled run.
    if (result.error.code === "P0409") throw new ScanRunStopped("cancelled");
    if (["P0500", "P0429"].includes(result.error.code))
      throw new AppError(
        409,
        "candidate_limit",
        "保存できる候補の上限（5,000社）に達しました。",
      );
    databaseError(result.error);
  }
  const data = result.data as unknown as {
    status: ScanRunStatus;
    row: CompanyCandidateRow | null;
    saved: boolean;
  } | null;
  if (!data)
    throw new AppError(
      500,
      "scan_state_unavailable",
      "検索状態を確認できません。再試行してください。",
    );
  requireActive({ run_id: runId, status: data.status });
  if (!data.row)
    throw new AppError(
      409,
      "candidate_changed",
      "候補が変更されました。同じ位置から再開してください。",
    );
  return { row: data.row, saved: data.saved === true };
}

export async function cancelScanRun(
  db: DB,
  organization: string,
  runId: string,
) {
  const result = await db
    .rpc("cancel_discovery_scan_run", {
      org: organization,
      run_id: runId,
    })
    .abortSignal(AbortSignal.timeout(3_000));
  if (result.error) databaseError(result.error);
  const run = state(result.data);
  if (!["cancelled", "finished", "expired"].includes(run.status))
    throw new AppError(
      409,
      "scan_cancel_unconfirmed",
      "停止を確認できませんでした。もう一度停止してください。",
    );
  return run;
}

export async function finishScanRun(
  db: DB,
  organization: string,
  runId: string,
) {
  // Independent, bounded cleanup must remain possible after the HTTP/provider
  // signal has aborted. The database lease is the fallback if this RPC fails.
  const result = await db
    .rpc("finish_discovery_scan_run", {
      org: organization,
      run_id: runId,
    })
    .abortSignal(AbortSignal.timeout(3_000));
  if (result.error) databaseError(result.error);
  const run = state(result.data);
  if (!["cancelled", "finished", "expired"].includes(run.status))
    throw new AppError(
      500,
      "scan_finish_unconfirmed",
      "検索の終了状態を確認できませんでした。",
    );
  return run;
}
