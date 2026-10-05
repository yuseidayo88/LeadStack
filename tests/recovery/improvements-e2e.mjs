// Runs only against disposable local fixture users; Auth mail/password calls are intercepted.
import { chromium, devices, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.E2E_BASE_URL || "http://localhost:3002";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const users = JSON.parse(await readFile(process.env.E2E_USERS_FILE, "utf8"));
const output = process.env.E2E_OUTPUT || "test-results/improvements";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const log = (m) => console.log("PASS:", m);
async function login(p, u) {
  await p.goto(base + "/login");
  await p.getByLabel("メールアドレス", { exact: true }).fill(u.email);
  await p.locator("input[name=password]").fill(u.password);
  await p.getByRole("button", { name: "ログイン", exact: true }).click();
  await p.waitForURL("**/dashboard");
}
async function api(path, method = "GET", data) {
  const r = await ctx.request.fetch(base + path, {
    method,
    data,
    headers: { origin: base },
  });
  const b = await r.json();
  assert.ok(r.ok(), `${r.status()} ${b.error?.code}`);
  return b;
}
try {
  await login(page, users.owner);
  const org = (await api("/api/organizations")).data[0].id;
  const root = `/api/organizations/${org}`;
  const company = (await api(root + "/companies")).data.find((c) =>
    c.name.startsWith("E2E企業-"),
  );
  assert.ok(company);
  const before = (await api(root + "/companies")).count;
  await page.goto(base + "/companies");
  await page.getByRole("button", { name: "CSV取込", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("CSVファイル").setInputFiles({
    name: "日本語.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `\uFEFF会社名,電話番号,事業内容\r\n"日本,CSV商事",0312345678,"一行目\n二行目"\r\n${company.name},09000000000,重複\r\n,0123456789,名前なし\r\n`,
    ),
  });
  const previewResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/company-import") &&
      r.request().postDataJSON()?.action === "preview",
  );
  await dialog.getByRole("button", { name: "プレビュー", exact: true }).click();
  const preview = await (await previewResponse).json();
  assert.ok(preview.id);
  await expect(dialog.getByLabel("2行目を登録")).toBeChecked();
  await expect(dialog.getByLabel("3行目を登録")).not.toBeChecked();
  await expect(dialog.getByLabel("4行目を登録")).toBeDisabled();
  assert.equal((await api(root + "/companies")).count, before);
  await expect(
    dialog.getByRole("button", { name: "1件を登録する" }),
  ).toBeDisabled();
  await dialog.getByLabel("選択した行と重複候補を確認しました").check();
  await dialog.getByRole("button", { name: "1件を登録する" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "1件の企業を登録しました",
  );
  const imported = (await api(root + "/companies")).data.find(
    (c) => c.name === "日本,CSV商事",
  );
  assert.equal(imported.phone, "0312345678");
  const retry = await api(root + "/company-import", "POST", {
    action: "confirm",
    id: preview.id,
    rows: [2],
    confirmed: true,
  });
  assert.deepEqual(retry.ids, [imported.id]);
  assert.equal((await api(root + "/companies")).count, before + 1);
  await page.screenshot({ path: output + "/csv-confirmation-desktop.png" });
  log(
    "CSV Japanese/quoted preview → invalid/duplicate exclusion → explicit confirmation → idempotent DB save",
  );
  await page.goto(`${base}/companies/${company.id}`);
  await page.getByRole("button", { name: "架電を記録", exact: true }).click();
  await dialog.locator("select[name=result]").selectOption("callback");
  await expect(dialog.getByLabel("次回の再架電タスクを作成")).toBeChecked();
  await expect(dialog.getByLabel("次回の再架電タスクを作成")).toBeDisabled();
  await dialog.getByRole("button", { name: "活動を保存", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("再架電日時", { exact: true })).toHaveValue(
    "",
  );
  await dialog
    .getByLabel("再架電日時", { exact: true })
    .fill("2026-10-06T10:00");
  const next = (await api(`${root}/companies/${company.id}/next`)).company;
  assert.ok(next);
  await dialog.getByRole("button", { name: "保存して次の企業へ" }).click();
  await page.waitForURL(`${base}/companies/${next.id}`);
  log(
    "callback auto-prompts required date; save-and-next persists then navigates",
  );
  await api(root + "/tasks", "POST", {
    company_id: company.id,
    assigned_user_id: users.owner.id,
    title: "期限超過フォロー",
    type: "follow_up",
    due_at: "2026-01-01T01:00:00Z",
  });
  const noTask = (
    await api(root + "/companies", "POST", {
      name: "次のタスクなし検証",
      assigned_user_id: users.owner.id,
    })
  ).data;
  const latestBefore = (await api(root + "/companies")).data.find(
    (c) => c.id === company.id,
  ).last_contact_at;
  assert.ok(latestBefore);
  await api(root + "/activities", "POST", {
    company_id: company.id,
    type: "memo",
    content: "社内メモ",
    occurred_at: "2027-01-01T00:00:00Z",
  });
  assert.equal(
    (await api(root + "/companies")).data.find((c) => c.id === company.id)
      .last_contact_at,
    latestBefore,
  );
  const dash = await api(root + "/dashboard");
  assert.ok(dash.overdue.some((t) => t.title === "期限超過フォロー"));
  assert.ok(dash.missingNext.some((c) => c.id === noTask.id));
  await page.goto(base + "/dashboard");
  await expect(
    page.getByText("期限超過フォロー", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: noTask.name, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: output + "/daily-actions-desktop.png",
    fullPage: true,
  });
  log(
    "dashboard overdue/non-callback and missing-next actions; memo does not advance last contact",
  );
  await page.goto(`${base}/companies/${company.id}`);
  await page.getByRole("tab", { name: "改善提案", exact: true }).click();
  await page.getByText("ヒアリングから下書きを作成", { exact: true }).click();
  for (const label of [
    "根拠となる業務",
    "根拠となる課題",
    "根拠となる利用ツール",
  ])
    await page.getByLabel(label).selectOption({ index: 1 });
  await page.getByLabel("選択した登録情報をヒアリングで確認済み").check();
  for (const title of ["新規システム構築", "n8n 自動化", "既存ツール維持"]) {
    await page
      .getByRole("button", { name: title + "の下書きを確認", exact: true })
      .click();
    await expect(dialog.getByLabel("提案理由", { exact: false })).toContainText(
      "",
    );
    assert.match(
      await dialog.getByLabel("提案理由", { exact: false }).inputValue(),
      /登録情報/,
    );
    assert.match(
      await dialog.getByLabel("提案内容", { exact: false }).inputValue(),
      /要確認/,
    );
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/proposals") && r.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    assert.equal((await response).status(), 201);
    await expect(dialog).toHaveCount(0);
  }
  const drafted = (
    await api(root + "/proposals?company_id=" + company.id)
  ).data.filter((p) => p.generated_by === "rule");
  assert.equal(drafted.length, 3);
  assert.ok(drafted.every((d) => d.status === "draft"));
  assert.deepEqual(
    drafted.find((d) => d.type === "automate").automation_config.tools,
    ["Excel"],
  );
  log(
    "confirmed hearing → editable build/automate/keep drafts → persisted provenance and automation tools",
  );
  const viewerCtx = await browser.newContext();
  const vp = await viewerCtx.newPage();
  await login(vp, users.viewer);
  const denied = await viewerCtx.request.post(base + root + "/company-import", {
    headers: { origin: base },
    data: { action: "preview", csv: "会社名\n不可" },
  });
  assert.equal(denied.status(), 403);
  await vp.goto(base + "/companies");
  await expect(vp.getByRole("button", { name: "CSV取込" })).toHaveCount(0);
  await viewerCtx.close();
  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    storageState: await ctx.storageState(),
  });
  const mp = await mobile.newPage();
  await mp.goto(base + "/companies");
  await mp.getByRole("button", { name: "CSV取込" }).click();
  await expect(mp.getByRole("dialog")).toBeVisible();
  assert.ok(
    await mp.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await mp.screenshot({ path: output + "/csv-mobile.png" });
  await mobile.close();
  log("viewer import denied and mobile CSV dialog stays within viewport");
  // Browser transport mocks: no real email delivery or password update.
  await page.goto(base + "/reset-password");
  await page.waitForURL("**/login?error=confirmation");
  log("ordinary session cannot open recovery-only password form");
  await page.goto(base + "/login");
  let requests = 0;
  await page.route("**/api/auth/reset-password", (r) => {
    requests++;
    return r.fulfill({
      status: requests === 1 ? 429 : 200,
      contentType: "application/json",
      body:
        requests === 1
          ? '{"error":{"code":"rate_limited","message":"時間を置いて再試行してください"}}'
          : '{"ok":true}',
    });
  });
  await page.getByRole("button", { name: "パスワードを忘れた方" }).click();
  await page.getByLabel("送信先メールアドレス").fill("nobody@example.test");
  await page.getByRole("button", { name: "メールを送信", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "再試行" }),
  ).toContainText("再試行");
  await page.getByRole("button", { name: "メールを送信", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("対象のアカウント");
  await page.route("**/api/auth/resend-confirmation", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"ok":true}',
    }),
  );
  await page
    .getByRole("button", { name: "確認メールを再送", exact: true })
    .click();
  await page.getByLabel("送信先メールアドレス").fill("nobody@example.test");
  await page.getByRole("button", { name: "メールを送信", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("対象のアカウント");
  await page.screenshot({ path: output + "/auth-recovery-desktop.png" });
  log("recovery/resend UI + retry tested with mocked delivery");
  assert.deepEqual(errors, []);
  log("all improvement flows passed; browser page errors = 0");
} finally {
  await browser.close();
}
