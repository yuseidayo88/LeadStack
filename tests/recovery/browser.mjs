// Run after npm run build && npm start. No production writes or emails.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto("http://localhost:3000/login?error=confirmation");
  await page.getByRole("heading", { name: "おかえりなさい" }).waitFor();
  assert.match(
    await page
      .getByRole("alert")
      .filter({ hasText: "メールの確認リンク" })
      .innerText(),
    /確認リンクを処理できません/,
  );
  await page
    .getByLabel("メールアドレス", { exact: true })
    .fill("person@example.test");
  await page
    .getByLabel("パスワード", { exact: true })
    .fill("test-password-only");
  // Exercise UI feedback without using a real account or transmitting credentials.
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "auth_unavailable",
          message:
            "認証サービスに接続できません。時間を置いて再試行してください",
        },
      }),
    }),
  );
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page
    .getByText("認証サービスに接続できません。時間を置いて再試行してください", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "ログイン", exact: true })
      .isEnabled(),
    true,
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path:
      process.env.RECOVERY_SCREENSHOT || "test-results/login-verification.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "新規登録", exact: true }).click();
  assert.equal(
    await page.getByLabel("お名前", { exact: true }).isVisible(),
    true,
  );
  assert.equal(
    await page.locator("input[name=password]").getAttribute("minlength"),
    "12",
  );
  await page.goto("http://localhost:3000/companies");
  await page.waitForURL("**/login?next=*");
  assert.equal(new URL(page.url()).searchParams.get("next"), "/companies");
  const api = page.request;
  const unauth = await api.get("http://localhost:3000/api/profile");
  assert.equal(unauth.status(), 401);
  const invalid = await api.post("http://localhost:3000/api/auth/login", {
    data: { email: "bad", password: "" },
    headers: { origin: "http://localhost:3000" },
  });
  assert.equal(invalid.status(), 422);
  const csrf = await api.post("http://localhost:3000/api/auth/login", {
    data: { email: "person@example.test", password: "unused" },
    headers: { origin: "https://evil.example" },
  });
  assert.equal(csrf.status(), 403);
  const health = await api.get("http://localhost:3000/api/health");
  assert.equal(health.status(), 200);
  assert.equal((await health.json()).databaseVerified, false);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: login render; confirmation failure alert; simulated unavailable feedback; submit re-enabled; signup fields; protected redirect; API unauthenticated 401; invalid input 422; origin 403; health configured; no page errors.",
  );
  console.log(
    "No successful real-account login, SMTP delivery, or authenticated browser CRM flow was tested.",
  );
} finally {
  await browser.close();
}
