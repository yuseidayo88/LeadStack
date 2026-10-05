// Real Auth/PostgREST/browser checks against a disposable local fixture only.
// Candidate records below are synthetic. No live Gbiz or public website is called.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import ts from "typescript";

const base = process.env.E2E_BASE_URL || "http://localhost:3011";
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
const output = process.env.E2E_OUTPUT || "test-results/targeting";
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

// Load the actual pure mapper and its two known runtime dependencies. This
// keeps the database byte-budget regression repeatable without a private
// generated fixture, a new loader, or importing the server application.
async function actualMapping() {
  async function moduleUrl(path, replacements = {}) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    let code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    for (const [specifier, url] of Object.entries(replacements))
      code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(url));
    return (
      "data:text/javascript;base64," + Buffer.from(code).toString("base64")
    );
  }
  const display = await moduleUrl("../../src/lib/crm/display.ts");
  const industries = await moduleUrl("../../src/lib/discovery/industries.ts");
  return import(
    await moduleUrl("../../src/lib/discovery/mapping.ts", {
      "@/lib/crm/display": display,
      "./industries": industries,
    })
  );
}

try {
  stage = "local login and dedicated synthetic fixture";
  await login(page, users.owner);
  const org = (
    await request(
      page,
      "/api/organizations",
      "POST",
      {
        name: `営業対象検索E2E-${Date.now()}`,
      },
      201,
    )
  ).data.id;
  const emptyOrg = (
    await request(
      page,
      "/api/organizations",
      "POST",
      {
        name: `営業対象検索の別組織-${Date.now()}`,
      },
      201,
    )
  ).data.id;
  const endpoint = `/api/organizations/${org}/company-discovery`;
  const initial = await request(page, endpoint);
  assert.equal(initial.configured, false, "Live Gbiz must be disabled locally");
  assert.equal(initial.count, 0);
  const seed = [
    {
      key: "nine",
      name: "人数境界09",
      employee_number: 9,
      summary: "空調設備の保守",
    },
    {
      key: "ten",
      name: "人数境界10",
      employee_number: 10,
      summary: "空調設備の定期点検と報告書作成",
    },
    {
      key: "fifty",
      name: "人数境界50 設備",
      employee_number: 50,
      summary: "現場作業の請負",
    },
    {
      key: "fiftyOne",
      name: "人数境界51",
      employee_number: 51,
      summary: "空調設備の保守",
    },
    {
      key: "zero",
      name: "人数境界00",
      employee_number: 0,
      summary: "空調設備の保守",
    },
    {
      key: "null",
      name: "人数境界未確認",
      employee_number: null,
      summary: "空調設備の保守",
    },
    {
      key: "industryUnknown",
      name: "業種未確認の点検会社",
      employee_number: 20,
      industry_codes: [],
      industry_labels: [],
      summary: "空調設備の保守",
    },
    {
      key: "industryOther",
      name: "卸売業の点検会社",
      employee_number: 20,
      industry_codes: ["I"],
      industry_labels: ["卸売業、小売業"],
      summary: "空調設備の保守",
    },
    {
      key: "outside",
      name: "大阪の点検会社",
      employee_number: 20,
      prefecture_code: "27",
      prefecture: "大阪府",
      summary: "空調設備の保守",
    },
    {
      key: "unrelated",
      name: "別事業の会社",
      employee_number: 20,
      summary: "雑貨の製造",
    },
    ...[
      ["percent", "%_"],
      ["star", "*"],
      ["quote", '引用"事業'],
      ["paren", "事業(支店)"],
      ["slash", "C\\事業"],
      ["inject", '")id.neq.a'],
    ].map(([key, summary], i) => ({
      key,
      name: `文字列照合${i}`,
      employee_number: 20,
      summary,
    })),
  ];
  const token = await tokenFor(users.owner);
  const rows = await direct(
    "/rest/v1/company_candidates",
    "POST",
    token,
    seed.map(({ summary, ...row }, i) => ({
      organization_id: org,
      corporate_number: String(8300000000000 + i),
      prefecture_code: "13",
      prefecture: "東京都",
      location: "東京都検証市1番地",
      industry_codes: ["D"],
      industry_labels: ["建設業"],
      phone: null,
      website_url: null,
      fetched_at: new Date(Date.UTC(2026, 9, 5, 2, i)).toISOString(),
      provenance: {
        fixture: "synthetic-local-targeting-only",
        businessSummary: summary,
        fieldSources: {
          business_summary: {
            source: "Gビズインフォ・ローカル検証用出典",
            retrievedAt: "2026-10-05T00:00:00Z",
            sourceUpdatedAt: "2026-09-01",
          },
        },
      },
      ...Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== "key"),
      ),
    })),
    201,
  );
  const candidates = Object.fromEntries(
    seed.map((row) => [
      row.key,
      rows.find((candidate) => candidate.name === row.name),
    ]),
  );
  const keys = (body) =>
    body.data
      .map((row) => seed.find((entry) => entry.name === row.name)?.key)
      .sort();
  async function query(params, expected, status = 200) {
    const body = await request(
      page,
      endpoint + "?" + new URLSearchParams(params),
      "GET",
      undefined,
      status,
    );
    if (expected) {
      assert.equal(body.count, expected.length, "Filtered exact count");
      assert.deepEqual(
        keys(body),
        [...expected].sort(),
        "Filtered candidate identity",
      );
    }
    return body;
  }
  pass(
    "Dedicated local organization seeded via authenticated owner RLS; Gbiz token absent",
  );

  stage = "employee boundaries and unknown semantics against real PostgREST";
  const boundary = { search: "人数境界" };
  await query({ ...boundary, employeeMin: "10", employeeMax: "50" }, [
    "ten",
    "fifty",
  ]);
  await query(
    {
      ...boundary,
      employeeMin: "10",
      employeeMax: "50",
      includeUnknownEmployees: "true",
    },
    ["ten", "fifty", "null"],
  );
  await query(
    {
      ...boundary,
      employeeMin: "10",
      employeeMax: "50",
      includeUnknownEmployees: "true",
      hasEmployees: "true",
    },
    ["ten", "fifty"],
  );
  await query({ ...boundary, employeeMin: "0", employeeMax: "0" }, ["zero"]);
  await query(
    { ...boundary, employeeMax: "9", includeUnknownEmployees: "true" },
    ["zero", "nine", "null"],
  );
  await query({ ...boundary, employeeMin: "50" }, ["fifty", "fiftyOne"]);
  await query(
    { ...boundary, employeeMin: "2147483647", includeUnknownEmployees: "true" },
    ["null"],
  );
  for (const params of [
    { employeeMin: "51", employeeMax: "50" },
    { employeeMin: "-1" },
    { employeeMax: "1.5" },
    { employeeMax: "2147483648" },
    { includeUnknownEmployees: "yes" },
    { includeUnknownIndustry: "yes" },
    {
      businessKeywords: Array.from({ length: 9 }, (_, i) => `word${i}`).join(
        " ",
      ),
    },
  ])
    await query(params, undefined, 422);
  pass(
    "Employee 9/10/50/51 and 0/null boundaries, inclusive range, unknown opt-in, presence intersection and invalid input 422",
  );

  stage = "business keyword OR with industry prefecture and range AND";
  const combined = {
    prefecture: "13",
    industry: "D",
    employeeMin: "10",
    employeeMax: "50",
    businessKeywords: "設備、保守",
  };
  await query(combined, ["ten", "fifty"]);
  await query({ ...combined, includeUnknownEmployees: "true" }, [
    "ten",
    "fifty",
    "null",
  ]);
  await query({ ...combined, includeUnknownIndustry: "true" }, [
    "ten",
    "fifty",
    "industryUnknown",
  ]);
  const allUnknown = {
    ...combined,
    includeUnknownEmployees: "true",
    includeUnknownIndustry: "true",
  };
  await query(allUnknown, ["ten", "fifty", "null", "industryUnknown"]);
  await query({ ...allUnknown, industry: "unknown" }, ["industryUnknown"]);
  await query({ ...combined, search: "人数境界10" }, ["ten"]);
  await query({ ...combined, businessKeywords: "未該当，設備 保守,設備" }, [
    "ten",
    "fifty",
  ]);
  await query({ ...combined, businessKeywords: "未該当" }, []);
  const first = await query({
    ...allUnknown,
    sort: "name",
    direction: "asc",
    pageSize: "2",
    page: "1",
  });
  const second = await query({
    ...allUnknown,
    sort: "name",
    direction: "asc",
    pageSize: "2",
    page: "2",
  });
  assert.equal(first.count, 4);
  assert.equal(second.count, 4);
  assert.equal(first.data.length, 2);
  assert.equal(second.data.length, 2);
  assert.equal(
    new Set([...first.data, ...second.data].map((row) => row.id)).size,
    4,
  );
  const clamped = await query({
    ...allUnknown,
    sort: "name",
    direction: "asc",
    pageSize: "2",
    page: "999",
  });
  assert.equal(clamped.page, 2);
  assert.deepEqual(
    clamped.data.map((row) => row.id),
    second.data.map((row) => row.id),
  );
  const summary = (await query({ search: candidates.ten.corporate_number }))
    .data[0];
  assert.equal(
    summary.business_summary,
    seed.find((row) => row.key === "ten").summary,
  );
  assert.equal(
    summary.provenance.fieldSources.business_summary.sourceUpdatedAt,
    "2026-09-01",
  );
  pass(
    "Name OR business-summary keyword matching, AND filters, unknown industry, pre-pagination exact count and out-of-range clamp",
  );

  stage = "literal keyword and query-injection safety";
  for (const key of ["percent", "star", "quote", "paren", "slash", "inject"]) {
    const term = seed.find((row) => row.key === key).summary;
    await query({ businessKeywords: term }, [key]);
  }
  await query({ businessKeywords: 'x"),employee_number.gte.0' }, []);
  pass(
    "Literal wildcard, quote, parentheses, backslash and injection-shaped keyword remain data",
  );

  stage = "desktop preset, preserved region, company-name suggestions";
  await organization(page, org);
  await visibleCount(seed.length);
  await choose(page, "都道府県", "東京都", "東京");
  let acquireCalls = 0;
  page.on("request", (req) => {
    if (
      req.url().endsWith(endpoint) &&
      req.method() === "POST" &&
      req.postDataJSON()?.action === "acquire"
    )
      acquireCalls++;
  });
  await page
    .getByRole("button", { name: "設備工事・保守点検", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "都道府県", exact: true }),
  ).toContainText("東京都");
  await expect(page.getByLabel("従業員数の下限", { exact: true })).toHaveValue(
    "10",
  );
  await expect(page.getByLabel("従業員数の上限", { exact: true })).toHaveValue(
    "50",
  );
  await expect(
    page.getByLabel("従業員数が未確認の企業も含める", { exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel("業務キーワード", { exact: true })).toHaveValue(
    "設備 電気 空調 給排水 保守 点検",
  );
  await visibleCount(5);
  assert.equal(
    acquireCalls,
    0,
    "Preset never silently starts provider acquisition",
  );
  await page.screenshot({
    path: output + "/preset-desktop.png",
    fullPage: true,
  });
  const nameHints = page.locator('[aria-label="企業名で取得する候補"]');
  await nameHints.getByRole("button", { name: "空調", exact: true }).click();
  await expect(
    page.getByLabel("企業名・法人番号", { exact: true }),
  ).toHaveValue("空調");
  await expect(page.getByLabel("業務キーワード", { exact: true })).toHaveValue(
    "設備 電気 空調 給排水 保守 点検",
  );
  assert.equal(
    acquireCalls,
    0,
    "Company-name suggestion requires explicit acquire action",
  );
  await page.getByLabel("企業名・法人番号", { exact: true }).fill("");
  await visibleCount(5);
  await choose(page, "業種", "建設業", "建設");
  await visibleCount(3);
  await page.getByLabel("業種が未確認の企業も含める", { exact: true }).check();
  await visibleCount(4);
  await page.reload();
  await visibleCount(4);
  await expect(page.getByLabel("従業員数の下限", { exact: true })).toHaveValue(
    "10",
  );
  await expect(
    page.getByLabel("業種が未確認の企業も含める", { exact: true }),
  ).toBeChecked();
  await organization(page, emptyOrg);
  await visibleCount(0);
  await expect(page.getByLabel("従業員数の下限", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("業務キーワード", { exact: true })).toHaveValue(
    "",
  );
  await organization(page, org);
  await visibleCount(4);
  await expect(page.getByLabel("従業員数の下限", { exact: true })).toHaveValue(
    "10",
  );
  pass(
    "Equipment preset sets 10–50 and unknown employees, preserves prefecture, suggestions stay explicit, reload persists per organization",
  );

  stage = "other tab saves filters without changing the current selection";
  await page
    .getByRole("checkbox", {
      name: candidates.ten.name + "を選択",
      exact: true,
    })
    .check();
  const secondTab = await context.newPage();
  await secondTab.goto(base + "/discover");
  await organization(secondTab, org);
  await expect(
    secondTab.getByLabel("従業員数の下限", { exact: true }),
  ).toHaveValue("10");
  await secondTab.getByLabel("従業員数の下限", { exact: true }).fill("20");
  await expect(
    secondTab.getByRole("heading", { name: "取得済み候補 3 社", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("従業員数の下限", { exact: true })).toHaveValue(
    "10",
  );
  await expect(
    page.getByRole("checkbox", {
      name: candidates.ten.name + "を選択",
      exact: true,
    }),
  ).toBeChecked();
  await visibleCount(4);
  await secondTab.close();
  await page.reload();
  await visibleCount(3);
  await expect(page.getByLabel("従業員数の下限", { exact: true })).toHaveValue(
    "20",
  );
  await expect(
    page.getByText("1 / 50 社を選択中", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("従業員数の下限", { exact: true }).fill("10");
  await visibleCount(4);
  pass(
    "Another tab cannot silently replace current filters or selected companies; reload restores the latest saved criteria",
  );

  stage =
    "range validation suppresses invalid requests and clear resets persisted state";
  const invalidCalls = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" || !req.url().includes(endpoint + "?")) return;
    const params = new URL(req.url()).searchParams;
    if (
      Number(params.get("employeeMin")) > Number(params.get("employeeMax")) &&
      params.has("employeeMax")
    )
      invalidCalls.push(req.url());
  });
  await page.getByLabel("従業員数の下限", { exact: true }).fill("51");
  await expect(page.locator("#discovery-targeting-error")).toContainText(
    "下限",
  );
  await page.waitForTimeout(650);
  assert.equal(
    invalidCalls.length,
    0,
    "Invalid range is validated before any request",
  );
  await page.getByRole("button", { name: "条件をクリア", exact: true }).click();
  await visibleCount(seed.length);
  await expect(page.getByLabel("従業員数の下限", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("従業員数の上限", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("業務キーワード", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByRole("combobox", { name: "都道府県", exact: true }),
  ).toContainText("すべて");
  await page.reload();
  await visibleCount(seed.length);
  await expect(page.getByLabel("従業員数の下限", { exact: true })).toHaveValue(
    "",
  );
  pass(
    "Invalid employee range makes no API call; clear and reload reset all targeting filters",
  );

  stage = "candidate business evidence and mobile layout";
  await searchFor(candidates.ten.corporate_number);
  await visibleCount(1);
  await page
    .getByRole("button", { name: candidates.ten.name, exact: true })
    .click();
  const dialog = page.locator('[data-slot="dialog-content"]');
  await expect(dialog.getByText("事業内容", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(summary.business_summary, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Gビズインフォ・ローカル検証用出典", { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByText(/2026-09-01/)).toBeVisible();
  await page.screenshot({
    path: output + "/business-evidence-desktop.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "条件をクリア", exact: true }).click();
  await page
    .getByRole("button", { name: "設備工事・保守点検", exact: true })
    .click();
  await visibleCount(6);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "都道府県", exact: true }).click();
  await popupWithinViewport(page);
  await page.keyboard.press("Escape");
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(
    widths.scroll <= widths.client + 1,
    "Mobile has no horizontal page overflow",
  );
  await page.screenshot({
    path: output + "/preset-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(runtimeErrors, []);
  pass(
    "Candidate displays factual business summary with source and source date; responsive preset/filter controls and dropdown remain bounded",
  );

  stage = "tenant denial for targeting filters";
  const otherContext = await browser.newContext();
  contexts.push(otherContext);
  const otherPage = await otherContext.newPage();
  await login(otherPage, users.other);
  await request(
    otherPage,
    endpoint + "?" + new URLSearchParams(allUnknown),
    "GET",
    undefined,
    403,
  );
  const otherToken = await tokenFor(users.other);
  const hidden = await direct(
    `/rest/v1/company_candidates?organization_id=eq.${org}&employee_number=gte.10&select=id`,
    "GET",
    otherToken,
  );
  assert.deepEqual(hidden, []);
  pass(
    "Other organization's API denied and Data API rows hidden by RLS with new filters",
  );

  stage = "long Japanese summary mapping, real database limit and manual edit";
  const { candidateFromGbiz, candidateProvenanceBytes } = await actualMapping();
  const originalSummary = "設備保守😀".repeat(1200);
  const sourceCompany = {
    corporateNumber: "8399999999901",
    name: "長文事業内容の保存検証",
    location: "東京都検証市1番地",
    postalCode: null,
    status: null,
    updatedAt: "2026-09-01",
    industry: ["D"],
    companyUrl: null,
    employeeNumber: 20,
    businessSummary: originalSummary,
    provenance: {
      source: "gBizINFO",
      retrievedAt: "2026-10-05T01:00:00Z",
      requestUrl: "https://api.info.gbiz.go.jp/hojin/v2/hojin/8399999999901",
      metadata: {
        source: { business_summary: "Gビズインフォ：事業概要の検証用出典" },
        lastUpdateDate: { business_summary: "2026-09-01" },
      },
    },
  };
  const mapped = candidateFromGbiz(sourceCompany);
  assert.equal(mapped.provenance.businessSummaryTruncated, true);
  assert.ok(candidateProvenanceBytes(mapped.provenance) <= 16_000);
  assert.ok(originalSummary.startsWith(mapped.provenance.businessSummary));
  assert.equal(mapped.provenance.businessSummary.isWellFormed(), true);
  const [stored] = await direct(
    "/rest/v1/company_candidates",
    "POST",
    token,
    {
      organization_id: emptyOrg,
      ...mapped,
    },
    201,
  );
  const longEndpoint = `/api/organizations/${emptyOrg}/company-discovery`;
  const longResult = (await request(page, longEndpoint)).data[0];
  assert.equal(longResult.id, stored.id);
  assert.equal(longResult.business_summary_truncated, true);
  assert.equal(longResult.business_summary, mapped.provenance.businessSummary);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await organization(page, emptyOrg);
  await visibleCount(1);
  await page.getByRole("button", { name: mapped.name, exact: true }).click();
  const longDialog = page.locator('[data-slot="dialog-content"]');
  await expect(
    longDialog.getByText(
      "長い事業内容の一部を表示しています。全文は下の取得元リンクで確認してください。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    longDialog.getByText("Gビズインフォ：事業概要の検証用出典", {
      exact: false,
    }),
  ).toBeVisible();
  await longDialog.getByLabel("電話番号", { exact: true }).fill("03-9876-5432");
  const saveLong = page.waitForResponse(
    (response) =>
      response.url().endsWith(longEndpoint) &&
      response.request().method() === "POST" &&
      response.request().postDataJSON()?.action === "update",
  );
  await longDialog
    .getByRole("button", { name: "確認して保存", exact: true })
    .click();
  assert.equal(
    (await saveLong).status(),
    200,
    "Manual edit of near-cap provenance succeeds",
  );
  await expect(
    longDialog.getByRole("button", { name: "確認して保存", exact: true }),
  ).toBeDisabled();
  const edited = (await request(page, longEndpoint)).data[0];
  assert.equal(edited.phone, "03-9876-5432");
  assert.ok(edited.provenance.manualOverrides.includes("phone"));
  assert.ok(edited.provenance.manual.updatedAt);
  assert.ok(candidateProvenanceBytes(edited.provenance) <= 16_000);
  assert.equal(edited.business_summary_truncated, true);
  assert.ok(originalSummary.startsWith(edited.business_summary));
  assert.equal(edited.business_summary.isWellFormed(), true);
  await page.screenshot({
    path: output + "/long-business-evidence.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await request(page, longEndpoint, "POST", {
    action: "remove",
    ids: [stored.id],
    confirmed: true,
  });
  assert.equal((await request(page, longEndpoint)).count, 0);
  const mixedSummary = "A".repeat(9001) + "😀".repeat(999);
  const mixed = candidateFromGbiz({
    ...sourceCompany,
    corporateNumber: "8399999999902",
    name: "Unicode境界の保存検証",
    businessSummary: mixedSummary,
  });
  assert.equal(mixed.provenance.businessSummaryTruncated, false);
  assert.ok(mixed.provenance.businessSummary === mixedSummary);
  const [mixedStored] = await direct(
    "/rest/v1/company_candidates",
    "POST",
    token,
    {
      organization_id: emptyOrg,
      ...mixed,
    },
    201,
  );
  const mixedResult = (await request(page, longEndpoint)).data[0];
  assert.equal(mixedResult.id, mixedStored.id);
  assert.ok(
    mixedResult.business_summary === mixedSummary,
    "API preserves the complete 10,000-codepoint summary even when UTF-16 length is greater",
  );
  assert.equal(mixedResult.business_summary.isWellFormed(), true);
  assert.equal(mixedResult.business_summary_truncated, false);
  await request(page, longEndpoint, "POST", {
    action: "remove",
    ids: [mixedStored.id],
    confirmed: true,
  });
  assert.equal((await request(page, longEndpoint)).count, 0);
  assert.deepEqual(runtimeErrors, []);
  pass(
    "Actual mapper truncates 6,000 Japanese/emoji codepoints within the real database limit; source/flag display and manual edit survive, temporary candidate removed",
  );
  console.log(
    "PASS: Targeting E2E complete (actual local Auth/PostgREST and browser; no live Gbiz/public website)",
  );
} catch (error) {
  console.error(
    `FAIL: Targeting E2E stage '${stage}' (${error instanceof Error ? error.name : "UnknownError"})`,
  );
  const location =
    error instanceof Error
      ? error.stack?.match(/targeting-e2e\.mjs:\d+:\d+/)?.[0]
      : null;
  if (location) console.error(location);
  if (error instanceof Error && error.name === "AssertionError")
    console.error(error.message.split("\n").slice(0, 3).join("\n"));
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  for (const p of loggedInPages)
    await request(p, "/api/auth/logout", "POST", {}).catch(() => {});
  for (const token of tokenSessions) {
    await fetch(gateway + "/auth/v1/logout?scope=local", {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser.close();
}
