// Real search page and controls with a fixture-only workspace and intercepted
// API. Refuse every non-loopback browser request, including company websites.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

const root = process.cwd();
const fixtures = resolve(root, "tests/recovery/fixtures/search-quality-ui");
const output =
  process.env.SEARCH_QUALITY_OUTPUT || "/workspace/handoff/search-quality-fix";
await mkdir(output, { recursive: true });
const org = "11111111-1111-4111-8111-111111111111";
const base = `/api/organizations/${org}`;
const id = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const rows = Array.from({ length: 27 }, (_, i) => ({
  id: id(i + 1),
  organization_id: org,
  corporate_number: String(7000000000000 + i),
  name: i < 25 ? `試験設備${i + 1}` : `情報不足設備${i - 24}`,
  prefecture: "東京都",
  prefecture_code: "13",
  location: "東京都千代田区（合成データ）",
  industry_codes: ["D"],
  industry_labels: ["建設業"],
  employee_number: i < 25 ? 25 : null,
  phone: null,
  website_url: null,
  business_summary: "設備の保守・点検",
  provenance: {},
  source_updated_at: null,
  fetched_at: "2026-10-12T00:00:00Z",
  updated_at: "2026-10-12T00:00:00Z",
  created_at: "2026-10-12T00:00:00Z",
  company_id: null,
  enrichment_status: null,
  enrichment_error: null,
  enrichment_checked_at: null,
  enrichment_result: null,
  match_evidence: {
    industryCode: "D",
    keywords: ["設備"],
    missing: i < 25 ? [] : ["employees"],
  },
}));
const server = await createServer({
  configFile: false,
  root: fixtures,
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  resolve: {
    alias: [
      {
        find: "@/components/layout/workspace",
        replacement: resolve(fixtures, "workspace.ts"),
      },
      { find: "next/link", replacement: resolve(fixtures, "link.tsx") },
      {
        find: "next/navigation",
        replacement: resolve(fixtures, "navigation.ts"),
      },
      { find: "@", replacement: resolve(root, "src") },
    ],
  },
});
let browser;
const errors = [],
  rejected = [],
  apiRequests = [];
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) {
      rejected.push(url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    apiRequests.push({
      path: url.pathname,
      query: url.search,
      method: req.method(),
    });
    if (
      url.pathname === `${base}/company-discovery` &&
      req.method() === "GET"
    ) {
      const review = url.searchParams.get("resultGroup") === "needs_review";
      const filtered = rows.filter(
        (row) => (row.employee_number === null) === review,
      );
      const page = Math.min(
        Number(url.searchParams.get("page") || 1),
        Math.max(1, Math.ceil(filtered.length / 20)),
      );
      return route.fulfill({
        json: {
          data: filtered.slice((page - 1) * 20, page * 20),
          count: filtered.length,
          totalCached: rows.length,
          page,
          pageSize: 20,
          configured: true,
          lastFetchedAt: rows[0].fetched_at,
          industryOptions: [{ value: "D", label: "建設業" }],
        },
      });
    }
    if (
      url.pathname === `${base}/company-discovery/scan` &&
      req.method() === "POST"
    ) {
      const resume = !!req.postDataJSON().resumeToken;
      const event = {
        type: "complete",
        scanned: resume ? 200 : 20,
        matched: 5,
        needsReview: 15,
        target: resume ? 40 : 20,
        saved: 0,
        reused: 20,
        detailsFailed: 0,
        unknownEmployees: 15,
        unknownIndustry: 0,
        matchedIds: rows.slice(0, 5).map((row) => row.id),
        resumeToken: resume ? null : "synthetic-checkpoint",
        nextAllowedAt: new Date().toISOString(),
        reason: resume ? "scan_limit" : "target",
      };
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: JSON.stringify(event) + "\n",
      });
    }
    rejected.push(`${req.method()} ${url.pathname}`);
    return route.fulfill({
      status: 500,
      json: { error: { message: "Unexpected fixture request" } },
    });
  });
  await context.addInitScript(
    ({ base }) =>
      localStorage.setItem(
        `leadstack.discovery.filters.v1.${base}`,
        JSON.stringify({
          version: 1,
          filters: {
            search: "",
            prefecture: "13",
            industry: "D",
            employeeMin: "10",
            employeeMax: "50",
            includeUnknownEmployees: true,
            includeUnknownIndustry: true,
            businessKeywords: "設備",
            presetId: "",
            hasPhone: false,
            hasWebsite: false,
            hasEmployees: false,
            sort: "fetched_at",
            direction: "desc",
          },
        }),
      ),
    { base },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await expect(
    page.getByRole("heading", { name: "取得済み候補 · 条件一致 25 社" }),
  ).toBeVisible();
  await expect(
    page
      .getByText("業種コード一致：D（大分類）")
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByText(
        "名称・事業内容の語句一致：設備。業種を確定する根拠ではありません。",
      )
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expect(page.getByText("情報不足設備1", { exact: true })).toHaveCount(0);
  await page
    .getByRole("group", { name: "保存済み一覧のページ送り" })
    .getByRole("button", { name: "次のページ" })
    .click();
  await expect(
    page.getByRole("button", { name: "試験設備21", exact: true }),
  ).toBeVisible();
  assert.equal(apiRequests.filter((r) => r.method === "POST").length, 0);
  await page
    .getByRole("button", { name: "情報不足（別枠）", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "取得済み候補 · 情報不足 2 社" }),
  ).toBeVisible();
  await expect(
    page
      .getByText("情報不足：従業員数が未確認（条件一致には含めません）")
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(output, "review-desktop.png"),
    animations: "disabled",
    fullPage: true,
  });
  assert.equal(apiRequests.filter((r) => r.method === "POST").length, 0);
  await page
    .getByRole("button", { name: "条件に合う企業を探す", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "今回の確認目安に達しました" }),
  ).toContainText("条件一致5社・情報不足15社");
  await page
    .getByRole("button", {
      name: "外部取得を続ける（候補20社分）",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "確認上限に達しました" }),
  ).toContainText("全件確認済みではありません");
  await expect(
    page.getByRole("button", {
      name: "外部取得を続ける（候補20社分）",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.screenshot({
    path: resolve(output, "limit-desktop.png"),
    animations: "disabled",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "情報不足設備1", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("情報不足：従業員数が未確認（条件一致には含めません）")
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
  }));
  assert.equal(dimensions.width, dimensions.viewport);
  await page.screenshot({
    path: resolve(output, "review-mobile.png"),
    animations: "disabled",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(rejected, []);
  assert.equal(apiRequests.filter((r) => r.method === "POST").length, 2);
  await writeFile(
    resolve(output, "browser-result.json"),
    JSON.stringify(
      {
        success: true,
        fixtureOnly: true,
        errors,
        rejected,
        dimensions,
        apiRequests,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      success: true,
      fixtureOnly: true,
      errors,
      rejected,
      dimensions,
      fixtureScanPosts: 2,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
