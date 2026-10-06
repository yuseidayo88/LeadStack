// Native PostgreSQL concurrency checks. This creates and drops ONLY an isolated
// database in our explicitly named local test container; it never uses env URLs.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
const container = "leadstack-e2e-db";
const database = `leadstack_scan_verify_${process.pid}`;
const actor = "20000000-0000-4000-8000-000000000001";
const org = "20000000-0000-4000-8000-000000000002";
const args = (target = database) => [
  "exec",
  "-i",
  container,
  "psql",
  "-h",
  "/tmp",
  "-p",
  "5432",
  "-U",
  "supabase_admin",
  "-d",
  target,
  "-AtX",
  "-v",
  "ON_ERROR_STOP=1",
  "-v",
  "VERBOSITY=verbose",
];
const run = (sql, target = database) =>
  execFileSync("docker", args(target), {
    input: sql,
    encoding: "utf8",
    maxBuffer: 2 ** 22,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const claims = `set role authenticated; select set_config('request.jwt.claim.sub','${actor}',false); select set_config('request.jwt.claims','{"sub":"${actor}","session_id":"${actor}"}',false);`;
function session() {
  const child = spawn("docker", args(), { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {}); // psql may exit after an expected SQL rejection
  let out = "",
    err = "";
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    out += chunk;
    for (const waiter of waiters)
      if (out.includes(waiter.marker)) waiter.resolve();
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out, err }));
  });
  return {
    send(sql) {
      child.stdin.write(sql + "\n");
    },
    async marker(marker) {
      if (out.includes(marker)) return;
      await Promise.race([
        new Promise((resolve) => waiters.push({ marker, resolve })),
        new Promise((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Native session readiness timed out")),
            10000,
          );
          timeout.unref();
        }),
      ]);
    },
    finish(sql = "") {
      child.stdin.end(sql + "\n");
      return ended;
    },
  };
}
const runIds = Array.from(
  { length: 20 },
  (_, i) => `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
const start = (id, deadline = "null", issued = "clock_timestamp()") =>
  `select start_discovery_scan_run('${org}','${id}',${issued},${deadline});`;
const reserve = (id) =>
  `select authorize_discovery_scan_step('${org}','${id}','detail');`;
const cancel = (id) => `select cancel_discovery_scan_run('${org}','${id}');`;
const data = (number) =>
  JSON.stringify({
    corporate_number: String(number),
    name: "Native cancellation",
    industry_codes: [],
    industry_labels: [],
    fetched_at: new Date().toISOString(),
    provenance: { fixture: true },
  });
const save = (id, number, expected = "null") =>
  `select commit_discovery_scan_candidate('${org}','${id}','${data(number)}',${expected});`;
const lastJSON = (out) => JSON.parse(out.trim().split("\n").at(-1));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForContendedLock() {
  for (let i = 0; i < 20; i++) {
    const waiting = Number(
      run(
        `select count(*) from pg_stat_activity where datname='${database}' and wait_event_type='Lock';`,
      ),
    );
    if (waiting > 0) return;
    await pause(25);
  }
  assert.fail("Expected simultaneous SQL session to wait on a database lock");
}
let created = false;
try {
  run(`create database ${database};`, "postgres");
  created = true;
  run(`create schema auth;grant usage on schema public,auth to authenticated,anon;
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  for (const file of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    run(await readFile(`supabase/migrations/${file}`, "utf8"));
  run(
    `insert into auth.users(id,email,email_confirmed_at)values('${actor}','scan-native@example.test',now());insert into auth.sessions values('${actor}','${actor}',null);insert into organizations(id,name)values('${org}','Owned native scan fixture');insert into organization_members(organization_id,user_id,role)values('${org}','${actor}','owner');`,
  );
  // A cancellation transaction reaches the barrier before the delayed save.
  {
    const id = runIds[0];
    run(`${claims}${start(id)}${reserve(id)}`);
    const a = session();
    a.send(`begin;${claims}${cancel(id)}select 'cancel_locked';`);
    await a.marker("cancel_locked");
    const b = session();
    b.send(`${claims}${save(id, 9800000000001)}`);
    await waitForContendedLock();
    assert.equal((await a.finish("commit;")).code, 0);
    const blocked = await b.finish();
    assert.equal(blocked.code, 0);
    assert.equal(lastJSON(blocked.out).status, "cancelled");
    assert.equal(
      run(
        "select count(*) from company_candidates where corporate_number='9800000000001';",
      ),
      "0",
    );
    console.log(
      "PASS: cancellation acknowledgement rejects a save already waiting on the run lock",
    );
  }
  // An in-flight commit that won the row lock finishes before cancel can ACK.
  {
    const id = runIds[1];
    run(`${claims}${start(id)}${reserve(id)}${reserve(id)}`);
    const a = session();
    a.send(`begin;${claims}${save(id, 9800000000002)}select 'save_locked';`);
    await a.marker("save_locked");
    const b = session();
    b.send(`${claims}${cancel(id)}`);
    await waitForContendedLock();
    assert.equal((await a.finish("commit;")).code, 0);
    const ack = await b.finish();
    assert.equal(ack.code, 0);
    assert.equal(lastJSON(ack.out).status, "cancelled");
    assert.equal(lastJSON(ack.out).saved_count, 1);
    assert.equal(
      lastJSON(run(`${claims}${save(id, 9800000000003)}`)).status,
      "cancelled",
    );
    assert.equal(
      run(
        "select count(*) from company_candidates where corporate_number in ('9800000000002','9800000000003');",
      ),
      "1",
    );
    console.log(
      "PASS: in-flight committed row precedes ACK; all subsequent scan writes are denied",
    );
  }
  // REPEATABLE READ must not use an obsolete active snapshot after cancellation.
  {
    const id = runIds[2];
    run(`${claims}${start(id)}${reserve(id)}`);
    const a = session();
    a.send(
      `begin isolation level repeatable read;${claims}select count(*) from company_candidates;select 'old_snapshot';`,
    );
    await a.marker("old_snapshot");
    run(`${claims}${cancel(id)}`);
    const stale = await a.finish(`${save(id, 9800000000004)}commit;`);
    assert.notEqual(stale.code, 0);
    assert.ok(stale.err.includes("40001"));
    assert.equal(
      run(
        "select count(*) from company_candidates where corporate_number='9800000000004';",
      ),
      "0",
    );
    console.log(
      "PASS: stale repeatable-read snapshot serializes instead of bypassing cancellation",
    );
  }
  // The lease must be checked again after a manual candidate row lock delay.
  {
    const id = runIds[3];
    const stamp = run(
      `select updated_at from company_candidates where corporate_number='9800000000002';`,
    );
    run(
      `${claims}${start(id, "clock_timestamp()+interval '1 second'")}${reserve(id)}`,
    );
    const a = session();
    a.send(
      `begin;${claims}select id from company_candidates where corporate_number='9800000000002' for update;select 'candidate_locked';`,
    );
    await a.marker("candidate_locked");
    const b = session();
    b.send(`${claims}${save(id, 9800000000002, `'${stamp}'::timestamptz`)}`);
    await waitForContendedLock();
    await pause(1150);
    assert.equal((await a.finish("commit;")).code, 0);
    const expired = await b.finish();
    assert.equal(expired.code, 0);
    assert.equal(lastJSON(expired.out).status, "expired");
    assert.equal(
      run(
        `select saved_count from private.discovery_scan_runs where run_id='${id}';`,
      ),
      "0",
    );
    console.log(
      "PASS: lease expiry while waiting on manual candidate edit prevents the later update",
    );
  }
  // INSERT can wait inside quota trigger after the earlier lease check.
  {
    const id = runIds[4];
    run(
      `${claims}${start(id, "clock_timestamp()+interval '1 second'")}${reserve(id)}`,
    );
    const a = session();
    a.send(
      `begin;select total from private.company_candidate_counts where organization_id='${org}' for update;select 'quota_locked';`,
    );
    await a.marker("quota_locked");
    const b = session();
    b.send(`${claims}${save(id, 9800000000005)}`);
    await waitForContendedLock();
    await pause(1150);
    assert.equal((await a.finish("commit;")).code, 0);
    const expired = await b.finish();
    assert.notEqual(expired.code, 0);
    assert.ok(expired.err.includes("P0409"));
    assert.equal(
      run(
        "select count(*) from company_candidates where corporate_number='9800000000005';",
      ),
      "0",
    );
    assert.equal(
      run(
        `select saved_count from private.discovery_scan_runs where run_id='${id}';`,
      ),
      "0",
    );
    console.log(
      "PASS: expiry during quota-trigger wait rolls back candidate insert and quota atomically",
    );
  }
  // Cancel-before-start and newer/older starts contend on the same org lock.
  {
    const id = runIds[5];
    const a = session();
    a.send(`begin;${claims}${cancel(id)}select 'tombstone_locked';`);
    await a.marker("tombstone_locked");
    const b = session();
    b.send(`${claims}${start(id)}`);
    await waitForContendedLock();
    assert.equal((await a.finish("commit;")).code, 0);
    const delayed = await b.finish();
    assert.equal(delayed.code, 0);
    assert.equal(lastJSON(delayed.out).started, false);
    assert.equal(lastJSON(delayed.out).status, "cancelled");
    console.log(
      "PASS: cancellation before start wins across concurrent independent SQL sessions",
    );
  }
  {
    const newer = runIds[6],
      older = runIds[7];
    const a = session();
    a.send(`begin;${claims}${start(newer)}select 'newer_locked';`);
    await a.marker("newer_locked");
    const b = session();
    b.send(
      `${claims}${start(older, "null", "clock_timestamp()-interval '2 seconds'")}`,
    );
    await waitForContendedLock();
    assert.equal((await a.finish("commit;")).code, 0);
    const delayed = await b.finish();
    assert.equal(delayed.code, 0);
    assert.equal(lastJSON(delayed.out).started, false);
    assert.equal(lastJSON(run(`${claims}${reserve(newer)}`)).allowed, true);
    console.log(
      "PASS: delayed older request cannot supersede newer worker after org-lock contention",
    );
  }
  console.log("7 native PostgreSQL cancellation concurrency checks passed");
} catch (error) {
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : "Native scan verification failed (captured SQL/session claims omitted)",
  );
  process.exitCode = 1;
} finally {
  if (created) run(`drop database ${database} with (force);`, "postgres");
}
