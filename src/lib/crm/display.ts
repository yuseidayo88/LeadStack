import type { Tables } from "@/lib/database.types";
export type Role = "owner" | "admin" | "sales" | "viewer";
export type Organization = Tables<"organizations"> & { role: Role };
export type Member = Tables<"organization_members"> & {
  profile?: Pick<Tables<"profiles">, "id" | "name" | "email" | "avatar_url">;
};
export type CompanySummary = Tables<"companies"> & {
  assigned_user_name: string | null;
  last_contact_at: string | null;
  next_task: { id: string; title: string; due_at: string | null } | null;
};
export type Activity = Tables<"activities"> & {
  call_details: Tables<"call_details"> | null;
};
export const companyStatusLabels = {
  new: "未接触",
  active: "アプローチ中",
  nurturing: "育成中",
  not_target: "対象外",
  closed: "対応完了",
};
export const stageLabels = {
  discovery: "ヒアリング",
  proposal: "提案",
  negotiation: "条件交渉",
  won: "成約",
  lost: "失注",
};
export const taskTypeLabels = {
  callback: "再架電",
  follow_up: "フォロー",
  meeting: "商談",
  proposal: "提案作成",
  other: "その他",
};
export const taskStatusLabels = {
  todo: "未完了",
  completed: "完了",
  cancelled: "キャンセル",
};
export const roleLabels: Record<Role, string> = {
  owner: "オーナー",
  admin: "管理者",
  sales: "営業",
  viewer: "閲覧のみ",
};
export const activityLabels = {
  call: "電話",
  meeting: "商談",
  email: "メール",
  memo: "メモ",
  status_change: "ステータス変更",
};
export const callResultLabels = {
  no_answer: "不在",
  gatekeeper: "受付対応",
  connected: "担当者接続",
  callback: "再架電",
  appointment: "アポイント",
  rejected: "お断り",
  other: "その他",
};
export const proposalTypeLabels = {
  build: "新規システム構築",
  automate: "ツール連携・自動化",
  keep: "既存ツール維持",
};
export const proposalStatusLabels = {
  draft: "下書き",
  proposed: "提案済み",
  accepted: "採用",
  rejected: "見送り",
};
export const processLabels = {
  project_management: "案件管理",
  estimate: "見積",
  daily_report: "日報",
  billing: "請求",
  customer_management: "顧客管理",
  scheduling: "スケジュール",
  inventory: "在庫管理",
  reporting: "報告書",
  document_management: "文書管理",
  inquiry_management: "問い合わせ管理",
  communication: "社内連絡",
  other: "その他",
};
export const painLabels = {
  duplicate_entry: "二重入力",
  manual_work: "手作業",
  fragmented_information: "情報分散",
  paperwork: "紙作業",
  slow_reporting: "報告の遅れ",
  human_error: "入力ミス",
  repetitive_work: "繰り返し作業",
  communication_delay: "連絡の遅れ",
  approval_delay: "承認待ち",
  data_search: "情報を探す手間",
  person_dependency: "属人化",
  other: "その他",
};
export const toolPolicyLabels = {
  unknown: "未確認",
  keep: "継続利用",
  replace: "置き換え",
  integrate: "連携する",
};
export const industries = [
  "電気工事",
  "空調・設備",
  "内装",
  "リフォーム",
  "建物メンテナンス",
];
export const prefectures = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
];
export function label(
  map: Record<string, string>,
  value: string | null | undefined,
) {
  return value ? map[value] || value : "—";
}
export function money(value: number | null | undefined) {
  return value == null
    ? "—"
    : new Intl.NumberFormat("ja-JP", {
        style: "currency",
        currency: "JPY",
        maximumFractionDigits: 0,
      }).format(value);
}
export function dateTime(value: string | null | undefined, dateOnly = false) {
  if (!value) return "未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "short",
    day: "numeric",
    ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(new Date(value));
}
export function localInputDate(value: string | null | undefined) {
  return value
    ? new Date(new Date(value).getTime() + 9 * 3600000)
        .toISOString()
        .slice(0, 16)
    : "";
}
export function toTimestamp(value: string) {
  return value ? new Date(value + ":00+09:00").toISOString() : null;
}
export function options(map: Record<string, string>) {
  return Object.entries(map).map(([value, label]) => ({ value, label }));
}
