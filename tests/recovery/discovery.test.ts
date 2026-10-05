import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CompanyCandidateRow } from "@/lib/database.types";
import type { GbizCompany } from "@/lib/gbiz/client";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ requireOrganization: vi.fn() }));
vi.mock("@/lib/gbiz/client", async (original) => ({
  ...(await original<typeof import("@/lib/gbiz/client")>()),
  searchGbizCompanies: vi.fn(),
  getGbizCompany: vi.fn(),
}));
vi.mock("@/lib/discovery/website-enrichment", () => ({
  enrichOfficialWebsite: vi.fn(),
}));

import { requireOrganization } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import {
  GbizError,
  getGbizCompany,
  searchGbizCompanies,
} from "@/lib/gbiz/client";
import { enrichOfficialWebsite } from "@/lib/discovery/website-enrichment";
import { normalizeIndustries } from "@/lib/discovery/industries";
import { candidateFromGbiz, discoverySearch } from "@/lib/discovery/mapping";
import { discoveryInput, discoveryQuery } from "@/lib/discovery/schemas";
import {
  acquireCandidates,
  enrichCandidate,
  listCandidates,
  updateCandidate,
} from "@/lib/discovery/service";
import {
  GET,
  POST,
} from "@/app/api/organizations/[org]/company-discovery/route";

const org = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const candidateId = "33333333-3333-4333-8333-333333333333";
const secondId = "44444444-4444-4444-8444-444444444444";
const corporateNumber = "4000012090001";
const timestamp = "2026-10-05T01:00:00.000Z";
const privateText = "private-upstream-response-must-not-leak";

type QueryCall = { method: string; args: unknown[] };
type Query = { table: string; calls: QueryCall[] };
type Reply = {
  data?: unknown;
  error?: { code: string; message: string } | null;
  count?: number | null;
};

// A small recorded thenable lets tests check tenant/version predicates while
// exercising the actual service and HTTP handlers. RLS is tested against SQL.
function database(...replies: Reply[]) {
  const queries: Query[] = [];
  const from = vi.fn((table: string) => {
    const reply = { data: null, error: null, ...replies.shift() };
    const query = { table, calls: [] as QueryCall[] };
    queries.push(query);
    const builder: Record<string, unknown> = {};
    for (const method of [
      "select",
      "eq",
      "in",
      "or",
      "contains",
      "containedBy",
      "not",
      "neq",
      "order",
      "range",
      "limit",
      "update",
      "upsert",
      "delete",
      "maybeSingle",
    ]) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push({ method, args });
        return builder;
      };
    }
    builder.then = Promise.resolve(reply).then.bind(Promise.resolve(reply));
    return builder;
  });
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
  return {
    db: { from, rpc } as unknown as Parameters<typeof listCandidates>[0],
    from,
    rpc,
    queries,
  };
}

function row(
  overrides: Partial<CompanyCandidateRow> = {},
): CompanyCandidateRow {
  return {
    id: candidateId,
    organization_id: org,
    corporate_number: corporateNumber,
    name: "テスト企業",
    prefecture_code: "13",
    prefecture: "東京都",
    location: "東京都千代田区",
    industry_codes: ["E"],
    industry_labels: ["製造業"],
    phone: null,
    website_url: null,
    employee_number: null,
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
    name: "テスト企業",
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

function authorize(db: ReturnType<typeof database>["db"]) {
  vi.mocked(requireOrganization).mockResolvedValue({
    db,
    org,
    role: "owner",
    user: { id: userId } as Awaited<
      ReturnType<typeof requireOrganization>
    >["user"],
  });
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(
    `https://leadstack.example/api/organizations/${org}/company-discovery`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://leadstack.example",
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}
const context = { params: Promise.resolve({ org }) };
const update = {
  action: "update" as const,
  id: candidateId,
  expectedUpdatedAt: timestamp,
  phone: null,
  website_url: null,
  employee_number: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://leadstack.example");
  vi.stubEnv("GBIZ_API_TOKEN", "test-only-not-a-real-token");
});
afterEach(() => vi.unstubAllEnvs());

describe("discovery input and normalization", () => {
  test.each([
    { prefecture: "00" },
    { prefecture: "48" },
    { prefecture: "東京都" },
    { industry: "101" },
    { industry: "U" },
    { industry: "E,organization_id.eq.other" },
    { page: "0" },
    { page: "1.5" },
    { pageSize: "51" },
    { sort: "organization_id" },
  ])("rejects invalid list filters %j", (input) => {
    expect(discoveryQuery.safeParse(input).success).toBe(false);
  });

  test.each([
    { action: "acquire" },
    { action: "acquire", name: " " },
    { action: "acquire", prefecture: "13", page: 11 },
    { action: "acquire", prefecture: "13", organization_id: org },
    { action: "acquire", prefecture: "13", token: privateText },
    { action: "preview", ids: [] },
    {
      action: "import",
      ids: [candidateId],
      reviewToken: "reviewed",
      confirmedDuplicates: false,
    },
    {
      action: "import",
      ids: [candidateId],
      reviewToken: "reviewed",
      confirmedDuplicates: false,
      confirmed: false,
    },
    {
      action: "import",
      ids: [candidateId],
      confirmedDuplicates: true,
      confirmed: true,
    },
    { ...update, website_url: "javascript:alert(1)" },
    { ...update, website_url: "https://user:secret@example.test/" },
    { ...update, employee_number: -1 },
    { ...update, employee_number: 2147483648 },
    { ...update, expectedUpdatedAt: "stale" },
  ])("rejects unsafe or unconfirmed mutations %j", (input) => {
    expect(discoveryInput.safeParse(input).success).toBe(false);
  });

  test("import has a bounded deduplicated selection and retains explicit confirmation", () => {
    expect(
      discoveryInput.parse({
        action: "import",
        ids: [candidateId, candidateId, secondId],
        reviewToken: "reviewed",
        confirmedDuplicates: false,
        confirmed: true,
      }),
    ).toMatchObject({ ids: [candidateId, secondId], confirmed: true });
    expect(
      discoveryInput.safeParse({
        action: "preview",
        ids: Array(51).fill(candidateId),
      }).success,
    ).toBe(false);
    expect(
      discoveryInput.parse({
        ...update,
        phone: " ",
        website_url: "",
        employee_number: 0,
      }),
    ).toMatchObject({ phone: null, website_url: null, employee_number: 0 });
  });

  test("JSIC divisions and labels normalize without treating procurement codes as industry", () => {
    expect(
      normalizeIndustries(["A01010", "B03", "E", "製造業", "農業，林業"]),
    ).toEqual({
      codes: ["A", "B", "E"],
      labels: ["農業、林業", "漁業", "製造業"],
    });
    expect(normalizeIndustries(["101", "999", "unknown", "未確認"])).toEqual({
      codes: [],
      labels: [],
    });
    expect(normalizeIndustries(null)).toEqual({ codes: [], labels: [] });
    expect(normalizeIndustries(["分類不能の産業"])).toEqual({
      codes: ["T"],
      labels: ["分類不能の産業"],
    });
  });

  test("PostgREST control characters remain quoted literal search text", () => {
    expect(discoverySearch('A,()"B')).toBe(
      'name.ilike."%A,()\\"B%",corporate_number.ilike."%A,()\\"B%"',
    );
    expect(discoverySearch("%_\\")).toBe(
      'name.ilike."%\\\\%\\\\_\\\\\\\\%",corporate_number.ilike."%\\\\%\\\\_\\\\\\\\%"',
    );
    expect(discoverySearch("４００００１２０９０００１")).toContain(
      'corporate_number.ilike."%4000012090001%"',
    );
  });

  test("upstream refresh preserves unknown values, known values, and deliberate manual clearing", () => {
    expect(candidateFromGbiz(company())).toMatchObject({
      employee_number: null,
      website_url: null,
      prefecture_code: "13",
      industry_codes: [],
    });
    expect(candidateFromGbiz(company({ employeeNumber: 0 }))).toHaveProperty(
      "employee_number",
      0,
    );
    const known = row({
      employee_number: 25,
      website_url: "https://known.example/",
    });
    expect(candidateFromGbiz(company(), known)).toMatchObject({
      employee_number: 25,
      website_url: "https://known.example/",
      industry_codes: ["E"],
    });
    const manual = row({
      employee_number: null,
      website_url: null,
      provenance: {
        manualOverrides: ["website_url", "employee_number"],
        note: "human evidence",
      },
    });
    expect(
      candidateFromGbiz(
        company({
          employeeNumber: 60,
          companyUrl: "https://upstream.example/",
        }),
        manual,
      ),
    ).toMatchObject({
      employee_number: null,
      website_url: null,
      provenance: {
        note: "human evidence",
        manualOverrides: ["website_url", "employee_number"],
      },
    });
    expect(
      candidateFromGbiz(company({ employeeNumber: 2147483648 }), known),
    ).toHaveProperty("employee_number", 25);
  });

  test("changed upstream website clears proposal and all enrichment status from the old URL", () => {
    const previous = row({
      website_url: "https://old.example/",
      enrichment_result: {
        phone: "03-0000-0000",
        sourceUrl: "https://old.example/about",
      },
      enrichment_status: "complete",
      enrichment_checked_at: timestamp,
      enrichment_error: "old status",
    });
    expect(
      candidateFromGbiz(
        company({ companyUrl: "https://new.example/" }),
        previous,
      ),
    ).toMatchObject({
      website_url: "https://new.example/",
      enrichment_result: null,
      enrichment_status: null,
      enrichment_checked_at: null,
      enrichment_error: null,
    });
  });

  test.each(["https://known.example/", null])(
    "same or absent upstream website keeps the existing proposal (%s)",
    (companyUrl) => {
      const previous = row({
        website_url: "https://known.example/",
        enrichment_result: {
          phone: "03-0000-0000",
          sourceUrl: "https://known.example/about",
        },
        enrichment_status: "complete",
        enrichment_checked_at: timestamp,
      });
      const refreshed = {
        ...previous,
        ...candidateFromGbiz(company({ companyUrl }), previous),
      };
      expect(refreshed).toMatchObject({
        website_url: previous.website_url,
        enrichment_result: previous.enrichment_result,
        enrichment_status: previous.enrichment_status,
        enrichment_checked_at: previous.enrichment_checked_at,
      });
    },
  );

  test("manual website override preserves its proposal and evidence despite a different upstream URL", () => {
    const source = {
      source: "担当者確認",
      retrievedAt: timestamp,
      sourceUrl: "https://manual.example/",
    };
    const previous = row({
      website_url: "https://manual.example/",
      enrichment_result: {
        phone: "03-0000-0000",
        sourceUrl: "https://manual.example/about",
      },
      enrichment_status: "complete",
      enrichment_checked_at: timestamp,
      provenance: {
        manualOverrides: ["website_url"],
        fieldSources: { website_url: source },
      },
    });
    const refreshed = {
      ...previous,
      ...candidateFromGbiz(
        company({ companyUrl: "https://upstream.example/" }),
        previous,
      ),
    };
    expect(refreshed).toMatchObject({
      website_url: "https://manual.example/",
      enrichment_result: previous.enrichment_result,
      enrichment_status: "complete",
      enrichment_checked_at: timestamp,
      provenance: { fieldSources: { website_url: source } },
    });
  });

  test("field source dates describe when each value was obtained, even after a newer basic-only fetch", () => {
    const original = company({
      employeeNumber: 25,
      companyUrl: "https://known.example/",
      industry: ["E"],
      updatedAt: "2026-09-20",
      provenance: {
        ...company().provenance,
        metadata: {
          source: {
            employee_number: "雇用公開資料",
            company_url: "法人公開資料",
          },
          lastUpdateDate: {
            employee_number: "2026-08-01",
            company_url: "2026-09-01",
          },
          lastAcquisitionDate: {},
          dataQuality: {},
          importFrequency: {},
        },
      },
    });
    const first = candidateFromGbiz(original);
    const sourceUrl = `https://info.gbiz.go.jp/hojin/ichiran?hojinBango=${corporateNumber}`;
    const employeeSource = {
      source: "雇用公開資料",
      retrievedAt: timestamp,
      sourceUpdatedAt: "2026-08-01",
      sourceUrl,
    };
    const websiteSource = {
      source: "法人公開資料",
      retrievedAt: timestamp,
      sourceUpdatedAt: "2026-09-01",
      sourceUrl,
    };
    expect(first.provenance).toMatchObject({
      fieldSources: {
        employee_number: employeeSource,
        website_url: websiteSource,
        industry: {
          source: "Gビズインフォ",
          sourceUpdatedAt: "2026-09-20",
          retrievedAt: timestamp,
        },
      },
    });

    const laterTime = "2026-10-06T01:00:00.000Z";
    const basic = company({
      name: "更新後の名称",
      updatedAt: "2026-10-06",
      provenance: { ...company().provenance, retrievedAt: laterTime },
    });
    const refreshed = candidateFromGbiz(basic, row(first));
    expect(refreshed).toMatchObject({
      name: "更新後の名称",
      employee_number: 25,
      website_url: "https://known.example/",
      fetched_at: laterTime,
      provenance: {
        gbiz: { retrievedAt: laterTime },
        fieldSources: {
          employee_number: employeeSource,
          website_url: websiteSource,
          name: { retrievedAt: laterTime, sourceUpdatedAt: "2026-10-06" },
          industry: { retrievedAt: timestamp },
        },
      },
    });
  });

  test("a newly supplied employee count of zero replaces both the value and its source", () => {
    const laterTime = "2026-10-06T01:00:00.000Z";
    const previous = row({
      employee_number: 25,
      provenance: {
        fieldSources: {
          employee_number: { source: "古い資料", retrievedAt: timestamp },
          website_url: { source: "公式サイト", retrievedAt: timestamp },
        },
      },
    });
    const refreshed = candidateFromGbiz(
      company({
        employeeNumber: 0,
        provenance: {
          ...company().provenance,
          retrievedAt: laterTime,
          metadata: {
            source: { employee_number: "新しい公開資料" },
            lastUpdateDate: { employee_number: "2026-10-05" },
            lastAcquisitionDate: {},
            dataQuality: {},
            importFrequency: {},
          },
        },
      }),
      previous,
    );
    expect(refreshed).toMatchObject({
      employee_number: 0,
      provenance: {
        fieldSources: {
          employee_number: {
            source: "新しい公開資料",
            retrievedAt: laterTime,
            sourceUpdatedAt: "2026-10-05",
          },
          website_url: { source: "公式サイト", retrievedAt: timestamp },
        },
      },
    });
  });
});

describe("discovery HTTP boundary", () => {
  test.each([
    { action: "remove", ids: [candidateId] },
    { action: "remove", ids: [candidateId], confirmed: false },
    {
      action: "remove",
      ids: [candidateId],
      confirmed: true,
      organization_id: secondId,
    },
  ])("removal requires strict explicit confirmation %j", async (body) => {
    const response = await POST(request(body), context);
    expect(response.status).toBe(422);
    expect(requireOrganization).not.toHaveBeenCalled();
  });

  test("confirmed removal deletes only selected candidates in the authorized organization", async () => {
    const db = database({ data: [{ id: candidateId }] });
    authorize(db.db);
    const response = await POST(
      request({
        action: "remove",
        ids: [candidateId, candidateId],
        confirmed: true,
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: 1 });
    expect(requireOrganization).toHaveBeenCalledWith(org, true);
    expect(db.queries).toEqual([
      {
        table: "company_candidates",
        calls: [
          { method: "delete", args: [] },
          { method: "eq", args: ["organization_id", org] },
          { method: "in", args: ["id", [candidateId]] },
          { method: "select", args: ["id"] },
        ],
      },
    ]);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(searchGbizCompanies).not.toHaveBeenCalled();
  });

  test("viewer cannot remove candidates even with confirmation", async () => {
    const db = database();
    vi.mocked(requireOrganization).mockRejectedValue(
      new AppError(403, "read_only", "閲覧専用のユーザーです"),
    );
    const response = await POST(
      request({ action: "remove", ids: [candidateId], confirmed: true }),
      context,
    );
    expect(response.status).toBe(403);
    expect(requireOrganization).toHaveBeenCalledWith(org, true);
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  test.each(["read_only", "forbidden"])(
    "%s denial precedes all upstream and database work",
    async (code) => {
      vi.mocked(requireOrganization).mockRejectedValue(
        new AppError(403, code, "権限がありません"),
      );
      const response = await POST(
        request({ action: "acquire", prefecture: "13" }),
        context,
      );
      expect(response.status).toBe(403);
      expect(requireOrganization).toHaveBeenCalledWith(org, true);
      expect(searchGbizCompanies).not.toHaveBeenCalled();
      expect(getGbizCompany).not.toHaveBeenCalled();
      expect(enrichOfficialWebsite).not.toHaveBeenCalled();
    },
  );

  test("GET checks tenant membership before candidate access", async () => {
    vi.mocked(requireOrganization).mockRejectedValue(
      new AppError(403, "forbidden", "権限がありません"),
    );
    expect(
      (
        await GET(
          new Request("https://leadstack.example/?prefecture=13"),
          context,
        )
      ).status,
    ).toBe(403);
    expect(requireOrganization).toHaveBeenCalledWith(org);
    expect(searchGbizCompanies).not.toHaveBeenCalled();
  });

  test.each<Record<string, string>>([
    { origin: "https://attacker.example" },
    { "sec-fetch-site": "cross-site" },
  ])(
    "cross-site mutation is rejected before authorization %j",
    async (headers) => {
      const response = await POST(
        request({ action: "acquire", prefecture: "13" }, headers),
        context,
      );
      expect(response.status).toBe(403);
      expect(requireOrganization).not.toHaveBeenCalled();
      expect(searchGbizCompanies).not.toHaveBeenCalled();
    },
  );

  test("strict body rejects caller-supplied organization before any work", async () => {
    const response = await POST(
      request({
        action: "acquire",
        prefecture: "13",
        organization_id: secondId,
      }),
      context,
    );
    expect(response.status).toBe(422);
    expect(requireOrganization).not.toHaveBeenCalled();
    expect(searchGbizCompanies).not.toHaveBeenCalled();
  });

  test("missing token returns 503 without reserving quota or invoking Gbiz", async () => {
    vi.stubEnv("GBIZ_API_TOKEN", " ");
    const db = database();
    authorize(db.db);
    const response = await POST(
      request({ action: "acquire", prefecture: "13" }),
      context,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "gbiz_not_configured" },
    });
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(searchGbizCompanies).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test.each(["preview", "import"] as const)(
    "%s forwards only authorized org and reviewed unique IDs",
    async (action) => {
      const db = database();
      db.rpc.mockResolvedValue({ data: { items: [] }, error: null });
      authorize(db.db);
      const body =
        action === "preview"
          ? { action, ids: [candidateId, candidateId] }
          : {
              action,
              ids: [candidateId, candidateId],
              confirmed: true,
              confirmedDuplicates: false,
              reviewToken: "review-token",
            };
      const response = await POST(request(body), context);
      expect(response.status).toBe(200);
      expect(requireOrganization).toHaveBeenCalledWith(org, true);
      expect(db.rpc).toHaveBeenCalledExactlyOnceWith(
        action === "preview"
          ? "preview_company_candidates"
          : "import_company_candidates",
        {
          org,
          candidate_ids: [candidateId],
          ...(action === "import"
            ? { confirmed_duplicates: false, review_token: "review-token" }
            : {}),
        },
      );
      expect(searchGbizCompanies).not.toHaveBeenCalled();
    },
  );

  test("changed import review becomes 409 and database internals remain private", async () => {
    const db = database();
    db.rpc.mockResolvedValue({
      data: null,
      error: { code: "40001", message: privateText },
    });
    authorize(db.db);
    const response = await POST(
      request({
        action: "import",
        ids: [candidateId],
        confirmed: true,
        confirmedDuplicates: true,
        reviewToken: "old-review",
      }),
      context,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(privateText);
  });
});

describe("discovery service tenant and failure behavior", () => {
  test("cached list and linked CRM matches remain scoped to the requested organization", async () => {
    const db = database(
      { data: [row({ phone: "03-1111-1111" })], count: 1 },
      { count: 8 },
      { data: [{ fetched_at: timestamp }] },
      {
        data: [
          {
            id: secondId,
            corporate_number: corporateNumber,
            name: "CRM上の企業名",
            phone: "03-2222-2222",
          },
        ],
      },
    );
    const result = await listCandidates(
      db.db,
      org,
      discoveryQuery.parse({
        prefecture: "13",
        industry: "unknown",
        hasEmployees: "true",
        search: 'A,()"B',
      }),
    );
    expect(result).toMatchObject({
      count: 1,
      totalCached: 8,
      lastFetchedAt: timestamp,
      data: [
        {
          company_id: secondId,
          phone: "03-1111-1111",
          crm_company_name: "CRM上の企業名",
          crm_company_phone: "03-2222-2222",
        },
      ],
    });
    expect(db.queries).toHaveLength(4);
    for (const query of db.queries)
      expect(query.calls).toContainEqual({
        method: "eq",
        args: ["organization_id", org],
      });
    expect(db.queries[0].calls).toContainEqual({
      method: "containedBy",
      args: ["industry_codes", []],
    });
    expect(db.queries[0].calls).toContainEqual({
      method: "not",
      args: ["employee_number", "is", null],
    });
    expect(db.queries[0].calls).toContainEqual({
      method: "or",
      args: [discoverySearch('A,()"B')],
    });
    expect(db.queries[3].calls).toContainEqual({
      method: "select",
      args: ["id,corporate_number,name,phone"],
    });
    expect(
      result.industryOptions.filter((option) =>
        ["unknown", "T"].includes(option.value),
      ),
    ).toHaveLength(2);
    expect(searchGbizCompanies).not.toHaveBeenCalled();
  });

  test.each(["03-2222-2222", null])(
    "GET keeps CRM phone %s separate from the external candidate phone",
    async (crmPhone) => {
      const db = database(
        { data: [row({ phone: "03-1111-1111" })], count: 1 },
        { count: 1 },
        { data: [{ fetched_at: timestamp }] },
        {
          data: [
            {
              id: secondId,
              corporate_number: corporateNumber,
              name: "担当者が編集した企業名",
              phone: crmPhone,
            },
          ],
        },
      );
      authorize(db.db);
      const response = await GET(
        new Request(
          `https://leadstack.example/api/organizations/${org}/company-discovery`,
        ),
        context,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: [
          {
            id: candidateId,
            name: "テスト企業",
            phone: "03-1111-1111",
            company_id: secondId,
            crm_company_name: "担当者が編集した企業名",
            crm_company_phone: crmPhone,
          },
        ],
      });
      expect(requireOrganization).toHaveBeenCalledWith(org);
      expect(db.queries[3]).toEqual({
        table: "companies",
        calls: [
          { method: "select", args: ["id,corporate_number,name,phone"] },
          { method: "eq", args: ["organization_id", org] },
          { method: "in", args: ["corporate_number", [corporateNumber]] },
        ],
      });
    },
  );

  test("out-of-range pages return the last actual page with stable ordering", async () => {
    const db = database(
      { data: [], count: 21 },
      { count: 21 },
      { data: [] },
      { data: [row()] },
      { data: [] },
    );
    expect(
      await listCandidates(db.db, org, discoveryQuery.parse({ page: 500 })),
    ).toMatchObject({ page: 2, count: 21, data: [{ id: candidateId }] });
    expect(db.queries[3].calls).toContainEqual({
      method: "range",
      args: [20, 39],
    });
    expect(db.queries[3].calls).toContainEqual({
      method: "order",
      args: ["id"],
    });
  });

  test.each([null, 0])(
    "PostgREST range error with count %s recounts filtered rows before fetching the last page",
    async (initialCount) => {
      const db = database(
        {
          data: null,
          count: initialCount,
          error: {
            code: "PGRST103",
            message: "Requested range not satisfiable",
          },
        },
        { count: 90 },
        { data: [{ fetched_at: timestamp }] },
        { count: 22 },
        { data: [row()], count: 22 },
        { data: [] },
      );
      const input = discoveryQuery.parse({
        page: 999,
        pageSize: 7,
        prefecture: "13",
        industry: "E",
        search: "テスト",
        hasPhone: "true",
      });
      expect(await listCandidates(db.db, org, input)).toMatchObject({
        page: 4,
        pageSize: 7,
        count: 22,
        totalCached: 90,
        data: [{ id: candidateId }],
      });
      expect(db.queries[3].calls).toContainEqual({
        method: "select",
        args: ["*", { count: "exact", head: true }],
      });
      expect(db.queries[3].calls.some((call) => call.method === "range")).toBe(
        false,
      );
      for (const query of [db.queries[3], db.queries[4]]) {
        expect(query.calls).toEqual(
          expect.arrayContaining([
            { method: "eq", args: ["organization_id", org] },
            { method: "eq", args: ["prefecture_code", "13"] },
            { method: "contains", args: ["industry_codes", ["E"]] },
            { method: "or", args: [discoverySearch("テスト")] },
            { method: "not", args: ["phone", "is", null] },
          ]),
        );
      }
      expect(db.queries[4].calls).toContainEqual({
        method: "range",
        args: [21, 27],
      });
      expect(db.queries).toHaveLength(6);
    },
  );

  test("concurrent deletion after a range recount falls back once to page one with the new count", async () => {
    const rangeError = {
      code: "PGRST103",
      message: "Requested range not satisfiable",
    };
    const db = database(
      { error: rangeError, count: null },
      { count: 22 },
      { data: [] },
      { count: 22 },
      { error: rangeError, count: null },
      { data: [row()], count: 1 },
      { data: [] },
    );
    expect(
      await listCandidates(
        db.db,
        org,
        discoveryQuery.parse({ page: 999, pageSize: 7 }),
      ),
    ).toMatchObject({ page: 1, count: 1, data: [{ id: candidateId }] });
    expect(db.queries[4].calls).toContainEqual({
      method: "range",
      args: [21, 27],
    });
    expect(db.queries[5].calls).toContainEqual({
      method: "range",
      args: [0, 6],
    });
    expect(db.queries[5].calls).toContainEqual({
      method: "eq",
      args: ["organization_id", org],
    });
    expect(db.queries).toHaveLength(7);
  });

  test("persistent range failure ends after the single fallback instead of retrying indefinitely", async () => {
    const rangeError = { code: "PGRST103", message: privateText };
    const db = database(
      { error: rangeError },
      { count: 22 },
      { data: [] },
      { count: 22 },
      { error: rangeError },
      { error: rangeError },
    );
    await expect(
      listCandidates(
        db.db,
        org,
        discoveryQuery.parse({ page: 999, pageSize: 7 }),
      ),
    ).rejects.toMatchObject({ status: 500, code: "database_error" });
    expect(db.queries).toHaveLength(6);
    expect(db.queries[5].calls).toContainEqual({
      method: "range",
      args: [0, 6],
    });
  });

  test("acquisition does one bounded page and retains base candidates after a partial detail failure", async () => {
    const other = company({ corporateNumber: "5000012090002", name: "別企業" });
    vi.mocked(searchGbizCompanies).mockResolvedValue({
      companies: [company(), other],
      page: 2,
      limit: 20,
    });
    vi.mocked(getGbizCompany).mockImplementation(async (number) => {
      if (number === corporateNumber) throw new Error(privateText);
      return { ...other, industry: ["G39"], employeeNumber: 0 };
    });
    const db = database(
      { data: [] },
      { data: [{ id: candidateId }] },
      { data: [{ id: secondId }] },
    );
    const result = await acquireCandidates(db.db, org, {
      action: "acquire",
      prefecture: "13",
      page: 2,
    });
    expect(result).toMatchObject({
      fetched: 2,
      detailsFailed: 1,
      page: 2,
      nextPage: null,
    });
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(searchGbizCompanies).toHaveBeenCalledExactlyOnceWith(
      {
        prefecture: "13",
        name: undefined,
        corporateNumber: undefined,
        page: 2,
        limit: 20,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(getGbizCompany).toHaveBeenCalledTimes(2);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith(
      "reserve_company_discovery_request",
      { org, operation: "acquire" },
    );
    expect(db.queries[0].calls).toContainEqual({
      method: "eq",
      args: ["organization_id", org],
    });
    for (const query of db.queries.slice(1)) {
      const call = query.calls.find((call) => call.method === "upsert")!;
      expect(call.args).toEqual([
        expect.objectContaining({ organization_id: org }),
        {
          onConflict: "organization_id,corporate_number",
          ignoreDuplicates: true,
        },
      ]);
    }
    expect(
      db.queries[1].calls.find((call) => call.method === "upsert")?.args[0],
    ).toMatchObject({ employee_number: null });
    expect(
      db.queries[2].calls.find((call) => call.method === "upsert")?.args[0],
    ).toMatchObject({ employee_number: 0, industry_codes: ["G"] });
  });

  test("quota denial does not invoke the upstream service", async () => {
    const db = database();
    db.rpc.mockResolvedValue({ data: false, error: null });
    await expect(
      acquireCandidates(db.db, org, {
        action: "acquire",
        prefecture: "13",
        page: 1,
      }),
    ).rejects.toMatchObject({ status: 429, code: "discovery_rate_limited" });
    expect(searchGbizCompanies).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  test("upstream throttling maps to a safe retryable error", async () => {
    vi.mocked(searchGbizCompanies).mockRejectedValue(
      new GbizError("rate_limited", 429),
    );
    await expect(
      acquireCandidates(database().db, org, {
        action: "acquire",
        prefecture: "13",
        page: 1,
      }),
    ).rejects.toMatchObject({ status: 429, code: "gbiz_rate_limited" });
    expect(getGbizCompany).not.toHaveBeenCalled();
  });

  test("concurrent candidate refresh never reports a skipped update as saved", async () => {
    vi.mocked(searchGbizCompanies).mockResolvedValue({
      companies: [company()],
      page: 1,
      limit: 20,
    });
    vi.mocked(getGbizCompany).mockResolvedValue(company());
    const db = database({ data: [row()] }, { data: [] });
    expect(
      await acquireCandidates(db.db, org, {
        action: "acquire",
        prefecture: "13",
        page: 1,
      }),
    ).toMatchObject({ fetched: 0 });
    expect(db.queries[1].calls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["organization_id", org] },
        { method: "eq", args: ["id", candidateId] },
        { method: "eq", args: ["updated_at", timestamp] },
      ]),
    );
  });

  test("manual update records deliberate clearing and uses the reviewed row version", async () => {
    const old = row({
      phone: "03-0000-0000",
      employee_number: 20,
      provenance: { manualOverrides: ["website_url"] },
    });
    const db = database({ data: old }, { data: row() }, { data: null });
    expect(await updateCandidate(db.db, org, userId, update)).toMatchObject({
      candidate: {
        company_id: null,
        crm_company_name: null,
        crm_company_phone: null,
      },
    });
    for (const query of db.queries)
      expect(query.calls).toContainEqual({
        method: "eq",
        args: ["organization_id", org],
      });
    expect(db.queries[1].calls).toContainEqual({
      method: "eq",
      args: ["updated_at", timestamp],
    });
    expect(
      db.queries[1].calls.find((call) => call.method === "update")?.args[0],
    ).toMatchObject({
      phone: null,
      employee_number: null,
      provenance: {
        manualOverrides: expect.arrayContaining([
          "website_url",
          "phone",
          "employee_number",
        ]),
        manual: { updatedBy: userId },
      },
    });
  });

  test("manual update response refreshes authoritative CRM details while keeping the candidate phone distinct", async () => {
    const newCandidatePhone = "03-3333-3333";
    const db = database(
      { data: row({ phone: "03-1111-1111" }) },
      { data: row({ phone: newCandidatePhone }) },
      { data: { id: secondId, name: "CRM企業名", phone: "03-2222-2222" } },
    );
    authorize(db.db);
    const response = await POST(
      request({ ...update, phone: newCandidatePhone }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      candidate: {
        id: candidateId,
        phone: newCandidatePhone,
        company_id: secondId,
        crm_company_name: "CRM企業名",
        crm_company_phone: "03-2222-2222",
      },
    });
    expect(db.queries[2]).toEqual({
      table: "companies",
      calls: [
        { method: "select", args: ["id,name,phone"] },
        { method: "eq", args: ["organization_id", org] },
        { method: "eq", args: ["corporate_number", corporateNumber] },
        { method: "maybeSingle", args: [] },
      ],
    });
    expect(
      db.queries[2].calls.some((call) =>
        ["update", "upsert"].includes(call.method),
      ),
    ).toBe(false);
    expect(requireOrganization).toHaveBeenCalledWith(org, true);
  });

  test("enrichment response preserves CRM phone separately from candidate and proposed phone", async () => {
    const candidatePhone = "03-1111-1111";
    const initial = row({
      phone: candidatePhone,
      website_url: "https://official.example/",
    });
    const proposal = {
      status: "found" as const,
      phone: "03-3333-3333",
      employeeNumber: null,
      sourceUrl: "https://official.example/about",
      evidence: "会社概要",
      message: null,
      checkedAt: timestamp,
    };
    vi.mocked(enrichOfficialWebsite).mockResolvedValue(proposal);
    const db = database(
      { data: initial },
      { data: row({ ...initial, updated_at: "2026-10-05T02:00:00.000Z" }) },
      {
        data: row({
          ...initial,
          enrichment_result: proposal,
          enrichment_status: "complete",
        }),
      },
      { data: { id: secondId, name: "CRM企業名", phone: "03-2222-2222" } },
    );
    authorize(db.db);
    const response = await POST(
      request({ action: "enrich", id: candidateId }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      candidate: {
        id: candidateId,
        phone: candidatePhone,
        company_id: secondId,
        crm_company_name: "CRM企業名",
        crm_company_phone: "03-2222-2222",
        enrichment_result: { phone: "03-3333-3333" },
      },
    });
    expect(db.queries[3]).toEqual({
      table: "companies",
      calls: [
        { method: "select", args: ["id,name,phone"] },
        { method: "eq", args: ["organization_id", org] },
        { method: "eq", args: ["corporate_number", corporateNumber] },
        { method: "maybeSingle", args: [] },
      ],
    });
    expect(
      db.queries[2].calls.find((call) => call.method === "update")?.args[0],
    ).not.toHaveProperty("phone");
  });

  test("zero affected manual updates return conflict instead of false success", async () => {
    const db = database({ data: row() }, { data: null });
    authorize(db.db);
    const response = await POST(request(update), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "candidate_changed" },
    });
  });

  test("another organization's or missing candidate is denied before website fetching", async () => {
    const db = database({ data: null });
    await expect(enrichCandidate(db.db, org, secondId)).rejects.toMatchObject({
      status: 404,
      code: "candidate_not_found",
    });
    expect(db.queries[0].calls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["organization_id", org] },
        { method: "eq", args: ["id", secondId] },
      ]),
    );
    expect(db.rpc).not.toHaveBeenCalled();
    expect(enrichOfficialWebsite).not.toHaveBeenCalled();
  });

  test("enrichment does not overwrite a concurrent edit or report unsaved results", async () => {
    const pendingTime = "2026-10-05T02:00:00.000Z";
    const initial = row({ website_url: "https://official.example/" });
    const db = database(
      { data: initial },
      { data: row({ updated_at: pendingTime }) },
      { data: null },
    );
    vi.mocked(enrichOfficialWebsite).mockResolvedValue({
      status: "found",
      phone: "03-0000-0000",
      employeeNumber: null,
      sourceUrl: initial.website_url,
      evidence: "会社概要",
      message: null,
      checkedAt: timestamp,
    });
    await expect(
      enrichCandidate(db.db, org, candidateId),
    ).rejects.toMatchObject({ status: 409, code: "candidate_changed" });
    for (const query of db.queries)
      expect(query.calls).toContainEqual({
        method: "eq",
        args: ["organization_id", org],
      });
    expect(db.queries[1].calls).toContainEqual({
      method: "eq",
      args: ["updated_at", timestamp],
    });
    expect(db.queries[2].calls).toContainEqual({
      method: "eq",
      args: ["updated_at", pendingTime],
    });
    expect(
      db.queries[2].calls.find((call) => call.method === "update")?.args[0],
    ).not.toHaveProperty("phone");
  });
});
