// New local-only E2E, not recovered original tests. Requires a disposable Auth/PostgREST DB.
import { chromium, devices, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.E2E_BASE_URL || "http://localhost:3001";
assert.ok(
  ["localhost", "127.0.0.1"].includes(new URL(base).hostname),
  "Local E2E only",
);
assert.ok(
  process.env.E2E_USERS_FILE,
  "E2E_USERS_FILE required (local fixture accounts only)",
);
const users = JSON.parse(await readFile(process.env.E2E_USERS_FILE, "utf8"));
const browser = await chromium.launch({ headless: true });
const output = process.env.E2E_OUTPUT || "test-results/authenticated-e2e";
await mkdir(output, { recursive: true });
const stamp = Date.now();
const log = (msg) => console.log("PASS:", msg);
async function login(page, user, next = "/companies") {
  await page.goto(`${base}/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("メールアドレス", { exact: true }).fill(user.email);
  await page.locator("input[name=password]").fill(user.password);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  assert.equal((await response).status(), 200, "login API");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}
async function api(context, path, method = "GET", data) {
  const r = await context.request.fetch(base + path, {
    method,
    data,
    headers: { origin: base },
  });
  const body = await r.json();
  assert.ok(
    r.ok(),
    `${method} ${path}: ${r.status()} ${body.error?.code || ""}`,
  );
  return body;
}
async function saveDialog(page, endpoint, button = "保存") {
  const pending = page.waitForResponse(
    (r) =>
      r.url().includes(endpoint) &&
      ["POST", "PATCH"].includes(r.request().method()),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: button, exact: true })
    .click();
  const r = await pending;
  assert.ok(
    r.ok(),
    `${endpoint}: ${r.status()} ${(await r.json()).error?.code || ""}`,
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let org, company;
try {
  await login(page, users.owner);
  await page
    .getByRole("heading", { name: "チームのワークスペースを用意" })
    .waitFor();
  await page.getByLabel("組織名", { exact: true }).fill(`E2E組織-${stamp}`);
  const orgResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/organizations") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "ワークスペースを作成" }).click();
  org = (await (await orgResponse).json()).data.id;
  await page.waitForURL("**/dashboard");
  await page.goto(base + "/companies");
  await page
    .getByRole("button", { name: "新規企業登録", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("会社名", { exact: false })
    .fill(`E2E企業-${stamp}`);
  await page
    .getByRole("dialog")
    .getByLabel("電話番号", { exact: true })
    .fill("03-0000-0000");
  await saveDialog(page, `/${org}/companies`);
  const companies = await api(ctx, `/api/organizations/${org}/companies`);
  company = companies.data.find((c) => c.name === `E2E企業-${stamp}`).id;
  await page.goto(`${base}/companies/${company}`);
  await page
    .getByRole("heading", { name: `E2E企業-${stamp}`, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "担当者を追加", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("担当者名", { exact: false })
    .fill("検証担当者");
  await saveDialog(page, `/${org}/contacts`);
  assert.equal(
    (await api(ctx, `/api/organizations/${org}/contacts?company_id=${company}`))
      .data.length,
    1,
  );
  log("real local login → onboarding → company/contact UI → DB");
  await page.getByRole("button", { name: "架電を記録", exact: true }).click();
  await page
    .getByRole("dialog")
    .locator("select[name=result]")
    .selectOption("callback");
  await page
    .getByRole("dialog")
    .getByLabel("活動メモ", { exact: true })
    .fill("ローカルE2E架電");
  await expect(
    page
      .getByRole("dialog")
      .getByLabel("次回の再架電タスクを作成", { exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("dialog").getByLabel("再架電日時", { exact: true }),
  ).toHaveAttribute("required", "");
  await page
    .getByRole("dialog")
    .getByText("活動の詳細（種類・日時・担当者など）", { exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("再架電タスク名", { exact: true })
    .fill("E2E折返し");
  await page
    .getByRole("dialog")
    .getByLabel("再架電日時", { exact: true })
    .fill("2026-10-05T10:00");
  await saveDialog(page, `/${org}/activities`, "活動を保存");
  const tasks = (
    await api(ctx, `/api/organizations/${org}/tasks?company_id=${company}`)
  ).data;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "E2E折返し");
  const activity = (
    await api(ctx, `/api/organizations/${org}/activities?company_id=${company}`)
  ).data;
  assert.equal(activity[0].call_details.result, "callback");
  await page.goto(base + "/tasks?period=all");
  await page
    .getByRole("button", { name: "E2E折返しを完了する", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await api(ctx, `/api/organizations/${org}/tasks/${tasks[0].id}`)).data
          .status,
    )
    .toBe("completed");
  log("call + callback atomic save; task completion UI persisted");
  await page.goto(`${base}/companies/${company}`);
  await page.getByRole("tab", { name: "商談", exact: true }).click();
  await page.getByRole("button", { name: "商談を追加", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("案件名", { exact: false })
    .fill("E2E商談");
  await page
    .getByRole("dialog")
    .getByLabel("初期費用（円）", { exact: true })
    .fill("150000");
  await saveDialog(page, `/${org}/deals`);
  const deal = (
    await api(ctx, `/api/organizations/${org}/deals?company_id=${company}`)
  ).data[0];
  await page.getByRole("combobox", { name: /E2E商談/ }).selectOption("won");
  await expect
    .poll(
      async () =>
        (await api(ctx, `/api/organizations/${org}/deals/${deal.id}`)).data
          .stage,
    )
    .toBe("won");
  log("deal create → won through UI persisted");
  await page.getByRole("tab", { name: "業務ヒアリング", exact: true }).click();
  await page.getByRole("button", { name: "業務を追加", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("業務の種類", { exact: false })
    .selectOption("billing");
  await page
    .getByRole("dialog")
    .getByLabel("現在の運用方法", { exact: false })
    .fill("Excel");
  await page
    .getByRole("dialog")
    .getByLabel("業務内容", { exact: true })
    .fill("毎月の請求処理");
  await saveDialog(page, `/${org}/business_processes`);
  await page
    .getByRole("button", { name: "利用ツールを追加", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("ツール名", { exact: false })
    .fill("Excel");
  await saveDialog(page, `/${org}/company_tools`);
  await page.getByRole("button", { name: "課題を追加", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("課題の種類", { exact: false })
    .selectOption("duplicate_entry");
  await saveDialog(page, `/${org}/pain_points`);
  await page.getByRole("tab", { name: "改善提案", exact: true }).click();
  for (const type of ["build", "automate", "keep"]) {
    await page
      .getByRole("button", { name: "改善提案を追加", exact: true })
      .first()
      .click();
    const d = page.getByRole("dialog");
    await d.getByLabel("提案の種類", { exact: false }).selectOption(type);
    await d.getByLabel("提案名", { exact: false }).fill(`E2E-${type}`);
    if (type === "automate") {
      await d.getByLabel("きっかけ", { exact: false }).fill("請求締め日");
      await d.getByLabel("処理の流れ", { exact: false }).fill("集計\n承認依頼");
    }
    await saveDialog(page, `/${org}/proposals`);
  }
  assert.equal(
    (
      await api(
        ctx,
        `/api/organizations/${org}/proposals?company_id=${company}`,
      )
    ).data.length,
    3,
  );
  log("hearing/tools/pain points + build/automate/keep proposals UI persisted");
  await page.screenshot({
    path: output + "/proposals-desktop.png",
    fullPage: true,
  });
  // Viewer joins via the actual application invitation endpoints, no DB bypass.
  await api(ctx, `/api/organizations/${org}/members`, "POST", {
    action: "invite",
    email: users.viewer.email,
    role: "viewer",
  });
  const viewerCtx = await browser.newContext();
  const viewerPage = await viewerCtx.newPage();
  await login(viewerPage, users.viewer);
  const invites = (await api(viewerCtx, "/api/invitations")).data;
  await api(viewerCtx, "/api/invitations", "POST", {
    invitation_id: invites[0].id,
  });
  await viewerPage.goto(`${base}/companies/${company}`);
  await viewerPage
    .getByRole("heading", { name: `E2E企業-${stamp}`, exact: true })
    .waitFor();
  await expect(
    viewerPage.getByRole("button", { name: "架電を記録" }),
  ).toHaveCount(0);
  const viewerWrite = await viewerCtx.request.post(
    `${base}/api/organizations/${org}/companies`,
    { data: { name: "blocked" }, headers: { origin: base } },
  );
  assert.equal(viewerWrite.status(), 403);
  const otherCtx = await browser.newContext();
  const otherPage = await otherCtx.newPage();
  await login(otherPage, users.other);
  const otherOrg = (
    await api(otherCtx, "/api/organizations", "POST", { name: "E2E別組織" })
  ).data.id;
  assert.notEqual(otherOrg, org);
  const forbidden = await otherCtx.request.get(
    `${base}/api/organizations/${org}/companies/${company}`,
  );
  assert.equal(forbidden.status(), 403);
  log(
    "actual Auth/PostgREST: viewer UI/API write denied; other tenant API denied",
  );
  await viewerCtx.close();
  await otherCtx.close();
  // Persisted cookie context approximates browser restart; never save real account credentials.
  const state = await ctx.storageState();
  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    storageState: state,
  });
  const mp = await mobile.newPage();
  mp.setDefaultTimeout(15000);
  await mp.goto(`${base}/companies/${company}`);
  await mp
    .getByRole("heading", { name: `E2E企業-${stamp}`, exact: true })
    .waitFor();
  await mp.reload();
  await mp
    .getByRole("heading", { name: `E2E企業-${stamp}`, exact: true })
    .waitFor();
  await mp.goto(base + "/tasks?period=all");
  await mp.goBack();
  await mp
    .getByRole("heading", { name: `E2E企業-${stamp}`, exact: true })
    .waitFor();
  await mp.screenshot({ path: output + "/company-mobile.png", fullPage: true });
  log("iPhone-size Chromium: persisted session + reload + back navigation");
  // Force stored expires_at into the past to exercise actual refresh token rotation.
  const cookies = await mobile.cookies();
  const authCookies = cookies
    .filter((c) => c.name.includes("-auth-token"))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.ok(authCookies.length);
  const packed = authCookies.map((c) => c.value).join("");
  assert.ok(packed.startsWith("base64-"));
  const session = JSON.parse(
    Buffer.from(packed.slice(7), "base64url").toString(),
  );
  const oldRefresh = session.refresh_token;
  session.expires_at = 1;
  const encoded =
    "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  await mobile.clearCookies({ name: /-auth-token/ });
  const originalName = authCookies[0].name.replace(/\.\d+$/, "");
  await mobile.addCookies(
    Array.from({ length: Math.ceil(encoded.length / 3180) }, (_, i) => ({
      ...authCookies[0],
      name: encoded.length > 3180 ? originalName + "." + i : originalName,
      value: encoded.slice(i * 3180, (i + 1) * 3180),
    })),
  );
  await mp.reload();
  await mp
    .getByRole("heading", { name: `E2E企業-${stamp}`, exact: true })
    .waitFor();
  const fresh = (await mobile.cookies())
    .filter((c) => c.name.includes("-auth-token"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => c.value)
    .join("");
  assert.notEqual(
    JSON.parse(Buffer.from(fresh.slice(7), "base64url").toString())
      .refresh_token,
    oldRefresh,
  );
  log(
    "expired stored session refresh rotates token and retains authenticated page",
  );
  await api(mobile, "/api/auth/logout", "POST", {});
  await mp.goto(`${base}/companies/${company}`);
  await mp.waitForURL((url) => url.pathname === "/login");
  await mp
    .getByLabel("メールアドレス", { exact: true })
    .fill(users.owner.email);
  await mp.locator("input[name=password]").fill("intentionally-wrong-password");
  const rejected = mp.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/login") && r.request().method() === "POST",
  );
  await mp.getByRole("button", { name: "ログイン", exact: true }).click();
  assert.equal((await rejected).status(), 401);
  await mp
    .getByText(
      "ログインできませんでした。メールアドレスとパスワードを確認してください",
      { exact: true },
    )
    .waitFor();
  await expect(
    mp.getByRole("button", { name: "ログイン", exact: true }),
  ).toBeEnabled();
  log(
    "mobile wrong password shows actionable message and re-enables submission",
  );
  await login(mp, users.owner, `/companies/${company}`);
  await mp
    .getByRole("heading", { name: `E2E企業-${stamp}`, exact: true })
    .waitFor();
  log("logout protects page; next destination restored after mobile login");
  await mobile.close();
  assert.deepEqual(errors, []);
  log("no desktop page exceptions");
} catch (error) {
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
  console.error("E2E failed:", error.message);
  throw error;
} finally {
  await browser.close();
}
