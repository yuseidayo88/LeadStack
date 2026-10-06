// Real Auth/PostgREST/browser checks against a disposable local fixture only.
// Candidate records below are synthetic. No live Gbiz or public website is called.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

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
const output = process.env.E2E_OUTPUT || "test-results/discovery-performance";
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

const fixtureCount = Number(process.env.PERF_CANDIDATES || 1000);
assert.ok([500, 1000, 5000].includes(fixtureCount));
const phase = process.env.PERF_PHASE || "baseline";
assert.ok(/^[a-z0-9-]+$/.test(phase));
const listView = process.env.PERF_VIEW || "full";
assert.ok(["full", "summary"].includes(listView));
let org;
let token;
const report = {
  phase,
  listView,
  measuredAt: new Date().toISOString(),
  notes: [
    "Bounded local comparison with synthetic large provenance, not a production load test or SLA.",
    "First request is the first timed sample; database and application caches are not forcibly cold.",
    "p95 uses nearest rank on the stated small sample and equals the observed maximum here.",
    "Body bytes are decoded JSON size, not compressed network transfer size.",
    "Database EXPLAIN times do not include JSON serialization or network transfer.",
  ],
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  fixture: { candidates: fixtureCount, localOnly: true },
  api: {},
  database: {},
  browser: {},
};
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    p50Ms: Number(sorted[Math.ceil(sorted.length * 0.5) - 1].toFixed(2)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)),
    minMs: Number(sorted[0].toFixed(2)),
    maxMs: Number(sorted.at(-1).toFixed(2)),
  };
}
async function minimalWrite(path, method, rows) {
  const response = await fetch(gateway + path, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    ...(rows === undefined ? {} : { body: JSON.stringify(rows) }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);
  assert.ok(response, "Local fixture write failed");
  assert.ok(response.ok, "Local fixture write status " + response.status);
}
async function timedApp(path) {
  return page.evaluate(async (path) => {
    const started = performance.now();
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const text = await response.text();
    const readAt = performance.now();
    const data = JSON.parse(text);
    const parsedAt = performance.now();
    const bytes = (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length;
    const rows = data.data || [];
    return {
      status: response.status,
      responseMs: readAt - started,
      parseMs: parsedAt - readAt,
      bodyBytes: new TextEncoder().encode(text).length,
      count: data.count,
      page: data.page,
      rows: rows.length,
      firstId: rows[0]?.id ?? null,
      listSummary: rows[0]?.list_summary === true,
      serverTiming: response.headers.get("server-timing"),
      provenanceBytes: rows.reduce(
        (n, row) => n + (row.provenance ? bytes(row.provenance) : 0),
        0,
      ),
      repeatedSummaryBytes: rows.reduce(
        (n, row) =>
          n + (row.business_summary ? bytes(row.business_summary) : 0),
        0,
      ),
    };
  }, path);
}

try {
  stage = "local login and isolated fixture";
  await login(page, users.owner);
  org = (
    await request(
      page,
      "/api/organizations",
      "POST",
      {
        name: `企業検索性能-${phase}-${Date.now()}`,
      },
      201,
    )
  ).data.id;
  assert.match(org, /^[0-9a-f-]{36}$/);
  const endpoint = `/api/organizations/${org}/company-discovery`;
  assert.equal(
    (await request(page, endpoint)).configured,
    false,
    "No live Gbiz configuration allowed",
  );
  token = await tokenFor(users.owner);
  const longSummary =
    "空調設備の保守点検、現場報告書の作成、写真管理、見積と請求の事務作業。".repeat(
      90,
    );
  const provenance = {
    fixture: "synthetic-local-performance-only",
    businessSummary: longSummary,
    businessSummaryTruncated: false,
    gbiz: {
      source: "gBizINFO",
      retrievedAt: "2026-10-05T01:00:00Z",
      requestUrl: "https://api.info.gbiz.go.jp/hojin/v2/hojin/8300000000000",
      metadata: {
        source: Object.fromEntries(
          [
            "name",
            "location",
            "industry",
            "employee_number",
            "company_url",
            "business_summary",
          ].map((key) => [key, "Gビズインフォ合成検証データ"]),
        ),
        lastUpdateDate: { business_summary: "2026-09-01" },
      },
    },
    fieldSources: Object.fromEntries(
      [
        "name",
        "location",
        "industry",
        "employee_number",
        "website_url",
        "business_summary",
      ].map((key) => [
        key,
        {
          source: "Gビズインフォ合成検証データ",
          retrievedAt: "2026-10-05T01:00:00Z",
          sourceUpdatedAt: "2026-09-01",
          sourceUrl:
            "https://info.gbiz.go.jp/hojin/ichiran?hojinBango=8300000000000",
        },
      ]),
    ),
  };
  report.fixture.provenanceBytes = Buffer.byteLength(
    JSON.stringify(provenance),
  );
  report.fixture.businessSummaryBytes = Buffer.byteLength(longSummary);
  assert.ok(report.fixture.provenanceBytes < 15_800);
  for (let offset = 0; offset < fixtureCount; offset += 100) {
    await minimalWrite(
      "/rest/v1/company_candidates",
      "POST",
      Array.from({ length: Math.min(100, fixtureCount - offset) }, (_, i) => {
        const index = offset + i;
        return {
          organization_id: org,
          corporate_number: String(8400000000000 + index),
          name: `性能検証${String(index).padStart(5, "0")}設備`,
          prefecture_code: index % 4 ? "13" : "27",
          prefecture: index % 4 ? "東京都" : "大阪府",
          location: index % 4 ? "東京都検証市1番地" : "大阪府検証市1番地",
          industry_codes: [index % 3 ? "D" : "I"],
          industry_labels: [index % 3 ? "建設業" : "卸売業、小売業"],
          employee_number: index % 7 === 0 ? null : index % 100,
          website_url: "https://example.test/fixture",
          phone: "03-0000-0000",
          fetched_at: new Date(Date.UTC(2026, 9, 5, 0, 0, index)).toISOString(),
          provenance,
        };
      }),
    );
  }
  assert.equal((await request(page, endpoint)).count, fixtureCount);
  console.log("Fixture ready: " + JSON.stringify(report.fixture));

  stage = "bounded real API latency and payload measurements";
  const queryCases = {
    firstPage: "?pageSize=20&page=1",
    filtered:
      "?pageSize=20&page=1&prefecture=13&industry=D&employeeMin=10&employeeMax=50&includeUnknownEmployees=true&businessKeywords=" +
      encodeURIComponent("設備 保守 点検"),
    lastPage: "?pageSize=20&page=" + Math.ceil(fixtureCount / 20),
  };
  for (const [name, params] of Object.entries(queryCases)) {
    const path = endpoint + params + "&view=" + listView;
    const first = await timedApp(path);
    assert.equal(first.status, 200);
    const samples = [];
    for (let i = 0; i < 7; i++) {
      const result = await timedApp(path);
      assert.equal(result.status, 200);
      samples.push(result);
    }
    report.api[name] = {
      firstRequestMs: Number(first.responseMs.toFixed(2)),
      warm: summary(samples.map((s) => s.responseMs)),
      jsonParse: summary(samples.map((s) => s.parseMs)),
      bodyBytes: first.bodyBytes,
      rows: first.rows,
      count: first.count,
      provenanceBytes: first.provenanceBytes,
      repeatedSummaryBytes: first.repeatedSummaryBytes,
      serverTiming: first.serverTiming,
    };
    if (listView === "summary") {
      assert.equal(first.listSummary, true);
      assert.ok(
        first.provenanceBytes <= 100,
        "Summary list excludes full provenance",
      );
      assert.ok(
        first.bodyBytes < 50_000,
        "Twenty summary rows stay below 50KB for this fixture",
      );
    }
  }
  if (listView === "summary") {
    const list = await timedApp(endpoint + "?view=summary&pageSize=20");
    const started = performance.now();
    const detail = await request(page, endpoint + "/" + list.firstId);
    report.api.detail = {
      elapsedMs: Number((performance.now() - started).toFixed(2)),
      bodyBytes: Buffer.byteLength(JSON.stringify(detail)),
      provenanceBytes: Buffer.byteLength(
        JSON.stringify(detail.candidate.provenance),
      ),
    };
    assert.equal(detail.candidate.provenance.businessSummary, longSummary);
    assert.equal(detail.candidate.business_summary, longSummary);
    assert.equal(
      detail.candidate.provenance.fieldSources.business_summary.source,
      "Gビズインフォ合成検証データ",
    );
  }

  stage = "authenticated RLS database execution time";
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString(),
  );
  assert.match(claims.sub, /^[0-9a-f-]{36}$/);
  assert.match(claims.session_id, /^[0-9a-f-]{36}$/);
  const claimsSql = JSON.stringify({
    sub: claims.sub,
    session_id: claims.session_id,
  });
  const predicates = `organization_id='${org}'::uuid`;
  const dbQueries = {
    firstPage: `select * from public.company_candidates where ${predicates} order by fetched_at desc,id limit 20`,
    filtered: `select * from public.company_candidates where ${predicates} and prefecture_code='13' and industry_codes @> '{D}' and (employee_number is null or employee_number between 10 and 50) and (name ilike '%設備%' or provenance->>'businessSummary' ilike '%設備%' or name ilike '%保守%' or provenance->>'businessSummary' ilike '%保守%' or name ilike '%点検%' or provenance->>'businessSummary' ilike '%点検%') order by fetched_at desc,id limit 20`,
    count: `select count(*) from public.company_candidates where ${predicates}`,
  };
  for (const [name, sql] of Object.entries(dbQueries)) {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const raw = execFileSync(
        "docker",
        [
          "exec",
          "-i",
          "leadstack-e2e-db",
          "psql",
          "-X",
          "-qAt",
          "-h",
          "/tmp",
          "-p",
          "5432",
          "-U",
          "supabase_admin",
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
        ],
        {
          encoding: "utf8",
          input: `begin;set local role authenticated;set local request.jwt.claim.sub='${claims.sub}';set local request.jwt.claims='${claimsSql}';explain (analyze,buffers,format json) ${sql};rollback;`,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15000,
        },
      );
      const plan = JSON.parse(raw)[0];
      samples.push(plan["Execution Time"]);
      report.database[name] = {
        warm: summary(samples),
        planningMs: plan["Planning Time"],
        rows: plan.Plan["Actual Rows"],
        sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
        sharedReadBlocks: plan.Plan["Shared Read Blocks"],
      };
    }
  }

  stage = "real browser list visibility and request count";
  await page.evaluate(
    (id) => localStorage.setItem("leadstack.organization", id),
    org,
  );
  const pageSamples = [];
  for (let i = 0; i < 3; i++) {
    const calls = [];
    const onRequest = (req) => {
      const url = new URL(req.url());
      if (url.pathname.startsWith("/api/"))
        calls.push({ path: url.pathname, method: req.method() });
    };
    page.on("request", onRequest);
    const began = performance.now();
    await page.goto(base + "/discover");
    await expect(
      page.getByRole("heading", {
        name: `取得済み候補 ${fixtureCount.toLocaleString()} 社`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `性能検証${String(fixtureCount - 1).padStart(5, "0")}設備`,
        exact: true,
      }),
    ).toBeVisible();
    const readyMs = performance.now() - began;
    await page.waitForTimeout(500);
    page.off("request", onRequest);
    const listRequests = calls.filter((call) =>
      call.path.endsWith("/company-discovery"),
    );
    pageSamples.push({
      visibleMs: Number(readyMs.toFixed(2)),
      listRequests: listRequests.length,
      allApiRequests: calls.length,
    });
  }
  report.browser = {
    firstNavigation: pageSamples[0],
    repeat: summary(pageSamples.slice(1).map((sample) => sample.visibleMs)),
    samples: pageSamples,
    runtimeErrors: runtimeErrors.length,
  };
  await page.screenshot({
    path: `${output}/${phase}-desktop.png`,
    fullPage: true,
  });
  assert.deepEqual(runtimeErrors, []);
  await writeFile(`${output}/${phase}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: Performance stage '${stage}' (${error instanceof Error ? error.name : "UnknownError"})`,
  );
  if (error instanceof Error) {
    const location = error.stack?.match(
      /discovery-performance\.mjs:\d+:\d+/,
    )?.[0];
    if (location) console.error(location);
    if (error.name === "AssertionError")
      console.error(error.message.split("\n").slice(0, 3).join("\n"));
  }
  process.exitCode = 1;
} finally {
  if (org && token) {
    await minimalWrite(
      `/rest/v1/company_candidates?organization_id=eq.${org}`,
      "DELETE",
    )
      .then(() => console.log("Own performance candidates cleaned up"))
      .catch(() => {
        console.error("Own local fixture cleanup failed");
        process.exitCode = 1;
      });
  }
  for (const p of loggedInPages)
    await request(p, "/api/auth/logout", "POST", {}).catch(() => {});
  for (const sessionToken of tokenSessions)
    await fetch(gateway + "/auth/v1/logout?scope=local", {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${sessionToken}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  await context.close();
  await browser.close();
}
