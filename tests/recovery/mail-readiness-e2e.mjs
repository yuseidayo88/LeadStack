// Local-only browser/API check for the explicit mail readiness gate.
import { chromium, devices, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.E2E_BASE_URL || "http://localhost:3006";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const ready = process.env.E2E_EMAIL_READY === "true";
const users = JSON.parse(await readFile(process.env.E2E_USERS_FILE, "utf8"));
const browser = await chromium.launch({ headless: true });
try {
  for (const mobile of [false, true]) {
    const ctx = await browser.newContext(
      mobile
        ? devices["iPhone 13"]
        : { viewport: { width: 1440, height: 1000 } },
    );
    const page = await ctx.newPage();
    await page.goto(base + "/login");
    if (!ready) {
      await expect(page.getByRole("status")).toContainText(
        "認証メール機能は準備中",
      );
      await expect(
        page.getByRole("button", { name: "新規登録", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "メールを送信", exact: true }),
      ).toHaveCount(0);
      for (const action of [
        "signup",
        "reset-password",
        "resend-confirmation",
      ]) {
        const r = await ctx.request.post(base + "/api/auth/" + action, {
          headers: { origin: base },
          data: {
            email: "blocked@example.test",
            password: "local-fixture12",
            name: "Blocked",
          },
        });
        assert.equal(r.status(), 503);
        assert.equal((await r.json()).error.code, "email_not_ready");
      }
      await page
        .getByLabel("メールアドレス", { exact: true })
        .fill(users.owner.email);
      await page.locator("input[name=password]").fill(users.owner.password);
      const response = page.waitForResponse((r) =>
        r.url().endsWith("/api/auth/login"),
      );
      await page.getByRole("button", { name: "ログイン", exact: true }).click();
      assert.equal((await response).status(), 200);
      await page.waitForURL("**/dashboard");
    } else {
      await expect(
        page.getByRole("button", { name: "新規登録", exact: true }),
      ).toBeEnabled();
      await page
        .getByRole("button", { name: "パスワードを忘れた方", exact: true })
        .click();
      await expect(page.getByLabel("送信先メールアドレス")).toBeVisible();
      // Invalid input must reach normal validation, without sending any mail.
      const r = await ctx.request.post(base + "/api/auth/reset-password", {
        headers: { origin: base },
        data: { email: "invalid" },
      });
      assert.equal(r.status(), 422);
    }
    console.log(
      `PASS: mail ready=${ready}; ${mobile ? "mobile Chromium" : "desktop"} UI and server gate${ready ? "" : " + existing account login"}`,
    );
    await ctx.close();
  }
} finally {
  await browser.close();
}
