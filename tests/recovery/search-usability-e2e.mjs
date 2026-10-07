import { expandSearchOptions } from "./search-options.mjs";
// Real Auth/PostgREST/browser checks against a disposable local fixture only.
// Candidate records below are synthetic. No live Gbiz or public website is called.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.E2E_BASE_URL || "http://localhost:3012";
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
const output = process.env.E2E_OUTPUT || "test-results/search-usability";
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
const pass = (message) => console.log("PASS: " + message);
const contexts = [context];
const loggedInPages = [];
const tokenSessions = [];

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
  tokenSessions.push(session.access_token);
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
  loggedInPages.push(p);
}

async function organization(p, id, destination = "/discover") {
  await p.evaluate(
    (value) => localStorage.setItem("leadstack.organization", value),
    id,
  );
  await p.goto(base + destination);
  if (destination === "/discover") await expandSearchOptions(p);
  await expect(
    p.getByRole("heading", {
      name: destination === "/discover" ? "企業を探す" : "営業リスト",
      exact: true,
    }),
  ).toBeVisible();
}

async function choose(p, label, option, search = option) {
  await p.getByRole("combobox", { name: label, exact: true }).click();
  const popover = p.locator('[data-slot="popover-content"]');
  await popover
    .getByRole("combobox", { name: `${label}を検索`, exact: true })
    .fill(search);
  await popover.getByRole("option", { name: option, exact: true }).click();
}

const organizations = [];
let ownerToken;
let externalStarts = 0;
page.on("request", (req) => {
  if (req.method() === "POST" && req.url().includes("/company-discovery"))
    externalStarts++;
});
const savedRegion = (p = page) =>
  p.getByRole("region", { name: "保存した検索条件", exact: true });
const callSaved = (name, p = page) =>
  savedRegion(p).getByRole("button", {
    name: `保存条件「${name}」を呼び出す`,
    exact: true,
  });
async function save(name, p = page) {
  await savedRegion(p)
    .getByRole("button", { name: "条件を保存", exact: true })
    .click();
  const dialog = p.getByRole("dialog", { name: "検索条件を保存", exact: true });
  await dialog.getByLabel("条件名", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(callSaved(name, p)).toBeVisible();
}
async function count(n) {
  await expect(
    page.getByRole("heading", { name: `取得済み候補 ${n} 社`, exact: true }),
  ).toBeVisible();
}
try {
  stage = "login and own synthetic fixture";
  await context.route("**/*", (route) =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  await login(page, users.owner);
  ownerToken = await tokenFor(users.owner);
  const ownerId = (await request(page, "/api/profile")).data.id;
  for (const suffix of ["A", "B"]) {
    const org = (
      await request(
        page,
        "/api/organizations",
        "POST",
        { name: `条件保存E2E-${suffix}-${Date.now()}` },
        201,
      )
    ).data.id;
    organizations.push(org);
  }
  const [orgA, orgB] = organizations;
  const scope = { actorId: ownerId, base: `/api/organizations/${orgA}` };
  const key = `leadstack.discovery.saved-searches.v1.${ownerId}.${scope.base}`;
  const keyB = `leadstack.discovery.saved-searches.v1.${ownerId}./api/organizations/${orgB}`;
  const rows = Array.from({ length: 2 }, (_, i) => ({
    organization_id: orgA,
    corporate_number: String(8400000000000 + i),
    name: `保存条件検証${i + 1}法人`,
    location: "東京都検証市",
    prefecture: "東京都",
    prefecture_code: "13",
    industry_codes: ["D"],
    industry_labels: ["建設業"],
    employee_number: 20,
    website_url: "https://example.test/",
    phone: i === 0 ? "03-1234-5678" : null,
    provenance: {},
    fetched_at: new Date().toISOString(),
  }));
  await direct("/rest/v1/company_candidates", "POST", ownerToken, rows, 201);
  await organization(page, orgA);
  await choose(page, "都道府県", "東京都");
  await choose(page, "業種", "建設業");
  await page.getByLabel("従業員数の下限", { exact: true }).fill("10");
  await page.getByLabel("従業員数の上限", { exact: true }).fill("50");
  await page.getByLabel("電話番号あり", { exact: true }).check();
  await count(1);
  await save("東京の架電候補");
  pass(
    "Named conditions save through the real authenticated page; the filtered candidate list uses the real local Data API",
  );

  stage = "restore criteria without force refresh or an external scan";
  await choose(page, "都道府県", "大阪府");
  await page.getByLabel("従業員数の下限", { exact: true }).fill("5");
  await page.getByLabel("電話番号あり", { exact: true }).uncheck();
  await page
    .getByLabel("取得済みの企業情報も更新する（時間がかかります）", {
      exact: true,
    })
    .check();
  await callSaved("東京の架電候補").click();
  await expect(
    page.getByRole("combobox", { name: "都道府県", exact: true }),
  ).toContainText("東京都");
  await expect(page.getByLabel("従業員数の下限", { exact: true })).toHaveValue(
    "10",
  );
  await expect(page.getByLabel("従業員数の上限", { exact: true })).toHaveValue(
    "50",
  );
  await expect(page.getByLabel("電話番号あり", { exact: true })).toBeChecked();
  await expect(
    page.getByLabel("取得済みの企業情報も更新する（時間がかかります）", {
      exact: true,
    }),
  ).not.toBeChecked();
  await count(1);
  assert.equal(externalStarts, 0);
  pass(
    "Restore recovers region, industry, people and phone conditions, clears force-refresh mode, and starts zero external searches",
  );

  stage = "individual removal and selection reset";
  await page
    .getByRole("checkbox", { name: "保存条件検証1法人を選択", exact: true })
    .check();
  await expect(
    page.getByText("1 / 50 社を選択中", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "指定中の検索条件", exact: true })
    .getByRole("button", { name: "電話番号ありの条件を解除", exact: true })
    .click();
  await count(2);
  await expect(
    page.getByText("1 / 50 社を選択中", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "都道府県", exact: true }),
  ).toContainText("東京都");
  await expect(
    page.getByRole("combobox", { name: "業種", exact: true }),
  ).toContainText("建設業");
  await expect(page.getByLabel("従業員数の下限", { exact: true })).toHaveValue(
    "10",
  );
  await page.reload();
  await expandSearchOptions(page);
  await expect(callSaved("東京の架電候補")).toBeVisible();
  await expect(
    page.getByLabel("電話番号あり", { exact: true }),
  ).not.toBeChecked();
  await callSaved("東京の架電候補").click();
  await count(1);
  pass(
    "One filter can be removed without losing area or industry; selections reset; reload preserves saved conditions without applying them automatically",
  );

  stage = "duplicate names and organization/actor scopes";
  await savedRegion()
    .getByRole("button", { name: "条件を保存", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "検索条件を保存",
    exact: true,
  });
  await dialog.getByLabel("条件名", { exact: true }).fill("東京の架電候補");
  await dialog.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("同じ名前");
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  const original = await page.evaluate((key) => localStorage.getItem(key), key);
  await organization(page, orgB);
  await expect(callSaved("東京の架電候補")).toHaveCount(0);
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: keyB,
    value: original,
  });
  await page.reload();
  await expandSearchOptions(page);
  await expect(callSaved("東京の架電候補")).toHaveCount(0);
  await page.evaluate(
    ({ key, value }) =>
      localStorage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(value), actorId: "other-fixture-user" }),
      ),
    { key, value: original },
  );
  await organization(page, orgA);
  await expect(callSaved("東京の架電候補")).toHaveCount(0);
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key,
    value: original,
  });
  await page.reload();
  await expandSearchOptions(page);
  await expect(callSaved("東京の架電候補")).toBeVisible();
  pass(
    "Duplicate names never overwrite; another organization's or actor's stored payload is ignored even when copied under the current key",
  );

  stage = "two-tab save merge and independent current filters";
  await page
    .getByRole("checkbox", { name: "保存条件検証1法人を選択", exact: true })
    .check();
  const second = await context.newPage();
  second.setDefaultTimeout(15000);
  await second.goto(base + "/discover");
  await expandSearchOptions(second);
  await expect(callSaved("東京の架電候補", second)).toBeVisible();
  await choose(second, "都道府県", "大阪府");
  await Promise.all([save("東京の追加条件"), save("大阪の追加条件", second)]);
  for (const p of [page, second]) {
    await expect(callSaved("東京の追加条件", p)).toBeVisible();
    await expect(callSaved("大阪の追加条件", p)).toBeVisible();
  }
  await expect(
    page.getByRole("combobox", { name: "都道府県", exact: true }),
  ).toContainText("東京都");
  await expect(
    second.getByRole("combobox", { name: "都道府県", exact: true }),
  ).toContainText("大阪府");
  await savedRegion(second)
    .getByRole("button", {
      name: "保存条件「大阪の追加条件」を削除",
      exact: true,
    })
    .click();
  await expect(callSaved("大阪の追加条件")).toHaveCount(0);
  await expect(callSaved("東京の架電候補")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "都道府県", exact: true }),
  ).toContainText("東京都");
  await second.close();
  await expect(
    page.getByText("1 / 50 社を選択中", { exact: true }),
  ).toBeVisible();
  pass(
    "Simultaneous tab saves retain both entries; deletion syncs without changing the other tab's current filters",
  );

  stage = "quota failure leaves stored conditions intact";
  const beforeFailure = await page.evaluate(
    (key) => localStorage.getItem(key),
    key,
  );
  await page.evaluate((key) => {
    window.__savedSearchSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === key)
        throw new DOMException("Synthetic storage limit", "QuotaExceededError");
      return window.__savedSearchSetItem.call(this, k, v);
    };
  }, key);
  await savedRegion()
    .getByRole("button", { name: "条件を保存", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "検索条件を保存", exact: true });
  await dialog.getByLabel("条件名", { exact: true }).fill("保存失敗検証");
  await dialog.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("保存できませんでした");
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), key),
    beforeFailure,
  );
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__savedSearchSetItem;
    delete window.__savedSearchSetItem;
  });
  pass(
    "Storage failure is visible, leaves the dialog recoverable and preserves existing saved conditions",
  );

  stage = "ten-item limit and narrow viewport";
  const stored = JSON.parse(beforeFailure);
  const longName = "東京都の設備工事会社の業務効率化営業候補"
    .repeat(2)
    .slice(0, 40);
  const full = {
    ...stored,
    items: Array.from({ length: 10 }, (_, i) => ({
      ...stored.items[0],
      id: randomUUID(),
      name: i === 0 ? longName : `条件${i}`,
    })),
  };
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key,
    value: JSON.stringify(full),
  });
  await page.reload();
  await expandSearchOptions(page);
  await savedRegion()
    .getByRole("button", { name: "条件を保存", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "検索条件を保存", exact: true });
  await dialog.getByLabel("条件名", { exact: true }).fill("11件目");
  await dialog.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("10件まで");
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(savedRegion().getByRole("alert")).toHaveCount(0);
  await expect
    .poll(() =>
      savedRegion().evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    )
    .toBe(true);
  await savedRegion().scrollIntoViewIfNeeded();
  await page.screenshot({ path: output + "/saved-searches-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: output + "/saved-searches-desktop.png" });
  assert.equal(
    externalStarts,
    0,
    "No action tested here may acquire, scan or enrich companies",
  );
  assert.deepEqual(runtimeErrors, []);
  pass(
    "Ten-item cap is enforced; long Japanese names fit 390px; browser is clean; all operations start zero external searches",
  );
  console.log(
    "PASS: Seven saved-search and filter E2E groups completed with the own local fixture only",
  );
} catch (error) {
  console.error(
    `FAIL: Search usability stage '${stage}' (${error instanceof Error ? error.name : "UnknownError"})`,
  );
  const location = error?.stack?.match(
    /search-usability-e2e\.mjs:\d+:\d+/,
  )?.[0];
  if (location) console.error(location);
  if (error?.name === "AssertionError")
    console.error(error.message.split("\n").slice(0, 3).join("\n"));
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  if (ownerToken)
    for (const org of organizations)
      await direct(
        `/rest/v1/company_candidates?organization_id=eq.${org}`,
        "DELETE",
        ownerToken,
      ).catch(() => {
        process.exitCode = 1;
      });
  for (const p of loggedInPages)
    await request(p, "/api/auth/logout", "POST", {}).catch(() => {});
  for (const token of tokenSessions)
    await fetch(gateway + "/auth/v1/logout?scope=local", {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser.close();
}
