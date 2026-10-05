export type DiscoveryFilters = {
  search: string;
  prefecture: string;
  industry: string;
  hasPhone: boolean;
  hasWebsite: boolean;
  hasEmployees: boolean;
  employeeMin: string;
  employeeMax: string;
  includeUnknownEmployees: boolean;
  includeUnknownIndustry: boolean;
  businessKeywords: string;
  presetId: string;
  sort: "name" | "fetched_at" | "employee_number";
  direction: "asc" | "desc";
};

export const defaultDiscoveryFilters: DiscoveryFilters = {
  search: "",
  prefecture: "",
  industry: "",
  hasPhone: false,
  hasWebsite: false,
  hasEmployees: false,
  employeeMin: "",
  employeeMax: "",
  includeUnknownEmployees: true,
  includeUnknownIndustry: false,
  businessKeywords: "",
  presetId: "",
  sort: "fetched_at",
  direction: "desc",
};

export const targetingPresets = [
  {
    id: "equipment",
    label: "設備工事・保守点検",
    employeeMin: "10",
    employeeMax: "50",
    industry: "",
    includeUnknownIndustry: false,
    businessKeywords: "設備 電気 空調 給排水 保守 点検",
    nameHints: ["設備", "電気", "空調", "給排水", "保守", "点検"],
    workflow:
      "現場で写真・作業内容を入力 → AIが報告書を下書き → 担当者が確認・保存",
    questions: [
      "現場の報告を、事務所で入力し直していますか？",
      "報告書や写真の整理は、月に何件・何時間ありますか？",
      "まず一つの帳票から試せる担当者はいますか？",
    ],
  },
  {
    id: "wholesale",
    label: "卸売・受発注",
    employeeMin: "10",
    employeeMax: "50",
    industry: "I",
    includeUnknownIndustry: true,
    businessKeywords: "",
    nameHints: ["商事", "商会", "物産", "卸"],
    workflow: "注文を受付 → 内容を整理して受発注アプリへ → 担当者が確認・集計",
    questions: [
      "メールやFAXの注文を、別の画面へ入力していますか？",
      "注文入力や照合に、月に何件・何時間かかりますか？",
      "最初に対象にできる商品・取引先はありますか？",
    ],
  },
  {
    id: "services",
    label: "受託サービス",
    employeeMin: "10",
    employeeMax: "30",
    industry: "",
    includeUnknownIndustry: false,
    businessKeywords: "制作 代行 支援",
    nameHints: ["制作", "代行", "支援", "サービス"],
    workflow: "依頼を受付 → 案件・進捗を共有 → AIが報告の下書き → 担当者が確認",
    questions: [
      "依頼や進捗が、メール・チャット・表に分かれていますか？",
      "確認や報告の作業は、月に何件・何時間ありますか？",
      "まず一つの案件種類から運用を試せますか？",
    ],
  },
] as const;

export type TargetingPreset = (typeof targetingPresets)[number];

export function applyTargetingPreset(
  filters: DiscoveryFilters,
  preset: TargetingPreset,
): DiscoveryFilters {
  return {
    ...filters,
    search: "",
    industry: preset.industry,
    hasPhone: false,
    hasWebsite: false,
    hasEmployees: false,
    employeeMin: preset.employeeMin,
    employeeMax: preset.employeeMax,
    includeUnknownEmployees: true,
    includeUnknownIndustry: preset.includeUnknownIndustry,
    businessKeywords: preset.businessKeywords,
    presetId: preset.id,
  };
}

export function businessKeywordTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .trim()
        .split(/[\s,、，]+/u)
        .filter(Boolean),
    ),
  ];
}

export function targetingFilterError(filters: DiscoveryFilters): string | null {
  for (const value of [filters.employeeMin, filters.employeeMax]) {
    if (value && (!/^\d+$/.test(value) || Number(value) > 2147483647))
      return "従業員数は0〜2,147,483,647の整数で入力してください。";
  }
  if (
    filters.employeeMin !== "" &&
    filters.employeeMax !== "" &&
    Number(filters.employeeMin) > Number(filters.employeeMax)
  )
    return "従業員数の下限は、上限以下にしてください。";
  const terms = businessKeywordTerms(filters.businessKeywords);
  if (
    filters.businessKeywords.length > 200 ||
    terms.length > 8 ||
    terms.some((term) => term.length > 40)
  )
    return "業務キーワードは全体200文字以内、8語まで、1語40文字以内で入力してください。";
  return null;
}

export function isTargetingPresetModified(
  filters: DiscoveryFilters,
  preset: TargetingPreset,
) {
  return (
    filters.search !== "" ||
    filters.industry !== preset.industry ||
    filters.employeeMin !== preset.employeeMin ||
    filters.employeeMax !== preset.employeeMax ||
    !filters.includeUnknownEmployees ||
    filters.includeUnknownIndustry !== preset.includeUnknownIndustry ||
    filters.businessKeywords !== preset.businessKeywords ||
    filters.hasPhone ||
    filters.hasWebsite ||
    filters.hasEmployees
  );
}

export function parseDiscoveryFilters(value: string | null): DiscoveryFilters {
  if (!value || value.length > 3000) return { ...defaultDiscoveryFilters };
  try {
    const saved: unknown = JSON.parse(value);
    if (
      !saved ||
      typeof saved !== "object" ||
      !("version" in saved) ||
      saved.version !== 1 ||
      !("filters" in saved)
    )
      return { ...defaultDiscoveryFilters };
    const input = saved.filters;
    if (!input || typeof input !== "object")
      return { ...defaultDiscoveryFilters };
    const record = input as Record<string, unknown>;
    const filters = { ...defaultDiscoveryFilters };
    for (const key of [
      "search",
      "prefecture",
      "industry",
      "employeeMin",
      "employeeMax",
      "businessKeywords",
      "presetId",
    ] as const) {
      if (typeof record[key] === "string" && record[key].length <= 200)
        filters[key] = record[key];
    }
    for (const key of [
      "hasPhone",
      "hasWebsite",
      "hasEmployees",
      "includeUnknownEmployees",
      "includeUnknownIndustry",
    ] as const) {
      if (typeof record[key] === "boolean") filters[key] = record[key];
    }
    if (!/^(?:0[1-9]|[1-3]\d|4[0-7])?$/.test(filters.prefecture))
      filters.prefecture = "";
    if (!/^(?:[A-T]|unknown)?$/.test(filters.industry)) filters.industry = "";
    if (!targetingPresets.some((preset) => preset.id === filters.presetId))
      filters.presetId = "";
    if (
      record.sort === "name" ||
      record.sort === "fetched_at" ||
      record.sort === "employee_number"
    )
      filters.sort = record.sort;
    if (record.direction === "asc" || record.direction === "desc")
      filters.direction = record.direction;
    if (filters.hasEmployees) filters.includeUnknownEmployees = false;
    if (targetingFilterError(filters)) return { ...defaultDiscoveryFilters };
    return filters;
  } catch {
    return { ...defaultDiscoveryFilters };
  }
}

export function matchingBusinessKeywords(
  candidate: { name: string; business_summary?: string | null },
  keywords: string,
) {
  const text =
    `${candidate.name} ${candidate.business_summary ?? ""}`.toLocaleLowerCase(
      "ja",
    );
  return businessKeywordTerms(keywords).filter((term) =>
    text.includes(term.toLocaleLowerCase("ja")),
  );
}
