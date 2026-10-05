import { afterEach, expect, test, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ requireOrganization: vi.fn() }));
import { requireOrganization } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { discoveryQuery } from "@/lib/discovery/schemas";
import { listCandidates } from "@/lib/discovery/service";
import { GET } from "@/app/api/organizations/[org]/company-discovery/[id]/route";

const org = "11111111-1111-4111-8111-111111111111";
const id = "33333333-3333-4333-8333-333333333333";
const summary = "設備会社の事業内容。".repeat(500) + "給与計算";
const evidence = {
  businessSummary: summary,
  fieldSources: { business_summary: { source: "公式資料" } },
};
const candidate = {
  id,
  organization_id: org,
  corporate_number: "4000012090001",
  name: "試験設備",
  provenance: evidence,
  enrichment_result: { evidence: "公式サイトで確認済み" },
  employee_number: 20,
  industry_codes: ["D"],
  phone: "03-0000-0000",
};

function database(detail = false) {
  const requests: URL[] = [];
  const db = createClient<Database>(
    "https://database.example",
    "test-public-key",
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          requests.push(url);
          const select = url.searchParams.get("select") ?? "";
          let data: unknown = [];
          if (url.pathname.endsWith("/company_candidates")) {
            if (detail) data = candidate;
            else if (select.includes("business_summary:")) {
              const {
                provenance: _provenance,
                enrichment_result: _result,
                ...row
              } = candidate;
              void _provenance;
              void _result;
              data = [
                {
                  ...row,
                  business_summary: summary,
                  business_summary_truncated: false,
                },
              ];
            } else if (select === "*") data = [candidate];
          }
          return new Response(
            init?.method === "HEAD" ? null : JSON.stringify(data),
            {
              headers: {
                "content-type": "application/json",
                "content-range": "0-0/1",
              },
            },
          );
        },
      },
    },
  );
  return { db, requests };
}

afterEach(() => vi.resetAllMocks());

test("table response omits full evidence and bounds the excerpt while retaining matches beyond it", async () => {
  const { db, requests } = database();
  const result = await listCandidates(
    db,
    org,
    discoveryQuery.parse({ view: "summary", businessKeywords: "給与計算" }),
  );
  expect(result.data[0]).toMatchObject({
    list_summary: true,
    provenance: {},
    enrichment_result: null,
    matched_business_keywords: ["給与計算"],
  });
  expect(Array.from(result.data[0].business_summary ?? "")).toHaveLength(240);
  expect(result.data[0].business_summary).not.toContain("給与計算");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(3000);
  const projection = requests.find((url) =>
    url.searchParams.get("select")?.includes("business_summary:"),
  )!;
  expect(projection.searchParams.get("organization_id")).toBe(`eq.${org}`);
  expect(projection.searchParams.get("select")).not.toMatch(
    /(?:^|,)provenance(?:,|$)|enrichment_result/,
  );
});

test("full list remains compatible for existing API clients", async () => {
  const result = await listCandidates(
    database().db,
    org,
    discoveryQuery.parse({}),
  );
  expect(result.data[0].provenance).toEqual(evidence);
  expect(result.data[0].business_summary).toBe(summary);
  expect(result.data[0].list_summary).toBeUndefined();
});

test("detail route reads full source evidence within the authorized organization and candidate", async () => {
  const { db, requests } = database(true);
  vi.mocked(requireOrganization).mockResolvedValue({ db } as Awaited<
    ReturnType<typeof requireOrganization>
  >);
  const response = await GET(new Request("https://app.example/api/detail"), {
    params: Promise.resolve({ org, id }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).candidate).toMatchObject({
    provenance: evidence,
    business_summary: summary,
    enrichment_result: candidate.enrichment_result,
  });
  expect(requireOrganization).toHaveBeenCalledWith(org);
  const lookup = requests.find((url) =>
    url.pathname.endsWith("/company_candidates"),
  )!;
  expect(lookup.searchParams.get("organization_id")).toBe(`eq.${org}`);
  expect(lookup.searchParams.get("id")).toBe(`eq.${id}`);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

test("detail route denies another organization without querying a candidate", async () => {
  vi.mocked(requireOrganization).mockRejectedValue(
    new AppError(403, "forbidden", "権限がありません"),
  );
  const response = await GET(new Request("https://app.example/api/detail"), {
    params: Promise.resolve({ org, id }),
  });
  expect(response.status).toBe(403);
});
