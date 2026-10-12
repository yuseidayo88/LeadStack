import type { Candidate } from "@/lib/discovery/contracts";

export function CandidateMatchEvidence({
  candidate,
}: {
  candidate: Candidate;
}) {
  const evidence = candidate.match_evidence;
  if (!evidence) return null;
  return (
    <div
      className="mt-1 space-y-1 text-xs text-muted-foreground"
      aria-label="検索条件の根拠"
    >
      {evidence.missing.length > 0 && (
        <p className="font-medium">
          情報不足：
          {evidence.missing
            .map((field) => (field === "employees" ? "従業員数" : "業種"))
            .join("・")}
          が未確認（条件一致には含めません）
        </p>
      )}
      {evidence.industryCode && (
        <p>業種コード一致：{evidence.industryCode}（大分類）</p>
      )}
      {evidence.keywords.length > 0 && (
        <p>
          名称・事業内容の語句一致：{evidence.keywords.join("・")}
          。業種を確定する根拠ではありません。
        </p>
      )}
    </div>
  );
}
