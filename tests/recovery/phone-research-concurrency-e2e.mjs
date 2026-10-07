// Real multi-tab UI + Auth/PostgREST + PostgreSQL lock contention, local only.
// External requests are intercepted by phone-research-preload; no live sites.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";

const base = process.env.E2E_BASE_URL || "http://localhost:3013";
const gateway = "http://127.0.0.1:55321";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
assert.equal(new URL(base).port, "3013");
assert.ok(process.env.E2E_USERS_FILE);
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
assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, gateway);
const anonKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert.ok(anonKey);
const output = process.env.E2E_OUTPUT || "test-results/phone-concurrency";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const pages = await Promise.all(
  Array.from({ length: 3 }, () => context.newPage()),
);
const page = pages[0];
const runtimeErrors = [];
for (const p of pages) {
  p.setDefaultTimeout(15000);
  p.on("pageerror", (error) => runtimeErrors.push(error.name));
}
const evidence = [];
const lockers = [];
let stage = "setup";
let token;
const pass = (message, details) => {
  console.log("PASS: " + message);
  evidence.push({ message, ...details });
};
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
      name: destination === "/discover" ? "企業を探す" : "営業リスト",
      exact: true,
    }),
  ).toBeVisible();
}

const psqlArgs = [
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
];
function sql(query) {
  try {
    return execFileSync("docker", psqlArgs, {
      input: query,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("Disposable fixture SQL failed");
  }
}
function quota(org) {
  return Number(
    sql(
      `select total from private.discovery_rate_limits where organization_id='${org}' and operation='enrich' and expires_at>now();`,
    ),
  );
}
async function lockReservations(org) {
  assert.match(org, /^[a-f0-9-]{36}$/);
  const process = spawn("docker", psqlArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  lockers.push(process);
  let output = "";
  process.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  process.stderr.on("data", () => {});
  process.stdin.write(
    `begin; select pg_advisory_xact_lock(hashtextextended('discovery_rate:${org}:enrich',0)); select 'ready:'||pg_backend_pid();\n`,
  );
  await expect.poll(() => /ready:\d+/.test(output)).toBe(true);
  const pid = Number(output.match(/ready:(\d+)/)[1]);
  return {
    waiting: () =>
      Number(
        sql(
          `select count(*) from pg_locks w join pg_locks h on w.locktype=h.locktype and w.database=h.database and w.classid=h.classid and w.objid=h.objid and w.objsubid=h.objsubid where h.pid=${pid} and h.locktype='advisory' and h.granted and not w.granted;`,
        ),
      ),
    release: async () => {
      if (process.exitCode !== null) return;
      const exited = new Promise((resolve) => process.once("exit", resolve));
      process.stdin.end("commit;\n\\q\n");
      await exited;
    },
  };
}
async function siteRequests(rows) {
  const hosts = new Set(rows.map((row) => new URL(row.website_url).hostname));
  return (
    await readFile(
      "/workspace/handoff/e2e-private/phone-requests.jsonl",
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((item) => hosts.has(item.host));
}
async function fixture(label, number, reserve = 0, slow = false) {
  const tag = `${Date.now()}-${label}`;
  const org = (
    await request(
      page,
      "/api/organizations",
      "POST",
      { name: `同時調査検証-${tag}` },
      201,
    )
  ).data.id;
  const rows = await direct(
    "/rest/v1/company_candidates",
    "POST",
    token,
    Array.from({ length: number }, (_, i) => ({
      organization_id: org,
      corporate_number: String(8810000000000 + i),
      name: `${i + 1} 同時調査検証 ${label}`,
      prefecture_code: "13",
      prefecture: "東京都",
      location: "東京都検証市1番地",
      industry_codes: ["D"],
      industry_labels: ["建設業"],
      phone: null,
      website_url: `https://${slow ? "slow4" : "found"}.${tag}-${i}.phone-fixture.test/`,
      employee_number: 25,
      provenance: { fixture: "local-phone-concurrency-only" },
      fetched_at: new Date().toISOString(),
    })),
    201,
  );
  for (let i = 0; i < reserve; i++) {
    assert.equal(
      await direct(
        "/rest/v1/rpc/reserve_company_discovery_request",
        "POST",
        token,
        { org, operation: "enrich" },
      ),
      true,
    );
  }
  await Promise.all(pages.map((p) => organization(p, org)));
  return { org, rows, endpoint: `/api/organizations/${org}/company-discovery` };
}
async function select(p, rows) {
  for (const row of rows) {
    await p
      .getByRole("row")
      .filter({ has: p.getByRole("button", { name: row.name, exact: true }) })
      .getByRole("checkbox")
      .check();
  }
  await p.getByRole("button", { name: /^電話番号を調べる/ }).click();
  return p.getByRole("dialog", { name: "電話番号を調べる", exact: true });
}
function response(p, endpoint, id) {
  return p
    .waitForResponse(
      (r) =>
        r.url().endsWith(endpoint) &&
        r.request().method() === "POST" &&
        r.request().postDataJSON()?.action === "research_phone" &&
        r.request().postDataJSON()?.id === id,
    )
    .then(async (r) => ({ status: r.status(), body: await r.json() }));
}
async function together(org, dialogs) {
  const lock = await lockReservations(org);
  try {
    await Promise.all(
      dialogs.map((dialog) =>
        dialog
          .getByRole("button", { name: /社の調査を開始$/, exact: false })
          .click(),
      ),
    );
    // This disposable PostgREST instance has a two-connection pool. Observe
    // both connections waiting at the actual quota lock; a third UI request
    // remains in flight and may wait for a pool connection.
    const waiting = Math.min(2, dialogs.length);
    await expect
      .poll(lock.waiting, { timeout: 2200, intervals: [50, 100] })
      .toBe(waiting);
    return waiting;
  } finally {
    await lock.release();
  }
}
function card(dialog, row) {
  return dialog.getByRole("article", { name: row.name, exact: true });
}
function bar(dialog) {
  return dialog.getByRole("progressbar", {
    name: "電話番号調査の進捗",
    exact: true,
  });
}
async function detail(f, row) {
  return (await request(page, `${f.endpoint}/${row.id}`)).candidate;
}

try {
  await context.route("**/*", (route) => {
    return ["localhost", "127.0.0.1"].includes(
      new URL(route.request().url()).hostname,
    )
      ? route.continue()
      : route.abort();
  });
  await login(page, users.owner);
  await Promise.all(pages.slice(1).map((p) => p.goto(base + "/discover")));
  token = await tokenFor(users.owner);

  stage = "three tabs race for two remaining reservations";
  const remaining = await fixture("残枠2", 4, 18);
  assert.equal(quota(remaining.org), 18);
  const dialogs = await Promise.all(
    pages.map((p, i) => select(p, [remaining.rows[i]])),
  );
  const replies = pages.map((p, i) =>
    response(p, remaining.endpoint, remaining.rows[i].id),
  );
  const waiters = await together(remaining.org, dialogs);
  const results = await Promise.all(replies);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 429]);
  assert.equal(quota(remaining.org), 20);
  for (let i = 0; i < 3; i++) {
    if (results[i].status === 200) {
      assert.equal(results[i].body.outcome, "checked");
      await expect(dialogs[i].getByRole("status")).toHaveText(
        "調査が完了しました。",
      );
      await expect(bar(dialogs[i])).toHaveAttribute("aria-valuenow", "1");
    } else {
      await expect(dialogs[i].getByRole("status")).toContainText(
        "調査を中断しました",
      );
      await expect(dialogs[i].getByRole("alert")).toContainText(
        "確認回数の上限",
      );
      assert.equal(
        (await detail(remaining, remaining.rows[i])).enrichment_result,
        null,
      );
    }
  }
  const attempts = await siteRequests(remaining.rows);
  const fetchedHosts = [...new Set(attempts.map((r) => r.host))];
  assert.equal(fetchedHosts.length, 2);
  assert.equal(attempts.length, 4, "Only two robots + homepage pairs start");
  for (let i = 0; i < 3; i++) {
    const host = new URL(remaining.rows[i].website_url).hostname;
    assert.equal(fetchedHosts.includes(host), results[i].status === 200);
  }
  await page.screenshot({ path: output + "/last-slots.png" });
  await organization(page, remaining.org);
  const rejectedDialog = await select(page, [remaining.rows[3]]);
  const rejected = response(page, remaining.endpoint, remaining.rows[3].id);
  await rejectedDialog
    .getByRole("button", { name: "1社の調査を開始", exact: true })
    .click();
  assert.equal((await rejected).status, 429);
  assert.equal(quota(remaining.org), 20);
  assert.equal((await siteRequests(remaining.rows)).length, 4);
  pass(
    "Three tabs with 18/20 reserved: exactly two investigations, third and subsequent attempt rejected before website access",
    {
      org: remaining.org,
      blockedAtDbLock: waiters,
      before: 18,
      after: 20,
      statuses: results.map((r) => r.status),
      fetchedSites: fetchedHosts.length,
      httpAttempts: attempts.length,
    },
  );

  stage = "same candidate simultaneous CAS and pending reuse";
  const shared = await fixture("同一候補", 1, 0, true);
  const sameDialogs = await Promise.all(
    pages.map((p) => select(p, shared.rows)),
  );
  const sameReplies = pages
    .slice(0, 2)
    .map((p) => response(p, shared.endpoint, shared.rows[0].id));
  const sameWaiters = await together(shared.org, sameDialogs.slice(0, 2));
  await expect
    .poll(
      () =>
        sql(
          `select enrichment_status from company_candidates where id='${shared.rows[0].id}';`,
        ),
      { intervals: [50, 100] },
    )
    .toBe("pending");
  const observedPending = response(
    pages[2],
    shared.endpoint,
    shared.rows[0].id,
  );
  await sameDialogs[2]
    .getByRole("button", { name: "1社の調査を開始", exact: true })
    .click();
  const reused = await observedPending;
  assert.equal(reused.status, 200);
  assert.equal(reused.body.outcome, "pending");
  await expect(
    card(sameDialogs[2], shared.rows[0]).getByText("別の調査が進行中", {
      exact: true,
    }),
  ).toBeVisible();
  const sameResults = await Promise.all(sameReplies);
  assert.deepEqual(sameResults.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    quota(shared.org),
    2,
    "CAS loser conservatively consumes a reservation; pending observer consumes none",
  );
  const sameAttempts = await siteRequests(shared.rows);
  assert.equal(sameAttempts.length, 2);
  assert.equal(sameAttempts.filter((r) => r.path === "/").length, 1);
  assert.equal(
    (await detail(shared, shared.rows[0])).enrichment_result.phone,
    "0312345678",
  );
  const loser = sameResults.findIndex((r) => r.status === 409);
  await expect(
    card(sameDialogs[loser], shared.rows[0]).getByRole("alert"),
  ).toContainText("候補が更新されました");
  await pages[loser].screenshot({
    path: output + "/same-candidate-conflict.png",
  });
  pass(
    "Two tabs read the same candidate version: one extraction and one 409; a third pending observer performs no website access",
    {
      org: shared.org,
      blockedAtDbLock: sameWaiters,
      statuses: sameResults.map((r) => r.status),
      observerOutcome: reused.body.outcome,
      reservations: quota(shared.org),
      fetchedSites: 1,
      httpAttempts: sameAttempts.length,
    },
  );

  stage = "stop current company while another tab exhausts its quota";
  const stopping = await fixture("停止と残枠1", 4, 19, true);
  const batches = [stopping.rows.slice(0, 2), stopping.rows.slice(2)];
  const stopDialogs = await Promise.all(
    pages.slice(0, 2).map((p, i) => select(p, batches[i])),
  );
  const queuePosts = [[], []];
  const listeners = pages.slice(0, 2).map((p, i) => {
    const listener = (r) => {
      if (
        r.url().endsWith(stopping.endpoint) &&
        r.method() === "POST" &&
        r.postDataJSON()?.action === "research_phone"
      )
        queuePosts[i].push(r.postDataJSON().id);
    };
    p.on("request", listener);
    return listener;
  });
  const stopReplies = pages
    .slice(0, 2)
    .map((p, i) => response(p, stopping.endpoint, batches[i][0].id));
  const stopWaiters = await together(stopping.org, stopDialogs);
  let activeId;
  await expect
    .poll(
      () => {
        activeId = sql(
          `select id from company_candidates where organization_id='${stopping.org}' and enrichment_status='pending';`,
        );
        return batches.some((batch) => batch[0].id === activeId);
      },
      { intervals: [50, 100] },
    )
    .toBe(true);
  const winner = batches.findIndex((batch) => batch[0].id === activeId);
  const other = 1 - winner;
  const activeDialog = stopDialogs[winner];
  await expect(
    card(activeDialog, batches[winner][0]).getByText("調査中…", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    card(activeDialog, batches[winner][1]).getByText("待機中", { exact: true }),
  ).toBeVisible();
  await activeDialog
    .getByRole("button", { name: "調査を停止", exact: true })
    .click();
  await expect(activeDialog.getByRole("status")).toContainText(
    "停止中… 今の1社の結果を保存してから停止します。",
  );
  await expect(
    activeDialog.getByRole("button", { name: "停止中…", exact: true }),
  ).toBeDisabled();
  await expect(bar(activeDialog)).toHaveAttribute("aria-valuenow", "0");
  await expect(
    card(activeDialog, batches[winner][0]).getByText("調査中…", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    card(activeDialog, batches[winner][1]).getByText("待機中", { exact: true }),
  ).toBeVisible();
  await pages[winner].screenshot({
    path: output + "/stopping-current-company.png",
  });
  const stopResults = await Promise.all(stopReplies);
  assert.equal(stopResults[winner].status, 200);
  assert.equal(stopResults[other].status, 429);
  await expect(activeDialog.getByRole("status")).toContainText(
    "調査を停止しました",
  );
  await expect(bar(activeDialog)).toHaveAttribute("aria-valuenow", "1");
  await expect(bar(activeDialog)).toHaveAttribute("aria-valuemax", "2");
  await expect(
    card(activeDialog, batches[winner][1]).getByText("未実行", { exact: true }),
  ).toBeVisible();
  await expect(
    card(activeDialog, batches[winner][0]).getByText(
      "電話番号候補あり・要確認",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(stopDialogs[other].getByRole("status")).toContainText(
    "調査を中断しました",
  );
  await expect(
    card(stopDialogs[other], batches[other][1]).getByText("未実行", {
      exact: true,
    }),
  ).toBeVisible();
  assert.deepEqual(
    queuePosts,
    batches.map((batch) => [batch[0].id]),
  );
  assert.equal(quota(stopping.org), 20);
  const stopAttempts = await siteRequests(stopping.rows);
  assert.equal(stopAttempts.length, 2);
  assert.equal(new Set(stopAttempts.map((r) => r.host)).size, 1);
  for (const row of stopping.rows) {
    const current = await detail(stopping, row);
    if (row.id === activeId)
      assert.equal(current.enrichment_result.phone, "0312345678");
    else {
      assert.equal(current.enrichment_result, null);
      assert.equal(
        current.updated_at,
        row.updated_at,
        "Unstarted/quota-rejected candidate remains untouched",
      );
    }
  }
  await pages[winner].screenshot({ path: output + "/stopped-one-of-two.png" });
  pages.slice(0, 2).forEach((p, i) => p.off("request", listeners[i]));
  pass(
    "Two tabs with 19/20 reserved: one current company drains on stop; both queues leave their next company unstarted and show correct progress",
    {
      org: stopping.org,
      blockedAtDbLock: stopWaiters,
      before: 19,
      after: 20,
      statuses: stopResults.map((r) => r.status),
      queueRequestCounts: queuePosts.map((ids) => ids.length),
      stoppedProgress: "1/2",
      fetchedSites: 1,
      httpAttempts: stopAttempts.length,
    },
  );
  assert.deepEqual(runtimeErrors, []);
  await writeFile(
    output + "/evidence.json",
    JSON.stringify(
      {
        syntheticOnly: true,
        realDatabaseLocks: true,
        evidence,
        browserErrors: 0,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("FAIL stage: " + stage + " (" + (error?.name || "Error") + ")");
  const location = error?.stack?.match(
    /phone-research-concurrency-e2e\.mjs:\d+:\d+/,
  )?.[0];
  if (location) console.error(location);
  for (let i = 0; i < pages.length; i++)
    await pages[i]
      .screenshot({ path: `${output}/failure-${i}.png` })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  for (const process of lockers)
    if (process.exitCode === null) process.stdin.end("rollback;\n\\q\n");
  await context.close();
  await browser.close();
}
