// Synthetic records in the dedicated local fixture only. Never run against production.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.E2E_BASE_URL || "http://localhost:3006";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const users = JSON.parse(await readFile(process.env.E2E_USERS_FILE, "utf8"));
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function api(path, method = "GET", data) {
  const r = await context.request.fetch(base + path, {
    method,
    data,
    headers: { origin: base },
  });
  assert.ok(r.ok(), `${method} ${path.split("?")[0]}: HTTP ${r.status()}`);
  return r.status() === 204 ? null : r.json();
}
const log = (s) => console.log("PASS: " + s);
try {
  await api("/api/auth/login", "POST", {
    email: users.owner.email,
    password: users.owner.password,
  });
  const org = (
    await api("/api/organizations", "POST", {
      name: "検索・架電検証-" + Date.now(),
    })
  ).data.id;
  const root = "/api/organizations/" + org;
  const company = (
    await api(root + "/companies", "POST", {
      name: "検索テスト本社",
      phone: "０３（１２３４）－５６７８",
      corporate_number: "1234567890123",
      prefecture: "東京都",
      city: "千代田区",
    })
  ).data;
  for (const term of [
    "0312345678",
    "03-1234-5678",
    "０３ １２３４ ５６７８",
    "1234567890123",
  ]) {
    const r = await api(root + "/companies?search=" + encodeURIComponent(term));
    assert.equal(r.count, 1);
    assert.equal(r.data[0].id, company.id);
  }
  for (const term of ["%_", "A,B(支店)", '引用"社', "C\\支店"]) {
    const c = (await api(root + "/companies", "POST", { name: term })).data;
    const r = await api(root + "/companies?search=" + encodeURIComponent(term));
    assert.equal(r.count, 1);
    assert.equal(r.data[0].id, c.id);
  }
  const attack = await api(
    root +
      "/companies?search=" +
      encodeURIComponent('"),id.neq.00000000-0000-0000-0000-000000000000'),
  );
  assert.equal(attack.count, 0);
  log("Company phone/registration lookup and literal filter metacharacters");
  const duplicates = [],
    contacts = [];
  for (let i = 1; i <= 25; i++) {
    duplicates.push(
      (
        await api(root + "/companies", "POST", {
          name: "同名企業",
          prefecture: "東京都",
          city: `地区${i}`,
          phone: `06-1000-${String(i).padStart(4, "0")}`,
        })
      ).data,
    );
    contacts.push(
      (
        await api(root + "/contacts", "POST", {
          company_id: company.id,
          name: "同姓担当者",
          department: `部署${i}`,
          phone: `090-2000-${String(i).padStart(4, "0")}`,
          email: `person${i}@example.test`,
        })
      ).data,
    );
  }
  for (const term of ["person25@example.test", "０９０２０００００２５"]) {
    const r = await api(
      root +
        "/contacts?company_id=" +
        company.id +
        "&search=" +
        encodeURIComponent(term),
    );
    assert.equal(r.count, 1);
    assert.equal(r.data[0].id, contacts[24].id);
  }
  log("Contact phone and email lookup retains company scope");
  await page.goto(base + "/companies");
  await page.evaluate(
    (org) => localStorage.setItem("leadstack.organization", org),
    org,
  );
  await page.reload();
  const search = page.getByLabel("会社名・電話番号・法人番号を検索", {
    exact: true,
  });
  await search.fill("0312345678");
  await expect(
    page.getByRole("link", { name: "検索テスト本社", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: company.phone, exact: true }),
  ).toHaveAttribute("href", "tel:0312345678");
  await page
    .getByRole("button", { name: "検索テスト本社の架電を記録", exact: true })
    .click();
  const dialog = page.locator('[data-slot="dialog-content"]');
  await expect(dialog.getByRole("heading")).toHaveText(
    "検索テスト本社の営業活動を記録",
  );
  await dialog.getByText("件名", { exact: true }).click();
  await expect(dialog).toBeVisible(); // Dialog portal must not trigger table-row navigation.
  assert.equal(new URL(page.url()).pathname, "/companies");
  await expect(dialog.getByLabel("架電先電話番号")).toHaveValue(company.phone);
  await dialog
    .getByRole("combobox", { name: "企業担当者", exact: true })
    .click();
  let popup = page.locator('[data-slot="popover-content"]');
  await expect(popup.getByText("25 件中 1–20 件")).toBeVisible();
  await popup.getByRole("button", { name: "次のページ", exact: true }).click();
  await expect(popup.getByText("25 件中 21–25 件")).toBeVisible();
  const sortedContacts = [...contacts].sort((a, b) => a.id.localeCompare(b.id));
  const lastContact = sortedContacts[24];
  await popup
    .getByRole("option")
    .filter({ hasText: lastContact.email })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "企業担当者", exact: true }),
  ).toContainText(lastContact.department);
  await dialog.getByLabel("件名", { exact: true }).fill("一覧からの架電記録");
  await dialog.getByRole("button", { name: "活動を保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(new URL(page.url()).pathname, "/companies");
  const activities = await api(root + "/activities?company_id=" + company.id);
  const activity = activities.data.find(
    (r) => r.title === "一覧からの架電記録",
  );
  assert.ok(activity);
  assert.equal(activity.company_id, company.id);
  assert.equal(activity.contact_id, lastContact.id);
  assert.equal(activity.call_details.phone_number, company.phone);
  log(
    "List → record call → paged contact selection → save, without navigating away",
  );
  await page.goto(base + "/tasks?period=all");
  await page.getByRole("button", { name: "タスクを追加", exact: true }).click();
  await dialog.getByRole("combobox", { name: "企業", exact: true }).click();
  popup = page.locator('[data-slot="popover-content"]');
  await popup.getByLabel("企業の候補を検索").fill("同名企業");
  await expect(popup.getByText("25 件中 1–20 件")).toBeVisible();
  await popup.getByRole("button", { name: "次のページ", exact: true }).click();
  await expect(popup.getByText("25 件中 21–25 件")).toBeVisible();
  const lastCompany = [...duplicates].sort((a, b) =>
    a.id.localeCompare(b.id),
  )[24];
  await popup
    .getByRole("option")
    .filter({ hasText: lastCompany.phone })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "企業", exact: true }),
  ).toContainText(lastCompany.city);
  await dialog.getByRole("combobox", { name: "企業", exact: true }).click();
  await expect(
    popup.getByRole("button", { name: "前のページ", exact: true }),
  ).toBeDisabled();
  await popup.getByLabel("企業の候補を検索").fill("0312345678");
  await expect(popup.getByText("1 件中 1–1 件")).toBeVisible();
  await popup.getByRole("option").filter({ hasText: "検索テスト本社" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "企業", exact: true }),
  ).toContainText("千代田区");
  log(
    "Same-name companies beyond 20 candidates selected by location/phone; new search resets page",
  );
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.goto(base + "/companies");
  await search.fill("0312345678");
  await expect(
    page.getByRole("link", { name: "検索テスト本社", exact: true }),
  ).toBeVisible();
  await mkdir("test-results/search", { recursive: true });
  await page.screenshot({
    path: "test-results/search/company-search.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "検索テスト本社の架電を記録", exact: true })
    .click();
  await dialog
    .getByRole("combobox", { name: "企業担当者", exact: true })
    .click();
  await expect(popup.getByText("25 件中 1–20 件")).toBeVisible();
  await page.screenshot({
    path: "test-results/search/contact-lookup.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  log("Rendered UI, navigation and browser runtime errors checked");
} finally {
  await browser.close();
}
