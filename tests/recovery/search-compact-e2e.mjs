import { expandSearchOptions } from "./search-options.mjs";
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
const output = process.env.E2E_OUTPUT || "test-results/search-compact";
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

let org, ownerToken, root;
const metrics = [];
async function saveActivity() {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/activities") && r.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "活動を保存", exact: true })
    .click();
  assert.ok((await response).ok());
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
try {
  await context.route("**/*", (route) =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  await login(page, users.owner);
  ownerToken = await tokenFor(users.owner);
  const ownerId = (await request(page, "/api/profile")).data.id;
  org = (
    await request(
      page,
      "/api/organizations",
      "POST",
      { name: `表示整理E2E-${Date.now()}` },
      201,
    )
  ).data.id;
  root = `/api/organizations/${org}`;
  const candidates = await direct(
    "/rest/v1/company_candidates",
    "POST",
    ownerToken,
    [0, 1].map((i) => ({
      organization_id: org,
      corporate_number: String(8300000000000 + i),
      name: `表示整理${i + 1}設備法人`,
      location: "東京都検証市",
      prefecture: "東京都",
      prefecture_code: "13",
      industry_codes: ["D"],
      industry_labels: ["建設業"],
      employee_number: i === 0 ? 20 : null,
      website_url: "https://example.test/",
      phone: i === 0 ? "03-1234-5678" : null,
      provenance: {},
      fetched_at: new Date().toISOString(),
    })),
    201,
  );
  await organization(page, org);
  stage = "collapsed search layout on desktop and mobile";
  await expect(
    page.getByRole("heading", { name: "取得済み候補 2 社", exact: true }),
  ).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(
      page.getByLabel("従業員数の下限", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("業務キーワード", { exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "条件を保存", exact: true }),
    ).toBeHidden();
    const button = page.getByRole("button", {
      name: "条件に合う企業を探す",
      exact: true,
    });
    const box = await button.boundingBox();
    assert.ok(
      box.y + box.height < (width === 390 ? 844 : 1000),
      "Search button must be in the first viewport",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    metrics.push({ width, searchButtonBottom: Math.round(box.y + box.height) });
    await page.screenshot({ path: output + `/search-${width}.png` });
  }
  await choose(page, "都道府県", "東京都");
  await expandSearchOptions(page);
  await page
    .getByRole("button", { name: "設備工事・保守点検", exact: true })
    .click();
  await page.locator("#discovery-advanced > summary").click();
  await expect(
    page.getByRole("group", { name: "指定中の検索条件", exact: true }),
  ).toContainText("設備");
  await expect(
    page.getByRole("group", { name: "指定中の検索条件", exact: true }),
  ).toContainText("未確認");
  await page.getByLabel("従業員数の下限", { exact: true }).fill("51");
  await expect(page.locator("#discovery-targeting-error")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "条件に合う企業を探す", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "条件をクリア", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "取得済み候補 2 社", exact: true }),
  ).toBeVisible();
  pass(
    "PC/390px show search in first viewport; applied conditions and invalid-range errors stay visible when advanced options are closed",
  );

  stage = "mobile phone, selection, source, import";
  let card = page
    .getByRole("list", { name: "企業候補", exact: true })
    .getByRole("listitem")
    .filter({ hasText: candidates[0].name });
  await expect(
    card.getByRole("link", { name: "03-1234-5678", exact: true }),
  ).toHaveAttribute("href", /tel:/);
  await card
    .getByRole("checkbox", { name: candidates[0].name + "を選択", exact: true })
    .check();
  await expect(
    page.getByText("1 / 50 社を選択中", { exact: true }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "詳細・出典を確認", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    candidates[0].corporate_number,
  );
  await page.keyboard.press("Escape");
  await card
    .getByRole("button", { name: "営業リストに取り込む", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByText("重複候補なし", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "確認して取り込む", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("新規 1 社");
  await dialog
    .getByRole("button", { name: "閉じる", exact: true })
    .last()
    .click();
  const company = (await request(page, root + "/companies")).data[0];
  assert.equal(company.name, candidates[0].name);
  assert.equal(company.phone, "03-1234-5678");
  await page.reload();
  card = page
    .getByRole("list", { name: "企業候補", exact: true })
    .getByRole("listitem")
    .filter({ hasText: candidates[0].name });
  await expect(
    card.getByRole("link", { name: "登録済み企業へ", exact: true }),
  ).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: output + "/mobile-candidate.png" });
  pass(
    "Mobile selection, telephone link, source dialog, duplicate preview and confirmed CRM import survive reload",
  );

  stage = "primary call flow and retry";
  await card
    .getByRole("button", {
      name: candidates[0].name + "の架電を記録",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("活動の種類", { exact: true })).toBeHidden();
  await dialog.getByLabel("架電結果", { exact: true }).selectOption("callback");
  await dialog
    .getByLabel("活動メモ", { exact: true })
    .fill("表示整理の折返し検証");
  let posts = 0,
    lastBody;
  page.on("request", (r) => {
    if (r.url().endsWith("/activities") && r.method() === "POST") {
      posts++;
      lastBody = r.postDataJSON();
    }
  });
  await dialog.getByRole("button", { name: "活動を保存", exact: true }).click();
  assert.equal(posts, 0, "Required callback date blocks incomplete submission");
  await dialog
    .getByLabel("再架電日時", { exact: true })
    .fill("2026-11-01T10:00");
  await page.screenshot({ path: output + "/mobile-call.png" });
  await page.route(
    "**/activities",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "fixture_unavailable",
            message: "保存できませんでした。もう一度お試しください。",
          },
        }),
      }),
    { times: 1 },
  );
  await dialog.getByRole("button", { name: "活動を保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("保存できませんでした");
  await expect(dialog.getByLabel("活動メモ", { exact: true })).toHaveValue(
    "表示整理の折返し検証",
  );
  const failedId = lastBody.request_id;
  await saveActivity();
  assert.equal(
    lastBody.request_id,
    failedId,
    "Retry preserves idempotency key",
  );
  let activities = (
    await request(page, root + `/activities?company_id=${company.id}`)
  ).data;
  let tasks = (await request(page, root + `/tasks?company_id=${company.id}`))
    .data;
  assert.equal(activities.length, 1);
  assert.equal(tasks.length, 1);
  assert.equal(activities[0].call_details.result, "callback");
  assert.equal(activities[0].content, "表示整理の折返し検証");
  assert.equal(tasks[0].title, "再架電・フォロー");
  assert.equal(tasks[0].assigned_user_id, ownerId);
  assert.equal(tasks[0].due_at, "2026-11-01T01:00:00+00:00");
  await request(page, root + "/activities", "POST", lastBody, 201);
  assert.equal(
    (await request(page, root + `/activities?company_id=${company.id}`)).count,
    1,
  );
  assert.equal(
    (await request(page, root + `/tasks?company_id=${company.id}`)).count,
    1,
  );
  pass(
    "Collapsed call defaults save with notes/callback atomically; missing date blocks submission, retry retains edits, repeated request produces no duplicate call or task",
  );

  stage = "details edits and hidden invalid inputs";
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + `/companies/${company.id}`);
  await page.getByRole("button", { name: "架電を記録", exact: true }).click();
  dialog = page.getByRole("dialog");
  const detail = dialog.locator("details").first();
  await detail.locator(":scope > summary").click();
  await dialog.getByLabel("件名", { exact: true }).fill("詳細を編集した架電");
  await dialog.getByLabel("活動日時", { exact: true }).fill("2026-10-07T09:30");
  await dialog.getByText("通話時間の詳細（任意）", { exact: true }).click();
  await dialog.getByLabel("通話時間（秒）", { exact: true }).fill("-1");
  await detail.locator(":scope > summary").click();
  await dialog.getByRole("button", { name: "活動を保存", exact: true }).click();
  await expect(
    dialog.getByLabel("通話時間（秒）", { exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("通話時間（秒）", { exact: true }).fill("120");
  await detail.locator(":scope > summary").click();
  await saveActivity();
  activities = (
    await request(page, root + `/activities?company_id=${company.id}`)
  ).data;
  const edited = activities.find((a) => a.title === "詳細を編集した架電");
  assert.equal(edited.call_details.duration_seconds, 120);
  assert.equal(edited.occurred_at, "2026-10-07T00:30:00+00:00");
  await page.reload();
  await page.getByRole("tab", { name: "営業活動", exact: true }).click();
  await expect(
    page.getByText("詳細を編集した架電", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "活動を追加", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("活動の種類", { exact: true })).toBeVisible();
  await dialog.getByLabel("件名", { exact: true }).fill("社内メモ検証");
  await dialog.getByLabel("活動メモ", { exact: true }).fill("メモの保存も維持");
  await saveActivity();
  assert.equal(
    (
      await request(
        page,
        root + `/activities?company_id=${company.id}&type=memo`,
      )
    ).count,
    1,
  );
  pass(
    "Details remain editable and survive collapse; invalid hidden fields reveal themselves; call timing and non-call activity persist after reload",
  );

  stage = "next-company save and empty pagination";
  const next = (
    await request(
      page,
      root + "/companies",
      "POST",
      { name: "表示整理9次の会社検証" },
      201,
    )
  ).data;
  await page.goto(base + `/companies/${company.id}`);
  await page.getByRole("button", { name: "架電を記録", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("活動メモ", { exact: true }).fill("次の企業に進む");
  await dialog
    .getByRole("button", { name: "保存して次の企業へ", exact: true })
    .click();
  await page.waitForURL(base + `/companies/${next.id}`);
  await page.getByRole("tab", { name: "営業活動", exact: true }).click();
  await expect(
    page.getByText("活動はまだありません", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "次のページ", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "活動を追加", exact: true }),
  ).toBeVisible();
  assert.equal(
    (await request(page, root + `/activities?company_id=${company.id}`)).count,
    4,
  );
  assert.deepEqual(runtimeErrors, []);
  await writeFile(output + "/metrics.json", JSON.stringify(metrics, null, 2));
  pass(
    "Save-and-next advances only after persistence; zero-row pagination disappears while add actions remain available; no browser errors",
  );
} catch (error) {
  console.error(`FAIL: Compact workflow stage '${stage}' (${error.name})`);
  const location = error?.stack?.match(/search-compact-e2e\.mjs:\d+:\d+/)?.[0];
  if (location) console.error(location);
  if (error.name === "AssertionError")
    console.error(error.message.split("\n").slice(0, 3).join("\n"));
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  if (ownerToken && org)
    for (const table of ["company_candidates", "companies"])
      await direct(
        `/rest/v1/${table}?organization_id=eq.${org}`,
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
