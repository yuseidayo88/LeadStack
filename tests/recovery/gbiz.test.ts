import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  getGbizCompany,
  searchGbizCompanies,
  type GbizSearchParams,
} from "@/lib/gbiz/client";

const corporateNumber = "4000012090001";
const mockToken = "test-token-that-must-not-appear-in-errors";
const fetchMock = vi.fn<typeof fetch>();

function reply(companies: unknown[], extra: Record<string, unknown> = {}) {
  fetchMock.mockResolvedValueOnce(
    Response.json({ "hojin-infos": companies, ...extra }),
  );
}

beforeEach(() => {
  vi.stubEnv("GBIZ_API_TOKEN", mockToken);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchMock.mockReset();
});

test("search sends bounded encoded filters only to the official HTTPS endpoint", async () => {
  reply([{ corporate_number: corporateNumber, name: " 経済産業省 " }]);
  const result = await searchGbizCompanies({
    prefecture: "13",
    name: "会社 A&B",
    page: 2,
    limit: 30,
  });
  expect(result).toMatchObject({
    page: 2,
    limit: 30,
    companies: [
      {
        corporateNumber,
        name: "経済産業省",
        employeeNumber: null,
        companyUrl: null,
        industry: null,
      },
    ],
  });
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(
    "https://api.info.gbiz.go.jp/hojin/v2/hojin?name=%E4%BC%9A%E7%A4%BE+A%26B&prefecture=13&page=2&limit=30&metadata_flg=true",
  );
  expect(init).toMatchObject({
    method: "GET",
    redirect: "manual",
    cache: "no-store",
    headers: { "X-hojinInfo-api-token": mockToken },
  });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(result).not.toHaveProperty("total");
  expect(result.companies[0]).not.toHaveProperty("phone");
});

test("detail preserves zero, provenance and raw status without guessing its meaning", async () => {
  reply([
    {
      corporate_number: corporateNumber,
      status: "uninterpreted-value",
      employee_number: 0,
      company_url: "https://www.meti.go.jp/",
      industry: [" 製造業 ", "", null],
      update_date: "2026-09-01",
      "meta-data": {
        source: {
          employee_number: "公開資料",
          name: "国税庁",
          unexpected: "ignored",
        },
        last_update_date: { employee_number: "2026-08-31" },
      },
    },
  ]);
  const company = await getGbizCompany(corporateNumber);
  expect(company).toMatchObject({
    corporateNumber,
    status: "uninterpreted-value",
    employeeNumber: 0,
    companyUrl: "https://www.meti.go.jp/",
    industry: ["製造業"],
    updatedAt: "2026-09-01",
    provenance: {
      source: "gBizINFO",
      metadata: {
        source: { employee_number: "公開資料", name: "国税庁" },
        lastUpdateDate: { employee_number: "2026-08-31" },
      },
    },
  });
  expect(company?.provenance.metadata?.source).not.toHaveProperty("unexpected");
  expect(Date.parse(company!.provenance.retrievedAt)).not.toBeNaN();
  expect(String(fetchMock.mock.calls[0][0])).toBe(
    `https://api.info.gbiz.go.jp/hojin/v2/hojin/${corporateNumber}?metadata_flg=true`,
  );
});

test.each([undefined, null, "12", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "unknown or invalid employee count %s stays null",
  async (employeeNumber) => {
    reply([
      {
        corporate_number: corporateNumber,
        employee_number: employeeNumber,
        company_url: "javascript:alert(1)",
        industry: [],
      },
    ]);
    expect(await getGbizCompany(corporateNumber)).toMatchObject({
      employeeNumber: null,
      companyUrl: null,
      industry: null,
      name: null,
    });
  },
);

test("empty search and missing detail remain distinguishable from errors", async () => {
  reply([], { errors: [] });
  expect(await searchGbizCompanies({ corporateNumber })).toEqual({
    companies: [],
    page: 1,
    limit: 20,
  });
  reply([]);
  expect(await getGbizCompany(corporateNumber)).toBeNull();
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect(await getGbizCompany(corporateNumber)).toBeNull();
});

test.each<GbizSearchParams>([
  {},
  { prefecture: "00" },
  { prefecture: "48" },
  { prefecture: "1" },
  { prefecture: "13", page: 0 },
  { prefecture: "13", page: 11 },
  { prefecture: "13", page: 1.5 },
  { prefecture: "13", limit: 19 },
  { prefecture: "13", limit: 51 },
  { prefecture: "13", limit: NaN },
  { name: " " },
  { name: "a".repeat(201) },
  { corporateNumber: "../redirect" },
])(
  "invalid search input is rejected before calling fetch: %j",
  async (params) => {
    await expect(searchGbizCompanies(params)).rejects.toMatchObject({
      code: "invalid_parameters",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("invalid corporate detail ID cannot change the request path", async () => {
  await expect(getGbizCompany("https://example.test")).rejects.toMatchObject({
    code: "invalid_parameters",
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([undefined, " "])("missing token fails locally", async (token) => {
  vi.stubEnv("GBIZ_API_TOKEN", token);
  await expect(getGbizCompany(corporateNumber)).rejects.toMatchObject({
    code: "not_configured",
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  [401, "unauthorized"],
  [403, "unauthorized"],
  [429, "rate_limited"],
  [400, "upstream_error"],
  [500, "upstream_error"],
  [302, "redirect_refused"],
] as const)(
  "HTTP %i fails safely without forwarding headers or bodies",
  async (status, code) => {
    fetchMock.mockResolvedValueOnce(
      new Response(mockToken, {
        status,
        headers: { Location: "https://other.test/" },
      }),
    );
    const error = await getGbizCompany(corporateNumber).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain(mockToken);
    expect(JSON.stringify(error)).not.toContain(mockToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

test("API errors inside HTTP 200 are failures and upstream messages stay private", async () => {
  reply([], {
    errors: [{ item: "token", message: mockToken }],
    id: "unknown",
    message: mockToken,
  });
  const error = await getGbizCompany(corporateNumber).catch(
    (error: unknown) => error,
  );
  expect(error).toMatchObject({ code: "upstream_error", status: 200 });
  expect(String(error)).not.toContain(mockToken);
  expect(JSON.stringify(error)).not.toContain(mockToken);
});

test.each([
  {},
  { "hojin-infos": null },
  { "hojin-infos": [{}] },
  { "hojin-infos": [], errors: "bad shape" },
  { "hojin-infos": [{ corporate_number: "1000000000000" }] },
  {
    "hojin-infos": [
      { corporate_number: corporateNumber },
      { corporate_number: corporateNumber },
    ],
  },
])("malformed or mismatched detail response fails safely: %j", async (body) => {
  fetchMock.mockResolvedValueOnce(Response.json(body));
  await expect(getGbizCompany(corporateNumber)).rejects.toMatchObject({
    code: "invalid_response",
  });
});

test("invalid JSON is a response error without exposing its contents", async () => {
  fetchMock.mockResolvedValueOnce(new Response(mockToken));
  await expect(getGbizCompany(corporateNumber)).rejects.toMatchObject({
    code: "invalid_response",
  });
});

test("request timeout aborts fetch and strips its error details", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error(mockToken)),
          { once: true },
        );
      }),
  );
  const request = getGbizCompany(corporateNumber);
  const assertion = expect(request).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(10_000);
  await assertion;
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

test("network failures discard their original message and cause", async () => {
  fetchMock.mockRejectedValueOnce(new Error(mockToken));
  const error = await getGbizCompany(corporateNumber).catch(
    (error: unknown) => error,
  );
  expect(error).toMatchObject({ code: "network_error" });
  expect(error).not.toHaveProperty("cause");
  expect(String(error)).not.toContain(mockToken);
});

test.each([true, false])(
  "response size is bounded even without Content-Length (%s)",
  async (declared) => {
    fetchMock.mockResolvedValueOnce(
      new Response("x".repeat(2 * 1024 * 1024 + 1), {
        headers: declared
          ? { "Content-Length": String(2 * 1024 * 1024 + 1) }
          : {},
      }),
    );
    await expect(getGbizCompany(corporateNumber)).rejects.toMatchObject({
      code: "response_too_large",
    });
  },
);
