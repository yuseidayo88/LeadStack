// Explicit opt-in for the disposable local Next server only. This file never
// changes application code, accepts real credentials, or calls the Gbiz API.
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";

export const controlPath =
  "/workspace/handoff/e2e-private/discovery-gbiz-control.json";
export const logPath =
  "/workspace/handoff/e2e-private/discovery-gbiz-requests.jsonl";

export function syntheticCompanies(scenario = "normal") {
  return Array.from(
    { length: scenario === "no-match" ? 230 : 70 },
    (_, index) => ({
      corporate_number: String(8500000000000 + index),
      name: `検索検証${String(index).padStart(3, "0")}法人`,
      location: "東京都検証市1番地",
      industry:
        scenario === "no-match" ? ["I"] : index % 7 === 0 ? null : ["D"],
      employee_number: [9, 10, 50, 51, null][index % 5],
      company_url: "https://example.test/company",
      business_summary:
        index % 4 === 0
          ? "雑貨を製造しています"
          : "空調設備の保守点検と現場報告書の作成",
      update_date: "2026-09-01",
      "meta-data": {
        source: { business_summary: "Gビズインフォ合成検証データ" },
      },
    }),
  );
}

async function pause(milliseconds, signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!milliseconds) return;
  await new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve();
    };
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

if (process.env.LEADSTACK_LOCAL_GBIZ_MOCK === "1") {
  assert.ok(
    process.env.GBIZ_API_TOKEN === "local-fixture-only",
    "Use the synthetic local Gbiz credential only",
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return originalFetch(input, init);
    if (
      url.hostname !== "api.info.gbiz.go.jp" ||
      !url.pathname.startsWith("/hojin/v2/hojin")
    )
      throw new Error(
        "Local discovery fixture blocked non-loopback network traffic",
      );
    const headers = new Headers(
      init?.headers || (input instanceof Request ? input.headers : undefined),
    );
    assert.ok(
      headers.get("X-hojinInfo-api-token") === "local-fixture-only",
      "Only the synthetic Gbiz credential is accepted",
    );
    const control = JSON.parse(await readFile(controlPath, "utf8"));
    const number = url.pathname.match(/\/hojin\/(\d{13})$/)?.[1];
    const signal =
      init?.signal || (input instanceof Request ? input.signal : undefined);
    await appendFile(
      logPath,
      JSON.stringify({
        at: Date.now(),
        scenario: control.scenario,
        kind: number ? "detail" : "search",
        number: number || null,
        query: Object.fromEntries(url.searchParams),
      }) + "\n",
    );
    await pause(
      number ? control.detailDelayMs || 0 : control.searchDelayMs || 0,
      signal,
    );
    if (control.scenario === "upstream-429")
      return Response.json(
        { errors: ["synthetic rate limit"] },
        { status: 429 },
      );
    const companies = syntheticCompanies(control.scenario);
    if (number) {
      const company = companies.find((row) => row.corporate_number === number);
      return Response.json({ "hojin-infos": company ? [company] : [] });
    }
    const from = url.searchParams.get("employee_number_from");
    const to = url.searchParams.get("employee_number_to");
    const requestedNumber = url.searchParams.get("corporate_number");
    const requestedName = url.searchParams.get("name");
    const filtered = companies.filter(
      (row) =>
        (!requestedNumber || row.corporate_number === requestedNumber) &&
        (!requestedName || row.name.includes(requestedName)) &&
        (from === null ||
          (row.employee_number !== null &&
            row.employee_number >= Number(from))) &&
        (to === null ||
          (row.employee_number !== null && row.employee_number <= Number(to))),
    );
    const page = Number(url.searchParams.get("page") || 1);
    const limit = Number(url.searchParams.get("limit") || 20);
    return Response.json({
      "hojin-infos": filtered
        .slice((page - 1) * limit, page * limit)
        .map(({ corporate_number, name, location }) => ({
          corporate_number,
          name,
          location,
        })),
    });
  };
}
