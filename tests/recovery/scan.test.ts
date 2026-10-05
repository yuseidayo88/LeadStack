import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CompanyCandidateRow } from "@/lib/database.types";
import type { GbizCompany } from "@/lib/gbiz/client";
import type { ScanEvent } from "@/lib/discovery/contracts";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/gbiz/client", async (original) => ({
  ...(await original<typeof import("@/lib/gbiz/client")>()),
  searchGbizCompanies: vi.fn(),
  getGbizCompany: vi.fn(),
}));
vi.mock("@/lib/discovery/service", async (original) => ({
  ...(await original<typeof import("@/lib/discovery/service")>()),
  reserveRequest: vi.fn(),
}));

import {
  GbizError,
  getGbizCompany,
  searchGbizCompanies,
} from "@/lib/gbiz/client";
import { reserveRequest } from "@/lib/discovery/service";
import { scanCriteria } from "@/lib/discovery/schemas";
import { startCompanyScan } from "@/lib/discovery/scan";
import { AppError } from "@/lib/errors";

const org = "11111111-1111-4111-8111-111111111111";
const otherOrg = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-10-06T01:00:00.000Z";
const number = (index: number) => String(1000000000000 + index);
const id = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

function company(
  index: number,
  overrides: Partial<GbizCompany> = {},
): GbizCompany {
  return {
    corporateNumber: number(index),
    name: `設備会社${index}`,
    location: "東京都千代田区",
    postalCode: null,
    status: null,
    updatedAt: null,
    industry: ["D"],
    companyUrl: "https://example.com/",
    employeeNumber: 25,
    businessSummary: "空調設備の保守点検",
    provenance: {
      source: "gBizINFO",
      requestUrl: "https://api.info.gbiz.go.jp/hojin/v2/hojin",
      retrievedAt: timestamp,
      metadata: null,
    },
    ...overrides,
  };
}

function database() {
  const rows = new Map<string, CompanyCandidateRow>();
  const calls: { table: string; method: string; value?: unknown }[] = [];
  let serial = 0;
  const from = (table: string) => {
    let operation = "select",
      payload: Record<string, unknown> = {},
      single = false;
    let signal: AbortSignal | undefined;
    const equals: Record<string, unknown> = {};
    let numbers: string[] | undefined;
    const builder = {
      select() {
        return builder;
      },
      eq(field: string, value: unknown) {
        equals[field] = value;
        return builder;
      },
      in(field: string, value: string[]) {
        if (field === "corporate_number") numbers = value;
        return builder;
      },
      update(value: Record<string, unknown>) {
        operation = "update";
        payload = value;
        return builder;
      },
      upsert(value: Record<string, unknown>) {
        operation = "upsert";
        payload = value;
        return builder;
      },
      abortSignal(value: AbortSignal) {
        signal = value;
        return builder;
      },
      maybeSingle() {
        single = true;
        return builder;
      },
      then(
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) {
        return Promise.resolve()
          .then(() => {
            calls.push({
              table,
              method: operation,
              value: { ...payload, ...equals },
            });
            if (signal?.aborted)
              return {
                data: null,
                error: { code: "57014", message: "cancelled" },
              };
            let result: CompanyCandidateRow[] = [];
            if (operation === "upsert") {
              const key = String(payload.corporate_number);
              if (!rows.has(key)) {
                const row = {
                  id: id(++serial),
                  phone: null,
                  company_id: null,
                  created_at: timestamp,
                  updated_at: timestamp,
                  enrichment_status: null,
                  enrichment_error: null,
                  enrichment_checked_at: null,
                  enrichment_result: null,
                  ...payload,
                } as CompanyCandidateRow;
                rows.set(key, row);
                result = [row];
              }
            } else {
              result = [...rows.values()].filter(
                (row) =>
                  Object.entries(equals).every(
                    ([field, value]) =>
                      row[field as keyof CompanyCandidateRow] === value,
                  ) &&
                  (!numbers || numbers.includes(row.corporate_number)),
              );
              if (operation === "update") {
                result = result.map(
                  (old) =>
                    ({
                      ...old,
                      ...payload,
                      updated_at: new Date().toISOString(),
                    }) as CompanyCandidateRow,
                );
                for (const row of result) rows.set(row.corporate_number, row);
              }
            }
            return { data: single ? (result[0] ?? null) : result, error: null };
          })
          .then(resolve, reject);
      },
    };
    return builder;
  };
  return {
    rows,
    calls,
    db: { from } as unknown as Parameters<typeof startCompanyScan>[0],
  };
}

function upstream(companies: GbizCompany[]) {
  const byNumber = new Map(
    companies.map((value) => [value.corporateNumber, value]),
  );
  vi.mocked(searchGbizCompanies).mockImplementation(async (params) => ({
    companies: companies.slice(
      ((params.page ?? 1) - 1) * 20,
      (params.page ?? 1) * 20,
    ),
    page: params.page ?? 1,
    limit: 20,
  }));
  vi.mocked(getGbizCompany).mockImplementation(
    async (value) => byNumber.get(value) ?? null,
  );
}

async function events(response: Response): Promise<ScanEvent[]> {
  return (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ScanEvent);
}
const last = (values: ScanEvent[]) => values.at(-1)!;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(timestamp);
  vi.stubEnv("GBIZ_API_TOKEN", "private-test-token-never-print");
  vi.mocked(reserveRequest).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("streaming company discovery", () => {
  test("continues beyond the first20 until20 matches and resumes the exact middle-page tail for20more", async () => {
    const fixture = Array.from({ length: 55 }, (_, i) =>
      company(i + 1, { employeeNumber: i < 10 ? 9 : 25 }),
    );
    upstream(fixture);
    const { db, rows } = database();
    const criteria = scanCriteria.parse({
      prefecture: "13",
      employeeMin: 10,
      employeeMax: 50,
    });
    const response = await startCompanyScan(db, org, { criteria });
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    const first = await events(response);
    expect(first[0]).toMatchObject({
      type: "progress",
      scanned: 0,
      matched: 0,
      target: 20,
    });
    expect(first[0].resumeToken).toBeTruthy();
    expect(last(first)).toMatchObject({
      type: "complete",
      reason: "target",
      scanned: 30,
      matched: 20,
      saved: 30,
      target: 20,
    });
    expect(rows.size).toBe(30);
    expect(
      vi.mocked(searchGbizCompanies).mock.calls.map(([params]) => params.page),
    ).toEqual([1, 2]);
    expect(
      first.some((event) => event.type === "progress" && event.matched === 1),
    ).toBe(true);
    const second = await events(
      await startCompanyScan(db, org, {
        criteria,
        resumeToken: last(first).resumeToken!,
      }),
    );
    expect(last(second)).toMatchObject({
      type: "complete",
      reason: "target",
      scanned: 50,
      matched: 40,
      target: 40,
    });
    expect(
      vi.mocked(searchGbizCompanies).mock.calls.map(([params]) => params.page),
    ).toEqual([1, 2, 3]);
    expect(last(second).matchedIds).toHaveLength(40);
    expect(new Set(last(second).matchedIds).size).toBe(40);
    expect(rows.size).toBe(50);
    expect(JSON.stringify([...first, ...second])).not.toContain(
      "private-test-token-never-print",
    );
  });

  test("stops at200 scanned positions even when no company matches", async () => {
    upstream(
      Array.from({ length: 220 }, (_, i) =>
        company(i + 1, { employeeNumber: 500 }),
      ),
    );
    const { db, rows } = database();
    const result = last(
      await events(
        await startCompanyScan(db, org, {
          criteria: scanCriteria.parse({
            industry: "D",
            employeeMin: 10,
            employeeMax: 50,
          }),
        }),
      ),
    );
    expect(result).toMatchObject({
      type: "complete",
      reason: "scan_limit",
      scanned: 200,
      matched: 0,
      saved: 200,
      resumeToken: null,
    });
    expect(rows.size).toBe(200);
    expect(searchGbizCompanies).toHaveBeenCalledTimes(10);
    expect(getGbizCompany).toHaveBeenCalledTimes(200);
  });

  test("retains unknown employees by default and separates them from fetch failures", async () => {
    upstream([
      company(1, { employeeNumber: null }),
      company(2, { employeeNumber: 0 }),
      company(3, { employeeNumber: 10 }),
      company(4, { employeeNumber: 51 }),
    ]);
    const { db } = database();
    const criteria = scanCriteria.parse({
      prefecture: "13",
      employeeMin: 10,
      employeeMax: 50,
    });
    const result = last(
      await events(await startCompanyScan(db, org, { criteria })),
    );
    expect(result).toMatchObject({
      reason: "exhausted",
      scanned: 4,
      matched: 2,
      unknownEmployees: 1,
      detailsFailed: 0,
      resumeToken: null,
    });
    const params = vi.mocked(searchGbizCompanies).mock.calls[0][0];
    expect(params).not.toHaveProperty("employeeMin");
    expect(params).not.toHaveProperty("employeeMax");
  });

  test("uses the provider employee bounds only when unknown employees are excluded", async () => {
    upstream([]);
    const { db } = database();
    await events(
      await startCompanyScan(db, org, {
        criteria: scanCriteria.parse({
          employeeMin: 10,
          employeeMax: 50,
          includeUnknownEmployees: false,
        }),
      }),
    );
    expect(searchGbizCompanies).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeMin: 10,
        employeeMax: 50,
        name: undefined,
      }),
      expect.objectContaining({ allowUnfiltered: true }),
    );
  });

  test("individual404 and malformed details are skipped without turning failures into unknown matches", async () => {
    upstream([
      company(1),
      company(2),
      company(3, { employeeNumber: null, industry: null }),
    ]);
    vi.mocked(getGbizCompany)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new GbizError("invalid_response"));
    const { db } = database();
    const result = last(
      await events(
        await startCompanyScan(db, org, {
          criteria: scanCriteria.parse({
            prefecture: "13",
            employeeMin: 10,
            includeUnknownEmployees: true,
          }),
        }),
      ),
    );
    expect(result).toMatchObject({
      type: "complete",
      reason: "exhausted",
      scanned: 3,
      saved: 1,
      matched: 1,
      detailsFailed: 2,
      unknownEmployees: 1,
      unknownIndustry: 1,
    });
  });

  test.each([
    "rate_limited",
    "unauthorized",
    "timeout",
    "network_error",
    "upstream_error",
  ] as const)(
    "%s pauses at the failed position until a deliberate retry",
    async (code) => {
      const fixture = [company(1), company(2), company(3)];
      upstream(fixture);
      vi.mocked(getGbizCompany)
        .mockResolvedValueOnce(fixture[0])
        .mockRejectedValueOnce(new GbizError(code));
      const { db } = database();
      const criteria = scanCriteria.parse({ prefecture: "13" });
      const first = last(
        await events(await startCompanyScan(db, org, { criteria })),
      );
      expect(first).toMatchObject({
        type: "error",
        reason: "upstream_error",
        scanned: 1,
        saved: 1,
        matched: 1,
        detailsFailed: 1,
        unknownEmployees: 0,
      });
      expect(first.resumeToken).toBeTruthy();
      const second = last(
        await events(
          await startCompanyScan(db, org, {
            criteria,
            resumeToken: first.resumeToken!,
          }),
        ),
      );
      expect(second).toMatchObject({
        reason: "exhausted",
        scanned: 3,
        saved: 3,
        matched: 3,
        detailsFailed: 1,
      });
      expect(
        vi.mocked(getGbizCompany).mock.calls.map(([value]) => value),
      ).toEqual([number(1), number(2), number(2), number(3)]);
      expect(searchGbizCompanies).toHaveBeenCalledTimes(1);
    },
  );

  test("repeated10s timeouts never silently consume companies across automatic chunks", async () => {
    upstream([company(1), company(2)]);
    vi.mocked(getGbizCompany).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 10_000);
      throw new GbizError("timeout");
    });
    const { db } = database();
    const criteria = scanCriteria.parse({ prefecture: "13", employeeMin: 10 });
    const first = last(
      await events(await startCompanyScan(db, org, { criteria })),
    );
    const second = last(
      await events(
        await startCompanyScan(db, org, {
          criteria,
          resumeToken: first.resumeToken!,
        }),
      ),
    );
    expect(first).toMatchObject({
      type: "error",
      scanned: 0,
      matched: 0,
      detailsFailed: 1,
      unknownEmployees: 0,
    });
    expect(second).toMatchObject({
      type: "error",
      scanned: 0,
      matched: 0,
      detailsFailed: 2,
      unknownEmployees: 0,
    });
    expect(
      vi.mocked(getGbizCompany).mock.calls.map(([value]) => value),
    ).toEqual([number(1), number(1)]);
  });

  test("a deadline pause keeps the page tail and target without incrementing for another20", async () => {
    const fixture = Array.from({ length: 5 }, (_, i) => company(i + 1));
    upstream(fixture);
    vi.mocked(getGbizCompany).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 21_000);
      return fixture[0];
    });
    const { db } = database();
    const criteria = scanCriteria.parse({ prefecture: "13" });
    const first = last(
      await events(await startCompanyScan(db, org, { criteria })),
    );
    expect(first).toMatchObject({
      type: "paused",
      reason: "time_limit",
      scanned: 1,
      matched: 1,
      target: 20,
    });
    expect(Date.parse(first.nextAllowedAt)).toBeGreaterThan(Date.now());
    const second = last(
      await events(
        await startCompanyScan(db, org, {
          criteria,
          resumeToken: first.resumeToken!,
        }),
      ),
    );
    expect(second).toMatchObject({
      reason: "exhausted",
      scanned: 5,
      matched: 5,
      target: 20,
    });
    expect(searchGbizCompanies).toHaveBeenCalledTimes(1);
  });

  test("hard25s deadline aborts an in-flight provider call before the30s request gate reopens", async () => {
    upstream([company(1)]);
    let providerSignal: AbortSignal | undefined;
    vi.mocked(getGbizCompany).mockImplementation(
      (_number, options) =>
        new Promise((_resolve, reject) => {
          providerSignal = options?.signal;
          options?.signal?.addEventListener(
            "abort",
            () => reject(new GbizError("cancelled")),
            { once: true },
          );
        }),
    );
    const { db } = database();
    const response = await startCompanyScan(db, org, {
      criteria: scanCriteria.parse({ prefecture: "13" }),
    });
    const reading = events(response);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(providerSignal?.aborted).toBe(true);
    const result = last(await reading);
    expect(result).toMatchObject({
      type: "paused",
      reason: "time_limit",
      scanned: 0,
      matched: 0,
      detailsFailed: 0,
    });
    expect(Date.parse(result.nextAllowedAt)).toBeGreaterThan(Date.now());
  });

  test("client cancellation aborts the provider and retains a valid checkpoint", async () => {
    upstream([company(1)]);
    const stop = new AbortController();
    vi.mocked(getGbizCompany).mockImplementation(
      (_number, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new GbizError("cancelled")),
            { once: true },
          );
        }),
    );
    const { db } = database();
    const response = await startCompanyScan(
      db,
      org,
      { criteria: scanCriteria.parse({ prefecture: "13" }) },
      stop.signal,
    );
    const reading = events(response);
    await vi.advanceTimersByTimeAsync(1);
    stop.abort();
    const result = last(await reading);
    expect(result).toMatchObject({
      type: "paused",
      reason: "cancelled",
      scanned: 0,
      matched: 0,
    });
    expect(result.resumeToken).toBeTruthy();
  });

  test("search-page errors are retryable and never reported as exhaustion", async () => {
    upstream([company(1)]);
    vi.mocked(searchGbizCompanies).mockRejectedValueOnce(
      new GbizError("upstream_error"),
    );
    const { db } = database();
    const criteria = scanCriteria.parse({ prefecture: "13" });
    const first = last(
      await events(await startCompanyScan(db, org, { criteria })),
    );
    expect(first).toMatchObject({
      type: "error",
      reason: "upstream_error",
      scanned: 0,
      saved: 0,
    });
    const second = last(
      await events(
        await startCompanyScan(db, org, {
          criteria,
          resumeToken: first.resumeToken!,
        }),
      ),
    );
    expect(second).toMatchObject({
      type: "complete",
      reason: "exhausted",
      scanned: 1,
      saved: 1,
    });
    expect(
      vi.mocked(searchGbizCompanies).mock.calls.map(([params]) => params.page),
    ).toEqual([1, 1]);
  });

  test("duplicate provider records are counted as positions but never inflate matches", async () => {
    upstream([company(1), company(1), company(2)]);
    const { db } = database();
    const result = last(
      await events(
        await startCompanyScan(db, org, {
          criteria: scanCriteria.parse({ industry: "D" }),
        }),
      ),
    );
    expect(result).toMatchObject({ scanned: 3, saved: 2, matched: 2 });
    expect(getGbizCompany).toHaveBeenCalledTimes(2);
  });

  test("cross-organization or changed criteria tokens fail before acquiring the request quota", async () => {
    upstream([company(1)]);
    vi.mocked(getGbizCompany).mockRejectedValueOnce(new GbizError("timeout"));
    const { db } = database();
    const criteria = scanCriteria.parse({ prefecture: "13" });
    const first = last(
      await events(await startCompanyScan(db, org, { criteria })),
    );
    vi.mocked(reserveRequest).mockClear();
    await expect(
      startCompanyScan(db, otherOrg, {
        criteria,
        resumeToken: first.resumeToken!,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      startCompanyScan(db, org, {
        criteria: scanCriteria.parse({ prefecture: "14" }),
        resumeToken: first.resumeToken!,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(reserveRequest).not.toHaveBeenCalled();
  });

  test("a rate reservation failure prevents any provider call or streaming body", async () => {
    vi.mocked(reserveRequest).mockRejectedValueOnce(
      new AppError(429, "discovery_rate_limited", "取得が集中しています"),
    );
    const { db } = database();
    await expect(
      startCompanyScan(db, org, {
        criteria: scanCriteria.parse({ prefecture: "13" }),
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(searchGbizCompanies).not.toHaveBeenCalled();
    expect(getGbizCompany).not.toHaveBeenCalled();
  });
});
