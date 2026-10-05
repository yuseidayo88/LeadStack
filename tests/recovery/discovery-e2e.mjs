// Real Auth/PostgREST/browser checks against a disposable local fixture only.
// Candidate records below are synthetic. No live Gbiz or public website is called.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

const base = process.env.E2E_BASE_URL || "http://localhost:3006";
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
const output = process.env.E2E_OUTPUT || "test-results/discovery";
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
}

async function organization(p, id, destination = "/discover") {
  await p.evaluate(
    (value) => localStorage.setItem("leadstack.organization", value),
    id,
  );
  await p.goto(base + destination);
  await expect(
    p.getByRole("heading", {
      name: destination === "/discover" ? "企業を探す" : "企業",
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

async function searchFor(value) {
  await page.getByLabel("企業名・法人番号", { exact: true }).fill(value);
}

async function visibleCount(count) {
  await expect(
    page.getByRole("heading", {
      name: `取得済み候補 ${count} 社`,
      exact: true,
    }),
  ).toBeVisible();
}

async function popupWithinViewport(p) {
  const popover = p.locator('[data-slot="popover-content"]');
  await expect(popover).toBeVisible();
  const box = await popover.boundingBox();
  const viewport = p.viewportSize();
  assert.ok(box && viewport);
  assert.ok(
    box.height <= 361 &&
      box.x >= -1 &&
      box.y >= -1 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1,
    "Searchable options fit viewport",
  );
}

try {
  stage = "local login and synthetic candidate seed";
  await login(page, users.owner);
  const orgName = `企業発見E2E-${Date.now()}`;
  const org = (
    await request(page, "/api/organizations", "POST", { name: orgName }, 201)
  ).data.id;
  const root = `/api/organizations/${org}`;
  const endpoint = root + "/company-discovery";
  const initial = await request(page, endpoint);
  assert.equal(
    initial.configured,
    false,
    "Use a local app with GBIZ_API_TOKEN unset; no live provider calls are allowed",
  );
  assert.equal(initial.count, 0);
  const seed = [
    {
      key: "zero",
      name: "取込検証 ゼロ建設",
      prefecture_code: "13",
      prefecture: "東京都",
      industry_codes: ["D"],
      industry_labels: ["建設業"],
      phone: "03-1234-5678",
      website_url: "https://example.test/company",
      employee_number: 0,
    },
    {
      key: "unknown",
      name: "情報未確認建設",
      prefecture_code: "13",
      prefecture: "東京都",
      industry_codes: ["D"],
      industry_labels: ["建設業"],
    },
    {
      key: "tokyoManufacturing",
      name: "東京製造",
      prefecture_code: "13",
      prefecture: "東京都",
      industry_codes: ["E"],
      industry_labels: ["製造業"],
      employee_number: 50,
    },
    {
      key: "osaka",
      name: "大阪建設",
      prefecture_code: "27",
      prefecture: "大阪府",
      industry_codes: ["D"],
      industry_labels: ["建設業"],
      phone: "06-1234-5678",
      employee_number: 30,
    },
    {
      key: "existing",
      name: "取込検証 既存法人候補",
      prefecture_code: "13",
      prefecture: "東京都",
      industry_codes: ["G"],
      industry_labels: ["情報通信業"],
      phone: "03-9999-9999",
      employee_number: 90,
    },
    {
      key: "sameName",
      name: "取込検証 同名会社",
      prefecture_code: "13",
      prefecture: "東京都",
      industry_codes: ["L"],
      industry_labels: ["学術研究、専門・技術サービス業"],
    },
    {
      key: "blocked",
      name: "内部URL補完拒否",
      prefecture_code: "14",
      prefecture: "神奈川県",
      industry_codes: ["G"],
      industry_labels: ["情報通信業"],
      website_url: "http://127.0.0.1/private-test",
    },
    ...["%_", "A,B(支店)", '引用"社', "C\\支店"].map((name, i) => ({
      key: `literal${i}`,
      name,
    })),
    ...Array.from({ length: 22 }, (_, i) => ({
      key: `page${i + 1}`,
      name: `ページ候補${String(i + 1).padStart(2, "0")}`,
      prefecture_code: "14",
      prefecture: "神奈川県",
      industry_codes: ["E"],
      industry_labels: ["製造業"],
      employee_number: i + 1,
    })),
  ];
  const token = await tokenFor(users.owner);
  const candidateRows = await direct(
    "/rest/v1/company_candidates",
    "POST",
    token,
    seed.map((row, index) => ({
      organization_id: org,
      corporate_number: String(8100000000000 + index),
      prefecture_code: null,
      prefecture: null,
      industry_codes: [],
      industry_labels: [],
      phone: null,
      website_url: null,
      employee_number: null,
      location: row.prefecture ? `${row.prefecture}検証市1番地` : null,
      fetched_at: new Date(Date.UTC(2026, 9, 5, 1, index)).toISOString(),
      provenance: { fixture: "synthetic-local-only" },
      ...Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== "key"),
      ),
    })),
    201,
  );
  const candidates = Object.fromEntries(
    seed.map((row) => [
      row.key,
      candidateRows.find((candidate) => candidate.name === row.name),
    ]),
  );
  assert.equal(candidateRows.length, seed.length);
  const savedExisting = (
    await request(
      page,
      root + "/companies",
      "POST",
      {
        name: "手入力を維持する既存法人",
        corporate_number: candidates.existing.corporate_number,
        phone: "03-1111-1111",
        employee_min: 4,
        employee_max: 4,
      },
      201,
    )
  ).data;
  const savedSameName = (
    await request(
      page,
      root + "/companies",
      "POST",
      {
        name: candidates.sameName.name,
        corporate_number: "8200000000000",
      },
      201,
    )
  ).data;
  pass(
    "Synthetic candidates inserted using authenticated owner RLS; no service-role seed",
  );

  stage = "real API search, filter, pagination, missing configuration";
  let result = await request(page, endpoint + "?prefecture=13&industry=D");
  assert.equal(result.count, 2);
  result = await request(
    page,
    endpoint +
      "?prefecture=13&industry=D&hasPhone=true&hasWebsite=true&hasEmployees=true",
  );
  assert.equal(result.count, 1);
  assert.equal(result.data[0].id, candidates.zero.id);
  assert.equal(result.data[0].employee_number, 0);
  result = await request(page, endpoint + "?industry=unknown");
  assert.equal(result.count, 4);
  for (const key of ["literal0", "literal1", "literal2", "literal3", "zero"]) {
    const term = candidates[key].name;
    const found = await request(
      page,
      endpoint + "?search=" + encodeURIComponent(term),
    );
    assert.equal(found.count, 1, "Literal company search");
    assert.equal(found.data[0].id, candidates[key].id);
  }
  const wideNumber = candidates.zero.corporate_number.replace(/[0-9]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) + 0xfee0),
  );
  assert.equal(
    (
      await request(
        page,
        endpoint + "?search=" + encodeURIComponent(wideNumber),
      )
    ).data[0].id,
    candidates.zero.id,
  );
  assert.equal(
    (
      await request(
        page,
        endpoint +
          "?search=" +
          encodeURIComponent('\"),id.neq.00000000-0000-0000-0000-000000000000'),
      )
    ).count,
    0,
  );
  result = await request(
    page,
    endpoint +
      "?search=" +
      encodeURIComponent("ページ候補") +
      "&sort=name&direction=asc&pageSize=7&page=2",
  );
  assert.equal(result.count, 22);
  assert.deepEqual(
    result.data.map((row) => row.name),
    seed
      .filter((row) => row.key.startsWith("page"))
      .slice(7, 14)
      .map((row) => row.name),
  );
  result = await request(
    page,
    endpoint +
      "?search=" +
      encodeURIComponent("ページ候補") +
      "&sort=name&direction=asc&pageSize=7&page=999",
  );
  assert.equal(result.page, 4);
  assert.equal(result.data[0].id, candidates.page22.id);
  const unavailable = await request(
    page,
    endpoint,
    "POST",
    { action: "acquire", prefecture: "13" },
    503,
  );
  assert.equal(unavailable.error.code, "gbiz_not_configured");
  pass(
    "Prefecture AND industry, field-presence filters, zero vs unknown, literal/full-width lookup, ordered pages and missing token 503",
  );

  stage = "desktop search UI and keyboard controls";
  await organization(page, org);
  await visibleCount(seed.length);
  await choose(page, "都道府県", "東京都", "東京");
  await expect(
    page.getByRole("button", {
      name: "Gビズインフォから候補を取得",
      exact: true,
    }),
  ).toBeDisabled();
  await choose(page, "業種", "建設業", "建設");
  await visibleCount(2);
  await page
    .getByRole("checkbox", { name: "従業員数あり", exact: true })
    .check();
  await visibleCount(1);
  await expect(
    page.getByRole("row").filter({
      has: page.getByRole("button", {
        name: candidates.zero.name,
        exact: true,
      }),
    }),
  ).toContainText("0 名");
  await page
    .getByRole("checkbox", { name: "電話番号あり", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Webサイトあり", exact: true })
    .check();
  await visibleCount(1);
  await page.screenshot({
    path: output + "/filtered-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "条件をクリア", exact: true }).click();
  await visibleCount(seed.length);
  const prefecture = page.getByRole("combobox", {
    name: "都道府県",
    exact: true,
  });
  await prefecture.focus();
  await prefecture.press("ArrowDown");
  await popupWithinViewport(page);
  const popup = page.locator('[data-slot="popover-content"]');
  const prefSearch = popup.getByRole("combobox", {
    name: "都道府県を検索",
    exact: true,
  });
  await expect(prefSearch).toBeFocused();
  await prefSearch.fill("神奈川");
  await expect(
    popup.getByRole("option", { name: "神奈川県", exact: true }),
  ).toBeVisible();
  await prefSearch.press("Enter");
  await expect(prefecture).toContainText("神奈川県");
  await expect(prefecture).toBeFocused();
  await prefecture.click();
  await prefSearch.press("Escape");
  await expect(prefecture).toBeFocused();
  await choose(page, "都道府県", "都道府県：すべて", "");
  await searchFor("存在しない候補-検証");
  await visibleCount(0);
  await expect(
    page.getByText("条件に合う取得済み候補はありません", { exact: true }),
  ).toBeVisible();
  await searchFor("ページ候補");
  await visibleCount(22);
  await page.getByRole("button", { name: "企業名", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toContainText("ページ候補01");
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await expect(
    page.getByText("22 件中 21–22 件", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "ページ候補22を選択", exact: true })
    .check();
  await page.getByRole("button", { name: "前のページ", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "ページ候補01を選択", exact: true })
    .check();
  await expect(
    page.getByText("2 / 50 社を選択中", { exact: true }),
  ).toBeVisible();
  await searchFor(candidates.zero.corporate_number);
  await visibleCount(1);
  await expect(
    page.getByRole("button", { name: "前のページ", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("2 / 50 社を選択中", { exact: true }),
  ).toHaveCount(0);
  pass(
    "Browser AND filters, unknown/zero display, empty state, keyboard/Escape focus, paging and selection reset",
  );

  stage = "duplicate preview, explicit confirmation, CRM import and replay";
  const ids = [
    candidates.zero.id,
    candidates.existing.id,
    candidates.sameName.id,
  ];
  const preview = await request(page, endpoint, "POST", {
    action: "preview",
    ids,
  });
  assert.equal(
    preview.items.find((row) => row.candidate_id === candidates.existing.id)
      .company_id,
    savedExisting.id,
  );
  assert.ok(
    preview.items
      .find((row) => row.candidate_id === candidates.sameName.id)
      .duplicates.some((row) => row.id === savedSameName.id),
  );
  const blockedImport = await request(
    page,
    endpoint,
    "POST",
    {
      action: "import",
      ids,
      reviewToken: preview.review_token,
      confirmedDuplicates: false,
      confirmed: true,
    },
    409,
  );
  assert.equal(blockedImport.error.code, "preview_changed");
  assert.equal((await request(page, root + "/companies")).count, 2);
  await searchFor("取込検証");
  await visibleCount(3);
  for (const key of ["zero", "existing", "sameName"])
    await page
      .getByRole("checkbox", {
        name: candidates[key].name + "を選択",
        exact: true,
      })
      .check();
  await page
    .getByRole("button", { name: "営業リストに取り込む", exact: true })
    .click();
  let dialog = page.locator('[data-slot="dialog-content"]');
  await expect(
    dialog.getByRole("heading", {
      name: "営業リストへの取込を確認",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", {
      name: "登録済みの企業を開く（別タブ）",
      exact: true,
    }),
  ).toHaveAttribute("href", `/companies/${savedExisting.id}`);
  await expect(
    dialog.getByRole("button", { name: "確認して取り込む", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByText("企業名が一致", { exact: true })).toBeVisible();
  await page.screenshot({
    path: output + "/duplicate-review-desktop.png",
    fullPage: true,
  });
  await dialog.getByRole("checkbox").check();
  const pendingImport = page.waitForResponse(
    (r) =>
      r.url().endsWith(endpoint) &&
      r.request().method() === "POST" &&
      r.request().postDataJSON()?.action === "import",
  );
  await dialog
    .getByRole("button", { name: "確認して取り込む", exact: true })
    .click();
  const importResponse = await pendingImport;
  assert.equal(importResponse.status(), 200);
  const imported = await importResponse.json();
  assert.equal(imported.created_count, 2);
  assert.equal(imported.existing_count, 1);
  await expect(
    dialog.getByRole("heading", {
      name: "営業リストに取り込みました",
      exact: true,
    }),
  ).toBeVisible();
  const replay = await request(page, endpoint, "POST", {
    action: "import",
    ids,
    reviewToken: preview.review_token,
    confirmedDuplicates: true,
    confirmed: true,
  });
  assert.equal(replay.created_count, 0);
  assert.equal(replay.existing_count, 3);
  assert.equal((await request(page, root + "/companies")).count, 4);
  const preserved = (
    await request(page, root + `/companies/${savedExisting.id}`)
  ).data;
  assert.equal(preserved.name, savedExisting.name);
  assert.equal(preserved.phone, savedExisting.phone);
  assert.equal(preserved.employee_min, 4);
  const importedZero = imported.items.find(
    (row) => row.candidate_id === candidates.zero.id,
  ).company_id;
  stage = "import result to real persisted call activity";
  for (const call of [
    {
      candidate: candidates.zero,
      companyId: importedZero,
      companyName: candidates.zero.name,
      phone: candidates.zero.phone,
      title: "外部企業の取込直後に架電",
      screenshot: "imported-company-call.png",
    },
    {
      candidate: candidates.existing,
      companyId: savedExisting.id,
      companyName: savedExisting.name,
      phone: savedExisting.phone,
      title: "既存CRMの電話番号で架電",
      screenshot: "existing-company-call.png",
    },
  ]) {
    const resultDialog = page.locator('[data-slot="dialog-content"]').filter({
      has: page.getByRole("heading", {
        name: "営業リストに取り込みました",
        exact: true,
      }),
    });
    const resultRow = resultDialog.getByRole("listitem").filter({
      has: page.getByRole("link", { name: call.candidate.name, exact: true }),
    });
    await resultRow.getByRole("button", { name: /架電を記録$/ }).click();
    const activityDialog = page.locator('[data-slot="dialog-content"]').filter({
      has: page.getByRole("textbox", { name: "架電先電話番号", exact: true }),
    });
    await expect(
      activityDialog.getByLabel("架電先電話番号", { exact: true }),
    ).toHaveValue(call.phone);
    await expect(
      activityDialog.getByRole("heading", {
        name: `${call.companyName}の営業活動を記録`,
        exact: true,
      }),
    ).toBeVisible();
    await activityDialog.getByLabel("件名", { exact: true }).fill(call.title);
    await page.screenshot({
      path: output + "/" + call.screenshot,
      fullPage: true,
    });
    const activitySaved = page.waitForResponse(
      (response) =>
        response.url().endsWith(root + "/activities") &&
        response.request().method() === "POST",
    );
    await activityDialog
      .getByRole("button", { name: "活動を保存", exact: true })
      .click();
    assert.equal((await activitySaved).status(), 201);
    await expect(activityDialog).toHaveCount(0);
    await expect(resultDialog).toBeVisible();
    const activities = await request(
      page,
      root + "/activities?company_id=" + call.companyId,
    );
    const savedCall = activities.data.find((row) => row.title === call.title);
    assert.ok(savedCall);
    assert.equal(savedCall.company_id, call.companyId);
    assert.equal(savedCall.type, "call");
    assert.equal(savedCall.call_details.phone_number, call.phone);
    assert.equal(new URL(page.url()).pathname, "/discover");
  }
  pass(
    "Import result → record call → persisted activity; linked existing company uses original CRM phone, not candidate phone",
  );
  stage = "duplicate preview, explicit confirmation, CRM import and replay";
  assert.equal(
    (await request(page, root + `/companies/${importedZero}`)).data
      .employee_min,
    0,
  );
  const evidence = await direct(
    `/rest/v1/company_candidate_imports?organization_id=eq.${org}&select=company_id,candidate_snapshot`,
    "GET",
    token,
  );
  assert.equal(evidence.length, 3);
  assert.equal(
    evidence.find((row) => row.company_id === importedZero).candidate_snapshot
      .employee_number,
    0,
  );
  await dialog
    .locator('[data-slot="dialog-footer"]')
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  await page.reload();
  await searchFor(candidates.zero.corporate_number);
  await visibleCount(1);
  await expect(
    page
      .getByRole("row")
      .filter({
        has: page.getByRole("button", {
          name: candidates.zero.name,
          exact: true,
        }),
      })
      .getByRole("link", { name: "登録済み", exact: true }),
  ).toHaveAttribute("href", `/companies/${importedZero}`);
  pass(
    "UI confirms same-name duplicates; existing corporate number linked without overwrite; retry creates no duplicates; import evidence survives reload",
  );

  stage = "manual candidate edit, stale update conflict and SSRF refusal";
  const beforeEdit = (
    await request(
      page,
      endpoint + "?search=" + candidates.zero.corporate_number,
    )
  ).data[0];
  await page
    .getByRole("button", { name: candidates.zero.name, exact: true })
    .click();
  dialog = page.locator('[data-slot="dialog-content"]');
  await dialog.getByLabel("電話番号", { exact: true }).fill("03-2222-3333");
  await dialog.getByLabel("従業員数（名）", { exact: true }).fill("12");
  const pendingUpdate = page.waitForResponse(
    (r) =>
      r.url().endsWith(endpoint) &&
      r.request().method() === "POST" &&
      r.request().postDataJSON()?.action === "update",
  );
  await dialog
    .getByRole("button", { name: "確認して保存", exact: true })
    .click();
  assert.equal((await pendingUpdate).status(), 200);
  await expect(
    dialog.getByRole("button", { name: "確認して保存", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  const conflict = await request(
    page,
    endpoint,
    "POST",
    {
      action: "update",
      id: beforeEdit.id,
      expectedUpdatedAt: beforeEdit.updated_at,
      phone: "03-0000-0000",
      website_url: beforeEdit.website_url,
      employee_number: 99,
    },
    409,
  );
  assert.equal(conflict.error.code, "candidate_changed");
  await page.reload();
  await searchFor(candidates.zero.corporate_number);
  await visibleCount(1);
  const current = (
    await request(
      page,
      endpoint + "?search=" + candidates.zero.corporate_number,
    )
  ).data[0];
  assert.equal(current.phone, "03-2222-3333");
  assert.equal(current.employee_number, 12);
  assert.ok(current.provenance.manualOverrides.includes("phone"));
  const unmodifiedCRM = (
    await request(page, root + `/companies/${importedZero}`)
  ).data;
  assert.equal(unmodifiedCRM.phone, candidates.zero.phone);
  assert.equal(unmodifiedCRM.employee_min, 0);
  await searchFor(candidates.blocked.corporate_number);
  await visibleCount(1);
  await page
    .getByRole("button", { name: candidates.blocked.name, exact: true })
    .click();
  const pendingEnrich = page.waitForResponse(
    (r) =>
      r.url().endsWith(endpoint) &&
      r.request().method() === "POST" &&
      r.request().postDataJSON()?.action === "enrich",
  );
  await dialog
    .getByRole("button", { name: "公式サイトを確認", exact: true })
    .click();
  const enrichResponse = await pendingEnrich;
  assert.equal(enrichResponse.status(), 200);
  const enriched = (await enrichResponse.json()).candidate;
  assert.equal(enriched.enrichment_result.status, "blocked");
  assert.equal(enriched.phone, null);
  assert.equal(enriched.employee_number, null);
  await expect(
    dialog.getByText("公式サイトの確認結果", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  pass(
    "Manual values/provenance persist, stale edit returns 409, CRM stays intact and private-address enrichment is blocked",
  );

  stage = "responsive dropdowns and existing CRM form custom value";
  await page.goto(base + "/discover");
  await visibleCount(seed.length);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "都道府県", exact: true }).click();
  await popupWithinViewport(page);
  await page.screenshot({
    path: output + "/prefecture-mobile.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "業種", exact: true }).click();
  await popupWithinViewport(page);
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("combobox", { name: "業種を検索", exact: true })
    .fill("学術");
  await page
    .getByRole("option", {
      name: "学術研究、専門・技術サービス業",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("combobox", { name: "業種", exact: true }),
  ).toHaveAttribute("title", "学術研究、専門・技術サービス業");
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(
    widths.scroll <= widths.client + 1,
    "No page-wide horizontal overflow on mobile",
  );
  await page.screenshot({
    path: output + "/industry-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + "/companies");
  await page
    .getByRole("button", { name: "新規企業登録", exact: true })
    .first()
    .click();
  dialog = page.locator('[data-slot="dialog-content"]');
  await dialog
    .getByLabel("会社名", { exact: false })
    .fill("独自業種入力を保持する企業");
  const industry = dialog.getByRole("combobox", { name: "業種", exact: true });
  await industry.click();
  await popup
    .getByRole("combobox", { name: "業種を検索", exact: true })
    .fill("独自業種テスト");
  await popup
    .getByRole("option", { name: "「独自業種テスト」を設定", exact: true })
    .click();
  await expect(industry).toContainText("独自業種テスト");
  await industry.click();
  await expect(
    popup.getByRole("option", { name: "独自業種テスト", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await dialog.getByRole("combobox", { name: "都道府県", exact: true }).click();
  await popupWithinViewport(page);
  await popup
    .getByRole("combobox", { name: "都道府県を検索", exact: true })
    .fill("東京");
  await popup
    .getByRole("combobox", { name: "都道府県を検索", exact: true })
    .press("Enter");
  await expect(
    dialog.getByRole("combobox", { name: "都道府県", exact: true }),
  ).toContainText("東京都");
  await page.screenshot({
    path: output + "/company-form-desktop.png",
    fullPage: true,
  });
  const pendingCompany = page.waitForResponse(
    (r) =>
      r.url().endsWith(root + "/companies") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  assert.equal((await pendingCompany).status(), 201);
  await expect(dialog).toHaveCount(0);
  const custom = (
    await request(
      page,
      root +
        "/companies?search=" +
        encodeURIComponent("独自業種入力を保持する企業"),
    )
  ).data[0];
  assert.equal(custom.industry, "独自業種テスト");
  assert.equal(custom.prefecture, "東京都");
  await page.goto(base + `/companies/${custom.id}`);
  await page.getByRole("button", { name: "企業を編集", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "業種", exact: true }),
  ).toContainText("独自業種テスト");
  await dialog.getByRole("combobox", { name: "業種", exact: true }).click();
  await popup.getByRole("option", { name: "未設定", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "業種", exact: true }),
  ).toContainText("未設定");
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  pass(
    "Mobile dropdown height/width, long industry label, keyboard prefecture, custom industry save/reopen and clear",
  );

  stage = "viewer and cross-organization real API/RLS authorization";
  await request(page, root + "/members", "POST", {
    action: "invite",
    email: users.viewer.email,
    role: "viewer",
  });
  const viewerContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  contexts.push(viewerContext);
  const viewerPage = await viewerContext.newPage();
  viewerPage.on("pageerror", (error) => runtimeErrors.push(error.name));
  await login(viewerPage, users.viewer);
  const invitations = (await request(viewerPage, "/api/invitations")).data;
  const invite = invitations.find((row) => row.organization_name === orgName);
  assert.ok(invite);
  await request(viewerPage, "/api/invitations", "POST", {
    invitation_id: invite.id,
  });
  await organization(viewerPage, org);
  await expect(
    viewerPage.getByRole("heading", {
      name: `取得済み候補 ${seed.length} 社`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    viewerPage.getByRole("button", {
      name: "Gビズインフォから候補を取得",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    viewerPage.getByRole("checkbox", {
      name: "このページの候補をすべて選択",
      exact: true,
    }),
  ).toHaveCount(0);
  await viewerPage
    .getByLabel("企業名・法人番号", { exact: true })
    .fill(candidates.zero.corporate_number);
  await viewerPage
    .getByRole("button", { name: candidates.zero.name, exact: true })
    .click();
  const viewerDialog = viewerPage.locator('[data-slot="dialog-content"]');
  await expect(
    viewerDialog.getByRole("button", { name: "確認して保存", exact: true }),
  ).toHaveCount(0);
  await expect(
    viewerDialog.getByRole("button", { name: "公式サイトを確認", exact: true }),
  ).toHaveCount(0);
  for (const input of [
    { action: "preview", ids },
    {
      action: "import",
      ids,
      reviewToken: preview.review_token,
      confirmedDuplicates: true,
      confirmed: true,
    },
    { action: "acquire", prefecture: "13" },
    { action: "enrich", id: candidates.blocked.id },
    { action: "remove", ids: [candidates.existing.id], confirmed: true },
    {
      action: "update",
      id: current.id,
      expectedUpdatedAt: current.updated_at,
      phone: null,
      website_url: null,
      employee_number: null,
    },
  ])
    await request(viewerPage, endpoint, "POST", input, 403);
  const viewerToken = await tokenFor(users.viewer);
  const viewerRows = await direct(
    `/rest/v1/company_candidates?organization_id=eq.${org}&select=id`,
    "GET",
    viewerToken,
  );
  assert.equal(viewerRows.length, seed.length);
  const deniedUpdate = await direct(
    `/rest/v1/company_candidates?id=eq.${candidates.zero.id}`,
    "PATCH",
    viewerToken,
    { phone: "03-0000-0000" },
  );
  assert.deepEqual(deniedUpdate, []);
  await direct(
    "/rest/v1/company_candidates",
    "POST",
    viewerToken,
    {
      organization_id: org,
      corporate_number: "8999999999999",
      name: "Viewer write must fail",
    },
    403,
  );
  const otherContext = await browser.newContext();
  contexts.push(otherContext);
  const otherPage = await otherContext.newPage();
  otherPage.on("pageerror", (error) => runtimeErrors.push(error.name));
  await login(otherPage, users.other);
  await request(otherPage, endpoint, "GET", undefined, 403);
  await request(otherPage, endpoint, "POST", { action: "preview", ids }, 403);
  const otherToken = await tokenFor(users.other);
  assert.deepEqual(
    await direct(
      `/rest/v1/company_candidates?organization_id=eq.${org}&select=id`,
      "GET",
      otherToken,
    ),
    [],
  );
  assert.deepEqual(
    await direct(
      `/rest/v1/company_candidate_imports?organization_id=eq.${org}&select=id`,
      "GET",
      otherToken,
    ),
    [],
  );
  assert.equal(
    (
      await request(
        page,
        endpoint + "?search=" + candidates.zero.corporate_number,
      )
    ).data[0].phone,
    "03-2222-3333",
  );
  assert.deepEqual(runtimeErrors, []);
  pass(
    "Viewer UI/API/Data API write denial; other organization API denied and candidate/import RLS hidden; browser runtime clean",
  );

  stage = "candidate deletion leaves imported CRM and evidence intact";
  await organization(page, org);
  await searchFor(candidates.existing.corporate_number);
  await visibleCount(1);
  await page
    .getByRole("checkbox", {
      name: candidates.existing.name + "を選択",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "候補から削除", exact: true }).click();
  dialog = page.locator('[data-slot="dialog-content"]');
  await expect(
    dialog.getByRole("heading", {
      name: "選択した候補を削除しますか？",
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "削除する", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await visibleCount(0);
  assert.equal(
    (await request(page, root + `/companies/${savedExisting.id}`)).data.phone,
    savedExisting.phone,
  );
  assert.equal(
    (
      await direct(
        `/rest/v1/company_candidate_imports?organization_id=eq.${org}&select=id`,
        "GET",
        token,
      )
    ).length,
    3,
  );
  pass(
    "Confirmed candidate deletion preserves the imported CRM company and immutable source snapshot",
  );
  console.log(
    "PASS: Discovery E2E complete (local synthetic records; no live Gbiz/public-site call)",
  );
} catch (error) {
  // Do not print Playwright request traces, cookies, headers or fixture secrets.
  console.error(
    `FAIL: Discovery E2E stage '${stage}' (${error instanceof Error ? error.name : "UnknownError"})`,
  );
  const location =
    error instanceof Error
      ? error.stack?.match(/discovery-e2e\.mjs:\d+:\d+/)?.[0]
      : null;
  if (location) console.error(location);
  if (error instanceof Error && error.name === "AssertionError") {
    console.error(error.message.split("\n").slice(0, 3).join("\n"));
  }
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser.close();
}
