// Native PostgreSQL concurrency checks. This creates and drops ONLY an isolated
// database in our explicitly named local test container; it never uses env URLs.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
const container = "leadstack-e2e-db";
const database = `leadstack_discovery_verify_${process.pid}`;
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
let created = false;
try {
  run(`create database ${database};`, "postgres");
  created = true;
  run(`create schema auth; grant usage on schema public,auth to authenticated,anon;
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  for (const file of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    run(await readFile(`supabase/migrations/${file}`, "utf8"));
  run(`insert into auth.users(id,email,email_confirmed_at) values('${actor}','native@example.test',now());
 insert into auth.sessions values('${actor}','${actor}',null);
 insert into organizations(id,name) values('${org}','Native discovery concurrency');
 insert into organization_members(organization_id,user_id,role) values('${org}','${actor}','owner');
 ${claims}
 insert into company_candidates(organization_id,corporate_number,name) select '${org}',(9100000000000+i)::text,'Native '||i from generate_series(1,4999)i;`);
  const insert = (corporate) =>
    `insert into company_candidates(organization_id,corporate_number,name) values('${org}','${corporate}','Race ${corporate}');`;
  // A holds the last quota slot uncommitted while B tries to claim it.
  {
    const a = session();
    a.send(`begin;${claims}${insert("9199999999998")}select 'ready_quota';`);
    await a.marker("ready_quota");
    const b = session();
    b.send(`begin;${claims}${insert("9199999999999")}commit;`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await a.finish("commit;")).code, 0);
    const rejected = await b.finish();
    assert.notEqual(rejected.code, 0);
    assert.ok(rejected.err.includes("P0429"));
    assert.equal(
      run(
        `select count(*) from company_candidates where organization_id='${org}';`,
      ),
      "5000",
    );
    console.log(
      "PASS: concurrent last-slot inserts preserve 5000 candidate quota",
    );
  }
  // B establishes an old REPEATABLE READ snapshot, then A changes the counter.
  {
    run(
      `${claims}delete from company_candidates where corporate_number='9199999999998';`,
    );
    const b = session();
    b.send(
      `begin isolation level repeatable read;${claims}select count(*) from company_candidates;select 'ready_snapshot';`,
    );
    await b.marker("ready_snapshot");
    run(`${claims}${insert("9199999999998")}`);
    const rejected = await b.finish(`${insert("9199999999999")}commit;`);
    assert.notEqual(rejected.code, 0);
    assert.ok(rejected.err.includes("40001"));
    assert.equal(
      run(
        `select count(*) from company_candidates where organization_id='${org}';`,
      ),
      "5000",
    );
    console.log(
      "PASS: repeatable-read stale quota snapshot aborts instead of exceeding quota",
    );
  }
  // Competing confirmation requests serialize with manual/CSV CRM writes.
  {
    const candidate = run(
      `select id from company_candidates where corporate_number='9100000000001';`,
    );
    const call = `select import_company_candidates('${org}',array['${candidate}'::uuid]);`;
    const a = session();
    a.send(`begin;${claims}${call}select 'ready_import';`);
    await a.marker("ready_import");
    const b = session();
    b.send(`begin;${claims}${call}commit;`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const first = await a.finish("commit;");
    assert.equal(first.code, 0);
    const second = await b.finish();
    assert.equal(second.code, 0);
    assert.equal(
      run(
        `select count(*) from companies where organization_id='${org}' and corporate_number='9100000000001';`,
      ),
      "1",
    );
    assert.equal(
      run(
        `select count(*) from company_candidate_imports where organization_id='${org}' and corporate_number='9100000000001';`,
      ),
      "1",
    );
    console.log(
      "PASS: concurrent confirmations create one CRM company and one source snapshot",
    );
  }
  // Both request reservations share a persistent per-organization budget.
  {
    const reserve = `select reserve_company_discovery_request('${org}','acquire');`;
    const a = session();
    a.send(`begin;${claims}${reserve}select 'ready_rate';`);
    await a.marker("ready_rate");
    const b = session();
    b.send(`begin;${claims}${reserve}commit;`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await a.finish("commit;")).code, 0);
    const second = await b.finish();
    assert.equal(second.code, 0);
    assert.ok(second.out.split("\n").includes("f"));
    assert.equal(
      run(
        `select total from private.discovery_rate_limits where organization_id='${org}' and operation='acquire';`,
      ),
      "1",
    );
    console.log(
      "PASS: concurrent provider request reservations consume only one quota slot",
    );
  }
} catch (error) {
  // Avoid emitting captured SQL/session claims from child_process error objects.
  console.error(
    "Native discovery checks failed:",
    error instanceof assert.AssertionError
      ? error.message
      : "local PostgreSQL setup or statement failed",
  );
  process.exitCode = 1;
} finally {
  if (created) {
    run(`drop database ${database} with (force);`, "postgres");
    console.log("Temporary verification database removed");
  }
}
