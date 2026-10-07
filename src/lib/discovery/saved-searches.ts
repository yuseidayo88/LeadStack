import { prefectures } from "@/lib/crm/display";
import { industryOptions } from "./industries";
import {
  defaultDiscoveryFilters,
  parseDiscoveryFilters,
  targetingFilterError,
  type DiscoveryFilters,
} from "./targeting";

export const SAVED_SEARCH_LIMIT = 10;
export type SearchScope = { base: string; actorId: string };
export type SavedSearch = {
  id: string;
  name: string;
  filters: DiscoveryFilters;
};
export type FilterChip = {
  id: string;
  label: string;
  clear: Partial<DiscoveryFilters>;
};

export function savedSearchesKey({ base, actorId }: SearchScope) {
  return `leadstack.discovery.saved-searches.v1.${actorId}.${base}`;
}

export function discoveryFilterChips(f: DiscoveryFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.prefecture)
    chips.push({
      id: "prefecture",
      label: prefectures[Number(f.prefecture) - 1] || f.prefecture,
      clear: { prefecture: "" },
    });
  if (f.industry)
    chips.push({
      id: "industry",
      label:
        f.industry === "unknown"
          ? "業種：未確認"
          : `${industryOptions.find((i) => i.value === f.industry)?.label || f.industry}${f.includeUnknownIndustry ? "（未確認も含む）" : ""}`,
      clear: { industry: "", includeUnknownIndustry: false },
    });
  if (f.search)
    chips.push({
      id: "search",
      label: `企業名・法人番号：${f.search}`,
      clear: { search: "" },
    });
  if (f.employeeMin || f.employeeMax) {
    const range =
      f.employeeMin && f.employeeMax
        ? `${f.employeeMin}〜${f.employeeMax}人`
        : f.employeeMin
          ? `${f.employeeMin}人以上`
          : `${f.employeeMax}人以下`;
    chips.push({
      id: "employees",
      label: `従業員数：${range}${f.includeUnknownEmployees && !f.hasEmployees ? "（未確認も含む）" : ""}`,
      clear: { employeeMin: "", employeeMax: "" },
    });
  }
  if (f.businessKeywords)
    chips.push({
      id: "keywords",
      label: `業務：${f.businessKeywords}`,
      clear: { businessKeywords: "" },
    });
  for (const [key, label] of [
    ["hasPhone", "電話番号あり"],
    ["hasWebsite", "Webサイトあり"],
    ["hasEmployees", "従業員数あり"],
  ] as const)
    if (f[key]) chips.push({ id: key, label, clear: { [key]: false } });
  return chips;
}

function validFilters(value: unknown): value is DiscoveryFilters {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  const parsed = parseDiscoveryFilters(
    JSON.stringify({ version: 1, filters: input }),
  );
  // Reject malformed values instead of silently widening a saved search.
  return (
    Object.keys(defaultDiscoveryFilters).every(
      (key) => input[key] === parsed[key as keyof DiscoveryFilters],
    ) && !targetingFilterError(parsed)
  );
}

export function parseSavedSearches(
  raw: string | null,
  scope: SearchScope,
): SavedSearch[] {
  if (!raw || raw.length > 40000) return [];
  try {
    const data = JSON.parse(raw);
    if (
      data?.version !== 1 ||
      data.base !== scope.base ||
      data.actorId !== scope.actorId ||
      !Array.isArray(data.items) ||
      data.items.length > SAVED_SEARCH_LIMIT
    )
      return [];
    const ids = new Set<string>();
    const names = new Set<string>();
    const result: SavedSearch[] = [];
    for (const item of data.items) {
      if (
        !item ||
        typeof item.id !== "string" ||
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(item.id) ||
        typeof item.name !== "string" ||
        !item.name.trim() ||
        item.name.length > 40 ||
        !validFilters(item.filters)
      )
        continue;
      const normalizedName = item.name
        .normalize("NFKC")
        .trim()
        .toLocaleLowerCase("ja");
      if (ids.has(item.id) || names.has(normalizedName)) continue;
      ids.add(item.id);
      names.add(normalizedName);
      // Only known filter fields survive; no cursor, force-refresh flag or token.
      const filters = parseDiscoveryFilters(
        JSON.stringify({ version: 1, filters: item.filters }),
      );
      result.push({ id: item.id, name: item.name.trim(), filters });
    }
    return result;
  } catch {
    return [];
  }
}

export function addSavedSearch(
  items: SavedSearch[],
  name: string,
  filters: DiscoveryFilters,
  id: string,
): SavedSearch[] {
  const trimmed = name.normalize("NFKC").trim();
  if (!trimmed || trimmed.length > 40)
    throw new Error("条件名は1〜40文字で入力してください。");
  if (
    items.some(
      (item) =>
        item.name.normalize("NFKC").toLocaleLowerCase("ja") ===
        trimmed.toLocaleLowerCase("ja"),
    )
  )
    throw new Error("同じ名前の条件があります。別の名前を付けてください。");
  if (items.length >= SAVED_SEARCH_LIMIT)
    throw new Error(
      "保存できる条件は10件までです。不要な条件を削除してください。",
    );
  if (!validFilters(filters) || !discoveryFilterChips(filters).length)
    throw new Error("有効な検索条件を指定してから保存してください。");
  return [
    ...items,
    {
      id,
      name: trimmed,
      filters: parseDiscoveryFilters(JSON.stringify({ version: 1, filters })),
    },
  ];
}
