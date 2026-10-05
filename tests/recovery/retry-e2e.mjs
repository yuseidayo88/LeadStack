import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.E2E_BASE_URL || "http://localhost:3005";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const users = JSON.parse(await readFile(process.env.E2E_USERS_FILE, "utf8"));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
async function api(path, method = "GET", data, headers = {}) {
  const r = await ctx.request.fetch(base + path, {
    method,
    data,
    headers: { origin: base, ...headers },
  });
  return { status: r.status(), body: await r.json() };
}
const log = (s) => console.log("PASS: " + s);
try {
  assert.equal(
    (
      await api("/api/auth/login", "POST", {
        email: users.owner.email,
        password: users.owner.password,
      })
    ).status,
    200,
  );
  const org = (await api("/api/organizations")).body.data[0].id,
    root = `/api/organizations/${org}`;
  const company = (await api(root + "/companies")).body.data.find((c) =>
    c.name.startsWith("E2E企業-"),
  );
  assert.ok(company);
  await page.goto(base + "/companies/" + company.id);
  const dialog = page.getByRole("dialog");
  // Commit the write and drop its HTTP response, then retry in the same dialog.
  let activityRequests = 0,
    activityBody;
  await page.route("**" + root + "/activities", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    activityRequests++;
    activityBody = route.request().postDataJSON();
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    if (activityRequests === 1) return route.abort("failed");
    return route.fulfill({ response });
  });
  await page.getByRole("button", { name: "架電を記録", exact: true }).click();
  await dialog.locator("select[name=result]").selectOption("callback");
  const title = "通信中断再送-" + Date.now();
  await dialog.getByLabel("件名", { exact: true }).fill(title);
  await dialog.getByLabel("再架電タスク名", { exact: true }).fill(title);
  await dialog
    .getByLabel("再架電日時", { exact: true })
    .fill("2026-10-06T10:00");
  await dialog.getByRole("button", { name: "活動を保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("件名", { exact: true })).toHaveValue(title);
  await dialog.getByRole("button", { name: "活動を保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  assert.equal(activityRequests, 2);
  assert.equal(
    (await api(root + "/activities?company_id=" + company.id)).body.data.filter(
      (a) => a.title === title,
    ).length,
    1,
  );
  assert.equal(
    (await api(root + "/tasks?company_id=" + company.id)).body.data.filter(
      (a) => a.title === title,
    ).length,
    1,
  );
  assert.equal(
    (
      await api(root + "/activities", "POST", {
        ...activityBody,
        title: "changed",
      })
    ).status,
    409,
  );
  log(
    "activity+callback response loss retry saves one pair; changed replay returns 409",
  );
  await page.unroute("**" + root + "/activities");
  let contactRequests = 0;
  await page.route("**" + root + "/contacts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    contactRequests++;
    const response = await route.fetch();
    assert.ok(response.ok());
    if (contactRequests === 1) return route.abort("failed");
    return route.fulfill({ response });
  });
  await page.getByRole("button", { name: "担当者を追加", exact: true }).click();
  await dialog.getByLabel("担当者名", { exact: false }).fill(title);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  assert.equal(contactRequests, 2);
  assert.equal(
    (await api(root + "/contacts?company_id=" + company.id)).body.data.filter(
      (c) => c.name === title,
    ).length,
    1,
  );
  log(
    "generic create response loss retry returns original record without duplication",
  );
  await page.unroute("**" + root + "/contacts");
  const key = crypto.randomUUID(),
    data = { name: "同時登録" + Date.now() };
  const headers = { "Idempotency-Key": key };
  const race = await Promise.all([
    api(root + "/companies", "POST", data, headers),
    api(root + "/companies", "POST", data, headers),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 201]);
  assert.equal(race[0].body.data.id, race[1].body.data.id);
  assert.equal(
    (await api(root + "/companies", "POST", { name: "変更" }, headers)).status,
    409,
  );
  const taskkey = crypto.randomUUID(),
    task = {
      company_id: company.id,
      assigned_user_id: users.owner.id,
      type: "callback",
      title: "日時再送",
      due_at: "2026-10-06T10:00:00+09:00",
    };
  assert.equal(
    (await api(root + "/tasks", "POST", task, { "Idempotency-Key": taskkey }))
      .status,
    201,
  );
  assert.equal(
    (await api(root + "/tasks", "POST", task, { "Idempotency-Key": taskkey }))
      .status,
    200,
  );
  log(
    "concurrent create saves one row; changed replay rejected; timezone-normalized task retry works",
  );
} finally {
  await browser.close();
}
