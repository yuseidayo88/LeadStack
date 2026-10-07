import { expandSearchOptions } from "./search-options.mjs";
// Real Auth/PostgREST/browser checks against a disposable local fixture only.
// Candidate records below are synthetic. No live Gbiz or public website is called.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { controlPath, logPath } from "./discovery-gbiz-preload.mjs";
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
const output = process.env.E2E_OUTPUT || "test-results/discovery-scan";
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
  if (destination === "/discover") await expandSearchOptions(p);
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

const organizations = [];
let ownerToken;
async function control(scenario = "normal", detailDelayMs = 0) {
  await writeFile(controlPath, JSON.stringify({ scenario, detailDelayMs }), {
    mode: 0o600,
  });
  await writeFile(logPath, "", { mode: 0o600 });
}
async function upstreamLog() {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function releaseLocalQuota(org) {
  assert.ok(
    organizations.includes(org),
    "Only this test's own organizations may be reset",
  );
  assert.match(org, /^[a-f0-9-]{36}$/);
  execFileSync(
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
      input: `delete from private.discovery_rate_limits where organization_id='${org}'::uuid and operation='acquire';`,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    },
  );
}
async function newOrg(suffix) {
  const name = `条件検索E2E-${suffix}-${Date.now()}`;
  const org = (await request(page, "/api/organizations", "POST", { name }, 201))
    .data.id;
  organizations.push(org);
  return { org, name, endpoint: `/api/organizations/${org}/company-discovery` };
}
let lastIssuedAt = 0;
function scanPayload(criteria, resumeToken) {
  // The durable lease rejects equal/older timestamps and replayed run IDs.
  // Each HTTP chunk is a new attempt even when it resumes the same cursor.
  lastIssuedAt = Math.max(Date.now(), lastIssuedAt + 1);
  return {
    action: "scan",
    criteria,
    runId: randomUUID(),
    issuedAt: new Date(lastIssuedAt).toISOString(),
    ...(resumeToken ? { resumeToken } : {}),
  };
}
async function scan(endpoint, criteria, resumeToken, abortAfter) {
  const payload = scanPayload(criteria, resumeToken);
  const previousCalls = (await upstreamLog()).length;
  const result = await page.evaluate(
    async ({ endpoint, payload, abortAfter }) => {
      const controller = new AbortController();
      const events = [];
      let status = 0;
      let streamType = "";
      try {
        const response = await fetch(endpoint + "/scan", {
          method: "POST",
          credentials: "same-origin",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        status = response.status;
        streamType = response.headers.get("content-type") || "";
        if (!response.ok)
          return {
            status,
            events,
            errorCode: (await response.json()).error?.code,
          };
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let newline;
          while ((newline = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (line.trim()) events.push(JSON.parse(line));
            if (abortAfter && events.at(-1)?.scanned >= abortAfter) {
              controller.abort();
              await reader.cancel().catch(() => {});
              return { status, streamType, events, cancelled: true };
            }
          }
        }
        pending += decoder.decode();
        if (pending.trim()) events.push(JSON.parse(pending));
        return { status, streamType, events, cancelled: false };
      } catch {
        return {
          status,
          streamType,
          events,
          cancelled: controller.signal.aborted,
          failure: true,
        };
      }
    },
    { endpoint, payload, abortAfter },
  );
  assert.equal(
    result.status,
    200,
    `Scan status ${result.status} (${result.errorCode || "stream"})`,
  );
  assert.ok(result.streamType.includes("application/x-ndjson"));
  assert.ok(result.events.length > 0);
  if (result.cancelled) {
    // Transport abort alone is not a stop receipt. Await the persisted stop
    // before resetting the local quota or starting the next synthetic chunk.
    const acknowledgement = await request(
      page,
      endpoint + "/scan/cancel",
      "POST",
      { runId: payload.runId },
    );
    assert.equal(acknowledgement.data.runId, payload.runId);
    assert.ok(
      ["cancelled", "finished", "expired"].includes(
        acknowledgement.data.status,
      ),
    );
  }
  const calls = (await upstreamLog()).slice(previousCalls);
  const detailCount = calls.filter((call) => call.kind === "detail").length;
  const searchCount = calls.filter((call) => call.kind === "search").length;
  assert.ok(detailCount <= 5, "Every HTTP chunk permits at most five details");
  assert.ok(searchCount <= 2, "Every HTTP chunk permits at most two searches");
  const terminal = result.events.at(-1);
  if (!result.cancelled) {
    assert.notEqual(
      terminal.type,
      "progress",
      "A complete stream has a terminal event",
    );
    if (terminal.reason === "chunk_limit") {
      assert.equal(terminal.type, "paused");
      assert.ok(terminal.resumeToken);
      assert.ok(
        detailCount === 5 || searchCount === 2,
        "Chunk limit identifies the actual provider-call budget",
      );
    }
  }
  return { ...result, runId: payload.runId, detailCount, searchCount };
}

async function scanUntilTerminal(endpoint, criteria, resumeToken) {
  const org = endpoint.match(
    /^\/api\/organizations\/([^/]+)\/company-discovery$/,
  )?.[1];
  assert.ok(
    organizations.includes(org),
    "Only an own local fixture may skip the cooldown",
  );
  const chunks = [],
    events = [];
  let token = resumeToken;
  for (let index = 0; index < 45; index++) {
    if (index > 0) releaseLocalQuota(org);
    const chunk = await scan(endpoint, criteria, token);
    chunks.push(chunk);
    events.push(...chunk.events);
    const terminal = chunk.events.at(-1);
    if (
      terminal.type !== "paused" ||
      !["chunk_limit", "time_limit"].includes(terminal.reason)
    ) {
      assert.equal(
        new Set(chunks.map((item) => item.runId)).size,
        chunks.length,
      );
      return { events, chunks };
    }
    assert.ok(
      terminal.resumeToken,
      "A bounded chunk retains its exact resume position",
    );
    assert.ok(
      terminal.scanned > chunk.events[0].scanned,
      "The deterministic local fixture must make progress in each continued chunk",
    );
    token = terminal.resumeToken;
  }
  assert.fail("Synthetic scan exceeded 45 bounded chunks");
}

try {
  stage = "local fixture login and name-free streamed search";
  await login(page, users.owner);
  ownerToken = await tokenFor(users.owner);
  const primary = await newOrg("基本");
  assert.equal(
    (await request(page, primary.endpoint)).configured,
    true,
    "Run only with the explicit local Gbiz preload and fake token",
  );
  await control();
  const criteria = {
    prefecture: "13",
    industry: "D",
    employeeMin: 10,
    employeeMax: 50,
    includeUnknownEmployees: true,
    includeUnknownIndustry: true,
    businessKeywords: "設備 保守",
  };
  const legacy = await request(
    page,
    primary.endpoint,
    "POST",
    scanPayload(criteria),
    409,
  );
  assert.equal(legacy.error.code, "scan_endpoint_changed");
  assert.equal(
    (await upstreamLog()).length,
    0,
    "Legacy endpoint starts no provider requests",
  );
  const first = await scanUntilTerminal(primary.endpoint, criteria);
  assert.ok(first.chunks.length > 1);
  assert.equal(first.chunks[0].events.at(-1).reason, "chunk_limit");
  assert.equal(first.chunks[0].events.at(-1).scanned, 5);
  const firstDone = first.events.at(-1);
  assert.equal(firstDone.type, "complete");
  assert.equal(firstDone.reason, "target");
  assert.equal(firstDone.matched, 20);
  assert.ok(firstDone.scanned > 20 && firstDone.scanned < 70);
  assert.ok(firstDone.resumeToken);
  assert.ok(
    first.events.some((event) => event.matched > 0 && event.matched < 20),
  );
  assert.ok(firstDone.unknownEmployees > 0);
  assert.ok(firstDone.unknownIndustry > 0);
  const calls = await upstreamLog();
  const searches = calls.filter((call) => call.kind === "search");
  assert.ok(searches.length > 1);
  for (const call of searches) {
    assert.equal(call.query.name, undefined);
    assert.equal(
      call.query.employee_number_from,
      undefined,
      "Unknown employees stay eligible",
    );
    assert.equal(call.query.employee_number_to, undefined);
  }
  const filteredQuery = new URLSearchParams({
    prefecture: "13",
    industry: "D",
    employeeMin: "10",
    employeeMax: "50",
    includeUnknownEmployees: "true",
    includeUnknownIndustry: "true",
    businessKeywords: "設備 保守",
    pageSize: "50",
  });
  const firstMatches = await request(
    page,
    primary.endpoint + "?" + filteredQuery,
  );
  assert.equal(firstMatches.count, 20);
  assert.equal(
    firstMatches.data[0].provenance.fieldSources.business_summary.source,
    "Gビズインフォ合成検証データ",
  );
  assert.deepEqual(
    new Set(firstDone.matchedIds),
    new Set(firstMatches.data.map((row) => row.id)),
  );
  assert.ok(firstMatches.data.some((row) => row.employee_number === null));
  assert.ok(firstMatches.data.some((row) => row.industry_codes.length === 0));
  pass(
    "Dedicated scan endpoint reaches 20 persisted matches across bounded chunks; legacy endpoint is rejected and unknown fields remain visible",
  );

  stage = "rate limit, signed checkpoint scope and exact page-tail resume";
  await request(
    page,
    primary.endpoint + "/scan",
    "POST",
    scanPayload(criteria, firstDone.resumeToken),
    429,
  );
  releaseLocalQuota(primary.org);
  await request(
    page,
    primary.endpoint + "/scan",
    "POST",
    scanPayload({ ...criteria, employeeMax: 40 }, firstDone.resumeToken),
    409,
  );
  const otherOrg = await newOrg("署名別組織");
  await request(
    page,
    otherOrg.endpoint + "/scan",
    "POST",
    scanPayload(criteria, firstDone.resumeToken),
    409,
  );
  const resumed = await scanUntilTerminal(
    primary.endpoint,
    criteria,
    firstDone.resumeToken,
  );
  const completed = resumed.events.at(-1);
  assert.equal(completed.type, "complete");
  assert.equal(completed.reason, "exhausted");
  assert.equal(completed.target, 40);
  assert.equal(completed.scanned, 70);
  assert.equal(completed.resumeToken, null);
  assert.ok(completed.matched > 20 && completed.matched < 40);
  assert.equal(new Set(completed.matchedIds).size, completed.matched);
  const allCalls = await upstreamLog();
  const details = allCalls
    .filter((call) => call.kind === "detail")
    .map((call) => call.number);
  assert.equal(details.length, 70);
  assert.equal(
    new Set(details).size,
    70,
    "Mid-page resume neither loses nor repeats a provider detail",
  );
  assert.equal(
    (await request(page, primary.endpoint + "?" + filteredQuery)).count,
    completed.matched,
  );
  pass(
    "Immediate retry returns 429; signed cursor rejects changed criteria/organization and resumes the exact pending page tail without duplicate details",
  );

  stage = "known-only employee bounds and provider errors";
  const known = await newOrg("人数既知");
  await control();
  const knownResult = await scanUntilTerminal(known.endpoint, {
    ...criteria,
    includeUnknownEmployees: false,
  });
  assert.equal(knownResult.events.at(-1).unknownEmployees, 0);
  const knownSearch = (await upstreamLog()).find(
    (call) => call.kind === "search",
  );
  assert.equal(knownSearch.query.employee_number_from, "10");
  assert.equal(knownSearch.query.employee_number_to, "50");
  const unavailable = await newOrg("外部制限");
  await control("upstream-429");
  const limited = await scan(unavailable.endpoint, criteria);
  assert.equal(limited.events.at(-1).type, "error");
  assert.equal(limited.events.at(-1).reason, "upstream_error");
  assert.ok(limited.events.at(-1).resumeToken);
  assert.equal(limited.events.at(-1).scanned, 0);
  assert.equal((await request(page, unavailable.endpoint)).count, 0);
  pass(
    "Known-only bounds use the documented upstream numeric parameters; provider 429 preserves a resumable checkpoint without false results",
  );

  stage = "browser stop, reload, resume and changed-criteria cancellation";
  const ui = await newOrg("画面");
  await control("normal", 120);
  await organization(page, ui.org);
  await page
    .getByRole("button", { name: "設備工事・保守点検", exact: true })
    .click();
  await choose(page, "都道府県", "東京都", "東京");
  await expect(
    page.getByLabel("企業名・法人番号（任意）", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "条件に合う企業を探す", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "条件に合う企業を探す", exact: true })
    .click();
  await expect
    .poll(async () => {
      const box = await page.locator("#candidate-list-title").boundingBox();
      return !!box && box.y >= 0 && box.y + box.height <= 1000;
    })
    .toBe(true);
  const storageKey = `leadstack.discovery.scan.v1./api/organizations/${ui.org}`;
  await expect
    .poll(async () =>
      page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key) || "null")?.event.scanned || 0,
        storageKey,
      ),
    )
    .toBeGreaterThanOrEqual(4);
  await expect(
    page.getByRole("button", { name: "検索検証001法人", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: output + "/stream-progress-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "検索を停止", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存済みの位置から再開", exact: true }),
  ).toBeVisible();
  const stopped = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storageKey,
  );
  const detailLoaded = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes(ui.endpoint + "/"),
  );
  await page
    .getByRole("button", { name: "検索検証001法人", exact: true })
    .click();
  assert.equal((await detailLoaded).status(), 200);
  await expect(
    page
      .locator('[data-slot="dialog-content"]')
      .getByText("Gビズインフォ合成検証データ", { exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expandSearchOptions(page);
  await expect(
    page.getByRole("button", { name: "保存済みの位置から再開", exact: true }),
  ).toBeVisible();
  const reloaded = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storageKey,
  );
  assert.equal(reloaded.event.scanned, stopped.event.scanned);
  await page
    .getByRole("button", { name: "保存済みの位置から再開", exact: true })
    .click();
  await expect(
    page.getByText("アクセス間隔を空けて待機中です。自動で続きを確認します。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(
          (key) =>
            JSON.parse(localStorage.getItem(key) || "null")?.event.scanned || 0,
          storageKey,
        ),
      { timeout: 40000 },
    )
    .toBeGreaterThan(stopped.event.scanned);
  await page.getByLabel("業務キーワード", { exact: true }).fill("雑貨");
  await expect(
    page.getByRole("button", { name: "検索を停止", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "保存済みの位置から再開", exact: true }),
  ).toHaveCount(0);
  await page.waitForTimeout(400);
  const checkpointAfter = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storageKey,
  );
  await page.waitForTimeout(400);
  assert.equal(
    (
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)),
        storageKey,
      )
    ).savedAt,
    checkpointAfter.savedAt,
    "Aborted generation cannot replace the checkpoint",
  );
  await page.screenshot({
    path: output + "/criteria-search-desktop.png",
    fullPage: true,
  });
  pass(
    "Browser starts without a name, persists progress, stops/reloads/resumes after the real cooldown, and rejects late events after criteria change",
  );

  stage = "cancelled stream remains resumable and 200-record cap";
  const cancelled = await newOrg("中断");
  await control("normal", 50);
  const interrupted = await scan(cancelled.endpoint, criteria, undefined, 3);
  assert.equal(interrupted.cancelled, true);
  const cursor = interrupted.events.at(-1);
  assert.ok(cursor.resumeToken);
  await page.waitForTimeout(300);
  releaseLocalQuota(cancelled.org);
  await control();
  const afterCancel = await scanUntilTerminal(
    cancelled.endpoint,
    criteria,
    cursor.resumeToken,
  );
  assert.equal(afterCancel.events.at(-1).matched, 20);
  assert.equal(new Set(afterCancel.events.at(-1).matchedIds).size, 20);
  const capped = await newOrg("200社上限");
  await control("no-match");
  const capResult = await scanUntilTerminal(capped.endpoint, {
    prefecture: "13",
    industry: "D",
  });
  assert.equal(
    capResult.chunks.length,
    40,
    "200 positions require forty five-detail chunks",
  );
  const cap = capResult.events.at(-1);
  assert.equal(cap.type, "complete");
  assert.equal(cap.reason, "scan_limit");
  assert.equal(cap.scanned, 200);
  assert.equal(cap.matched, 0);
  assert.equal(cap.resumeToken, null);
  assert.equal(
    (await upstreamLog()).filter((call) => call.kind === "detail").length,
    200,
  );
  assert.equal((await request(page, capped.endpoint)).count, 200);
  pass(
    "Acknowledged aborted scan resumes saved matches; forty bounded chunks inspect exactly 200 nonmatching companies and return a terminal limit",
  );

  stage = "cross-organization scan and detail authorization";
  const otherContext = await browser.newContext();
  contexts.push(otherContext);
  const otherPage = await otherContext.newPage();
  await login(otherPage, users.other);
  await request(
    otherPage,
    primary.endpoint + "/scan",
    "POST",
    scanPayload(criteria),
    403,
  );
  await request(
    otherPage,
    primary.endpoint + "/" + firstDone.matchedIds[0],
    "GET",
    undefined,
    403,
  );
  const viewerToken = await tokenFor(users.other);
  const viewerId = JSON.parse(
    Buffer.from(viewerToken.split(".")[1], "base64url").toString(),
  ).sub;
  assert.match(viewerId, /^[a-f0-9-]{36}$/);
  assert.ok(organizations.includes(primary.org));
  execFileSync(
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
      input: `insert into public.organization_members(organization_id,user_id,role) values('${primary.org}'::uuid,'${viewerId}'::uuid,'viewer');`,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    },
  );
  await request(otherPage, primary.endpoint, "GET");
  await request(
    otherPage,
    primary.endpoint + "/" + firstDone.matchedIds[0],
    "GET",
  );
  await request(
    otherPage,
    primary.endpoint + "/scan",
    "POST",
    scanPayload(criteria),
    403,
  );
  await organization(otherPage, primary.org);
  await expect(
    otherPage.getByRole("button", {
      name: "条件に合う企業を探す",
      exact: true,
    }),
  ).toHaveCount(0);
  assert.deepEqual(runtimeErrors, []);
  pass(
    "Other organization cannot read or scan; explicitly seeded viewer can read full evidence but cannot start a scan in UI/API; browser runtime is clean",
  );
  console.log(
    "PASS: Conditional discovery E2E complete; only synthetic Gbiz responses and the own local Supabase fixture were used",
  );
} catch (error) {
  console.error(
    `FAIL: Scan E2E stage '${stage}' (${error instanceof Error ? error.name : "UnknownError"})`,
  );
  if (error instanceof Error) {
    const location = error.stack?.match(/discovery-scan-e2e\.mjs:\d+:\d+/)?.[0];
    if (location) console.error(location);
    if (error.name === "AssertionError")
      console.error(error.message.split("\n").slice(0, 3).join("\n"));
  }
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  if (ownerToken)
    for (const org of organizations) {
      await direct(
        `/rest/v1/company_candidates?organization_id=eq.${org}`,
        "DELETE",
        ownerToken,
      ).catch(() => {
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
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser.close();
}
