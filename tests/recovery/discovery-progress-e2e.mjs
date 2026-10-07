import { expandSearchOptions } from "./search-options.mjs";
// UI/protocol tests: real local login, synthetic delayed scan/list responses.
// Does not test server cancellation; discovery-stop-e2e covers that separately.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const base = process.env.E2E_BASE_URL || "http://localhost:3013";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
assert.ok(process.env.E2E_USERS_FILE, "Local fixture credentials required");
const users = JSON.parse(await readFile(process.env.E2E_USERS_FILE, "utf8"));
const output = process.env.E2E_OUTPUT || "test-results/discovery-progress";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.name));
const evidence = [];
let stage = "setup";
const pass = (message) => {
  evidence.push(message);
  console.log("PASS: " + message);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const pending = [];
let listGate = null;
let listError = false;
let data = [];
let cancelGate = null;
let cancelFails = false;
let cancelCalls = 0;
let org;
let endpoint;
const candidate = (name, n = 1) => ({
  id: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
  organization_id: org,
  corporate_number: String(8500000000000 + n),
  name,
  prefecture_code: "13",
  prefecture: "東京都",
  location: "東京都検証市",
  industry_codes: ["D"],
  industry_labels: ["建設業"],
  phone: null,
  website_url: null,
  employee_number: 25,
  source_updated_at: null,
  fetched_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  provenance: {},
  company_id: null,
  enrichment_status: null,
  enrichment_error: null,
  enrichment_checked_at: null,
  enrichment_result: null,
  list_summary: true,
});
const event = (overrides = {}) => ({
  type: "progress",
  scanned: 5,
  matched: 2,
  target: 20,
  saved: 5,
  detailsFailed: 0,
  unknownEmployees: 1,
  unknownIndustry: 0,
  matchedIds: [],
  resumeToken: "local-ui-fixture",
  nextAllowedAt: new Date().toISOString(),
  ...overrides,
});
async function respond(scan, events) {
  scan.resolve({
    status: 200,
    contentType: "application/x-ndjson",
    body: events.map((item) => JSON.stringify(item)).join("\n") + "\n",
  });
}
async function nextScan(index) {
  await expect.poll(() => pending.length).toBeGreaterThan(index);
  return pending[index];
}
const panel = page.locator("#discovery-search-progress");
const status = panel.getByRole("status");
const count = panel.getByRole("progressbar", {
  name: "企業情報の確認数",
  exact: true,
});
const matches = panel.getByRole("progressbar", {
  name: "条件に合う企業",
  exact: true,
});
const start = panel.getByRole("button", {
  name: "条件に合う企業を探す",
  exact: true,
});
const list = page.locator("#candidate-list");
async function criteria(name) {
  await expandSearchOptions(page);
  data = [];
  listError = false;
  await page
    .getByRole("textbox", { name: "企業名・法人番号（任意）", exact: true })
    .fill(name);
  await expect(start).toBeEnabled();
}
async function settled() {
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect(start).toBeEnabled();
}

try {
  await context.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    return ["localhost", "127.0.0.1"].includes(host)
      ? route.continue()
      : route.abort();
  });
  await page.goto(base + "/login?next=%2Fdiscover");
  await page
    .getByLabel("メールアドレス", { exact: true })
    .fill(users.owner.email);
  await page.locator("input[name=password]").fill(users.owner.password);
  const loggedIn = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  assert.equal((await loggedIn).status(), 200);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  const created = await page.evaluate(async () => {
    const response = await fetch("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `進捗UI検証-${Date.now()}` }),
    });
    return { status: response.status, data: await response.json() };
  });
  assert.equal(created.status, 201);
  org = created.data.data.id;
  endpoint = `/api/organizations/${org}/company-discovery`;
  await page.route(`**${endpoint}**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === endpoint && request.method() === "GET") {
      if (listGate) await listGate.promise;
      return route
        .fulfill({
          status: listError ? 403 : 200,
          contentType: "application/json",
          body: JSON.stringify(
            listError
              ? { error: { code: "FORBIDDEN", message: "合成一覧取得エラー" } }
              : {
                  data,
                  count: data.length,
                  page: 1,
                  pageSize: 20,
                  configured: true,
                  totalCached: data.length,
                  lastFetchedAt: data.length ? new Date().toISOString() : null,
                  industryOptions: [{ value: "D", label: "建設業" }],
                },
          ),
        })
        .catch(() => {});
    }
    if (path === endpoint + "/scan/cancel") {
      cancelCalls++;
      if (cancelGate) await cancelGate.promise;
      return route
        .fulfill({
          status: cancelFails ? 503 : 200,
          contentType: "application/json",
          body: JSON.stringify(
            cancelFails
              ? { error: { code: "UNAVAILABLE", message: "合成停止エラー" } }
              : {
                  data: {
                    runId: request.postDataJSON().runId,
                    status: "cancelled",
                  },
                },
          ),
        })
        .catch(() => {});
    }
    if (path === endpoint + "/scan") {
      const gate = deferred();
      pending.push({ ...gate, body: request.postDataJSON() });
      return route.fulfill(await gate.promise).catch(() => {});
    }
    throw new Error("Unexpected synthetic discovery path");
  });
  await page.evaluate(
    (id) => localStorage.setItem("leadstack.organization", id),
    org,
  );
  await page.goto(base + "/discover");

  stage = "delayed headers and immediate activity";
  await criteria("進捗検証");
  await start.evaluate((button) => {
    button.click();
    button.click();
  });
  const first = await nextScan(0);
  await expect(status).toContainText("検索中");
  await expect(count).toHaveAttribute("aria-valuenow", "0");
  await expect(list).toHaveAttribute("aria-busy", "true");
  await expect(
    list.getByText(
      /条件に合う取得済み候補はありません|条件を指定して企業を探しましょう/,
    ),
  ).not.toBeVisible();
  await expect(
    panel.getByRole("button", { name: "検索中…", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByText(/経過 [1-9]/)).toBeVisible();
  assert.equal(
    pending.length,
    1,
    "Double click starts one scan while headers are delayed",
  );
  await page.screenshot({ path: output + "/delayed-first-response.png" });
  pass(
    "Delayed first response: immediate busy UI, elapsed clock, zero processed, no false empty result, double-click blocked",
  );

  stage = "actual counts and cooldown";
  data = [candidate("進捗検証 一致A")];
  await respond(first, [
    event(),
    event({
      type: "paused",
      reason: "chunk_limit",
      nextAllowedAt: new Date(Date.now() + 4500).toISOString(),
    }),
  ]);
  await expect(count).toHaveAttribute("aria-valuenow", "5");
  await expect(matches).toHaveAttribute("aria-valuenow", "2");
  await expect(status).toContainText("待機中");
  await expect(panel.getByText(/次の確認まであと[1-5]秒/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "進捗検証 一致A", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: output + "/cooldown-progress.png" });
  const second = await nextScan(1);
  await expect(status).toContainText("検索中");
  await expect(count).toHaveAttribute("aria-valuenow", "5");
  assert.equal(second.body.resumeToken, "local-ui-fixture");
  pass(
    "Confirmed counts remain visible across cooldown and next delayed request; partial results appear before completion",
  );

  stage = "mobile accessibility and reduced motion";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await panel.scrollIntoViewIfNeeded();
  await expect
    .poll(() => panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    .toBe(true);
  const bar = panel.getByRole("progressbar", {
    name: "現在の処理",
    exact: true,
  });
  assert.equal(
    await bar.getAttribute("aria-valuenow"),
    null,
    "Unknown work has no fake percentage",
  );
  assert.equal(
    await bar
      .locator("div")
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const audit = await new AxeBuilder({ page })
    .include("#discovery-search-progress")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    audit.violations.map((v) => v.id),
    [],
  );
  await page.screenshot({ path: output + "/mobile-progress.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  pass(
    "390px mobile progress fits; indeterminate work omits aria-valuenow; reduced motion and WCAG audit pass",
  );

  stage = "delayed final list";
  listGate = deferred();
  await respond(second, [
    event({
      type: "complete",
      reason: "exhausted",
      scanned: 8,
      matched: 3,
      saved: 8,
      resumeToken: null,
    }),
  ]);
  await expect(status).toHaveText("結果を一覧に反映中…");
  await expect(
    panel.getByRole("button", { name: "結果を反映中…", exact: true }),
  ).toBeDisabled();
  await expect(list).toHaveAttribute("aria-busy", "true");
  await page.screenshot({ path: output + "/delayed-final-list.png" });
  data = [
    candidate("進捗検証 一致A"),
    candidate("進捗検証 一致B", 2),
    candidate("進捗検証 一致C", 3),
  ];
  listGate.resolve();
  listGate = null;
  await settled();
  await expect(status).toHaveText("検索が完了しました");
  await expect(count).toHaveAttribute("aria-valuenow", "8");
  await expect(count).toHaveAttribute("aria-valuemax", "200");
  await expect(matches).toHaveAttribute("aria-valuenow", "3");
  await expect(
    list.getByRole("button", { name: "進捗検証 一致C", exact: true }),
  ).toBeVisible();
  pass(
    "Terminal event stays busy until final list refresh settles; exhaustion preserves 8/200 and 3/20 instead of inventing 100%",
  );

  stage = "zero result";
  await criteria("該当なし検証");
  await start.click();
  const zero = await nextScan(2);
  listGate = deferred();
  await respond(zero, [
    event({
      type: "complete",
      reason: "exhausted",
      scanned: 0,
      matched: 0,
      saved: 0,
      resumeToken: null,
    }),
  ]);
  await expect(status).toHaveText("結果を一覧に反映中…");
  await expect(
    list.getByText(
      /条件に合う取得済み候補はありません|条件を指定して企業を探しましょう/,
    ),
  ).not.toBeVisible();
  listGate.resolve();
  listGate = null;
  await settled();
  await expect(status).toHaveText("検索が完了しました（条件一致0社）");
  pass("Zero results are announced only after the final list response");

  stage = "cancel acknowledgement, failed retry, stale response";
  await criteria("停止検証");
  await start.click();
  const old = await nextScan(3);
  cancelGate = deferred();
  cancelFails = true;
  const beforeCancel = cancelCalls;
  await panel.getByRole("button", { name: "検索を停止", exact: true }).click();
  await expect(status).toHaveText("停止を確認中…");
  await expect(start).toBeDisabled();
  await expect.poll(() => cancelCalls).toBe(beforeCancel + 1);
  cancelGate.resolve();
  cancelGate = null;
  await expect(status).toHaveText("停止の確認が必要です");
  await expect(start).toBeDisabled();
  cancelFails = false;
  await panel
    .getByRole("button", { name: "停止を再確認", exact: true })
    .click();
  await settled();
  await expect(status).toHaveText("検索を停止しました");
  await criteria("別条件の検証");
  await start.click();
  const fresh = await nextScan(4);
  await respond(old, [
    event({
      type: "complete",
      scanned: 199,
      matched: 20,
      saved: 199,
      resumeToken: null,
      reason: "target",
    }),
  ]);
  await expect(count).toHaveAttribute("aria-valuenow", "0");
  data = [candidate("別条件の検証 一致")];
  await respond(fresh, [
    event({
      type: "complete",
      scanned: 1,
      matched: 1,
      saved: 1,
      resumeToken: null,
      reason: "exhausted",
    }),
  ]);
  await settled();
  await expect(count).toHaveAttribute("aria-valuenow", "1");
  pass(
    "Stop acknowledgement gate, failed cancellation retry, and late old response cannot overwrite the new search progress",
  );

  stage = "upstream failure";
  await criteria("エラー検証");
  await start.click();
  const failed = await nextScan(5);
  failed.resolve({
    status: 502,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "UPSTREAM_ERROR", message: "合成外部取得エラー" },
    }),
  });
  await settled();
  await expect(status).toHaveText("検索を中断しました");
  await expect(panel.getByRole("alert")).toContainText("合成外部取得エラー");
  pass("Upstream failure settles activity and never announces completion");

  stage = "final list failure";
  await criteria("一覧エラー検証");
  await start.click();
  const failedList = await nextScan(6);
  listError = true;
  await respond(failedList, [
    event({
      type: "complete",
      scanned: 1,
      matched: 1,
      saved: 1,
      resumeToken: null,
      reason: "exhausted",
    }),
  ]);
  await expect(status).toHaveText("結果の一覧を更新できませんでした");
  await expect(list).toHaveAttribute("aria-busy", "false");
  await expect(list.getByRole("alert")).toContainText("合成一覧取得エラー");
  pass(
    "Final list failure is explicit instead of announcing a successful completed result",
  );
  stage = "resuming a reached target";
  await criteria("続きの検索検証");
  await start.click();
  const target = await nextScan(7);
  await respond(target, [
    event({
      type: "complete",
      reason: "target",
      scanned: 25,
      matched: 20,
      saved: 25,
    }),
  ]);
  await settled();
  await expect(matches).toHaveAttribute("aria-valuenow", "20");
  await panel
    .getByRole("button", { name: "さらに20社を探す", exact: true })
    .click();
  const resumed = await nextScan(8);
  await expect(status).toContainText("検索中");
  assert.equal(await matches.getAttribute("aria-valuenow"), null);
  await expect(matches).toHaveAttribute(
    "aria-valuetext",
    "20社（次の目標を確認中）",
  );
  await expect(count).toHaveAttribute("aria-valuenow", "25");
  await respond(resumed, [
    event({
      type: "complete",
      reason: "exhausted",
      scanned: 40,
      matched: 25,
      target: 40,
      saved: 40,
      resumeToken: null,
    }),
  ]);
  await settled();
  await expect(matches).toHaveAttribute("aria-valuenow", "25");
  await expect(matches).toHaveAttribute("aria-valuemax", "40");
  pass(
    "Resume keeps confirmed counts but waits for the next target before drawing its match bar",
  );
  assert.deepEqual(errors, [], "No browser runtime errors");
  await writeFile(
    output + "/evidence.json",
    JSON.stringify(
      { syntheticOnly: true, protocolMock: true, evidence },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("FAIL stage: " + stage);
  await page.screenshot({ path: output + "/failure.png" }).catch(() => {});
  // No raw network error dumps or credentials.
  console.error(error instanceof Error ? error.name : "Verification failure");
  const location = error?.stack?.match(
    /discovery-progress-e2e\.mjs:\d+:\d+/,
  )?.[0];
  if (location) console.error(location);
  process.exitCode = 1;
} finally {
  listGate?.resolve();
  cancelGate?.resolve();
  for (const scan of pending) scan.resolve({ status: 499, body: "closed" });
  await context.close();
  await browser.close();
}
