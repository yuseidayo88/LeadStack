// Real Auth/PostgREST/browser checks against a disposable local fixture only.
// Candidate records below are synthetic. No live Gbiz or public website is called.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

const base = process.env.E2E_BASE_URL || "http://localhost:3013";
const gateway = "http://127.0.0.1:55321";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
assert.ok(process.env.E2E_USERS_FILE, "Local fixture credentials are required");
const users = JSON.parse(await readFile(process.env.E2E_USERS_FILE, "utf8"));
const env = Object.fromEntries(
  (await readFile("/workspace/handoff/e2e-private/app.env", "utf8"))
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, ""),
    ]),
);
assert.equal(new URL(env.NEXT_PUBLIC_SUPABASE_URL).port, "55321");
assert.ok(
  ["localhost", "127.0.0.1"].includes(
    new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname,
  ),
);
const anonKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert.ok(anonKey);
const output = process.env.E2E_OUTPUT || "test-results/phone-research";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(error.name));
let stage = "setup";
const researchPosts = [];
page.on("request", (r) => {
  if (r.method() === "POST" && r.url().endsWith("/company-discovery")) {
    const body = r.postDataJSON();
    if (body.action === "research_phone") researchPosts.push(body.id);
  }
});
const pass = (message) => console.log("PASS: " + message);
const contexts = [context];

// Evaluate fetch inside the browser; never let a Playwright request exception
// print a cookie/header dump. Assertions below contain only status/code/labels.
async function request(p, path, method = "GET", body, status = 200) {
  const result = await p.evaluate(
    async ({ path, method, body }) => {
      try {
        const response = await fetch(path, {
          method,
          credentials: "same-origin",
          headers:
            body === undefined ? {} : { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          body: await response.json().catch(() => null),
        };
      } catch {
        return { status: 0, body: null };
      }
    },
    { path, method, body },
  );
  assert.equal(
    result.status,
    status,
    `${method} ${path} expected ${status}, received ${result.status} (${result.body?.error?.code || "no error code"})`,
  );
  return result.body;
}

async function direct(path, method, token, body, status = 200) {
  let response;
  try {
    response = await fetch(gateway + path, {
      method,
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Local Data API unavailable");
  }
  const responseBody = await response.json();
  assert.equal(
    response.status,
    status,
    `Local Data API ${method} expected ${status}, received ${response.status} (${responseBody?.code || responseBody?.error_code || "no error code"})`,
  );
  return responseBody;
}

async function tokenFor(user) {
  const session = await direct(
    "/auth/v1/token?grant_type=password",
    "POST",
    anonKey,
    { email: user.email, password: user.password },
  );
  assert.ok(session.access_token);
  return session.access_token;
}

async function login(p, user) {
  await p.goto(base + "/login?next=%2Fdiscover");
  await p.getByLabel("メールアドレス", { exact: true }).fill(user.email);
  await p.locator("input[name=password]").fill(user.password);
  const pending = p.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/login") && r.request().method() === "POST",
  );
  await p.getByRole("button", { name: "ログイン", exact: true }).click();
  assert.equal((await pending).status(), 200, "Login API");
  await p.waitForURL((url) => !url.pathname.startsWith("/login"));
}

async function organization(p, id, destination = "/discover") {
  await p.evaluate(
    (value) => localStorage.setItem("leadstack.organization", value),
    id,
  );
  await p.goto(base + destination);
  await expect(
    p.getByRole("heading", {
      name: destination === "/discover" ? "企業を探す" : "企業",
      exact: true,
    }),
  ).toBeVisible();
}

async function select(names) {
  const clear = page.getByRole("button", { name: "選択解除", exact: true });
  if (await clear.isVisible()) await clear.click();
  for (const name of names) {
    await page
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name, exact: true }) })
      .getByRole("checkbox")
      .check();
  }
  await page.getByRole("button", { name: /^電話番号を調べる/ }).click();
  return page.getByRole("dialog", { name: "電話番号を調べる", exact: true });
}
const posts = (action) =>
  page.waitForResponse(
    (r) =>
      r.url().endsWith("/company-discovery") &&
      r.request().method() === "POST" &&
      r.request().postDataJSON()?.action === action,
  );

try {
  await context.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    if (!["localhost", "127.0.0.1"].includes(host)) return route.abort();
    return route.continue();
  });
  stage = "local login and seed";
  await login(page, users.owner);
  const orgName = `電話調査E2E-${Date.now()}`;
  const org = (
    await request(page, "/api/organizations", "POST", { name: orgName }, 201)
  ).data.id;
  const root = `/api/organizations/${org}`;
  const endpoint = root + "/company-discovery";
  assert.equal((await request(page, endpoint)).configured, false);
  const token = await tokenFor(users.owner);
  const seed = [
    {
      key: "found",
      name: "01 電話調査検証 基本",
      website_url: "https://found.phone-fixture.test/",
    },
    {
      key: "detail",
      name: "02 電話調査検証 会社概要",
      website_url: "https://detail.phone-fixture.test/",
    },
    {
      key: "empty",
      name: "03 電話調査検証 番号なし",
      website_url: "https://empty.phone-fixture.test/",
    },
    {
      key: "blocked",
      name: "04 電話調査検証 自動取得不可",
      website_url: "https://blocked.phone-fixture.test/",
    },
    { key: "missing", name: "05 電話調査検証 URLなし" },
    {
      key: "existing",
      name: "06 電話調査検証 既存電話",
      phone: "0355556666",
      website_url: "https://existing.phone-fixture.test/",
    },
    {
      key: "slow",
      name: "07 電話調査検証 停止待ち",
      website_url: "https://slow.phone-fixture.test/",
    },
    {
      key: "later",
      name: "08 電話調査検証 未実行",
      website_url: "https://later.phone-fixture.test/",
    },
    ...Array.from({ length: 4 }, (_, n) => ({
      key: `extra${n}`,
      name: `${n + 9} 電話調査検証 追加${n}`,
    })),
  ];
  const rows = await direct(
    "/rest/v1/company_candidates",
    "POST",
    token,
    seed.map((item, n) => ({
      organization_id: org,
      corporate_number: String(8800000000000 + n),
      location: "東京都検証市1番地",
      prefecture_code: "13",
      prefecture: "東京都",
      industry_codes: ["E"],
      industry_labels: ["製造業"],
      employee_number: 25,
      phone: null,
      website_url: null,
      fetched_at: new Date().toISOString(),
      provenance: { fixture: "phone-research-local-only" },
      ...Object.fromEntries(
        Object.entries(item).filter(([key]) => key !== "key"),
      ),
    })),
    201,
  );
  const candidates = Object.fromEntries(
    seed.map((item) => [item.key, rows.find((r) => r.name === item.name)]),
  );
  const detail = async (key) =>
    (await request(page, `${endpoint}/${candidates[key].id}`)).candidate;
  await organization(page, org);
  await expect(
    page.getByRole("heading", { name: "取得済み候補 12 社", exact: true }),
  ).toBeVisible();

  stage = "real website extraction, immediate progress, no auto-save";
  let dialog = await select(seed.slice(0, 6).map((row) => row.name));
  await page.route(`**${endpoint}`, async (route) => {
    const req = route.request();
    if (
      req.method() === "POST" &&
      req.postDataJSON().action === "research_phone" &&
      req.postDataJSON().id === candidates.found.id
    )
      await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
  await dialog
    .getByRole("button", { name: "6社の調査を開始", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(dialog.getByRole("status")).toContainText("電話番号を調査中");
  await expect(
    dialog.getByRole("progressbar", { name: "電話番号調査の進捗" }),
  ).toHaveAttribute("aria-valuenow", "0");
  await expect(
    dialog.getByRole("progressbar", { name: "電話番号調査の進捗" }),
  ).toHaveAttribute("aria-valuemax", "6");
  await expect(
    dialog.getByLabel("電話番号の調査結果", { exact: true }),
  ).toHaveAttribute("aria-busy", "true");
  await expect(
    dialog.getByRole("button", { name: "調査を停止", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: output + "/research-running.png" });
  await expect(dialog.getByRole("status")).toHaveText("調査が完了しました。");
  await expect(
    dialog.getByRole("progressbar", { name: "電話番号調査の進捗" }),
  ).toHaveAttribute("aria-valuenow", "6");
  await expect(
    dialog.getByText("6 / 6社 · 残り0社", { exact: true }),
  ).toBeVisible();
  assert.equal(
    researchPosts.length,
    6,
    "Double click cannot start a second queue",
  );
  await expect(
    dialog.getByText("新規サイト調査 4社", { exact: false }),
  ).toBeVisible();
  await expect(
    dialog.getByText("公式URLが必要", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("自動取得できないサイト", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("電話番号が見つからず", { exact: true }),
  ).toBeVisible();
  const found = await detail("found");
  assert.equal(found.phone, null);
  assert.equal(found.enrichment_result.phone, "0312345678");
  assert.equal(
    (await detail("detail")).enrichment_result.sourceUrl,
    "https://detail.phone-fixture.test/company",
  );
  const foundCard = dialog.getByRole("article", {
    name: candidates.found.name,
    exact: true,
  });
  await expect(
    foundCard.getByRole("button", { name: "電話番号を保存", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: output + "/research-review-desktop.png" });
  pass(
    "6-company sequential pipeline, real extractor and DB evidence, outcomes, double-click prevention, no automatic phone saving",
  );

  stage = "cache and quota are not consumed twice";
  const beforeRequests = (
    await readFile(
      "/workspace/handoff/e2e-private/phone-requests.jsonl",
      "utf8",
    )
  )
    .trim()
    .split("\n").length;
  await dialog
    .getByRole("button", { name: "結果を再確認・未実行分を調査", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("調査が完了しました。");
  await expect(
    dialog.getByText("新規サイト調査 0社 · 結果の再利用 4社", { exact: false }),
  ).toBeVisible();
  assert.equal(
    (
      await readFile(
        "/workspace/handoff/e2e-private/phone-requests.jsonl",
        "utf8",
      )
    )
      .trim()
      .split("\n").length,
    beforeRequests,
  );
  pass(
    "24h cache reuses success, not-found and blocked outcomes without website requests",
  );

  stage = "mobile and reduced motion";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(
      async () => {
        const box = await dialog.boundingBox();
        return (
          !!box &&
          box.x >= -1 &&
          box.x + box.width <= 391 &&
          box.y >= -1 &&
          box.y + box.height <= 845
        );
      },
      { message: "Mobile dialog settles inside the viewport" },
    )
    .toBe(true);
  assert.ok(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    "No horizontal overflow",
  );
  await page.screenshot({ path: output + "/research-review-mobile.png" });
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    axe.violations.map((v) => ({ id: v.id, impact: v.impact })),
    [],
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  pass("390px mobile dialog, scrollable review, WCAG automated audit");

  stage = "confirmation and import with phone";
  await foundCard.getByRole("checkbox").check();
  let response = posts("confirm_phone");
  await foundCard
    .getByRole("button", { name: "電話番号を保存", exact: true })
    .click();
  assert.equal((await response).status(), 200);
  await expect(
    dialog.getByRole("button", {
      name: "電話番号ありの2社を取り込む",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByText("新規サイト調査 0社 · 結果の再利用 4社", { exact: false }),
  ).toBeVisible();
  assert.equal((await detail("found")).phone, "0312345678");
  assert.equal(
    (await detail("found")).employee_number,
    25,
    "Extracted employees do not overwrite existing count",
  );
  assert.equal((await detail("detail")).phone, null);
  await dialog
    .getByRole("button", { name: "電話番号ありの2社を取り込む", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "営業リストへの取込を確認",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "確認して取り込む", exact: true }),
  ).toBeEnabled();
  response = posts("import");
  await dialog
    .getByRole("button", { name: "確認して取り込む", exact: true })
    .click();
  const importResponse = await response;
  assert.equal(importResponse.status(), 200);
  const imported = await importResponse.json();
  assert.equal(imported.created_count, 2);
  const company = imported.items.find(
    (item) => item.candidate_id === candidates.found.id,
  );
  const savedCompany = (
    await request(page, `${root}/companies/${company.company_id}`)
  ).data;
  assert.equal(savedCompany.phone, "0312345678");
  const resultDialog = page.getByRole("dialog", {
    name: "営業リストに取り込みました",
    exact: true,
  });
  const importedRow = resultDialog
    .getByRole("listitem")
    .filter({ hasText: candidates.found.name });
  await importedRow.getByRole("button", { name: /架電を記録$/ }).click();
  const activity = page.getByRole("dialog").filter({
    has: page.getByRole("textbox", { name: "架電先電話番号", exact: true }),
  });
  await expect(
    activity.getByLabel("架電先電話番号", { exact: true }),
  ).toHaveValue("0312345678");
  await page.screenshot({ path: output + "/phone-to-call.png" });
  await page.keyboard.press("Escape");
  await resultDialog
    .getByRole("button", { name: "閉じる", exact: true })
    .first()
    .click();
  pass(
    "Explicit source review saves only phone, only phone-ready rows imported, actual call dialog receives correct phone",
  );

  stage = "stop waits for current result and does not start another site";
  dialog = await select([candidates.slow.name, candidates.later.name]);
  const beforeStop = researchPosts.length;
  await dialog
    .getByRole("button", { name: "2社の調査を開始", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("電話番号を調査中");
  const animation = await dialog
    .locator('[role="status"] span[aria-hidden]')
    .evaluate((el) => getComputedStyle(el).animationName);
  assert.equal(animation, "none", "Reduced motion disables spinner animation");
  await dialog.getByRole("button", { name: "調査を停止", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("停止中");
  await expect(
    dialog.getByRole("button", { name: "停止中…", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText("調査を停止しました");
  const stoppedProgress = dialog.getByRole("progressbar", {
    name: "電話番号調査の進捗",
  });
  await expect(stoppedProgress).toHaveAttribute("aria-valuenow", "1");
  await expect(stoppedProgress).toHaveAttribute("aria-valuemax", "2");
  await expect(
    dialog.getByText("1 / 2社 · 残り1社", { exact: true }),
  ).toBeVisible();
  assert.ok(
    await stoppedProgress
      .locator("div")
      .evaluate(
        (el) => parseFloat(getComputedStyle(el).transitionDuration) <= 0.01,
      ),
    "Reduced motion removes visible bar transition",
  );
  assert.equal(researchPosts.length - beforeStop, 1);
  assert.equal((await detail("slow")).enrichment_result.phone, "0312345678");
  assert.equal((await detail("later")).enrichment_result, null);
  await expect(
    dialog
      .getByRole("article", { name: candidates.later.name })
      .getByText("未実行", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: output + "/research-stopped.png" });
  await dialog
    .getByRole("button", { name: "閉じる", exact: true })
    .first()
    .click();
  pass(
    "Stop acknowledges completion of only current website; partial evidence persists and next website is untouched",
  );

  stage = "reload persistence and stale confirmation conflict";
  await page.reload();
  dialog = await select([candidates.detail.name]);
  await dialog
    .getByRole("button", { name: "1社の調査を開始", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("調査が完了しました。");
  await expect(
    dialog.getByText("保存済みの確認結果を表示しています。", { exact: true }),
  ).toBeVisible();
  const freshDetail = await detail("detail");
  await request(page, endpoint, "POST", {
    action: "update",
    id: freshDetail.id,
    expectedUpdatedAt: freshDetail.updated_at,
    phone: "0399998888",
    website_url: freshDetail.website_url,
    employee_number: freshDetail.employee_number,
  });
  await dialog.getByRole("checkbox").check();
  response = posts("confirm_phone");
  await dialog
    .getByRole("button", { name: "電話番号を保存", exact: true })
    .click();
  assert.equal((await response).status(), 409);
  await expect(dialog.getByRole("alert")).toContainText("候補が更新されました");
  assert.equal((await detail("detail")).phone, "0399998888");
  await dialog
    .getByRole("button", { name: "閉じる", exact: true })
    .first()
    .click();
  pass(
    "Reload reuses persisted evidence; concurrent edits cannot be overwritten by old confirmation",
  );

  stage = "hourly server quota stops queue";
  let quotaLeft = true;
  let reserved = 0;
  while (quotaLeft) {
    quotaLeft = await direct(
      "/rest/v1/rpc/reserve_company_discovery_request",
      "POST",
      token,
      { org, operation: "enrich" },
    );
    if (quotaLeft) reserved++;
    assert.ok(reserved <= 20);
  }
  assert.equal(
    reserved,
    15,
    "Only 5 actual website investigations consumed the existing hourly quota",
  );
  dialog = await select([candidates.later.name, candidates.extra0.name]);
  const quotaPosts = researchPosts.length;
  await dialog
    .getByRole("button", { name: "2社の調査を開始", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("調査を中断しました");
  await expect(dialog.getByRole("alert")).toContainText("確認回数の上限");
  assert.equal(researchPosts.length - quotaPosts, 1);
  assert.equal((await detail("later")).enrichment_result, null);
  await dialog
    .getByRole("button", { name: "閉じる", exact: true })
    .first()
    .click();
  pass(
    "Real persistent 20/hour quota, cache/known-phone/missing-URL do not consume quota, limit stops remaining queue",
  );

  stage = "selection cap and phone filter";
  const clear = page.getByRole("button", { name: "選択解除", exact: true });
  if (await clear.isVisible()) await clear.click();
  await page
    .getByRole("checkbox", {
      name: "このページの候補をすべて選択",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "電話番号を調べる（先頭10社）", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "電話番号を調べる", exact: true });
  await expect(
    dialog.getByRole("button", { name: "10社の調査を開始", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("article")).toHaveCount(10);
  await dialog
    .getByRole("button", { name: "閉じる", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "電話番号ありを表示", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "取得済み候補 3 社", exact: true }),
  ).toBeVisible();
  pass(
    "Batch capped at 10 companies; phone-only filter lists stored phone data",
  );

  stage = "viewer and tenant boundaries";
  await request(page, root + "/members", "POST", {
    action: "invite",
    email: users.viewer.email,
    role: "viewer",
  });
  const viewerContext = await browser.newContext();
  contexts.push(viewerContext);
  const viewer = await viewerContext.newPage();
  await login(viewer, users.viewer);
  const invitations = (await request(viewer, "/api/invitations")).data;
  const invitation = invitations.find(
    (row) => row.organization_name === orgName,
  );
  await request(viewer, "/api/invitations", "POST", {
    invitation_id: invitation.id,
  });
  await organization(viewer, org);
  await expect(
    viewer.getByRole("button", { name: /^電話番号を調べる/ }),
  ).toHaveCount(0);
  await request(
    viewer,
    endpoint,
    "POST",
    { action: "research_phone", id: candidates.later.id },
    403,
  );
  await request(
    viewer,
    endpoint,
    "POST",
    {
      action: "confirm_phone",
      id: candidates.later.id,
      expectedUpdatedAt: candidates.later.updated_at,
      confirmed: true,
    },
    403,
  );
  const another = (
    await request(
      page,
      "/api/organizations",
      "POST",
      { name: "電話調査 別組織" },
      201,
    )
  ).data.id;
  await request(
    page,
    `/api/organizations/${another}/company-discovery`,
    "POST",
    { action: "research_phone", id: candidates.later.id },
    404,
  );
  pass(
    "Real viewer cannot research/confirm, same user cannot research another organization's candidate",
  );
  assert.deepEqual(runtimeErrors, []);
  pass(
    "No browser runtime errors; no live GBiz, public website, or production database accessed",
  );
  console.log(
    JSON.stringify({ passed: true, org, groups: 10, screenshotFolder: output }),
  );
} catch (error) {
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
  console.error(`FAIL ${stage}: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const c of contexts) await c.close();
  await browser.close();
}
