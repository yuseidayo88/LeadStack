import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { CompanyCandidateRow, Database } from "@/lib/database.types";
import type { GbizCompany } from "@/lib/gbiz/client";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ requireOrganization: vi.fn() }));

import { requireOrganization } from "@/lib/auth";
import { getGbizCompany } from "@/lib/gbiz/client";
import {
  boundedCandidateProvenance,
  CandidateProvenanceTooLargeError,
  candidateProvenanceBytes,
  candidateFromGbiz,
  discoveryBusinessSearch,
} from "@/lib/discovery/mapping";
import { discoveryQuery } from "@/lib/discovery/schemas";
import {
  acquireCandidates,
  listCandidates,
  updateCandidate,
} from "@/lib/discovery/service";
import { GET } from "@/app/api/organizations/[org]/company-discovery/route";

const org = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const corporateNumber = "4000012090001";
const timestamp = "2026-10-05T01:00:00.000Z";

function row(
  overrides: Partial<CompanyCandidateRow> = {},
): CompanyCandidateRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: org,
    corporate_number: corporateNumber,
    name: "東京設備",
    prefecture_code: "13",
    prefecture: "東京都",
    location: "東京都千代田区",
    industry_codes: ["D"],
    industry_labels: ["建設業"],
    phone: null,
    website_url: null,
    employee_number: 10,
    source_updated_at: null,
    fetched_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    provenance: {},
    company_id: null,
    enrichment_status: null,
    enrichment_error: null,
    enrichment_checked_at: null,
    enrichment_result: null,
    ...overrides,
  };
}

function company(overrides: Partial<GbizCompany> = {}): GbizCompany {
  return {
    corporateNumber,
    name: "東京設備",
    location: "東京都千代田区",
    postalCode: null,
    status: null,
    updatedAt: null,
    industry: null,
    companyUrl: null,
    employeeNumber: null,
    provenance: {
      source: "gBizINFO",
      retrievedAt: timestamp,
      requestUrl: "https://api.info.gbiz.go.jp/hojin/v2/hojin",
      metadata: null,
    },
    ...overrides,
  };
}

// Use the actual Supabase/PostgREST builder so duplicate OR parameters, JSON
// paths, URL escaping, and pre-pagination predicates exercise the shipped SDK.
function database(resolver?: (url: URL, init?: RequestInit) => Response) {
  const requests: URL[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    return (
      resolver?.(url, init) ??
      new Response(init?.method === "HEAD" ? null : "[]", {
        headers: { "content-type": "application/json", "content-range": "*/0" },
      })
    );
  });
  const db = createClient<Database>(
    "https://database.example",
    "public-test-key",
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetcher },
    },
  );
  return { db, requests, fetcher };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GBIZ_API_TOKEN", "test-only-not-a-real-token");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("targeting input", () => {
  test.each([0, 9, 10, 50, 51, 2147483647])(
    "accepts employee integer %s",
    (value) => {
      expect(
        discoveryQuery.parse({
          employeeMin: String(value),
          employeeMax: String(value),
        }),
      ).toMatchObject({ employeeMin: value, employeeMax: value });
    },
  );

  test.each([
    "-1",
    "1.5",
    "2147483648",
    "NaN",
    "Infinity",
    "1e2",
    "0x10",
    "10,employee_number.is.null",
    null,
  ])("rejects invalid employee bound %j", (value) => {
    for (const field of ["employeeMin", "employeeMax"])
      expect(discoveryQuery.safeParse({ [field]: value }).success).toBe(false);
  });

  test("empty bounds stay absent instead of becoming zero", () => {
    expect(
      discoveryQuery.parse({ employeeMin: "", employeeMax: "　 " }),
    ).toMatchObject({
      employeeMin: undefined,
      employeeMax: undefined,
      includeUnknownEmployees: "false",
      includeUnknownIndustry: "false",
      businessKeywords: [],
    });
    expect(
      discoveryQuery.safeParse({ employeeMin: "51", employeeMax: "10" })
        .success,
    ).toBe(false);
  });

  test("keywords split common Japanese separators and deduplicate without inventing business traits", () => {
    expect(
      discoveryQuery.parse({
        businessKeywords: " 設備,点検、保守　設備，空調\n修理 ",
      }).businessKeywords,
    ).toEqual(["設備", "点検", "保守", "空調", "修理"]);
    expect(
      discoveryQuery.parse({ businessKeywords: " ,、，　 " }).businessKeywords,
    ).toEqual([]);
  });

  test.each([
    { businessKeywords: "x".repeat(41) },
    { businessKeywords: "1 2 3 4 5 6 7 8 9" },
    { businessKeywords: "x ".repeat(101) },
    { includeUnknownEmployees: "yes" },
    { includeUnknownIndustry: "1" },
  ])("rejects excessive or malformed filters %j", (input) => {
    expect(discoveryQuery.safeParse(input).success).toBe(false);
  });

  test("HTTP validation rejects inverted ranges before issuing a database request", async () => {
    const { db, fetcher } = database();
    vi.mocked(requireOrganization).mockResolvedValue({
      db,
      org,
      role: "owner",
      user: { id: userId } as Awaited<
        ReturnType<typeof requireOrganization>
      >["user"],
    });
    const response = await GET(
      new Request(
        `https://leadstack.example/api/organizations/${org}/company-discovery?employeeMin=51&employeeMax=10`,
      ),
      { params: Promise.resolve({ org }) },
    );
    expect(response.status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("targeting PostgREST requests", () => {
  test("uses inclusive numeric bounds and keeps zero distinct from unknown", async () => {
    const { db, requests } = database();
    await listCandidates(
      db,
      org,
      discoveryQuery.parse({ employeeMin: "0", employeeMax: "50" }),
    );
    const filters = requests[0].searchParams;
    expect(filters.getAll("employee_number")).toEqual(["gte.0", "lte.50"]);
    expect(filters.getAll("or")).toEqual([]);
    expect(filters.get("organization_id")).toBe(`eq.${org}`);
  });

  test.each([
    [
      { employeeMin: "10", employeeMax: "50" },
      "(employee_number.is.null,and(employee_number.gte.10,employee_number.lte.50))",
    ],
    [
      { employeeMin: "10" },
      "(employee_number.is.null,and(employee_number.gte.10))",
    ],
    [
      { employeeMax: "50" },
      "(employee_number.is.null,and(employee_number.lte.50))",
    ],
  ])(
    "unknown counts join the entire numeric interval %j",
    async (bounds, expected) => {
      const { db, requests } = database();
      await listCandidates(
        db,
        org,
        discoveryQuery.parse({ ...bounds, includeUnknownEmployees: "true" }),
      );
      expect(requests[0].searchParams.getAll("or")).toEqual([expected]);
    },
  );

  test("unknown switches alone do not narrow or expand an unfiltered list", async () => {
    const { db, requests } = database();
    await listCandidates(
      db,
      org,
      discoveryQuery.parse({
        includeUnknownEmployees: "true",
        includeUnknownIndustry: "true",
      }),
    );
    expect(requests[0].searchParams.has("or")).toBe(false);
    expect(requests[0].searchParams.has("industry_codes")).toBe(false);
    expect(requests[0].searchParams.has("employee_number")).toBe(false);
  });

  test("independent OR groups stay ANDed with name, prefecture, presence and pagination", async () => {
    const { db, requests } = database();
    await listCandidates(
      db,
      org,
      discoveryQuery.parse({
        search: "東京",
        prefecture: "13",
        industry: "D",
        includeUnknownIndustry: "true",
        employeeMin: "10",
        employeeMax: "50",
        includeUnknownEmployees: "true",
        businessKeywords: "設備 点検",
        hasPhone: "true",
        hasWebsite: "true",
        hasEmployees: "true",
        pageSize: "7",
      }),
    );
    const query = requests[0].searchParams;
    expect(query.getAll("or")).toEqual([
      '(name.ilike."%東京%",corporate_number.ilike."%東京%")',
      '(name.ilike."%設備%",provenance->>businessSummary.ilike."%設備%",name.ilike."%点検%",provenance->>businessSummary.ilike."%点検%")',
      "(industry_codes.cs.{D},industry_codes.cd.{})",
      "(employee_number.is.null,and(employee_number.gte.10,employee_number.lte.50))",
    ]);
    expect(query.get("prefecture_code")).toBe("eq.13");
    expect(query.get("organization_id")).toBe(`eq.${org}`);
    expect(query.get("employee_number")).toBe("not.is.null");
    expect(query.getAll("phone")).toEqual(["not.is.null", "neq."]);
    expect(query.getAll("website_url")).toEqual(["not.is.null", "neq."]);
    expect(query.get("limit")).toBe("7");
    expect(query.get("offset")).toBe("0");
  });

  test("selecting only unknown industry stays unknown-only", async () => {
    const { db, requests } = database();
    await listCandidates(
      db,
      org,
      discoveryQuery.parse({
        industry: "unknown",
        includeUnknownIndustry: "true",
      }),
    );
    expect(requests[0].searchParams.get("industry_codes")).toBe("cd.{}");
    expect(requests[0].searchParams.has("or")).toBe(false);
  });

  test("quoted filters preserve injection-shaped punctuation and literal percent/underscore/backslash", async () => {
    const term = 'A)"%_\\.or(id.not.is.null';
    const expected =
      'name.ilike."%A)\\"\\\\%\\\\_\\\\\\\\.or(id.not.is.null%",provenance->>businessSummary.ilike."%A)\\"\\\\%\\\\_\\\\\\\\.or(id.not.is.null%"';
    expect(discoveryBusinessSearch([term])).toBe(expected);
    const { db, requests } = database();
    await listCandidates(
      db,
      org,
      discoveryQuery.parse({ businessKeywords: term }),
    );
    expect(requests[0].searchParams.getAll("or")).toEqual([`(${expected})`]);
    expect([...requests[0].searchParams.keys()]).not.toContain("id");
  });

  test("literal asterisks use a fully escaped regex, including adversarial regex syntax", async () => {
    const term = "A*.[x]+?(a|b)^${2}\\";
    const escaped =
      "A\\\\*\\\\.\\\\[x\\\\]\\\\+\\\\?\\\\(a\\\\|b\\\\)\\\\^\\\\$\\\\{2\\\\}\\\\\\\\";
    const expected = `name.imatch."${escaped}",provenance->>businessSummary.imatch."${escaped}"`;
    expect(discoveryBusinessSearch([term])).toBe(expected);
    const { db, requests } = database();
    await listCandidates(
      db,
      org,
      discoveryQuery.parse({ businessKeywords: term, search: "*" }),
    );
    expect(requests[0].searchParams.getAll("or")).toEqual([
      '(name.imatch."\\\\*",corporate_number.imatch."\\\\*")',
      `(${expected})`,
    ]);
  });

  test("out-of-range recovery counts and fetches with identical targeting predicates", async () => {
    let rangeRequests = 0;
    const { db, requests } = database((url, init) => {
      const query = url.searchParams;
      if (url.pathname.endsWith("/companies")) return Response.json([]);
      if (query.get("select") === "fetched_at")
        return Response.json([{ fetched_at: timestamp }]);
      if (query.get("select") === "id")
        return new Response(null, { headers: { "content-range": "*/55" } });
      if (init?.method === "HEAD")
        return new Response(null, { headers: { "content-range": "*/3" } });
      rangeRequests++;
      if (rangeRequests === 1)
        return Response.json(
          { code: "PGRST103", message: "range" },
          { status: 416 },
        );
      return Response.json([row()], { headers: { "content-range": "2-2/3" } });
    });
    const result = await listCandidates(
      db,
      org,
      discoveryQuery.parse({
        employeeMin: "10",
        employeeMax: "50",
        businessKeywords: "設備",
        page: "999",
        pageSize: "2",
      }),
    );
    expect(result).toMatchObject({
      count: 3,
      page: 2,
      pageSize: 2,
      totalCached: 55,
    });
    const filtered = requests.filter(
      (url) => url.searchParams.get("select") === "*",
    );
    expect(filtered).toHaveLength(3);
    for (const url of filtered) {
      expect(url.searchParams.getAll("employee_number")).toEqual([
        "gte.10",
        "lte.50",
      ]);
      expect(url.searchParams.get("or")).toBe(
        '(name.ilike."%設備%",provenance->>businessSummary.ilike."%設備%")',
      );
    }
    expect(filtered[2].searchParams.get("offset")).toBe("2");
  });

  test.each([null, [], { businessSummary: 123 }, { businessSummary: " " }])(
    "malformed provenance %j never becomes displayed business facts",
    async (provenance) => {
      const { db } = database((url) =>
        url.pathname.endsWith("/companies")
          ? Response.json([])
          : Response.json([row({ provenance })], {
              headers: { "content-range": "0-0/1" },
            }),
      );
      const result = await listCandidates(db, org, discoveryQuery.parse({}));
      expect(result.data[0].business_summary).toBeNull();
    },
  );
});

describe("Gbiz business summary and provenance", () => {
  test("byte accounting includes JSONB spacing, escaped text and expanded numeric exponents", () => {
    expect(
      candidateProvenanceBytes({ a: ["設備😀", '"\\\n', null], b: true }),
    ).toBe(
      Buffer.byteLength('{"a": ["設備😀", "\\\"\\\\\\n", null], "b": true}'),
    );
    expect(candidateProvenanceBytes([1e21, -1.2e-7, 1.23e22])).toBe(
      Buffer.byteLength(
        "[1000000000000000000000, -0.00000012, 12300000000000000000000]",
      ),
    );
  });

  test("six thousand Japanese/emoji characters fit the complete database byte budget without splitting a character", () => {
    const text = "設備保守😀".repeat(1200);
    const mapped = candidateFromGbiz(company({ businessSummary: text }));
    const provenance = mapped.provenance as {
      businessSummary: string;
      businessSummaryTruncated: boolean;
      fieldSources: unknown;
    };
    expect(candidateProvenanceBytes(mapped.provenance)).toBeLessThanOrEqual(
      16_000,
    );
    expect(provenance.businessSummaryTruncated).toBe(true);
    expect(Array.from(provenance.businessSummary).length).toBeLessThan(6000);
    expect(text.startsWith(provenance.businessSummary)).toBe(true);
    expect(provenance.businessSummary.isWellFormed()).toBe(true);
    expect(provenance.fieldSources).toHaveProperty("business_summary");
  });

  test("already truncated upstream summaries remain visibly truncated even when ASCII fits the byte budget", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({
            "hojin-infos": [
              {
                corporate_number: corporateNumber,
                business_summary: "x".repeat(10_001),
              },
            ],
          }),
        ),
    );
    const normalized = await getGbizCompany(corporateNumber);
    expect(normalized?.businessSummaryTruncated).toBe(true);
    expect(candidateFromGbiz(normalized!).provenance).toMatchObject({
      businessSummaryTruncated: true,
    });
  });

  test("manual edits can add their evidence after a summary filled the byte budget", async () => {
    const mapped = candidateFromGbiz(
      company({ businessSummary: "設備😀".repeat(3000) }),
    );
    const saved = row({
      provenance: mapped.provenance,
      enrichment_result: {
        evidence: "確認資料".repeat(100),
        sourceUrl: "https://example.com/about",
      },
    });
    let updated: Record<string, unknown> | undefined;
    const { db } = database((url, init) => {
      if (url.pathname.endsWith("/companies")) return Response.json([]);
      if (init?.method === "PATCH") {
        updated = JSON.parse(String(init.body));
        return Response.json({ ...saved, ...updated });
      }
      return Response.json(saved);
    });
    const result = await updateCandidate(db, org, userId, {
      action: "update",
      id: saved.id,
      expectedUpdatedAt: timestamp,
      phone: "03-0000-0000",
      website_url: null,
      employee_number: 25,
    });
    expect(
      candidateProvenanceBytes(
        updated!.provenance as CompanyCandidateRow["provenance"],
      ),
    ).toBeLessThanOrEqual(16_000);
    expect(result.candidate.business_summary_truncated).toBe(true);
    expect(updated!.provenance).toMatchObject({
      manualOverrides: ["phone", "employee_number"],
      manual: { updatedBy: userId, evidence: saved.enrichment_result },
    });
  });

  test("oversized redundant Gbiz metadata can be omitted while per-field sources remain paired with their values", () => {
    const value = company({ businessSummary: "設備保守" });
    value.provenance.metadata = {
      source: {
        postal_code: "冗長".repeat(9000),
        business_summary: "公開資料",
      },
      lastAcquisitionDate: {},
      lastUpdateDate: {},
      dataQuality: {},
      importFrequency: {},
    };
    const result = candidateFromGbiz(value);
    expect(result.provenance).toMatchObject({
      gbiz: { metadata: null },
      gbizMetadataOmitted: true,
      businessSummary: "設備保守",
      fieldSources: { business_summary: { source: "公開資料" } },
    });
    expect(candidateProvenanceBytes(result.provenance)).toBeLessThanOrEqual(
      16_000,
    );
  });

  test("near-limit existing evidence is preserved instead of silently deleting it for a new source", () => {
    const existing = row({
      provenance: {
        customEvidence: "x".repeat(15_800),
        businessSummary: "既知の事業概要",
      },
    });
    const snapshot = structuredClone(existing);
    expect(() =>
      candidateFromGbiz(company({ businessSummary: "新しい概要" }), existing),
    ).toThrow(CandidateProvenanceTooLargeError);
    expect(existing).toEqual(snapshot);
    expect(() =>
      boundedCandidateProvenance({ evidence: "x".repeat(16_000) }, null, false),
    ).toThrow(CandidateProvenanceTooLargeError);
  });

  test("a pathological oversized record does not abort the other records in an acquisition batch", async () => {
    const secondNumber = "4000012090002";
    const base = (number: string) => ({
      corporate_number: number,
      name: "設備会社",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({
            "hojin-infos": [base(corporateNumber), base(secondNumber)],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            "hojin-infos": [
              {
                ...base(corporateNumber),
                "meta-data": { source: { name: "過大な出典".repeat(4000) } },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ "hojin-infos": [base(secondNumber)] }),
        ),
    );
    const written: Record<string, unknown>[] = [];
    const { db } = database((url, init) => {
      if (url.pathname.includes("/rpc/")) return Response.json(true);
      if (init?.method === "POST") {
        written.push(JSON.parse(String(init.body)));
        return Response.json([{ id: row().id }]);
      }
      return Response.json([]);
    });
    const result = await acquireCandidates(db, org, {
      action: "acquire",
      prefecture: "13",
      page: 1,
    });
    expect(result).toMatchObject({ fetched: 1, detailsFailed: 1 });
    expect(written).toHaveLength(1);
    expect(written[0].corporate_number).toBe(secondNumber);
  });

  test("normalizes official summary and its metadata without guessing missing facts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          "hojin-infos": [
            {
              corporate_number: corporateNumber,
              business_summary: " 空調設備の保守・点検 ",
              "meta-data": {
                source: { business_summary: "公開資料" },
                last_update_date: { business_summary: "2026-09-01" },
              },
            },
          ],
        }),
      ),
    );
    const result = await getGbizCompany(corporateNumber);
    expect(result).toMatchObject({
      businessSummary: "空調設備の保守・点検",
      provenance: {
        metadata: {
          source: { business_summary: "公開資料" },
          lastUpdateDate: { business_summary: "2026-09-01" },
        },
      },
    });
    const mapped = candidateFromGbiz(result!);
    expect(mapped.provenance).toMatchObject({
      businessSummary: "空調設備の保守・点検",
      fieldSources: {
        business_summary: { source: "公開資料", sourceUpdatedAt: "2026-09-01" },
      },
    });
  });

  test.each([undefined, null, "", "　", 123, [], {}])(
    "invalid or missing summary %j preserves known source and summary",
    async (summary) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            "hojin-infos": [
              {
                corporate_number: corporateNumber,
                business_summary: summary,
              },
            ],
          }),
        ),
      );
      const result = await getGbizCompany(corporateNumber);
      expect(result?.businessSummary).toBeNull();
      const previous = row({
        provenance: {
          businessSummary: "既存の事業内容",
          fieldSources: {
            business_summary: { source: "既存資料", retrievedAt: timestamp },
          },
        },
      });
      expect(candidateFromGbiz(result!, previous).provenance).toMatchObject({
        businessSummary: "既存の事業内容",
        fieldSources: {
          business_summary: { source: "既存資料", retrievedAt: timestamp },
        },
      });
    },
  );

  test("legacy fixtures with no summary field retain known summary and bounded new text", () => {
    const previous = row({ provenance: { businessSummary: "既存の事業内容" } });
    expect(candidateFromGbiz(company(), previous).provenance).toMatchObject({
      businessSummary: "既存の事業内容",
    });
    const result = candidateFromGbiz(
      company({ businessSummary: "x".repeat(10_001) }),
    );
    expect(
      (result.provenance as { businessSummary: string }).businessSummary,
    ).toHaveLength(10_000);
  });

  test("upstream summary is bounded before it reaches storage or the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          "hojin-infos": [
            {
              corporate_number: corporateNumber,
              business_summary: "x".repeat(10_001),
            },
          ],
        }),
      ),
    );
    expect(
      (await getGbizCompany(corporateNumber))?.businessSummary,
    ).toHaveLength(10_000);
    const { db } = database((url) =>
      url.pathname.endsWith("/companies")
        ? Response.json([])
        : Response.json(
            [row({ provenance: { businessSummary: "x".repeat(10_001) } })],
            { headers: { "content-range": "0-0/1" } },
          ),
    );
    expect(
      (await listCandidates(db, org, discoveryQuery.parse({}))).data[0]
        .business_summary,
    ).toHaveLength(10_000);
  });
});
