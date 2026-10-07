import type { ScanEvent } from "./contracts";

export function scanProgressState({
  event,
  running,
  finishing,
  requestPending,
  cancellation,
  waitingUntil,
  resultsUpdating,
  resultsError,
  error,
}: {
  event: ScanEvent | null;
  running: boolean;
  finishing: boolean;
  requestPending: boolean;
  cancellation: "idle" | "pending" | "failed";
  waitingUntil: string | null;
  resultsUpdating: boolean;
  resultsError: boolean;
  error: string;
}): { label: string; indeterminate: boolean } {
  if (cancellation === "pending")
    return { label: "停止を確認中…", indeterminate: true };
  if (cancellation === "failed")
    return { label: "停止の確認が必要です", indeterminate: false };
  if (error || (event?.type === "error" && (!running || !requestPending)))
    return { label: "検索を中断しました", indeterminate: false };
  if (running) {
    if (waitingUntil)
      return { label: "次の確認まで待機中…", indeterminate: false };
    if (requestPending)
      return { label: "検索中… 企業情報を取得しています", indeterminate: true };
    if (event?.type === "complete")
      return { label: "検索結果を受け取り中…", indeterminate: true };
    return {
      label: event?.scanned
        ? "企業情報を確認中…"
        : "検索中… 企業情報を取得しています",
      indeterminate: !event?.scanned,
    };
  }
  if (finishing || resultsUpdating)
    return { label: "結果を一覧に反映中…", indeterminate: true };
  if (resultsError)
    return { label: "結果の一覧を更新できませんでした", indeterminate: false };
  if (event?.type === "complete")
    return {
      label: event.matched
        ? "検索が完了しました"
        : "検索が完了しました（条件一致0社）",
      indeterminate: false,
    };
  return { label: "検索を停止しました", indeterminate: false };
}
