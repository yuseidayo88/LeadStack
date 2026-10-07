// Real Auth/PostgREST/browser checks against a disposable local fixture only.
// Candidate records below are synthetic. No live Gbiz or public website is called.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

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
const output = process.env.E2E_OUTPUT || "test-results/ui-remainder";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  timezoneId: "America/Los_Angeles",
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const runtimeErrors = [];
page.on("pageerror", (error) => runtimeErrors.push(error.name));
let stage = "setup";
const pass = (message) => console.log("PASS: " + message);
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

async function choose(p, label, option, search = option) {
  await p.getByRole("combobox", { name: label, exact: true }).click();
  const popover = p.locator('[data-slot="popover-content"]');
  await popover
    .getByRole("combobox", { name: `${label}を検索`, exact: true })
    .fill(search);
  await popover.getByRole("option", { name: option, exact: true }).click();
}

let org, ownerToken, root;
async function saveDialog(resource, method = "POST", status = 201) {
  const pending = page.waitForResponse(
    (r) => r.url().includes(`/${resource}`) && r.request().method() === method,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  assert.equal((await pending).status(), status);
  if (status < 400) await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function audit() {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    result.violations.map((violation) => violation.id),
    [],
  );
}
async function capture(name, fullPage = false) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "Page must fit viewport",
  );
  await page.screenshot({ path: output + "/" + name + ".png", fullPage });
}
try {
  await context.route("**/*", (route) =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  stage = "login and isolated fixture";
  await page.goto(base + "/login");
  await expect(
    page.getByRole("heading", { name: "ログイン", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("YOUR SALES WORKSPACE", { exact: true }),
  ).toHaveCount(0);
  await capture("login-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("login-mobile");
  await login(page, users.owner);
  ownerToken = await tokenFor(users.owner);
  const ownerId = (await request(page, "/api/profile")).data.id;
  org = (
    await request(
      page,
      "/api/organizations",
      "POST",
      { name: "残りのUI検証-" + Date.now() },
      201,
    )
  ).data.id;
  root = "/api/organizations/" + org;
  await page.evaluate(
    (id) => localStorage.setItem("leadstack.organization", id),
    org,
  );
  const company = (
    await request(
      page,
      root + "/companies",
      "POST",
      {
        name: "表示整理の設備会社",
        phone: "03-1234-5678",
        assigned_user_id: ownerId,
        industry: "建設",
        prefecture: "東京都",
      },
      201,
    )
  ).data;
  const noTask = (
    await request(
      page,
      root + "/companies",
      "POST",
      { name: "次のタスクがない検証会社", assigned_user_id: ownerId },
      201,
    )
  ).data;
  const date = (await request(page, root + "/dashboard")).date;
  const start = Date.parse(date + "T00:00:00+09:00"),
    day = 86400000;
  const when = (offset) => new Date(start + offset).toISOString();
  const tasks = [];
  for (const [title, type, due_at, status] of [
    ["期限超過の再架電", "callback", when(-3600000), "todo"],
    ["期限超過のフォロー", "follow_up", when(-7200000), "todo"],
    ["今日の再架電", "callback", when(3600000), "todo"],
    ["今日のフォロー", "follow_up", when(day - 1), "todo"],
    ["今後の再架電", "callback", when(day + 3600000), "todo"],
    ["期限未設定の再架電", "callback", null, "todo"],
    ["完了済みの再架電", "callback", when(3600000), "completed"],
    ["取消済みの再架電", "callback", when(-3600000), "cancelled"],
    ["今後の一般タスク", "follow_up", when(day + 7200000), "todo"],
  ])
    tasks.push(
      (
        await request(
          page,
          root + "/tasks",
          "POST",
          {
            company_id: company.id,
            assigned_user_id: ownerId,
            title,
            type,
            due_at,
            status,
          },
          201,
        )
      ).data,
    );
  pass(
    "Login layout works at PC/390px; dedicated local company/tasks seeded through authenticated APIs",
  );

  stage = "dashboard merging, Tokyo boundaries and folds";
  const expected = [
    "期限超過のフォロー",
    "期限超過の再架電",
    "今日の再架電",
    "今日のフォロー",
    "今後の再架電",
    "期限未設定の再架電",
  ];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(base + "/dashboard");
    const list = page.getByRole("list", {
      name: "対応するタスク",
      exact: true,
    });
    await expect(list.getByRole("listitem")).toHaveCount(6);
    assert.deepEqual(
      await list
        .getByRole("listitem")
        .evaluateAll((rows) =>
          rows.map((row) => row.querySelector("p").textContent),
        ),
      expected,
    );
    for (const title of expected)
      await expect(list.getByText(title, { exact: true })).toHaveCount(1);
    for (const title of [
      "完了済みの再架電",
      "取消済みの再架電",
      "今後の一般タスク",
    ])
      await expect(list.getByText(title, { exact: true })).toHaveCount(0);
    for (const [title, badge] of [
      ["期限超過の再架電", "期限超過"],
      ["今日の再架電", "今日"],
      ["今後の再架電", "今後"],
      ["期限未設定の再架電", "期限未設定"],
    ])
      await expect(
        list
          .getByRole("listitem")
          .filter({ hasText: title })
          .getByText(badge, { exact: true }),
      ).toBeVisible();
    await expect(
      page.getByRole("link", { name: noTask.name, exact: true }),
    ).toBeHidden();
    await capture("dashboard-" + width);
    await audit();
    await page
      .locator("summary")
      .filter({ hasText: "次のタスクがない担当企業" })
      .click();
    await expect(
      page.getByRole("link", { name: noTask.name, exact: true }),
    ).toBeVisible();
    await page
      .locator("summary")
      .filter({ hasText: "商談パイプライン" })
      .click();
    await expect(
      page.getByRole("link", { name: "商談一覧へ", exact: true }),
    ).toBeVisible();
    await capture("dashboard-expanded-" + width);
  }
  pass(
    "Dashboard shows each task once, sorted by due date; Tokyo today/overdue/future/undated remain correct in an LA browser; completed/cancelled rows are absent; all folded content opens",
  );

  stage = "stale completion and successful completion";
  const old = tasks.find((t) => t.title === "今日の再架電");
  await direct(`/rest/v1/tasks?id=eq.${old.id}`, "PATCH", ownerToken, {
    title: "更新後の再架電",
  });
  const rejected = page.waitForResponse(
    (r) =>
      r.url().endsWith("/tasks/" + old.id) && r.request().method() === "PATCH",
  );
  await page
    .getByRole("button", { name: "今日の再架電を完了する", exact: true })
    .click();
  assert.equal((await rejected).status(), 409);
  await expect(page.getByText(/別の操作で更新されています/)).toBeVisible();
  assert.equal(
    (await request(page, root + "/tasks/" + old.id)).data.status,
    "todo",
  );
  await page.reload();
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/tasks/" + old.id) && r.request().method() === "PATCH",
  );
  await page
    .getByRole("button", { name: "更新後の再架電を完了する", exact: true })
    .click();
  assert.equal((await saved).status(), 200);
  await expect(
    page
      .getByRole("list", { name: "対応するタスク", exact: true })
      .getByText("更新後の再架電", { exact: true }),
  ).toHaveCount(0);
  assert.equal(
    (await request(page, root + "/tasks/" + old.id)).data.status,
    "completed",
  );
  await page.reload();
  await expect(
    page
      .getByRole("list", { name: "対応するタスク", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(5);
  pass(
    "Stale completion is rejected without overwriting another edit; refreshed completion persists and removes the task immediately and after reload",
  );

  stage = "navigation and compact settings";
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const [name, path] of [
      ["営業リスト", "/companies"],
      ["企業を探す", "/discover"],
      ["商談", "/deals"],
      ["タスク", "/tasks"],
      ["ダッシュボード", "/dashboard"],
      ["設定", "/settings"],
    ]) {
      if (width === 390)
        await page
          .getByRole("button", { name: "メニューを開く", exact: true })
          .click();
      const container =
        width === 390
          ? page.getByRole("dialog", { name: "ナビゲーション", exact: true })
          : name === "設定"
            ? page
            : page.getByRole("navigation", {
                name: "メインナビゲーション",
                exact: true,
              });
      await container.getByRole("link", { name, exact: true }).click();
      await page.waitForURL(base + path);
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      if (width === 390)
        await expect(
          page.getByRole("dialog", { name: "ナビゲーション", exact: true }),
        ).toHaveCount(0);
    }
    await expect(page.getByText("Zoom Phone", { exact: true })).toBeHidden();
    await capture("settings-" + width);
    await page.getByText("今後の外部サービス連携", { exact: true }).click();
    await expect(page.getByText("Zoom Phone", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /準備中/ })).toHaveCount(0);
  }
  pass(
    "All navigation destinations work at PC/390px and mobile menu closes; future integrations remain available under one disclosure without unusable action buttons",
  );

  stage = "mobile CRM list and task actions";
  await page.goto(base + "/companies");
  const companies = page.getByRole("list", { name: "営業リスト", exact: true });
  const card = companies
    .getByRole("listitem")
    .filter({ hasText: company.name });
  await expect(
    card.getByRole("link", { name: company.name, exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("link", { name: "03-1234-5678", exact: true }),
  ).toHaveAttribute("href", /tel:/);
  await card
    .getByRole("checkbox", { name: company.name + "を選択", exact: true })
    .check();
  await expect(page.getByText("1 社を選択中", { exact: true })).toBeVisible();
  await card
    .getByRole("button", { name: company.name + "の架電を記録", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("架電先電話番号", { exact: true }),
  ).toHaveValue("03-1234-5678");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await card.getByText("企業情報", { exact: true }).click();
  await expect(card.getByText("東京都", { exact: true })).toBeVisible();
  await capture("companies-mobile");
  await audit();
  await page.getByRole("button", { name: "表示項目", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "電話番号", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    card.getByRole("link", { name: "03-1234-5678", exact: true }),
  ).toHaveCount(0);
  await page.goto(base + "/tasks?period=all");
  const taskList = page.getByRole("list", { name: "タスク一覧", exact: true });
  await expect(
    taskList.getByText("期限超過のフォロー", { exact: true }),
  ).toBeVisible();
  await capture("tasks-mobile");
  await audit();
  await taskList
    .getByRole("button", { name: "期限超過のフォローを編集", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("タスク名", { exact: false })
    .fill("スマホで編集したフォロー");
  await saveDialog("tasks", "PATCH", 200);
  await expect(
    taskList.getByText("スマホで編集したフォロー", { exact: true }),
  ).toBeVisible();
  await choose(page, "状態", "完了");
  await expect(
    taskList.getByText("更新後の再架電", { exact: true }),
  ).toBeVisible();
  await taskList
    .getByRole("button", { name: "更新後の再架電を未完了に戻す", exact: true })
    .click();
  await expect(
    taskList.getByText("更新後の再架電", { exact: true }),
  ).toHaveCount(0);
  assert.equal(
    (await request(page, root + "/tasks/" + old.id)).data.status,
    "todo",
  );
  pass(
    "Mobile company phone/call/selection/detail/visible-field controls work without horizontal scroll; task editing and completed-to-todo action persist",
  );

  stage = "compact hearing forms and edits";
  await page.goto(base + "/companies/" + company.id);
  await page.getByRole("tab", { name: "業務ヒアリング", exact: true }).click();
  await expect(
    page.getByText("現在の業務はまだありません", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "次のページ", exact: true }),
  ).toHaveCount(0);
  await capture("hearing-empty-mobile");
  await page.getByRole("button", { name: "業務を追加", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("現在の運用方法", { exact: false })
    .fill("Excelで手入力");
  await saveDialog("business_processes");
  await page
    .getByRole("button", { name: "利用ツールを追加", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("ツール名", { exact: false })
    .fill("Excel");
  await saveDialog("company_tools");
  await page.getByRole("button", { name: "課題を追加", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("課題の詳細", { exact: false })
    .fill("転記に時間がかかる");
  await saveDialog("pain_points");
  await page
    .getByRole("button", { name: "案件管理を編集", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("現在の運用方法", { exact: false })
    .fill("Excelと紙で管理");
  await saveDialog("business_processes", "PATCH", 200);
  await page.reload();
  await page.getByRole("tab", { name: "業務ヒアリング", exact: true }).click();
  await expect(
    page.getByText("Excelと紙で管理", { exact: true }),
  ).toBeVisible();
  assert.equal(
    (await request(page, root + "/business_processes?company_id=" + company.id))
      .data[0].current_method,
    "Excelと紙で管理",
  );
  await capture("hearing-mobile");
  pass(
    "Compact empty hearing sections retain each add action and no zero-row paginator; business process/tool/pain creation and editing survive reload",
  );

  stage = "proposal draft and build/automate/keep edit regression";
  await page.getByRole("tab", { name: "改善提案", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "改善提案を追加", exact: true }),
  ).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "次のページ", exact: true }),
  ).toHaveCount(0);
  await capture("proposals-empty-mobile");
  await page.getByText("ヒアリングから下書きを作成", { exact: true }).click();
  for (const label of [
    "根拠となる業務",
    "根拠となる課題",
    "根拠となる利用ツール",
  ])
    await page.getByLabel(label, { exact: false }).selectOption({ index: 1 });
  await page
    .getByLabel("選択した登録情報をヒアリングで確認済み", { exact: true })
    .check();
  await page
    .getByRole("button", {
      name: "ツール連携・自動化の下書きを確認",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("提案理由", { exact: false }),
  ).toHaveValue(/登録情報/);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  assert.equal(
    (await request(page, root + "/proposals?company_id=" + company.id)).count,
    0,
  );
  await page.getByText("ヒアリングから下書きを作成", { exact: true }).click();
  for (const type of ["build", "automate", "keep"]) {
    await page
      .getByRole("button", { name: "改善提案を追加", exact: true })
      .first()
      .click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("提案の種類", { exact: false }).selectOption(type);
    await dialog
      .getByLabel("提案名", { exact: false })
      .fill("提案検証-" + type);
    await dialog.getByLabel("提案内容", { exact: false }).fill("元の提案内容");
    if (type === "automate") {
      await dialog.getByLabel("きっかけ", { exact: false }).fill("請求締め日");
      await dialog
        .getByLabel("処理の流れ", { exact: false })
        .fill("集計\n承認依頼");
    }
    await saveDialog("proposals");
    await page
      .getByRole("button", { name: "提案検証-" + type + "を編集", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("提案内容", { exact: false })
      .fill("編集済み-" + type);
    await saveDialog("proposals", "PATCH", 200);
  }
  await page.reload();
  await page.getByRole("tab", { name: "改善提案", exact: true }).click();
  const proposals = (
    await request(page, root + "/proposals?company_id=" + company.id)
  ).data;
  assert.equal(proposals.length, 3);
  for (const proposal of proposals) {
    assert.equal(proposal.description, "編集済み-" + proposal.type);
    await expect(
      page.getByText(proposal.description, { exact: true }),
    ).toBeVisible();
  }
  assert.deepEqual(
    proposals.find((p) => p.type === "automate").automation_config.steps,
    ["集計", "承認依頼"],
  );
  await capture("proposals-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture("proposals-desktop");
  pass(
    "Hearing-based proposal preview creates nothing automatically; build/automate/keep creation and edits persist with automation steps intact at PC/390px",
  );

  stage = "dashboard truncation context and navigation to full task list";
  for (let i = 0; i < 31; i++)
    await request(
      page,
      root + "/tasks",
      "POST",
      {
        company_id: company.id,
        assigned_user_id: ownerId,
        title: "件数上限検証" + String(i).padStart(2, "0"),
        type: "callback",
        due_at: when(day * 2 + i * 60000),
      },
      201,
    );
  await page.goto(base + "/dashboard");
  await expect(
    page.getByText(
      "各区分の先頭30件をまとめて表示しています。全件はタスク一覧で確認できます。",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("link", { name: "タスク一覧", exact: true }).click();
  await page.waitForURL(base + "/tasks?period=all");
  const listed = await request(
    page,
    root + "/tasks?assigned_user_id=" + ownerId + "&status=todo",
  );
  assert.ok(listed.count > 30);
  await expect(
    page.getByRole("button", { name: "次のページ", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "前のページ", exact: true }),
  ).toBeEnabled();
  assert.deepEqual(runtimeErrors, []);
  await writeFile(
    output + "/evidence.json",
    JSON.stringify(
      {
        date,
        viewports: [1440, 390],
        browserTimezone: "America/Los_Angeles",
        mergedInitial: expected,
        groups: 8,
      },
      null,
      2,
    ),
  );
  pass(
    "A capped dashboard explains its source limits and links to the complete paginated task list; no browser errors",
  );
} catch (error) {
  console.error(`FAIL: Remainder UI stage '${stage}' (${error.name})`);
  const location = error?.stack?.match(/ui-remainder-e2e\.mjs:\d+:\d+/)?.[0];
  if (location) console.error(location);
  if (error.name === "AssertionError")
    console.error(error.message.split("\n").slice(0, 3).join("\n"));
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  if (ownerToken && org)
    await direct(
      `/rest/v1/companies?organization_id=eq.${org}`,
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
  await browser.close();
}
