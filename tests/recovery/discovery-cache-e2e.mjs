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
const output = process.env.E2E_OUTPUT || "test-results/discovery-cache";
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
  const name = `詳細再利用E2E-${suffix}-${Date.now()}`;
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

// Timed UI trials keep the real 30-second org cooldown. Quota resets below are
// exclusively for functional checks AFTER these timed trials have finished.
const scanRequests = [];
page.on("request", (req) => {
  if (req.method() === "POST" && req.url().endsWith("/company-discovery/scan"))
    scanRequests.push({
      at: Date.now(),
      criteria: req.postDataJSON().criteria,
    });
});
async function checkpointEvent(org) {
  return page.evaluate(
    (org) =>
      JSON.parse(
        localStorage.getItem(
          `leadstack.discovery.scan.v1./api/organizations/${org}`,
        ) || "null",
      )?.event,
    org,
  );
}
async function candidateRows(org) {
  return direct(
    `/rest/v1/company_candidates?organization_id=eq.${org}&order=corporate_number.asc`,
    "GET",
    ownerToken,
  );
}
async function timedUiScan(org) {
  const before = scanRequests.length;
  const callsBefore = (await upstreamLog()).length;
  const pending = page.waitForResponse(
    (res) =>
      res.request().method() === "POST" &&
      res.url().endsWith("/company-discovery/scan"),
  );
  const started = performance.now();
  await page
    .getByRole("button", { name: "条件に合う企業を探す", exact: true })
    .click();
  assert.equal((await pending).status(), 200);
  await expect(
    page.locator("#discovery-search-progress").getByRole("status"),
  ).toContainText("検索が完了しました", { timeout: 165000 });
  await expect(page.locator("#candidate-list")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(
    page.getByRole("button", { name: "条件に合う企業を探す", exact: true }),
  ).toBeEnabled();
  const elapsedMs = Math.round(performance.now() - started);
  const final = await checkpointEvent(org);
  assert.equal(final.type, "complete");
  assert.equal(final.reason, "target");
  assert.equal(final.matched, 20);
  const calls = (await upstreamLog()).slice(callsBefore);
  return {
    elapsedMs,
    final,
    chunks: scanRequests.length - before,
    requests: scanRequests.slice(before),
    detailCalls: calls.filter((c) => c.kind === "detail").length,
    searchCalls: calls.filter((c) => c.kind === "search").length,
  };
}
try {
  stage = "login and cold scan with actual cooldowns";
  await login(page, users.owner);
  ownerToken = await tokenFor(users.owner);
  const primary = await newOrg("速度");
  assert.equal((await request(page, primary.endpoint)).configured, true);
  await control("normal", 120);
  await organization(page, primary.org);
  await choose(page, "都道府県", "東京都");
  const cold = await timedUiScan(primary.org);
  assert.equal(cold.detailCalls, 20);
  assert.equal(cold.searchCalls, 1);
  assert.equal(cold.chunks, 4);
  assert.equal(cold.final.reused, 0);
  assert.equal(cold.final.saved, 20);
  for (let i = 1; i < cold.requests.length; i++)
    assert.ok(
      cold.requests[i].at - cold.requests[i - 1].at >= 30000,
      "Real chunk spacing is at least 30 seconds",
    );
  const rowsBefore = await candidateRows(primary.org);
  assert.equal(rowsBefore.length, 20);
  assert.ok(
    rowsBefore.every((r) =>
      r.provenance.gbiz.requestUrl.endsWith("?metadata_flg=true"),
    ),
    "Use real client provenance, not a cache-only mock format",
  );
  pass(
    `Cold scan: ${cold.elapsedMs} ms, 20 details, 4 chunks with real cooldowns`,
  );

  stage = "warm scan reuses recent details and preserves all stored fields";
  // A user starting immediately also sees this residual cooldown. Exclude only
  // the between-trial idle time, and report it separately, never suppress it.
  const betweenTrialWaitMs = Math.max(
    0,
    Date.parse(cold.final.nextAllowedAt) - Date.now() + 100,
  );
  if (betweenTrialWaitMs)
    await new Promise((resolve) => setTimeout(resolve, betweenTrialWaitMs));
  const warm = await timedUiScan(primary.org);
  assert.equal(warm.detailCalls, 0);
  assert.equal(warm.searchCalls, 1);
  assert.equal(warm.chunks, 1);
  assert.equal(warm.final.reused, 20);
  assert.equal(warm.final.saved, 0);
  assert.deepEqual(
    [...warm.final.matchedIds].sort(),
    [...cold.final.matchedIds].sort(),
  );
  assert.deepEqual(await candidateRows(primary.org), rowsBefore);
  await expect(page.locator("#discovery-search-progress")).toContainText(
    "保存済み情報を再利用 20社",
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await page.screenshot({ path: output + "/warm-search.png", fullPage: true });
  const metrics = {
    fixture:
      "Local Auth/PostgREST/Chromium; synthetic gBiz detail delay 120 ms; not production latency",
    trials: 1,
    cold: {
      elapsedMs: cold.elapsedMs,
      detailCalls: cold.detailCalls,
      searchCalls: cold.searchCalls,
      chunks: cold.chunks,
    },
    warm: {
      elapsedMs: warm.elapsedMs,
      detailCalls: warm.detailCalls,
      searchCalls: warm.searchCalls,
      chunks: warm.chunks,
    },
    betweenTrialWaitMs,
    cooldown:
      "30 seconds kept for every chunk; elapsed time begins at click and ends after final list revalidation",
  };
  await writeFile(
    output + "/metrics.json",
    JSON.stringify(metrics, null, 2) + "\n",
  );
  console.log("MEASURED: " + JSON.stringify(metrics));
  pass(
    "Warm scan completed using the same 20 IDs without any candidate writes or freshness extension",
  );

  stage =
    "stale detail is refreshed while manual values and nineteen fresh rows survive";
  const stale = rowsBefore[0];
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  // Seed a reviewed value through the real application route so provenance
  // correctly describes a manual override; raw field assignment is insufficient.
  await request(page, primary.endpoint, "POST", {
    action: "update",
    id: stale.id,
    expectedUpdatedAt: stale.updated_at,
    phone: "03-1234-5678",
    employee_number: 48,
    website_url: "https://reviewed.example/",
  });
  const reviewed = (await candidateRows(primary.org))[0];
  const reviewedProvenance = structuredClone(reviewed.provenance);
  reviewedProvenance.gbiz.retrievedAt = oldTime;
  await direct(
    `/rest/v1/company_candidates?id=eq.${stale.id}`,
    "PATCH",
    ownerToken,
    { fetched_at: oldTime, provenance: reviewedProvenance },
  );
  await control("normal", 0);
  releaseLocalQuota(primary.org);
  const mixed = await scan(primary.endpoint, { prefecture: "13" });
  assert.equal(mixed.detailCount, 1);
  assert.equal(mixed.events.at(-1).reused, 19);
  assert.equal(mixed.events.at(-1).saved, 1);
  const rowsAfter = await candidateRows(primary.org);
  assert.deepEqual(rowsAfter.slice(1), rowsBefore.slice(1));
  assert.equal(rowsAfter[0].employee_number, 48);
  assert.equal(rowsAfter[0].phone, "03-1234-5678");
  assert.equal(rowsAfter[0].website_url, "https://reviewed.example/");
  assert.ok(Date.parse(rowsAfter[0].fetched_at) > Date.parse(oldTime));
  pass(
    "One stale company fetched; nineteen reused; reviewed phone, employees and URL retained",
  );

  stage =
    "explicit refresh UI fetches recent records under the original budget";
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "企業を探す", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("取得済みの企業情報も更新する（時間がかかります）", {
      exact: true,
    })
    .check();
  releaseLocalQuota(primary.org);
  await control("normal", 0);
  const requestCountBefore = scanRequests.length;
  const forcedResponse = page
    .waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        res.url().endsWith("/company-discovery/scan"),
      { timeout: 45000 },
    )
    .catch(() => null);
  await page
    .getByRole("button", { name: "条件に合う企業を探す", exact: true })
    .click();
  const forcedResponseResult = await forcedResponse;
  assert.ok(
    forcedResponseResult,
    "Explicit refresh request starts after the persisted cooldown",
  );
  assert.equal(forcedResponseResult.status(), 200);
  await expect
    .poll(async () => (await checkpointEvent(primary.org))?.reason)
    .toBe("chunk_limit");
  const forced = await checkpointEvent(primary.org);
  assert.equal(scanRequests[requestCountBefore].criteria.refreshDetails, true);
  assert.equal(forced.reused, 0);
  assert.equal(forced.saved, 5);
  await page.getByRole("button", { name: "検索を停止", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "条件に合う企業を探す", exact: true }),
  ).toBeEnabled();
  assert.equal(
    (await upstreamLog()).filter((c) => c.kind === "detail").length,
    5,
  );
  pass(
    "Explicit refresh checkbox makes five real fixture detail calls and still stops at the chunk limit",
  );

  stage = "fresh details in another organization are never reused";
  const other = await newOrg("組織分離");
  await control("normal", 0);
  const otherScan = await scan(other.endpoint, {
    prefecture: "13",
    corporateNumber: stale.corporate_number,
  });
  assert.equal(otherScan.detailCount, 1);
  assert.equal(otherScan.events.at(-1).reused, 0);
  assert.equal(otherScan.events.at(-1).matched, 1);
  const otherRows = await candidateRows(other.org);
  assert.equal(otherRows.length, 1);
  assert.notEqual(otherRows[0].id, stale.id);
  const outsiderToken = await tokenFor(users.other);
  assert.deepEqual(
    await direct(
      `/rest/v1/company_candidates?organization_id=eq.${primary.org}`,
      "GET",
      outsiderToken,
    ),
    [],
  );
  assert.deepEqual(runtimeErrors, []);
  pass(
    "Other organization fetches its own detail; an unrelated user cannot read the cached records under RLS",
  );
  console.log(
    "PASS: Five cache E2E groups completed; no production services or live websites were used",
  );
} catch (error) {
  console.error(
    `FAIL: Cache E2E stage '${stage}' (${error instanceof Error ? error.name : "UnknownError"})`,
  );
  if (error instanceof Error) {
    const location = error.stack?.match(
      /discovery-cache-e2e\.mjs:\d+:\d+/,
    )?.[0];
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
