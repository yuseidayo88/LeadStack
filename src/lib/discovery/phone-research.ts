import type { PhoneResearchResponse } from "./contracts";

export const PHONE_RESEARCH_BATCH_LIMIT = 10;

export type PhoneResearchItem = {
  id: string;
  result?: PhoneResearchResponse;
  error?: string;
};

/** One bounded website request at a time. Stopping drains the current request,
 * preserving its saved evidence, and never starts the next one. No retries. */
export async function runPhoneResearch(input: {
  ids: string[];
  request: (id: string) => Promise<PhoneResearchResponse>;
  shouldStop: () => boolean;
  onStart: (id: string) => void;
  onResult: (item: PhoneResearchItem) => void;
}): Promise<"complete" | "stopped" | "error"> {
  const ids = [...new Set(input.ids)];
  if (!ids.length || ids.length > PHONE_RESEARCH_BATCH_LIMIT)
    throw new Error("電話番号の調査は1回10社までです。");
  for (const id of ids) {
    if (input.shouldStop()) return "stopped";
    input.onStart(id);
    try {
      input.onResult({ id, result: await input.request(id) });
    } catch (error) {
      input.onResult({
        id,
        error:
          error instanceof Error ? error.message : "調査できませんでした。",
      });
      const status = (error as { status?: number } | null)?.status;
      // Continue only after an unambiguous per-candidate rejection. In
      // particular, never retry an ambiguous network failure or hourly limit.
      if (status !== 404 && status !== 409 && status !== 422) return "error";
    }
  }
  return "complete";
}

export function phoneResearchLabel(result: PhoneResearchResponse): string {
  if (
    result.candidate.phone ||
    result.candidate.crm_company_phone ||
    result.outcome === "existing_phone"
  )
    return "電話番号あり";
  if (result.outcome === "missing_website") return "公式URLが必要";
  if (result.outcome === "pending") return "別の調査が進行中";
  const proposal = result.candidate.enrichment_result;
  if (proposal?.phone) return "電話番号候補あり・要確認";
  if (proposal?.status === "blocked") return "自動取得できないサイト";
  if (proposal?.status === "failed") return "取得失敗";
  return "電話番号が見つからず";
}
