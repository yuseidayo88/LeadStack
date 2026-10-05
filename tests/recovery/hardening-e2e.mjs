// Local disposable Auth/PostgREST + SMTP sink only. Never use production credentials.
import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.E2E_BASE_URL || "http://localhost:3005";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const cfg = JSON.parse(
  await readFile("/workspace/handoff/e2e-private/secrets.json", "utf8"),
);
const users = JSON.parse(await readFile(process.env.E2E_USERS_FILE, "utf8"));
const gateway = "http://127.0.0.1:55321";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const log = (s) => console.log("PASS: " + s);
async function app(action, data) {
  return context.request.post(base + "/api/auth/" + action, {
    headers: { origin: base },
    data,
  });
}
async function direct(path, method, token, data) {
  const r = await fetch(gateway + path, {
    method,
    headers: {
      apikey: cfg.anon_key,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
async function lastLink(email) {
  for (let i = 0; i < 40; i++) {
    const raw = await readFile(
      "/workspace/handoff/e2e-private/smtp-messages.jsonl",
      "utf8",
    ).catch(() => "");
    const mail = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s))
      .reverse()
      .find((s) => s.toLowerCase().includes(email.toLowerCase()));
    if (mail) {
      const decoded = mail
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/g, (_, s) =>
          String.fromCharCode(parseInt(s, 16)),
        );
      const m = decoded.match(/href="(http[^"]+)"/);
      if (m) return m[1].replaceAll("&amp;", "&");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Local recovery mail missing");
}
try {
  const u = users.other;
  assert.equal(
    (await app("login", { email: u.email, password: u.password })).status(),
    200,
  );
  const cookies = (await context.cookies()).filter((c) =>
    c.name.startsWith("sb-"),
  );
  assert.ok(
    cookies.length && cookies.every((c) => c.httpOnly && c.sameSite === "Lax"),
  );
  await page.goto(base + "/companies");
  assert.equal(
    (await context.request.get(base + "/api/profile")).status(),
    200,
  );
  log(
    "HttpOnly/SameSite cookies support real server-rendered authenticated page",
  );
  const newPassword = "Local-changed-password-2026!";
  assert.equal(
    (
      await app("update-password", {
        password: newPassword,
        confirmation: newPassword,
      })
    ).status(),
    403,
  );
  await page.goto(base + "/reset-password");
  await page.waitForURL("**/login?error=confirmation");
  const signed = await direct(
    "/auth/v1/token?grant_type=password",
    "POST",
    cfg.anon_key,
    { email: u.email, password: u.password },
  );
  assert.equal(signed.status, 200);
  const token = signed.body.access_token;
  const blocked = await direct("/auth/v1/user", "PUT", token, {
    password: newPassword,
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error_code, "current_password_required");
  log(
    "ordinary session denied password reset by app and direct Auth native current-password requirement",
  );
  assert.equal((await app("reset-password", { email: u.email })).status(), 200);
  const url = await lastLink(u.email);
  await page.goto(url);
  await page.waitForURL("**/reset-password");
  await expect(
    page.getByLabel("新しいパスワード", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("新しいパスワード", { exact: true }).fill(newPassword);
  await page
    .getByLabel("新しいパスワード（確認）", { exact: true })
    .fill(newPassword);
  const update = page.waitForResponse((r) =>
    r.url().endsWith("/api/auth/update-password"),
  );
  await page
    .getByRole("button", { name: "パスワードを更新", exact: true })
    .click();
  assert.equal((await update).status(), 200);
  await expect(page.getByRole("status")).toContainText("更新しました");
  assert.equal(
    (await context.request.get(base + "/api/profile")).status(),
    401,
  );
  const rows = await direct("/rest/v1/profiles?select=id", "GET", token);
  assert.equal(rows.status, 200);
  assert.deepEqual(rows.body, []);
  const created = await direct(
    "/rest/v1/rpc/create_organization",
    "POST",
    token,
    { org_name: "Should be denied" },
  );
  assert.equal(created.status, 403);
  const refreshed = await direct(
    "/auth/v1/token?grant_type=refresh_token",
    "POST",
    cfg.anon_key,
    { refresh_token: signed.body.refresh_token },
  );
  assert.equal(refreshed.status, 400);
  log(
    "real PKCE recovery works with HttpOnly cookies; global logout revokes other session refresh and DB access",
  );
  assert.equal(
    (await app("login", { email: u.email, password: newPassword })).status(),
    200,
  );
  assert.equal(
    (await context.request.get(base + "/api/profile")).status(),
    200,
  );
  await page.goto(url);
  await page.waitForURL((u) => u.pathname === "/login");
  log("new password login succeeds; consumed recovery link cannot be reused");
  // Restore only this disposable local fixture for later regression suites via admin API.
  const restored = await direct(
    "/auth/v1/admin/users/" + u.id,
    "PUT",
    cfg.service_key,
    { password: u.password },
  );
  assert.equal(restored.status, 200);
  const throttleEmail = `local-rate-${Date.now()}@example.test`;
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await app("login", {
          email: throttleEmail,
          password: "wrong-password-12",
        })
      ).status(),
      401,
    );
  assert.equal(
    (
      await app("login", {
        email: throttleEmail.toUpperCase(),
        password: "wrong-password-12",
      })
    ).status(),
    429,
  );
  log("persistent account-normalized login attempt limit returns 429");
} finally {
  await browser.close();
}
