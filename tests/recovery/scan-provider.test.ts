import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getGbizCompany, searchGbizCompanies } from "@/lib/gbiz/client";

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("GBIZ_API_TOKEN", "provider-test-token");
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockResolvedValue(Response.json({ "hojin-infos": [] }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("Gbiz condition discovery transport", () => {
  test("official employee range parameters are sent without requiring a company name", async () => {
    await searchGbizCompanies({ employeeMin: 0, employeeMax: 50, page: 2 });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin).toBe("https://api.info.gbiz.go.jp");
    expect(url.searchParams.get("employee_number_from")).toBe("0");
    expect(url.searchParams.get("employee_number_to")).toBe("50");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("name")).toBe(false);
    expect(url.searchParams.has("industry")).toBe(false);
  });

  test("a bounded unfiltered provider page is available only to the explicit server scan mode", async () => {
    await expect(searchGbizCompanies({ page: 1 })).rejects.toMatchObject({
      code: "invalid_parameters",
    });
    expect(fetcher).not.toHaveBeenCalled();
    await searchGbizCompanies(
      { page: 1, limit: 20 },
      { allowUnfiltered: true },
    );
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect([...url.searchParams.keys()]).toEqual([
      "page",
      "limit",
      "metadata_flg",
    ]);
  });

  test.each([
    { employeeMin: -1 },
    { employeeMax: 1.5 },
    { employeeMin: 2147483648 },
    { employeeMin: 51, employeeMax: 10 },
    { employeeMin: Number.NaN },
    { employeeMax: Number.POSITIVE_INFINITY },
  ])("invalid numeric bounds never reach the provider %j", async (bounds) => {
    await expect(
      searchGbizCompanies({ prefecture: "13", ...bounds }),
    ).rejects.toMatchObject({ code: "invalid_parameters" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each(["search", "detail"] as const)(
    "%s fetch honors a scan cancellation signal",
    async (operation) => {
      const controller = new AbortController();
      let receivedSignal: AbortSignal | null | undefined;
      fetcher.mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            receivedSignal = options?.signal;
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("private transport error")),
              { once: true },
            );
          }),
      );
      const request =
        operation === "search"
          ? searchGbizCompanies(
              { prefecture: "13" },
              { signal: controller.signal },
            )
          : getGbizCompany("4000012090001", { signal: controller.signal });
      controller.abort();
      await expect(request).rejects.toMatchObject({ code: "cancelled" });
      expect(receivedSignal?.aborted).toBe(true);
    },
  );

  test("the provider10s timeout is still distinct from client cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    fetcher.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private transport error")),
            { once: true },
          );
        }),
    );
    const assertion = expect(
      getGbizCompany("4000012090001", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(controller.signal.aborted).toBe(false);
  });
});
