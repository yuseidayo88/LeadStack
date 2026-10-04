import type { Resource } from "@/lib/crm/schemas";
import {
  companyStatusLabels,
  stageLabels,
  taskTypeLabels,
  taskStatusLabels,
  proposalTypeLabels,
  proposalStatusLabels,
  processLabels,
  painLabels,
  toolPolicyLabels,
  industries,
  prefectures,
} from "@/lib/crm/display";
export type Field = {
  key: string;
  label: string;
  type?:
    | "text"
    | "textarea"
    | "email"
    | "url"
    | "number"
    | "date"
    | "datetime-local"
    | "select"
    | "member"
    | "checkbox";
  required?: boolean;
  options?: Record<string, string>;
  suggestions?: string[];
  default?: string | boolean;
  wide?: boolean;
  min?: number;
  max?: number;
  hint?: string;
};
export const resourceNames: Record<Resource, string> = {
  companies: "企業",
  contacts: "担当者",
  tasks: "タスク",
  deals: "商談",
  business_processes: "業務",
  company_tools: "利用ツール",
  pain_points: "課題",
  proposals: "改善提案",
};
export const fields: Record<Resource, Field[]> = {
  companies: [
    { key: "name", label: "会社名", required: true, wide: true },
    { key: "industry", label: "業種", suggestions: industries },
    { key: "industry_subcategory", label: "業種（詳細）" },
    {
      key: "company_status",
      label: "ステータス",
      type: "select",
      options: companyStatusLabels,
      default: "new",
      required: true,
    },
    { key: "assigned_user_id", label: "担当営業", type: "member" },
    { key: "phone", label: "電話番号" },
    { key: "website_url", label: "Webサイト", type: "url" },
    {
      key: "prefecture",
      label: "都道府県",
      type: "select",
      options: Object.fromEntries(prefectures.map((p) => [p, p])),
    },
    { key: "city", label: "市区町村" },
    { key: "address", label: "住所", wide: true },
    { key: "employee_min", label: "従業員数（下限）", type: "number" },
    { key: "employee_max", label: "従業員数（上限）", type: "number" },
    { key: "capital", label: "資本金（円）", type: "number" },
    { key: "corporate_number", label: "法人番号", hint: "13桁の数字" },
    { key: "contact_url", label: "お問い合わせURL", type: "url" },
    { key: "source", label: "流入元" },
    {
      key: "business_description",
      label: "事業内容",
      type: "textarea",
      wide: true,
    },
  ],
  contacts: [
    { key: "name", label: "担当者名", required: true },
    { key: "department", label: "部署" },
    { key: "position", label: "役職" },
    { key: "phone", label: "電話番号" },
    { key: "email", label: "メールアドレス", type: "email" },
    {
      key: "is_decision_maker",
      label: "決裁者",
      type: "checkbox",
      default: false,
    },
    { key: "notes", label: "メモ", type: "textarea", wide: true },
  ],
  tasks: [
    { key: "title", label: "タスク名", required: true, wide: true },
    {
      key: "type",
      label: "種類",
      type: "select",
      options: taskTypeLabels,
      default: "follow_up",
      required: true,
    },
    {
      key: "status",
      label: "状態",
      type: "select",
      options: taskStatusLabels,
      default: "todo",
      required: true,
    },
    {
      key: "assigned_user_id",
      label: "担当営業",
      type: "member",
      required: true,
    },
    { key: "due_at", label: "期限（日本時間）", type: "datetime-local" },
    { key: "description", label: "詳細", type: "textarea", wide: true },
  ],
  deals: [
    { key: "name", label: "案件名", required: true, wide: true },
    {
      key: "stage",
      label: "ステージ",
      type: "select",
      options: stageLabels,
      default: "discovery",
      required: true,
    },
    { key: "owner_user_id", label: "担当営業", type: "member", required: true },
    { key: "initial_price", label: "初期費用（円）", type: "number" },
    { key: "monthly_price", label: "月額費用（円）", type: "number" },
    { key: "expected_close_date", label: "成約予定日", type: "date" },
    { key: "lost_reason", label: "失注理由", type: "textarea", wide: true },
    { key: "notes", label: "メモ", type: "textarea", wide: true },
  ],
  business_processes: [
    {
      key: "process_type",
      label: "業務の種類",
      type: "select",
      options: processLabels,
      default: "project_management",
      required: true,
    },
    {
      key: "current_method",
      label: "現在の運用方法",
      hint: "例：Excel、紙、専用システム",
    },
    {
      key: "pain_level",
      label: "負担の大きさ（1〜5）",
      type: "number",
      min: 1,
      max: 5,
    },
    { key: "description", label: "業務内容", type: "textarea", wide: true },
    { key: "notes", label: "ヒアリングメモ", type: "textarea", wide: true },
  ],
  company_tools: [
    { key: "tool_name", label: "ツール名", required: true },
    { key: "category", label: "用途カテゴリ" },
    {
      key: "keep_or_replace",
      label: "今後の方針",
      type: "select",
      options: toolPolicyLabels,
      default: "unknown",
      required: true,
    },
    {
      key: "usage_description",
      label: "利用状況",
      type: "textarea",
      wide: true,
    },
  ],
  pain_points: [
    {
      key: "type",
      label: "課題の種類",
      type: "select",
      options: painLabels,
      default: "manual_work",
      required: true,
    },
    {
      key: "severity",
      label: "深刻度（1〜5）",
      type: "number",
      min: 1,
      max: 5,
    },
    { key: "description", label: "課題の詳細", type: "textarea", wide: true },
  ],
  proposals: [
    { key: "title", label: "提案名", required: true, wide: true },
    {
      key: "type",
      label: "提案の種類",
      type: "select",
      options: proposalTypeLabels,
      default: "build",
      required: true,
    },
    {
      key: "status",
      label: "提案の状態",
      type: "select",
      options: proposalStatusLabels,
      default: "draft",
      required: true,
    },
    { key: "description", label: "提案内容", type: "textarea", wide: true },
    { key: "reason", label: "提案理由", type: "textarea", wide: true },
    {
      key: "expected_benefit",
      label: "期待する効果",
      type: "textarea",
      wide: true,
    },
  ],
};
