import { describe, expect, test } from "vitest";
import {
  addSavedSearch,
  discoveryFilterChips,
  parseSavedSearches,
  savedSearchesKey,
  SAVED_SEARCH_LIMIT,
} from "@/lib/discovery/saved-searches";
import { defaultDiscoveryFilters } from "@/lib/discovery/targeting";

const scope = { base: "/api/organizations/org-a", actorId: "user-a" };
const id = (i: number) =>
  `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`;
const filters = {
  ...defaultDiscoveryFilters,
  prefecture: "13",
  industry: "D",
  employeeMin: "0",
  employeeMax: "50",
  hasPhone: true,
};
const saved = () => addSavedSearch([], "東京の架電候補", filters, id(1));
const encode = (items: unknown, extra = {}) =>
  JSON.stringify({ version: 1, ...scope, items, ...extra });

describe("personal organization-scoped saved searches", () => {
  test("round trips all filters, zero bounds, unknown flags and ordering", () => {
    expect(parseSavedSearches(encode(saved()), scope)).toEqual(saved());
    expect(saved()[0].filters).toEqual(filters);
  });
  test.each([
    { ...scope, actorId: "user-b" },
    { ...scope, base: "/api/organizations/org-b" },
  ])("rejects scope %j even if the value was copied under its key", (other) => {
    expect(savedSearchesKey(other)).not.toEqual(savedSearchesKey(scope));
    expect(parseSavedSearches(encode(saved()), other)).toEqual([]);
  });
  test.each([
    null,
    "bad-json",
    "null",
    "{}",
    "[]",
    "x".repeat(40001),
    encode(saved(), { version: 2 }),
    encode(saved(), { items: {} }),
  ])("rejects unsupported or malformed storage %s", (raw) => {
    expect(parseSavedSearches(raw, scope)).toEqual([]);
  });
  test.each([
    { prefecture: "99" },
    { industry: "Z" },
    { employeeMin: "60" },
    { employeeMax: "invalid" },
    { hasPhone: "true" },
    { search: "x".repeat(201) },
    { includeUnknownEmployees: null },
  ])("drops a damaged entry without broadening its filters %j", (change) => {
    const item = saved()[0];
    const damaged = {
      ...item,
      id: id(2),
      filters: { ...item.filters, ...change },
    };
    expect(parseSavedSearches(encode([damaged, item]), scope)).toEqual([item]);
  });
  test("strips unsupported fields and never stores force-refresh, cursors or tokens", () => {
    const dirty = {
      ...filters,
      refreshDetails: true,
      resumeToken: "synthetic-cursor",
      token: "synthetic-token",
    };
    const result = addSavedSearch([], "保存", dirty, id(1));
    expect(result[0].filters).toEqual(filters);
    expect(
      parseSavedSearches(
        encode([{ ...result[0], secret: "synthetic-extra" }]),
        scope,
      ),
    ).toEqual(result);
  });
  test("snapshot does not change when the form is edited later", () => {
    const draft = { ...filters };
    const snapshot = addSavedSearch([], "元の条件", draft, id(1));
    draft.prefecture = "27";
    expect(snapshot[0].filters.prefecture).toBe("13");
  });
  test("duplicate names, including width/case variants, do not overwrite", () => {
    const original = addSavedSearch([], "ＡＢＣ", filters, id(1));
    expect(() =>
      addSavedSearch(
        original,
        " abc ",
        { ...filters, prefecture: "27" },
        id(2),
      ),
    ).toThrow("同じ名前");
    expect(original[0].filters.prefecture).toBe("13");
    expect(
      parseSavedSearches(
        encode([original[0], { ...original[0], id: id(2), name: "abc" }]),
        scope,
      ),
    ).toEqual(original);
  });
  test("caps saved conditions and rejects invalid or unfiltered drafts", () => {
    const full = Array.from({ length: SAVED_SEARCH_LIMIT }, (_, i) => ({
      ...saved()[0],
      id: id(i + 1),
      name: `条件${i}`,
    }));
    expect(() => addSavedSearch(full, "追加", filters, id(11))).toThrow("10件");
    expect(() => addSavedSearch([], "", filters, id(1))).toThrow("1〜40文字");
    expect(() => addSavedSearch([], "x".repeat(41), filters, id(1))).toThrow(
      "1〜40文字",
    );
    expect(() =>
      addSavedSearch([], "全て", defaultDiscoveryFilters, id(1)),
    ).toThrow("有効な検索条件");
    expect(() =>
      addSavedSearch([], "不正", { ...filters, employeeMax: "-1" }, id(1)),
    ).toThrow("有効な検索条件");
  });
});

describe("visible individual filters", () => {
  test("clearing one condition keeps region and unrelated conditions", () => {
    const phone = discoveryFilterChips(filters).find(
      (chip) => chip.id === "hasPhone",
    )!;
    expect({ ...filters, ...phone.clear }).toEqual({
      ...filters,
      hasPhone: false,
    });
    const people = discoveryFilterChips(filters).find(
      (chip) => chip.id === "employees",
    )!;
    expect(people.label).toContain("0〜50人");
    expect({ ...filters, ...people.clear }).toMatchObject({
      prefecture: "13",
      industry: "D",
      hasPhone: true,
      employeeMin: "",
      employeeMax: "",
    });
  });
  test("unknown flags are shown only when relevant and presence takes precedence", () => {
    expect(discoveryFilterChips(defaultDiscoveryFilters)).toEqual([]);
    expect(
      discoveryFilterChips({ ...filters, hasEmployees: true }).find(
        (chip) => chip.id === "employees",
      )?.label,
    ).not.toContain("未確認も含む");
    const industry = discoveryFilterChips({
      ...filters,
      includeUnknownIndustry: true,
    }).find((chip) => chip.id === "industry")!;
    expect(industry.label).toContain("建設業（未確認も含む）");
    expect(industry.clear).toEqual({
      industry: "",
      includeUnknownIndustry: false,
    });
  });
});
