import type { Tables } from "@/lib/database.types";
import { processLabels, painLabels, label } from "./display";
export function proposalDrafts(
  process?: Tables<"business_processes">,
  pain?: Tables<"pain_points">,
  tool?: Tables<"company_tools">,
) {
  if (!process && !pain && !tool) return [];
  const subject = process
    ? label(processLabels, process.process_type)
    : pain
      ? label(painLabels, pain.type)
      : tool!.tool_name;
  const facts = [
    process &&
      `登録業務：${subject}\n現在の運用：${process.current_method || "未記入"}\n業務内容：${process.description || "未記入"}`,
    pain &&
      `登録課題：${label(painLabels, pain.type)}\n詳細：${pain.description || "未記入"}`,
    tool &&
      `利用ツール：${tool.tool_name}\n利用状況：${tool.usage_description || "未記入"}\n継続方針：${tool.keep_or_replace}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const common = {
    status: "draft",
    generated_by: "rule",
    reason: `確認した登録情報\n${facts}\n\n以下は検討用の仮説です。実現性・費用・効果は未確認です。`,
  };
  return [
    ...(process || pain
      ? [
          {
            ...common,
            type: "build",
            title: `${subject}の仕組み化を検討`.slice(0, 300),
            description:
              "【検討案】情報の入力・共有方法を整理し、必要な機能を小さく試作する。\n【要確認】既存機能で対応できない理由、利用者、必要な項目、権限、予算。",
            expected_benefit:
              "情報を探す手間や属人化の軽減を目指す。効果は試行前後で測定する。",
          },
          {
            ...common,
            type: "automate",
            title: `${subject}の定型作業を検討`.slice(0, 300),
            description:
              "【検討案】繰り返し発生する作業を整理し、承認と例外処理を残した自動化を試す。\n【要確認】頻度、入力と出力、接続手段、データの取扱い。",
            expected_benefit:
              "作業時間と転記ミスの削減を目指す。削減率は未算定。",
            automation_config: {
              trigger: "要確認：対象業務を開始する条件",
              steps: [
                "対象データと権限を確認する",
                "試行環境で処理を検証する",
                "担当者が結果と例外を確認する",
              ],
              tools: tool ? [tool.tool_name] : [],
            },
          },
        ]
      : []),
    ...(tool
      ? [
          {
            ...common,
            type: "keep",
            title: `${tool.tool_name}の継続活用を検討`.slice(0, 300),
            description: `【検討案】既存ツールの設定・運用ルールで課題に対応できるか確認する。\n【要確認】不足機能、利用率、更新費用。登録された方針（${tool.keep_or_replace}）との整合も確認する。継続を決定したものではありません。`,
            expected_benefit:
              "既存の操作習熟を活かし、変更負担を抑えることを目指す。費用対効果は未確認。",
          },
        ]
      : []),
  ];
}
