import type { CompanyCandidateRow } from "@/lib/database.types";
import { object } from "./mapping";

export const GBIZ_DETAIL_FRESH_MS = 24 * 60 * 60 * 1000;

/** A recent successful detail lookup, never a name/address-only search result.
 * Reuse does not extend fetched_at or alter manually reviewed fields/evidence.
 */
export function reusableGbizDetail(
  row: CompanyCandidateRow | undefined,
  now: number,
): row is CompanyCandidateRow {
  if (!row) return false;
  const source = object(object(row.provenance).gbiz);
  const fetched = Date.parse(row.fetched_at);
  const detailUrl = `https://api.info.gbiz.go.jp/hojin/v2/hojin/${row.corporate_number}`;
  return (
    source.source === "gBizINFO" &&
    (source.requestUrl === `${detailUrl}?metadata_flg=true` ||
      source.requestUrl === detailUrl) &&
    typeof source.retrievedAt === "string" &&
    Date.parse(source.retrievedAt) === fetched &&
    Number.isFinite(fetched) &&
    fetched <= now &&
    now - fetched < GBIZ_DETAIL_FRESH_MS
  );
}
