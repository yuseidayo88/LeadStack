import type { ScanCriteria, ScanEvent } from "@/lib/discovery/contracts";
import type { DiscoveryFilters } from "@/lib/discovery/targeting";

export type ScanCheckpoint = {
  version: 1;
  base: string;
  scope: string;
  event: ScanEvent;
  savedAt: number;
};

export type ActiveScanRun = {
  version: 1;
  base: string;
  runId: string;
  tabId: string;
  actorId: string;
  issuedAt: string;
};

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function activeScanStorageKey(base: string) {
  return `leadstack.discovery.active.v1.${base}`;
}

export function parseActiveScanRun(
  value: string | null,
  expectedBase: string,
): ActiveScanRun | null {
  if (!value || value.length > 2000) return null;
  try {
    const run = JSON.parse(value) as ActiveScanRun;
    if (
      run?.version !== 1 ||
      run.base !== expectedBase ||
      typeof run.runId !== "string" ||
      !uuid.test(run.runId) ||
      typeof run.tabId !== "string" ||
      !uuid.test(run.tabId) ||
      typeof run.actorId !== "string" ||
      !uuid.test(run.actorId) ||
      typeof run.issuedAt !== "string" ||
      !Number.isFinite(Date.parse(run.issuedAt))
    )
      return null;
    return run;
  } catch {
    return null;
  }
}

// An old request may acknowledge cancellation after another tab has started.
// Never remove that newer tab's recovery marker.
export function clearActiveScanRun(
  storage: Pick<Storage, "getItem" | "removeItem">,
  run: ActiveScanRun,
) {
  const key = activeScanStorageKey(run.base);
  if (parseActiveScanRun(storage.getItem(key), run.base)?.runId === run.runId)
    storage.removeItem(key);
}

export async function requestScanCancellation(
  run: ActiveScanRun,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`${run.base}/company-discovery/scan/cancel`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId: run.runId }),
    keepalive: true,
    // This is deliberately independent of the already-aborted streaming request.
    signal: AbortSignal.timeout(10_000),
  });
  const result: unknown = response.ok ? await response.json() : null;
  const data =
    result && typeof result === "object" && "data" in result
      ? result.data
      : null;
  if (
    !data ||
    typeof data !== "object" ||
    !("runId" in data) ||
    data.runId !== run.runId ||
    !("status" in data) ||
    !["cancelled", "finished", "expired"].includes(String(data.status))
  )
    throw new Error("検索の停止を確認できませんでした。");
}

export function shouldContinueScan(event: ScanEvent) {
  return (
    event.type === "paused" &&
    (event.reason === "time_limit" || event.reason === "chunk_limit") &&
    !!event.resumeToken
  );
}

export function scanCriteriaFromFilters(
  filters: DiscoveryFilters,
): ScanCriteria {
  const search = filters.search.normalize("NFKC").trim();
  return {
    ...(filters.prefecture ? { prefecture: filters.prefecture } : {}),
    ...(search
      ? /^\d{13}$/.test(search)
        ? { corporateNumber: search }
        : { name: search }
      : {}),
    ...(filters.industry ? { industry: filters.industry } : {}),
    ...(filters.employeeMin !== ""
      ? { employeeMin: Number(filters.employeeMin) }
      : {}),
    ...(filters.employeeMax !== ""
      ? { employeeMax: Number(filters.employeeMax) }
      : {}),
    includeUnknownEmployees: filters.includeUnknownEmployees,
    includeUnknownIndustry: filters.includeUnknownIndustry,
    ...(filters.businessKeywords.trim()
      ? { businessKeywords: filters.businessKeywords.trim() }
      : {}),
    hasPhone: filters.hasPhone,
    hasWebsite: filters.hasWebsite,
    hasEmployees: filters.hasEmployees,
  };
}

export function hasScanCriteria(criteria: ScanCriteria): boolean {
  return !!(
    criteria.prefecture ||
    criteria.name ||
    criteria.corporateNumber ||
    criteria.industry ||
    criteria.employeeMin !== undefined ||
    criteria.employeeMax !== undefined ||
    criteria.businessKeywords
  );
}

export function parseScanEvent(value: unknown): ScanEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as ScanEvent;
  if (!["progress", "complete", "paused", "error"].includes(event.type))
    return null;
  for (const field of [
    "scanned",
    "matched",
    "target",
    "saved",
    "detailsFailed",
    "unknownEmployees",
    "unknownIndustry",
  ] as const) {
    if (
      !Number.isSafeInteger(event[field]) ||
      event[field] < 0 ||
      event[field] > (field === "detailsFailed" ? 1000 : 200)
    )
      return null;
  }
  if (
    event.reused !== undefined &&
    (!Number.isSafeInteger(event.reused) ||
      event.reused < 0 ||
      event.reused + event.saved > event.scanned)
  )
    return null;
  if (
    !Array.isArray(event.matchedIds) ||
    event.matchedIds.length > 200 ||
    event.matchedIds.some(
      (id) =>
        typeof id !== "string" ||
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id),
    )
  )
    return null;
  if (
    event.resumeToken !== null &&
    (typeof event.resumeToken !== "string" || event.resumeToken.length > 32768)
  )
    return null;
  if (
    typeof event.nextAllowedAt !== "string" ||
    !Number.isFinite(Date.parse(event.nextAllowedAt))
  )
    return null;
  if (
    event.message !== undefined &&
    (typeof event.message !== "string" || event.message.length > 2000)
  )
    return null;
  if (
    event.reason !== undefined &&
    ![
      "target",
      "scan_limit",
      "exhausted",
      "time_limit",
      "chunk_limit",
      "upstream_error",
      "cancelled",
    ].includes(event.reason)
  )
    return null;
  return event;
}

export function parseScanCheckpoint(
  value: string | null,
  expectedBase: string,
  now = Date.now(),
): ScanCheckpoint | null {
  if (!value || value.length > 50000) return null;
  try {
    const stored = JSON.parse(value) as ScanCheckpoint;
    if (
      stored.version !== 1 ||
      stored.base !== expectedBase ||
      typeof stored.scope !== "string" ||
      stored.scope.length > 2500 ||
      !Number.isFinite(stored.savedAt) ||
      stored.savedAt > now + 60000 ||
      now - stored.savedAt > 2 * 60 * 60 * 1000
    )
      return null;
    const event = parseScanEvent(stored.event);
    return event
      ? {
          version: 1,
          base: expectedBase,
          scope: stored.scope,
          event,
          savedAt: stored.savedAt,
        }
      : null;
  } catch {
    return null;
  }
}

export async function readScanEvents(
  response: Response,
  onEvent: (event: ScanEvent) => void,
): Promise<ScanEvent> {
  if (!response.ok) {
    let detail: unknown;
    try {
      detail = await response.json();
    } catch {}
    const error =
      detail && typeof detail === "object" && "error" in detail
        ? detail.error
        : null;
    const message =
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : "企業検索を開始できませんでした。時間をおいて再試行してください。";
    throw new Error(message);
  }
  if (!response.body) throw new Error("検索の応答を読み取れませんでした。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: ScanEvent | null = null;
  const accept = (line: string) => {
    if (!line.trim()) return;
    if (terminal)
      throw new Error("検索の終了後に予期しない応答を受信しました。");
    if (line.length > 64000)
      throw new Error("検索の応答が大きすぎるため停止しました。");
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("検索の応答を読み取れませんでした。");
    }
    const event = parseScanEvent(raw);
    if (!event) throw new Error("検索の応答を読み取れませんでした。");
    onEvent(event);
    if (event.type !== "progress") terminal = event;
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        accept(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > 64000)
        throw new Error("検索の応答が大きすぎるため停止しました。");
    }
    buffer += decoder.decode();
    accept(buffer);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!terminal)
    throw new Error(
      "検索との接続が中断されました。保存済みの位置から再開できます。",
    );
  return terminal;
}
