import { expandSearchOptions } from "./search-options.mjs";
// Real Auth/PostgREST/browser checks against a disposable local fixture only.
// Candidate records below are synthetic. No live Gbiz or public website is called.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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
if (anonKey.split(".").length === 3) {
  const expiry = JSON.parse(
    Buffer.from(anonKey.split(".")[1], "base64url").toString(),
  ).exp;
  assert.ok(
    Number.isFinite(expiry) && expiry * 1000 > Date.now(),
    "Disposable local fixture anonymous JWT has expired",
  );
}
const output = process.env.E2E_OUTPUT || "test-results/discovery-stop";
await mkdir(output, { recursive: true });
assert.equal(
  new URL(base).port,
  "3012",
  "This suite requires the disconnect-draining proxy on 3012",
);
const proxyState = await fetch(base + "/__test_proxy/state").then((r) =>
  r.json(),
);
assert.equal(proxyState.mode, "ignore-scan-disconnect");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const runtimeErrors = [];
const evidence = [];
page.on("pageerror", (error) => runtimeErrors.push(error.name));
let stage = "setup";
const pass = (message) => {
  evidence.push({ at: Date.now(), message });
  console.log("PASS: " + message);
};
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
      name: destination === "/discover" ? "企業を探す" : "営業リスト",
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
const runIds = [];
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
  const name = `停止検証E2E-${suffix}-${Date.now()}`;
  const org = (await request(page, "/api/organizations", "POST", { name }, 201))
    .data.id;
  organizations.push(org);
  return { org, name, endpoint: `/api/organizations/${org}/company-discovery` };
}
const criteria = {
  prefecture: "13",
  industry: "D",
  employeeMin: 10,
  employeeMax: 50,
  includeUnknownEmployees: true,
  includeUnknownIndustry: true,
  businessKeywords: "設備 保守",
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshot(org) {
  assert.ok(organizations.includes(org));
  return direct(
    `/rest/v1/company_candidates?organization_id=eq.${org}&select=id,corporate_number,updated_at&order=id.asc`,
    "GET",
    ownerToken,
  );
}
async function scansFor(org) {
  const state = await fetch(base + "/__test_proxy/state").then((r) => r.json());
  return state.scans.filter((scan) => scan.path.includes(`/${org}/`));
}
async function settle(org, timeout = 30000) {
  await expect
    .poll(
      async () => {
        const records = await scansFor(org);
        return records.length > 0 && records.every((scan) => scan.endedAt);
      },
      { timeout, intervals: [100, 200, 400] },
    )
    .toBe(true);
}
async function stable(org, before, milliseconds = 1200) {
  const start = Date.now();
  if (milliseconds >= 10000) {
    await pause(5000);
    assert.deepEqual(
      await snapshot(org),
      before,
      "Candidate IDs/timestamps stable at 5 seconds after acknowledgement",
    );
    evidence.push({
      checkpoint: "5s",
      organization: org,
      elapsedMs: Date.now() - start,
      candidateCount: before.length,
      candidates: before,
    });
    await pause(Math.max(0, milliseconds - (Date.now() - start)));
  } else await pause(milliseconds);
  assert.deepEqual(
    await snapshot(org),
    before,
    "No candidate ID or updated_at changes after cancellation ACK / terminal EOF",
  );
  evidence.push({
    checkpoint: "stable",
    organization: org,
    elapsedMs: Date.now() - start,
    candidateCount: before.length,
    candidates: before,
  });
}
async function startRaw(
  p,
  endpoint,
  {
    runId = crypto.randomUUID(),
    issuedAt = new Date().toISOString(),
    abortAfterSaved = 0,
    customCriteria = criteria,
    resumeToken,
  } = {},
) {
  runIds.push({ endpoint, runId });
  await p.evaluate(
    ({ endpoint, runId, issuedAt, abortAfterSaved, criteria, resumeToken }) => {
      const controller = new AbortController();
      window.__stopE2E ||= {};
      const state = (window.__stopE2E[runId] = {
        events: [],
        status: 0,
        done: false,
        errorCode: null,
        aborted: false,
        controller,
      });
      void (async () => {
        try {
          const response = await fetch(endpoint + "/scan", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              action: "scan",
              runId,
              issuedAt,
              criteria,
              ...(resumeToken ? { resumeToken } : {}),
            }),
          });
          state.status = response.status;
          if (!response.ok) {
            state.errorCode = (await response.json()).error?.code;
            return;
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            pending += decoder.decode(chunk.value, { stream: true });
            let index;
            while ((index = pending.indexOf("\n")) !== -1) {
              const line = pending.slice(0, index);
              pending = pending.slice(index + 1);
              if (!line.trim()) continue;
              const event = JSON.parse(line);
              state.events.push(event);
              if (abortAfterSaved && event.saved >= abortAfterSaved) {
                state.aborted = true;
                controller.abort();
                await reader.cancel().catch(() => {});
                return;
              }
            }
          }
          pending += decoder.decode();
          if (pending.trim()) state.events.push(JSON.parse(pending));
        } catch {
          state.aborted = controller.signal.aborted;
        } finally {
          state.done = true;
        }
      })();
    },
    {
      endpoint,
      runId,
      issuedAt,
      abortAfterSaved,
      criteria: customCriteria,
      resumeToken,
    },
  );
  return runId;
}
async function rawState(p, runId) {
  return p.evaluate((id) => {
    const { events, status, done, errorCode, aborted } = window.__stopE2E[id];
    return { events, status, done, errorCode, aborted };
  }, runId);
}
async function rawDone(p, runId, timeout = 30000) {
  await expect
    .poll(async () => (await rawState(p, runId)).done, { timeout })
    .toBe(true);
  return rawState(p, runId);
}
function cancelResponse(p, endpoint) {
  return p.waitForResponse(
    (r) =>
      r.url().endsWith(endpoint + "/scan/cancel") &&
      r.request().method() === "POST",
  );
}
async function acknowledged(response) {
  assert.equal(response.status(), 200, "Independent cancel acknowledgement");
  const body = await response.json();
  assert.ok(["cancelled", "finished", "expired"].includes(body.data?.status));
  return body.data;
}
async function prepareUI(org) {
  await organization(page, org);
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
}
async function startUI(target) {
  assert.equal((await snapshot(target.org)).length, 0);
  await page
    .getByRole("button", { name: "条件に合う企業を探す", exact: true })
    .click();
  await expect
    .poll(async () => (await snapshot(target.org)).length)
    .toBeGreaterThanOrEqual(1);
}
async function finishCancellation(target, cancel, label, wait = 1200) {
  const ack = await acknowledged(await cancel);
  const atAck = await snapshot(target.org);
  evidence.push({
    checkpoint: "acknowledged",
    label,
    organization: target.org,
    at: Date.now(),
    candidates: atAck,
  });
  assert.ok(atAck.length >= 1 && atAck.length <= 5);
  await settle(target.org);
  await stable(target.org, atAck, wait);
  const scans = await scansFor(target.org);
  assert.ok(
    scans.some((scan) => scan.clientClosedAt),
    "Browser disconnected while upstream stayed alive",
  );
  assert.ok(
    scans.every((scan) => !scan.upstreamAborted),
    "Proxy did not abort upstream",
  );
  evidence.push({
    label,
    countAtAck: atAck.length,
    terminalStatus: ack.status,
    scans: scans.map(({ startedAt, clientClosedAt, endedAt }) => ({
      startedAt,
      clientClosedAt,
      endedAt,
    })),
  });
  pass(
    label +
      ": cancellation acknowledged; candidate IDs/timestamps stable while ignored-disconnect upstream finishes",
  );
}

async function verifyRunDeadline() {
  stage = "25-second run deadline after abandoned browser";
  const expired = await newOrg("期限");
  // Each detail is below the provider's 10s timeout. The third call crosses
  // the overall 25s deadline, distinguishing it from a per-call timeout.
  await control("normal", 9000);
  const expiredId = await startRaw(page, expired.endpoint);
  await expect
    .poll(async () =>
      (await upstreamLog()).some((row) => row.kind === "detail"),
    )
    .toBe(true);
  await page.evaluate(
    (id) => window.__stopE2E[id].controller.abort(),
    expiredId,
  );
  await rawDone(page, expiredId);
  await settle(expired.org, 28000);
  const expiredScans = await scansFor(expired.org);
  const durationMs = expiredScans[0].endedAt - expiredScans[0].startedAt;
  assert.ok(
    durationMs >= 24000 && durationMs < 28000,
    "Overall run deadline, rather than individual 10s call timeout, bounds work",
  );
  assert.ok(expiredScans[0].clientClosedAt && !expiredScans[0].upstreamAborted);
  const expiredSnapshot = await snapshot(expired.org);
  assert.equal(
    expiredSnapshot.length,
    2,
    "Only two 9s details commit before the third crosses the overall deadline",
  );
  assert.equal(
    (await upstreamLog()).filter((row) => row.kind === "detail").length,
    3,
  );
  await stable(expired.org, expiredSnapshot);
  evidence.push({
    label: "25-second run deadline",
    durationMs,
    details: 3,
    saved: 2,
    candidates: expiredSnapshot,
  });
  pass(
    "Overall 25s deadline interrupts the third 9s detail despite ignored browser abort; two prior rows remain and no post-EOF writes occur",
  );
}

try {
  stage = "local fixture login";
  await login(page, users.owner);
  ownerToken = await tokenFor(users.owner);

  if (process.env.E2E_STOP_ONLY === "deadline") {
    await verifyRunDeadline();
    await writeFile(
      output + "/evidence.json",
      JSON.stringify(
        { syntheticOnly: true, proxyMode: "ignore-scan-disconnect", evidence },
        null,
        2,
      ),
    );
  } else {
    stage = "stop button with downstream disconnect ignored";
    const stopped = await newOrg("ボタン");
    await control("normal", 1100);
    await prepareUI(stopped.org);
    await startUI(stopped);
    const stoppedCancel = cancelResponse(page, stopped.endpoint);
    await page.getByRole("button", { name: "検索を停止", exact: true }).click();
    await finishCancellation(stopped, stoppedCancel, "Stop button", 32000);
    assert.equal(
      (await scansFor(stopped.org)).length,
      1,
      "No automatic next chunk after stop and original cooldown",
    );
    await expect(
      page.getByRole("button", { name: "保存済みの位置から再開", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({
      path: output + "/stop-acknowledged.png",
      fullPage: true,
    });

    if (process.env.E2E_STOP_ONLY === "1") {
      await writeFile(
        output + "/evidence.json",
        JSON.stringify(
          {
            syntheticOnly: true,
            proxyMode: "ignore-scan-disconnect",
            evidence,
          },
          null,
          2,
        ),
      );
      pass(
        "Focused stop verification complete with immediate, 5-second and 32-second candidate snapshots",
      );
    } else {
      stage = "resume creates a new guarded run";
      const firstSnapshot = await snapshot(stopped.org);
      const resumeRequest = page.waitForRequest(
        (r) =>
          r.url().endsWith(stopped.endpoint + "/scan") && r.method() === "POST",
      );
      await page
        .getByRole("button", { name: "保存済みの位置から再開", exact: true })
        .click();
      const resumePayload = (await resumeRequest).postDataJSON();
      assert.ok(
        resumePayload.resumeToken &&
          resumePayload.runId &&
          resumePayload.issuedAt,
      );
      await expect
        .poll(async () => (await snapshot(stopped.org)).length)
        .toBeGreaterThan(firstSnapshot.length);
      const resumedCancel = cancelResponse(page, stopped.endpoint);
      await page
        .getByRole("button", { name: "検索を停止", exact: true })
        .click();
      await acknowledged(await resumedCancel);
      const afterResumeAck = await snapshot(stopped.org);
      await settle(stopped.org);
      await stable(stopped.org, afterResumeAck);
      assert.ok(
        firstSnapshot.every((row) =>
          afterResumeAck.some((current) => current.id === row.id),
        ),
      );
      pass(
        "Resume starts a new guarded run and retains saved candidate IDs; stopping again prevents subsequent writes",
      );

      stage = "unexpected EOF independently cancels server job";
      const truncated = await newOrg("応答切断");
      await control("normal", 1100);
      await prepareUI(truncated.org);
      const truncateControl = await fetch(base + "/__test_proxy/truncate", {
        method: "POST",
      });
      assert.equal(truncateControl.status, 204);
      const truncatedCancel = cancelResponse(page, truncated.endpoint);
      await startUI(truncated);
      await finishCancellation(truncated, truncatedCancel, "Unexpected EOF");

      for (const lifecycle of ["reload", "navigation", "criteria"]) {
        stage = lifecycle + " independent cancellation";
        const target = await newOrg(lifecycle);
        await control("normal", 1100);
        await prepareUI(target.org);
        await startUI(target);
        const cancelled = cancelResponse(page, target.endpoint);
        if (lifecycle === "reload") await page.reload();
        else if (lifecycle === "navigation") {
          const link = page.getByRole("link", {
            name: "営業リスト",
            exact: true,
          });
          await link.click();
          await page.waitForURL((url) => url.pathname === "/companies");
        } else
          await page.getByLabel("業務キーワード", { exact: true }).fill("雑貨");
        await finishCancellation(target, cancelled, lifecycle);
        if (lifecycle === "criteria") {
          await expect(
            page.getByRole("button", { name: "検索を停止", exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("button", {
              name: "保存済みの位置から再開",
              exact: true,
            }),
          ).toHaveCount(0);
        }
      }

      for (const mode of ["cancel-delay", "cancel-fail"]) {
        stage = mode + " UI confirmation gate";
        const confirmation = await newOrg(mode);
        await control("normal", 1100);
        await prepareUI(confirmation.org);
        await startUI(confirmation);
        assert.equal(
          (await fetch(base + "/__test_proxy/" + mode, { method: "POST" }))
            .status,
          204,
        );
        const pendingCancel = cancelResponse(page, confirmation.endpoint);
        await page
          .getByRole("button", { name: "検索を停止", exact: true })
          .click();
        await expect(
          page.getByRole("button", {
            name: "条件に合う企業を探す",
            exact: true,
          }),
        ).toBeDisabled();
        if (mode === "cancel-delay") {
          await expect(
            page.getByText(
              "停止を確認中です。確認が完了するまで再開できません。",
              {
                exact: true,
              },
            ),
          ).toBeVisible();
          await acknowledged(await pendingCancel);
        } else {
          assert.equal((await pendingCancel).status(), 503);
          await expect(
            page.getByRole("button", { name: "停止を再確認", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: "条件に合う企業を探す",
              exact: true,
            }),
          ).toBeDisabled();
          const retry = cancelResponse(page, confirmation.endpoint);
          await page
            .getByRole("button", { name: "停止を再確認", exact: true })
            .click();
          await acknowledged(await retry);
        }
        const confirmedSnapshot = await snapshot(confirmation.org);
        await settle(confirmation.org);
        await stable(confirmation.org, confirmedSnapshot);
        await expect(
          page.getByRole("button", {
            name: "保存済みの位置から再開",
            exact: true,
          }),
        ).toBeVisible();
        pass(
          mode +
            ": start/resume blocked until durable cancellation acknowledgement; explicit retry recovers failure",
        );
      }

      stage = "stop after terminal event before response EOF";
      const held = await newOrg("終了行後停止");
      await control("normal", 100);
      await prepareUI(held.org);
      assert.equal(
        (await fetch(base + "/__test_proxy/hold-eof", { method: "POST" }))
          .status,
        204,
      );
      await startUI(held);
      await settle(held.org);
      await expect(
        page.getByRole("button", { name: "検索を停止", exact: true }),
      ).toBeVisible();
      const heldCancel = cancelResponse(page, held.endpoint);
      await page
        .getByRole("button", { name: "検索を停止", exact: true })
        .click();
      await acknowledged(await heldCancel);
      const heldSnapshot = await snapshot(held.org);
      await stable(held.org, heldSnapshot, 2800);
      assert.equal((await scansFor(held.org)).length, 1);
      pass(
        "Stop after terminal line but before EOF still cancels independently and does not schedule another chunk",
      );

      stage = "new tab supersedes the active UI run";
      const tabs = await newOrg("別タブ");
      await control("normal", 1100);
      await prepareUI(tabs.org);
      // Mount the second editor before the first run creates a cooldown checkpoint.
      const second = await context.newPage();
      await second.goto(base + "/discover");
      await expect(
        second.getByRole("button", {
          name: "条件に合う企業を探す",
          exact: true,
        }),
      ).toBeEnabled();
      await startUI(tabs);
      const spectator = await context.newPage();
      await spectator.goto(base + "/discover");
      await expect(
        spectator.getByRole("heading", { name: "企業を探す", exact: true }),
      ).toBeVisible();
      await pause(150);
      assert.equal(
        (await scansFor(tabs.org)).length,
        1,
        "Merely opening another tab cannot launch/supersede a scan",
      );
      await expect(
        page.getByRole("button", { name: "検索を停止", exact: true }),
      ).toBeVisible();
      await spectator.close();
      releaseLocalQuota(tabs.org);
      const oldCancel = cancelResponse(page, tabs.endpoint);
      const nextRequest = second.waitForRequest(
        (r) =>
          r.url().endsWith(tabs.endpoint + "/scan") && r.method() === "POST",
      );
      await second
        .getByRole("button", { name: "条件に合う企業を探す", exact: true })
        .click();
      await nextRequest;
      await acknowledged(await oldCancel);
      await expect.poll(async () => (await scansFor(tabs.org)).length).toBe(2);
      await expect(
        page.getByRole("button", { name: "検索を停止", exact: true }),
      ).toHaveCount(0);
      await expect(
        second.getByRole("button", { name: "検索を停止", exact: true }),
      ).toBeVisible();
      const newCancel = cancelResponse(second, tabs.endpoint);
      await second
        .getByRole("button", { name: "検索を停止", exact: true })
        .click();
      await acknowledged(await newCancel);
      const tabsSnapshot = await snapshot(tabs.org);
      await settle(tabs.org);
      await stable(tabs.org, tabsSnapshot);
      await second.close();
      pass(
        "A new run in a second tab cancels the old run; opening a tab alone leaves it active; both writes stop after acknowledgement",
      );

      stage = "abort without cancel stays bounded";
      const abandoned = await newOrg("切断のみ");
      await control("normal", 650);
      const abandonedId = await startRaw(page, abandoned.endpoint, {
        abortAfterSaved: 1,
      });
      const abandonedRaw = await rawDone(page, abandonedId);
      assert.equal(abandonedRaw.status, 200);
      assert.equal(abandonedRaw.aborted, true);
      await settle(abandoned.org);
      const abandonedSnapshot = await snapshot(abandoned.org);
      const abandonedScans = await scansFor(abandoned.org);
      assert.ok(
        abandonedSnapshot.length > 1 && abandonedSnapshot.length <= 5,
        "Ignored disconnect continues but only within 5-detail chunk",
      );
      assert.ok(
        abandonedScans[0].clientClosedAt && !abandonedScans[0].upstreamAborted,
      );
      assert.ok(
        abandonedScans[0].endedAt - abandonedScans[0].startedAt < 28000,
      );
      assert.ok(
        (await upstreamLog()).filter((row) => row.kind === "detail").length <=
          5,
      );
      await stable(abandoned.org, abandonedSnapshot);
      pass(
        "No-cancel browser abort genuinely leaves upstream running, but bounds it to <=5 detail calls and <28s response time",
      );

      await verifyRunDeadline();

      stage = "completed response has no delayed writes";
      const eof = await newOrg("応答終了");
      await control("normal", 100);
      const eofId = await startRaw(page, eof.endpoint);
      const eofState = await rawDone(page, eofId);
      assert.equal(eofState.status, 200);
      assert.equal(eofState.events.at(-1).reason, "chunk_limit");
      assert.equal(eofState.events.at(-1).scanned, 5);
      await settle(eof.org);
      const eofSnapshot = await snapshot(eof.org);
      await stable(eof.org, eofSnapshot);
      const lateCancel = await request(
        page,
        eof.endpoint + "/scan/cancel",
        "POST",
        { runId: eofId },
      );
      assert.ok(
        ["finished", "cancelled", "expired"].includes(lateCancel.data.status),
      );
      await stable(eof.org, eofSnapshot);
      pass(
        "A terminal chunk response performs no subsequent writes; repeated/late cancellation is safe",
      );

      stage = "completed run replay cannot reactivate";
      releaseLocalQuota(eof.org);
      const beforeReplayCalls = (await upstreamLog()).length;
      const replayId = await startRaw(page, eof.endpoint, { runId: eofId });
      const replayState = await rawDone(page, replayId);
      assert.equal(replayState.status, 409);
      assert.equal((await upstreamLog()).length, beforeReplayCalls);
      await stable(eof.org, eofSnapshot);
      pass(
        "Replaying a completed run ID cannot restart provider calls or refresh candidate timestamps",
      );

      stage = "cancel before begin";
      const preCancelled = await newOrg("開始前取消");
      await control("normal", 50);
      const beforeId = crypto.randomUUID();
      const preAck = await request(
        page,
        preCancelled.endpoint + "/scan/cancel",
        "POST",
        { runId: beforeId },
      );
      assert.equal(preAck.data.status, "cancelled");
      const preRun = await startRaw(page, preCancelled.endpoint, {
        runId: beforeId,
      });
      const preState = await rawDone(page, preRun);
      assert.equal(preState.status, 409);
      assert.equal((await snapshot(preCancelled.org)).length, 0);
      assert.equal((await upstreamLog()).length, 0);
      pass(
        "Cancellation arriving before begin creates a tombstone; delayed begin makes zero provider calls and writes",
      );

      stage = "server supersession without client cooperation";
      const superseded = await newOrg("サーバー世代");
      await control("normal", 850);
      const oldId = await startRaw(page, superseded.endpoint);
      await expect
        .poll(async () => (await snapshot(superseded.org)).length)
        .toBeGreaterThan(0);
      releaseLocalQuota(superseded.org);
      const delayedOldIssuedAt = new Date(Date.now() - 2000).toISOString();
      const newId = await startRaw(page, superseded.endpoint, {
        customCriteria: { ...criteria, name: "検索検証065" },
      });
      const newState = await rawDone(page, newId);
      const oldState = await rawDone(page, oldId);
      assert.equal(newState.status, 200);
      assert.equal(oldState.status, 200);
      assert.ok(
        oldState.events.at(-1).scanned < 5,
        "Superseded old run stops before completing its remaining chunk",
      );
      await settle(superseded.org);
      const supersededSnapshot = await snapshot(superseded.org);
      await stable(superseded.org, supersededSnapshot);
      pass(
        "A new server run fences the older run even without old client cancellation",
      );

      stage = "delayed old begin cannot supersede newer run";
      releaseLocalQuota(superseded.org);
      const delayedCalls = (await upstreamLog()).length;
      const delayedId = await startRaw(page, superseded.endpoint, {
        issuedAt: delayedOldIssuedAt,
      });
      const delayedState = await rawDone(page, delayedId);
      assert.equal(delayedState.status, 409);
      assert.equal((await upstreamLog()).length, delayedCalls);
      await stable(superseded.org, supersededSnapshot);
      pass(
        "A delayed older begin cannot supersede the newer generation or write candidates",
      );

      stage = "cancel authorization and CSRF";
      const otherContext = await browser.newContext();
      contexts.push(otherContext);
      const other = await otherContext.newPage();
      await login(other, users.other);
      await request(
        other,
        eof.endpoint + "/scan/cancel",
        "POST",
        { runId: eofId },
        403,
      );
      const otherToken = await tokenFor(users.other);
      const viewerId = JSON.parse(
        Buffer.from(otherToken.split(".")[1], "base64url").toString(),
      ).sub;
      assert.match(viewerId, /^[a-f0-9-]{36}$/);
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
          input: `insert into public.organization_members(organization_id,user_id,role) values('${eof.org}'::uuid,'${viewerId}'::uuid,'viewer');`,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15000,
        },
      );
      await request(other, eof.endpoint, "GET");
      await request(
        other,
        eof.endpoint + "/scan/cancel",
        "POST",
        { runId: eofId },
        403,
      );
      const csrfStatus = await context.request
        .post(base + eof.endpoint + "/scan/cancel", {
          headers: {
            Origin: "https://example.invalid",
            "Content-Type": "application/json",
          },
          data: { runId: eofId },
        })
        .then((r) => r.status())
        .catch(() => 0);
      assert.equal(csrfStatus, 403);
      const unauth = await fetch(base + eof.endpoint + "/scan/cancel", {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ runId: eofId }),
      });
      assert.equal(unauth.status, 401);
      assert.deepEqual(runtimeErrors, []);
      pass(
        "Cross-organization, viewer, cross-origin and unauthenticated cancellation are denied; browser runtime clean",
      );
      await writeFile(
        output + "/evidence.json",
        JSON.stringify(
          {
            syntheticOnly: true,
            proxyMode: "ignore-scan-disconnect",
            evidence,
          },
          null,
          2,
        ),
      );
      pass(
        "Stop E2E complete using only local synthetic candidates; no production or real GBiz access",
      );
    }
  }
} catch (error) {
  console.error(
    `FAIL: Stop E2E stage '${stage}' (${error instanceof Error ? error.name : "UnknownError"})`,
  );
  if (error instanceof Error) {
    const location = error.stack?.match(/discovery-stop-e2e\.mjs:\d+:\d+/)?.[0];
    if (location) console.error(location);
    if (error.name === "AssertionError")
      console.error(error.message.split("\n").slice(0, 4).join("\n"));
  }
  await writeFile(
    output + "/evidence.json",
    JSON.stringify(
      { syntheticOnly: true, failureStage: stage, evidence },
      null,
      2,
    ),
  );
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  // Cancel only our own fixture runs and own-org UI markers before closing clients.
  const markers = await page
    .evaluate(() =>
      Object.entries(localStorage)
        .filter(([key]) => key.startsWith("leadstack.discovery.active.v1."))
        .map(([, value]) => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    )
    .catch(() => []);
  for (const marker of markers) {
    const org = marker.base?.match(/\/organizations\/([a-f0-9-]{36})$/)?.[1];
    if (organizations.includes(org))
      runIds.push({
        endpoint: marker.base + "/company-discovery",
        runId: marker.runId,
      });
  }
  for (const { endpoint, runId } of runIds)
    await request(page, endpoint + "/scan/cancel", "POST", { runId }).catch(
      () => {},
    );
  for (const p of loggedInPages)
    await request(p, "/api/auth/logout", "POST", {}).catch(() => {});
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser.close();
  await Promise.all(
    organizations.map(async (org) => {
      if ((await scansFor(org)).length)
        await settle(org, 28000).catch(() => {});
    }),
  );
  if (ownerToken)
    for (const org of organizations)
      await direct(
        `/rest/v1/company_candidates?organization_id=eq.${org}`,
        "DELETE",
        ownerToken,
      ).catch(() => {
        process.exitCode = 1;
      });
  for (const sessionToken of tokenSessions)
    await fetch(gateway + "/auth/v1/logout?scope=local", {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${sessionToken}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
}
