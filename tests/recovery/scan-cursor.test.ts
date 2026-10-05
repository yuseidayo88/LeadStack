import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CompanyCandidateRow } from "@/lib/database.types";
import type { ScanCriteria } from "@/lib/discovery/contracts";
import type { GbizCompany } from "@/lib/gbiz/client";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/discovery/service", () => ({ reserveRequest: vi.fn() }));

import {
  openScanCursor,
  signScanCursor,
  type ScanCursor,
} from "@/lib/discovery/scan-cursor";
import { candidateMatchesScan } from "@/lib/discovery/scan";
import { candidateFromGbiz } from "@/lib/discovery/mapping";
import { discoveryInput, scanCriteria } from "@/lib/discovery/schemas";
import { AppError } from "@/lib/errors";

const org = "11111111-1111-4111-8111-111111111111";
const otherOrg = "22222222-2222-4222-8222-222222222222";
const now = Date.parse("2026-10-06T01:00:00.000Z");
const timestamp = new Date(now).toISOString();
const corporateNumber = "4000012090001";
const ids = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
  );
const numbers = (count: number) =>
  Array.from({ length: count }, (_, index) => String(4000012000000 + index));
const criteria = (overrides: ScanCriteria = {}) =>
  scanCriteria.parse({ prefecture: "13", ...overrides });

function row(
  overrides: Partial<CompanyCandidateRow> = {},
): CompanyCandidateRow {
  return {
    id: ids(1)[0],
    organization_id: org,
    corporate_number: corporateNumber,
    name: "東京設備 ACME",
    prefecture_code: "13",
    prefecture: "東京都",
    location: "東京都千代田区",
    industry_codes: ["D"],
    industry_labels: ["建設業"],
    phone: "03-0000-0000",
    website_url: "https://company.example/",
    employee_number: 20,
    source_updated_at: null,
    fetched_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    provenance: { businessSummary: "空調設備の保守・定期点検" },
    company_id: null,
    enrichment_status: null,
    enrichment_error: null,
    enrichment_checked_at: null,
    enrichment_result: null,
    ...overrides,
  };
}

function provider(overrides: Partial<GbizCompany> = {}): GbizCompany {
  return {
    corporateNumber,
    name: "東京設備 ACME",
    location: null,
    postalCode: null,
    status: null,
    updatedAt: null,
    industry: null,
    companyUrl: null,
    employeeNumber: null,
    businessSummary: null,
    provenance: {
      source: "gBizINFO",
      retrievedAt: timestamp,
      requestUrl: "https://api.info.gbiz.go.jp/hojin/v2/hojin",
      metadata: null,
    },
    ...overrides,
  };
}

function expectError(
  action: () => unknown,
  status = 409,
  code = "scan_scope_changed",
) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught).toMatchObject({ status, code });
}

beforeEach(() => {
  vi.stubEnv("GBIZ_API_TOKEN", "scan-test-only-not-a-real-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("scan cursor authentication and continuation", () => {
  test("starts at page one with a two-hour lifetime and a 20-match target", () => {
    const cursor = openScanCursor(org, criteria(), undefined, now);
    expect(cursor).toMatchObject({
      organization: org,
      page: 1,
      offset: 0,
      numbers: [],
      scanned: 0,
      saved: 0,
      matchedIds: [],
      target: 20,
      completedTarget: false,
      expires: now + 2 * 60 * 60 * 1000,
    });
    expect(signScanCursor(cursor)).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(
      openScanCursor(org, criteria(), signScanCursor(cursor), now),
    ).toEqual(cursor);
  });

  test("preserves the pending page tail, counts, and prior matches across a pause", () => {
    const cursor: ScanCursor = {
      ...openScanCursor(org, criteria(), undefined, now),
      page: 4,
      offset: 7,
      numbers: numbers(20),
      lastPage: false,
      scanned: 67,
      saved: 53,
      detailsFailed: 4,
      unknownEmployees: 11,
      unknownIndustry: 8,
      matchedIds: ids(13),
      seen: numbers(67),
    };
    const restored = openScanCursor(
      org,
      criteria(),
      signScanCursor(cursor),
      now + 60_000,
    );
    expect(restored).toEqual(cursor);
    expect(restored.numbers.slice(restored.offset)).toEqual(
      numbers(20).slice(7),
    );
  });

  test("requires configuration before creating a new cursor", () => {
    vi.stubEnv("GBIZ_API_TOKEN", "   ");
    expectError(
      () => openScanCursor(org, criteria(), undefined, now),
      503,
      "gbiz_not_configured",
    );
  });

  test("rejects another organization and another signing secret", () => {
    const token = signScanCursor(
      openScanCursor(org, criteria(), undefined, now),
    );
    expectError(() => openScanCursor(otherOrg, criteria(), token, now));
    vi.stubEnv("GBIZ_API_TOKEN", "a-different-test-secret");
    expectError(() => openScanCursor(org, criteria(), token, now));
  });

  const fullySpecified = {
    prefecture: "13",
    name: "東京設備",
    corporateNumber,
    industry: "D",
    employeeMin: 10,
    employeeMax: 50,
    includeUnknownEmployees: true,
    includeUnknownIndustry: false,
    businessKeywords: "設備 保守",
    hasPhone: false,
    hasWebsite: true,
    hasEmployees: false,
  } satisfies ScanCriteria;

  test.each<[keyof ScanCriteria, ScanCriteria[keyof ScanCriteria]]>([
    ["prefecture", "14"],
    ["name", "別の設備"],
    ["corporateNumber", "1180301018771"],
    ["industry", "E"],
    ["employeeMin", 11],
    ["employeeMax", 49],
    ["includeUnknownEmployees", false],
    ["includeUnknownIndustry", true],
    ["businessKeywords", "設備 点検"],
    ["hasPhone", true],
    ["hasWebsite", false],
    ["hasEmployees", true],
  ])("binds signed continuation to criterion %s", (field, value) => {
    const original = criteria(fullySpecified);
    const token = signScanCursor(openScanCursor(org, original, undefined, now));
    const changed = criteria({ ...fullySpecified, [field]: value });
    expectError(() => openScanCursor(org, changed, token, now));
  });

  test("canonical equivalent criteria keep the same scope", () => {
    const original = scanCriteria.parse({
      prefecture: "13",
      employeeMin: "10",
      businessKeywords: " 設備、保守　設備 ",
    });
    const equivalent = scanCriteria.parse({
      businessKeywords: "設備 保守",
      employeeMin: 10,
      prefecture: "13",
      includeUnknownEmployees: true,
    });
    const token = signScanCursor(openScanCursor(org, original, undefined, now));
    expect(openScanCursor(org, equivalent, token, now).page).toBe(1);
  });

  test("rejects payload tampering and forged target completion", () => {
    const cursor = {
      ...openScanCursor(org, criteria(), undefined, now),
      scanned: 20,
      matchedIds: ids(20),
    };
    const token = signScanCursor(cursor);
    const signature = token.split(".")[1];
    for (const changed of [
      { ...cursor, organization: otherOrg },
      { ...cursor, completedTarget: true },
      { ...cursor, target: 200 },
    ]) {
      const forged = `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
      expectError(() => openScanCursor(org, criteria(), forged, now));
    }
  });

  test("rejects signature tampering", () => {
    const token = signScanCursor(
      openScanCursor(org, criteria(), undefined, now),
    );
    const [payload, signature] = token.split(".");
    const altered = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expectError(() =>
      openScanCursor(org, criteria(), `${payload}.${altered}`, now),
    );
  });

  test("accepts immediately before expiry and rejects at or after expiry", () => {
    const cursor = openScanCursor(org, criteria(), undefined, now);
    const token = signScanCursor(cursor);
    expect(
      openScanCursor(org, criteria(), token, cursor.expires - 1).expires,
    ).toBe(cursor.expires);
    for (const expiredAt of [cursor.expires, cursor.expires + 1])
      expectError(
        () => openScanCursor(org, criteria(), token, expiredAt),
        410,
        "scan_expired",
      );
  });

  test("advances 20 to 40 only after signed completion and preserves progress", () => {
    const paused = {
      ...openScanCursor(org, criteria(), undefined, now),
      scanned: 29,
      saved: 29,
      matchedIds: ids(20),
      numbers: numbers(20),
      page: 2,
      offset: 9,
    };
    expect(
      openScanCursor(org, criteria(), signScanCursor(paused), now).target,
    ).toBe(20);
    const continued = openScanCursor(
      org,
      criteria(),
      signScanCursor({ ...paused, completedTarget: true }),
      now,
    );
    expect(continued).toEqual({
      ...paused,
      target: 40,
      completedTarget: false,
    });
    expect(
      openScanCursor(org, criteria(), signScanCursor(continued), now).target,
    ).toBe(40);
    expectError(() =>
      openScanCursor(
        org,
        criteria(),
        signScanCursor({
          ...paused,
          matchedIds: ids(19),
          completedTarget: true,
        }),
        now,
      ),
    );
  });

  test("caps completed targets at 200 and permits the maximum valid state", () => {
    const maximum: ScanCursor = {
      ...openScanCursor(org, criteria(), undefined, now),
      page: 11,
      numbers: numbers(20),
      offset: 20,
      scanned: 200,
      saved: 200,
      detailsFailed: 1000,
      unknownEmployees: 200,
      unknownIndustry: 200,
      matchedIds: ids(200),
      seen: numbers(200),
      target: 200,
      completedTarget: true,
    };
    const token = signScanCursor(maximum);
    expect(token.length).toBeLessThanOrEqual(32_768);
    expect(openScanCursor(org, criteria(), token, now)).toEqual({
      ...maximum,
      completedTarget: false,
    });
  });

  test.each([
    ".",
    "a",
    "a.b.c",
    "a.",
    ".b",
    "a+.b",
    "a.b=",
    "a. b",
    "a.b\n",
    "雪.b",
    `${"a".repeat(32_767)}.b`,
  ])("rejects malformed or oversized token %s", (token) => {
    expectError(() => openScanCursor(org, criteria(), token, now));
  });

  test.each<Record<string, unknown>>([
    { version: 2 },
    { organization: "not-a-uuid" },
    { scope: "not-a-digest" },
    { expires: 0 },
    { expires: "later" },
    { page: 0 },
    { page: 12 },
    { page: 1.5 },
    { offset: -1 },
    { offset: 21 },
    { offset: 1, numbers: [] },
    { numbers: numbers(21) },
    { numbers: ["123"] },
    { lastPage: "true" },
    { scanned: -1 },
    { scanned: 201 },
    { saved: 1, scanned: 0 },
    { saved: 201, scanned: 200 },
    { detailsFailed: 1001 },
    { unknownEmployees: 201 },
    { unknownIndustry: 201 },
    { matchedIds: ids(1), scanned: 0 },
    { matchedIds: [ids(1)[0], ids(1)[0]], scanned: 2 },
    { matchedIds: ["not-a-uuid"], scanned: 1 },
    { matchedIds: ids(201), scanned: 200 },
    { seen: numbers(201) },
    { seen: ["not-a-corporate-number"] },
    { target: 19 },
    { target: 21 },
    { target: 201 },
    { completedTarget: "true" },
    { unexpected: true },
  ])("rejects signed invalid cursor state %j", (overrides) => {
    const cursor = {
      ...openScanCursor(org, criteria(), undefined, now),
      ...overrides,
    } as ScanCursor;
    expectError(() =>
      openScanCursor(org, criteria(), signScanCursor(cursor), now),
    );
  });

  test.each([null, [], "cursor", {}, { version: 1 }])(
    "rejects signed non-cursor JSON %j",
    (payload) => {
      const token = signScanCursor(payload as unknown as ScanCursor);
      expectError(() => openScanCursor(org, criteria(), token, now));
    },
  );
});

describe("condition-based scan input", () => {
  test.each([
    { prefecture: "13" },
    { industry: "D" },
    { employeeMin: 10 },
    { employeeMax: 0 },
    { businessKeywords: "設備 保守" },
    { name: "東京設備" },
    { corporateNumber },
  ])("accepts a search scope without requiring a company name: %j", (input) => {
    const parsed = discoveryInput.parse({ action: "scan", criteria: input });
    expect(parsed.action).toBe("scan");
    if (parsed.action !== "scan") throw new Error("Unexpected action");
    expect(parsed.criteria).toMatchObject({
      includeUnknownEmployees: true,
      includeUnknownIndustry: false,
      hasPhone: false,
      hasWebsite: false,
      hasEmployees: false,
    });
  });

  test.each([
    {},
    { hasWebsite: true },
    { includeUnknownEmployees: true },
    { businessKeywords: " ,、　 " },
  ])("rejects absent scope %j", (input) => {
    expect(scanCriteria.safeParse(input).success).toBe(false);
  });

  test("normalizes optional blanks, numeric strings, and keyword separators", () => {
    expect(
      scanCriteria.parse({
        prefecture: "13",
        name: "",
        corporateNumber: null,
        industry: "",
        employeeMin: " 0 ",
        employeeMax: " 50 ",
        businessKeywords: "設備,保守、設備　点検，AI\n連携",
      }),
    ).toMatchObject({
      name: undefined,
      corporateNumber: undefined,
      industry: undefined,
      employeeMin: 0,
      employeeMax: 50,
      businessKeywords: "設備 保守 点検 AI 連携",
    });
  });

  test.each([0, 10, 50, 2147483647])(
    "allows inclusive employee bound %s",
    (value) => {
      expect(
        scanCriteria.parse({ employeeMin: value, employeeMax: value }),
      ).toMatchObject({
        employeeMin: value,
        employeeMax: value,
      });
    },
  );

  test.each([
    -1,
    0.5,
    2147483648,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "1e2",
    "0x10",
    "-1",
    "10,employee_number.is.null",
    null,
    true,
  ])("rejects malformed employee bound %j", (value) => {
    for (const field of ["employeeMin", "employeeMax"])
      expect(
        scanCriteria.safeParse({ prefecture: "13", [field]: value }).success,
      ).toBe(false);
  });

  test.each([
    { employeeMin: 51, employeeMax: 10 },
    { prefecture: "48" },
    { industry: "U" },
    { corporateNumber: "123" },
    { businessKeywords: "1 2 3 4 5 6 7 8 9" },
    { businessKeywords: "x".repeat(41) },
    { businessKeywords: "x ".repeat(101) },
    { includeUnknownEmployees: "true" },
    { hasWebsite: "true" },
    { unexpected: true },
  ])("rejects inconsistent or excessive criteria %j", (input) => {
    expect(scanCriteria.safeParse({ prefecture: "13", ...input }).success).toBe(
      false,
    );
  });

  test("accepts a bounded resume token and rejects extra client-controlled scan state", () => {
    expect(
      discoveryInput.safeParse({
        action: "scan",
        criteria: { industry: "D" },
        resumeToken: "a".repeat(32_768),
      }).success,
    ).toBe(true);
    for (const input of [
      { resumeToken: "" },
      { resumeToken: "a".repeat(32_769) },
      { target: 200 },
      { page: 10 },
      { matchedIds: ids(20) },
    ])
      expect(
        discoveryInput.safeParse({
          action: "scan",
          criteria: { industry: "D" },
          ...input,
        }).success,
      ).toBe(false);
  });
});

describe("scan matches saved candidate values", () => {
  test.each([
    [null, true, true],
    [null, false, false],
    [0, true, false],
    [0, false, false],
    [9, true, false],
    [10, false, true],
    [50, false, true],
    [51, true, false],
  ] as const)(
    "employee count %s with unknown=%s matches=%s",
    (employee, includeUnknownEmployees, expected) => {
      expect(
        candidateMatchesScan(
          row({ employee_number: employee }),
          criteria({
            employeeMin: 10,
            employeeMax: 50,
            includeUnknownEmployees,
          }),
        ),
      ).toBe(expected);
    },
  );

  test("distinguishes known zero from null and combines presence with unknown inclusion", () => {
    const filter = criteria({
      employeeMin: 0,
      employeeMax: 0,
      hasEmployees: true,
    });
    expect(candidateMatchesScan(row({ employee_number: 0 }), filter)).toBe(
      true,
    );
    expect(candidateMatchesScan(row({ employee_number: null }), filter)).toBe(
      false,
    );
    expect(
      candidateMatchesScan(row({ employee_number: null }), criteria()),
    ).toBe(true);
  });

  test("supports each one-sided inclusive employee bound", () => {
    expect(
      candidateMatchesScan(
        row({ employee_number: 50 }),
        criteria({ employeeMin: 50 }),
      ),
    ).toBe(true);
    expect(
      candidateMatchesScan(
        row({ employee_number: 49 }),
        criteria({ employeeMin: 50 }),
      ),
    ).toBe(false);
    expect(
      candidateMatchesScan(
        row({ employee_number: 50 }),
        criteria({ employeeMax: 50 }),
      ),
    ).toBe(true);
    expect(
      candidateMatchesScan(
        row({ employee_number: 51 }),
        criteria({ employeeMax: 50 }),
      ),
    ).toBe(false);
  });

  test.each([
    [[], "D", false, false],
    [[], "D", true, true],
    [["E"], "D", true, false],
    [["D", "E"], "D", false, true],
    [[], "unknown", false, true],
    [["D"], "unknown", true, false],
  ] as const)(
    "industry %j against %s, unknown=%s matches=%s",
    (industry_codes, industry, includeUnknownIndustry, expected) => {
      expect(
        candidateMatchesScan(
          row({ industry_codes: [...industry_codes] }),
          criteria({ industry, includeUnknownIndustry }),
        ),
      ).toBe(expected);
    },
  );

  test("uses ANY keyword across the company name and business summary, case-insensitively", () => {
    expect(
      candidateMatchesScan(row(), criteria({ businessKeywords: "物流 点検" })),
    ).toBe(true);
    expect(
      candidateMatchesScan(row(), criteria({ businessKeywords: "物流 acme" })),
    ).toBe(true);
    expect(
      candidateMatchesScan(row(), criteria({ businessKeywords: "物流 小売" })),
    ).toBe(false);
    expect(
      candidateMatchesScan(
        row({ provenance: { businessSummary: 123 } }),
        criteria({ businessKeywords: "123" }),
      ),
    ).toBe(false);
    expect(
      candidateMatchesScan(
        row({ provenance: null }),
        criteria({ businessKeywords: "点検" }),
      ),
    ).toBe(false);
  });

  test.each(["%", "_", "*", '"', "\\", "(株)", ".*", "[設備]"])(
    "treats keyword %s literally",
    (term) => {
      const filter = criteria({ businessKeywords: term });
      expect(candidateMatchesScan(row(), filter)).toBe(false);
      expect(
        candidateMatchesScan(
          row({ provenance: { businessSummary: `対応 ${term} 管理` } }),
          filter,
        ),
      ).toBe(true);
    },
  );

  test("ANDs region, name, number, industry, employee bounds, keywords and field presence", () => {
    const filter = criteria({
      name: "acme",
      corporateNumber,
      industry: "D",
      employeeMin: 10,
      employeeMax: 50,
      businessKeywords: "設備 保守",
      hasPhone: true,
      hasWebsite: true,
      hasEmployees: true,
    });
    expect(candidateMatchesScan(row(), filter)).toBe(true);
    for (const changed of [
      { prefecture_code: "14" },
      { corporate_number: "1180301018771" },
      { name: "別会社" },
      { industry_codes: ["E"] },
      { employee_number: 51 },
      { phone: null },
      { website_url: null },
      { employee_number: null },
      { name: "ACME", provenance: { businessSummary: "物流" } },
    ])
      expect(candidateMatchesScan(row(changed), filter)).toBe(false);
  });

  test("uses retained cache attributes when Gbiz omits them", () => {
    const previous = row();
    const saved = { ...previous, ...candidateFromGbiz(provider(), previous) };
    const filter = criteria({
      industry: "D",
      employeeMin: 10,
      employeeMax: 50,
      includeUnknownEmployees: false,
      hasPhone: true,
      hasWebsite: true,
      businessKeywords: "点検",
    });
    expect(saved.employee_number).toBe(20);
    expect(saved.industry_codes).toEqual(["D"]);
    expect(candidateMatchesScan(saved, filter)).toBe(true);
  });

  test("uses retained manual values instead of conflicting fresh provider attributes", () => {
    const previous = row({
      employee_number: 20,
      provenance: {
        manualOverrides: ["employee_number", "website_url"],
        businessSummary: "定期点検",
      },
    });
    const saved = {
      ...previous,
      ...candidateFromGbiz(
        provider({ employeeNumber: 300, companyUrl: "https://other.example/" }),
        previous,
      ),
    };
    expect(saved.employee_number).toBe(20);
    expect(saved.website_url).toBe(previous.website_url);
    expect(
      candidateMatchesScan(
        saved,
        criteria({ employeeMin: 10, employeeMax: 50, hasWebsite: true }),
      ),
    ).toBe(true);
  });
});
