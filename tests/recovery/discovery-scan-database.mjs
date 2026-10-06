import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
let db, org;
const ids = Object.fromEntries(
  ["owner", "other", "sales", "viewer", "admin"].map((name, i) => [
    name,
    `10000000-0000-4000-8000-00000000000${i + 1}`,
  ]),
);
let number = 7000000000000;
async function as(user, fn) {
  await db.exec("set role authenticated");
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claims',$2,false)",
    [ids[user], JSON.stringify({ sub: ids[user], session_id: ids[user] })],
  );
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}
async function scalar(sql, params = []) {
  return Object.values((await db.query(sql, params)).rows[0])[0];
}
async function denied(fn, code = "42501") {
  await assert.rejects(fn, (e) => e.code === code);
}
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin;
 create schema auth; grant usage on schema public,auth to authenticated,anon;
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
  for (const file of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
  for (const [name, id] of Object.entries(ids)) {
    await db.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
      [id, `${name}@example.test`],
    );
    await db.query("insert into auth.sessions values($1,$1,null)", [id]);
  }
  org = await as("owner", () =>
    scalar("select create_organization('検索組織A')"),
  );
  await as("other", () => scalar("select create_organization('検索組織B')"));
  for (const role of ["admin", "sales", "viewer"])
    await db.query("insert into organization_members values($1,$2,$3,now())", [
      org,
      ids[role],
      role,
    ]);
});
after(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("delete from private.discovery_scan_runs");
});
const start = (
  id,
  issued = new Date().toISOString(),
  target = org,
  deadline = null,
) =>
  scalar("select start_discovery_scan_run($1,$2,$3,$4)", [
    target,
    id,
    issued,
    deadline,
  ]);
const permit = (id, kind = "detail", target = org) =>
  scalar("select authorize_discovery_scan_step($1,$2,$3)", [target, id, kind]);
const cancel = (id, target = org) =>
  scalar("select cancel_discovery_scan_run($1,$2)", [target, id]);
const finish = (id, target = org) =>
  scalar("select finish_discovery_scan_run($1,$2)", [target, id]);
const payload = (extra = {}) => ({
  corporate_number: String(++number),
  name: "停止検証",
  prefecture_code: "16",
  prefecture: "富山県",
  location: "富山県",
  industry_codes: ["E"],
  industry_labels: ["製造業"],
  website_url: "https://example.test/",
  employee_number: 25,
  source_updated_at: null,
  fetched_at: new Date().toISOString(),
  provenance: { gbiz: { fixture: true } },
  ...extra,
});
const save = (id, data = payload(), expected = null, target = org) =>
  scalar("select commit_discovery_scan_candidate($1,$2,$3,$4)", [
    target,
    id,
    JSON.stringify(data),
    expected,
  ]);

test("scan table is private RLS and public wrappers are invoker with auth-only execute", async () => {
  assert.equal(
    await scalar(
      "select relrowsecurity from pg_class where oid='private.discovery_scan_runs'::regclass",
    ),
    true,
  );
  for (const role of ["anon", "authenticated"])
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"])
      assert.equal(
        await scalar(
          "select has_table_privilege($1,'private.discovery_scan_runs',$2)",
          [role, privilege],
        ),
        false,
      );
  for (const name of [
    "start_discovery_scan_run",
    "authorize_discovery_scan_step",
    "commit_discovery_scan_candidate",
    "cancel_discovery_scan_run",
    "finish_discovery_scan_run",
  ]) {
    const rows = (
      await db.query(
        "select p.oid,p.prosecdef,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname=$1",
        [name],
      )
    ).rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.prosecdef, row.nspname === "private");
      assert.equal(
        await scalar(
          "select has_function_privilege('anon',$1::oid,'EXECUTE')",
          [row.oid],
        ),
        false,
      );
      assert.equal(
        await scalar(
          "select has_function_privilege('authenticated',$1::oid,'EXECUTE')",
          [row.oid],
        ),
        true,
      );
    }
  }
});
test("cancel-before-start tombstone denies delayed start and any later write", async () =>
  as("owner", async () => {
    const id = randomUUID();
    assert.equal((await cancel(id)).status, "cancelled");
    assert.deepEqual(((x) => [x.status, x.started])(await start(id)), [
      "cancelled",
      false,
    ]);
    assert.equal((await permit(id)).allowed, false);
    assert.equal((await save(id)).status, "cancelled");
    assert.equal((await cancel(id)).status, "cancelled");
  }));
test("start is idempotent and never extends a lease or resets counts", async () =>
  as("owner", async () => {
    const id = randomUUID();
    const initial = await start(id);
    assert.equal(initial.started, true);
    assert.equal(initial.status, "active");
    await permit(id);
    const again = await start(id);
    assert.equal(again.started, false);
    assert.equal(again.detail_count, 1);
    assert.equal(again.expires_at, initial.expires_at);
  }));
test("newer run supersedes prior work without allowing terminal replay", async () =>
  as("owner", async () => {
    const a = randomUUID(),
      b = randomUUID();
    await start(a, new Date(Date.now() - 1000).toISOString());
    await permit(a);
    await start(b);
    assert.equal((await permit(a)).status, "cancelled");
    assert.equal((await save(a)).saved, false);
    assert.equal((await start(a)).started, false);
    assert.equal((await permit(b)).allowed, true);
  }));
test("delayed older or equal issued request cannot supersede newer active run", async () =>
  as("owner", async () => {
    const newest = randomUUID(),
      issued = new Date().toISOString();
    await start(newest, issued);
    for (const old of [new Date(Date.now() - 1000).toISOString(), issued]) {
      const r = await start(randomUUID(), old);
      assert.equal(r.started, false);
      assert.equal(r.status, "cancelled");
    }
    assert.equal((await permit(newest)).allowed, true);
  }));
test("cancelling old unknown run does not cancel a different active run", async () =>
  as("owner", async () => {
    const current = randomUUID();
    await start(current);
    await cancel(randomUUID());
    assert.equal((await permit(current)).allowed, true);
  }));
test("cancel after commit retains saved candidate and rejects subsequent commits", async () =>
  as("owner", async () => {
    const id = randomUUID();
    await start(id);
    await permit(id);
    const saved = await save(id);
    assert.equal(saved.saved, true);
    await permit(id);
    const state = await cancel(id);
    assert.equal(state.saved_count, 1);
    assert.equal((await save(id)).status, "cancelled");
    assert.equal(
      await scalar("select count(*)::int from company_candidates where id=$1", [
        saved.row.id,
      ]),
      1,
    );
  }));
test("finish prevents response-end work and preserves cancelled state", async () =>
  as("owner", async () => {
    const id = randomUUID();
    await start(id);
    await permit(id);
    assert.equal((await finish(id)).status, "finished");
    assert.equal((await save(id)).status, "finished");
    assert.equal((await finish(id)).status, "finished");
    const cancelled = randomUUID();
    await cancel(cancelled);
    assert.equal((await finish(cancelled)).status, "cancelled");
  }));
test("missing run never authorizes or writes; finish does not create one", async () =>
  as("owner", async () => {
    const id = randomUUID();
    assert.equal((await permit(id)).status, "missing");
    assert.equal((await save(id)).status, "missing");
    assert.equal((await finish(id)).status, "missing");
  }));
test("request is capped at five details and two searches even when provider errors use permits", async () =>
  as("owner", async () => {
    const id = randomUUID();
    await start(id);
    for (let i = 0; i < 5; i++) assert.equal((await permit(id)).allowed, true);
    assert.equal((await permit(id)).status, "chunk_limit");
    for (let i = 0; i < 2; i++)
      assert.equal((await permit(id, "search")).allowed, true);
    assert.equal((await permit(id, "search")).status, "chunk_limit");
  }));
test("save requires reserved detail and is capped at five committed attempts", async () =>
  as("owner", async () => {
    const id = randomUUID();
    await start(id);
    assert.equal((await save(id)).status, "chunk_limit");
    for (let i = 0; i < 5; i++) {
      await permit(id);
      assert.equal((await save(id)).saved, true);
    }
    assert.equal((await save(id)).status, "chunk_limit");
    assert.equal((await cancel(id)).saved_count, 5);
  }));
test("DB lease is at most 25 seconds and can use earlier logical cursor expiry", async () =>
  as("owner", async () => {
    const id = randomUUID(),
      deadline = new Date(Date.now() + 5000).toISOString();
    const state = await start(id, undefined, org, deadline);
    assert.equal(
      new Date(state.expires_at).getTime(),
      new Date(deadline).getTime(),
    );
  }));
test("expiry denies provider steps and commits independently of network cancellation", async () => {
  const id = randomUUID();
  await as("owner", async () => {
    await start(id);
    await permit(id);
  });
  await db.query(
    "update private.discovery_scan_runs set expires_at=clock_timestamp()-interval '1 second' where run_id=$1",
    [id],
  );
  await as("owner", async () => {
    assert.equal((await permit(id)).status, "expired");
    assert.equal((await save(id)).status, "expired");
    assert.equal((await start(id)).started, false);
  });
});
test("stale/future/infinite request times and expired cursor are rejected", async () =>
  as("owner", async () => {
    for (const t of [
      new Date(Date.now() - 121000).toISOString(),
      new Date(Date.now() + 31000).toISOString(),
      "infinity",
      "-infinity",
    ])
      await denied(() => start(randomUUID(), t), "22023");
    await denied(
      () =>
        start(
          randomUUID(),
          undefined,
          org,
          new Date(Date.now() - 1000).toISOString(),
        ),
      "22023",
    );
    await denied(() => permit(randomUUID(), "anything"), "22023");
  }));
test("each RPC enforces creator even for another writer in same organization", async () => {
  const id = randomUUID();
  await as("owner", () => start(id));
  await as("sales", async () => {
    for (const fn of [
      () => start(id),
      () => permit(id),
      () => save(id),
      () => cancel(id),
      () => finish(id),
    ])
      await denied(fn);
  });
});
test("all RPCs reject other organization, viewer, revoked session and anonymous user", async () => {
  const id = randomUUID();
  await as("owner", () => start(id));
  for (const user of ["other", "viewer"])
    await as(user, async () => {
      for (const fn of [
        () => start(id),
        () => permit(id),
        () => save(id),
        () => cancel(id),
        () => finish(id),
      ])
        await denied(fn);
    });
  await db.query("delete from auth.sessions where id=$1", [ids.owner]);
  await as("owner", async () => {
    for (const fn of [
      () => start(id),
      () => permit(id),
      () => save(id),
      () => cancel(id),
      () => finish(id),
    ])
      await denied(fn);
  });
  await db.query("insert into auth.sessions values($1,$1,null)", [ids.owner]);
  await db.exec("set role anon");
  try {
    await denied(() => cancel(id));
    await denied(() => start(id));
  } finally {
    await db.exec("reset role");
  }
});
test("admin and sales can start their own work and cancel it", async () => {
  for (const user of ["sales", "admin"])
    await as(user, async () => {
      const id = randomUUID();
      await start(id, new Date(Date.now() + 5).toISOString());
      assert.equal((await cancel(id)).status, "cancelled");
    });
});
test("candidate CAS preserves concurrent manual edits and consumes one commit reservation", async () =>
  as("owner", async () => {
    const id = randomUUID();
    await start(id);
    await permit(id);
    const old = await save(id);
    await scalar(
      "update company_candidates set phone='076-000-1111',website_url='https://manual.test/',employee_number=12,provenance=$2 where id=$1 returning id",
      [
        old.row.id,
        JSON.stringify({ manualOverrides: ["website_url", "employee_number"] }),
      ],
    );
    await permit(id);
    const stale = await save(
      id,
      payload({ corporate_number: old.row.corporate_number }),
      old.row.updated_at,
    );
    assert.equal(stale.saved, false);
    assert.equal(stale.row.phone, "076-000-1111");
    assert.equal(stale.row.website_url, "https://manual.test/");
    assert.equal(stale.row.employee_number, 12);
    assert.equal((await save(id)).status, "chunk_limit");
  }));
test("unseen-candidate insert conflict returns actual current row without overwriting it", async () =>
  as("owner", async () => {
    const id = randomUUID();
    await start(id);
    await permit(id);
    const old = await save(id);
    await permit(id);
    const result = await save(
      id,
      payload({
        corporate_number: old.row.corporate_number,
        name: "上書き不可",
      }),
    );
    assert.equal(result.saved, false);
    assert.equal(result.row.name, old.row.name);
  }));
test("valid CAS keeps phone/manual sources and invalidates enrichment only if website changes", async () =>
  as("owner", async () => {
    const id = randomUUID();
    await start(id);
    await permit(id);
    const old = await save(id);
    const edited = await scalar(
      "update company_candidates set phone='manual-phone',enrichment_status='complete',enrichment_result='{\"fixture\":true}',enrichment_checked_at=now() where id=$1 returning to_jsonb(company_candidates)",
      [old.row.id],
    );
    await permit(id);
    const same = await save(
      id,
      payload({
        corporate_number: old.row.corporate_number,
        provenance: {
          manualOverrides: ["phone"],
          fieldSources: { phone: { source: "手動" } },
        },
      }),
      edited.updated_at,
    );
    assert.equal(same.saved, true);
    assert.equal(same.row.phone, "manual-phone");
    assert.equal(same.row.enrichment_status, "complete");
    await permit(id);
    const changed = await save(
      id,
      payload({
        corporate_number: old.row.corporate_number,
        website_url: "https://changed.test/",
      }),
      same.row.updated_at,
    );
    assert.equal(changed.row.enrichment_status, null);
    assert.equal(changed.row.enrichment_result, null);
    assert.equal(changed.row.enrichment_checked_at, null);
  }));
test("provider payload cannot write organization, identity, phone, CRM or enrichment fields", async () =>
  as("owner", async () => {
    const id = randomUUID();
    await start(id);
    await permit(id);
    for (const field of [
      "organization_id",
      "id",
      "company_id",
      "phone",
      "enrichment_result",
      "enrichment_status",
      "created_at",
      "updated_at",
    ])
      await denied(() => save(id, payload({ [field]: null })), "22023");
    assert.equal((await save(id)).saved, true);
  }));
test("candidate constraints remain enforced and scan saves do not import CRM", async () =>
  as("owner", async () => {
    const before = await scalar("select count(*)::int from companies");
    const id = randomUUID();
    await start(id);
    await permit(id);
    await denied(
      () => save(id, payload({ corporate_number: "not-corporate" })),
      "23514",
    );
    assert.equal((await save(id)).saved, true);
    assert.equal(await scalar("select count(*)::int from companies"), before);
  }));
test("bounded tombstone capacity never evicts fresh cancelled request", async () => {
  const ids64 = Array.from({ length: 64 }, () => randomUUID());
  await as("owner", async () => {
    for (const id of ids64) await cancel(id);
    await denied(() => start(randomUUID()), "P0429");
    await denied(() => cancel(randomUUID()), "P0429");
    assert.equal((await start(ids64[0])).status, "cancelled");
  });
  assert.equal(
    await scalar("select count(*)::int from private.discovery_scan_runs"),
    64,
  );
});
test("cleanup removes only old tombstones and old delayed issued request still cannot revive", async () => {
  const id = randomUUID();
  await as("owner", () => cancel(id));
  await db.query(
    "update private.discovery_scan_runs set retain_until=clock_timestamp()-interval '1 second',issued_at=clock_timestamp()-interval '11 minutes' where run_id=$1",
    [id],
  );
  await as("owner", async () => {
    await start(randomUUID());
    await denied(
      () => start(id, new Date(Date.now() - 660000).toISOString()),
      "22023",
    );
  });
  assert.equal(
    await scalar(
      "select count(*)::int from private.discovery_scan_runs where run_id=$1",
      [id],
    ),
    0,
  );
});

test("unstarted cancellation tombstone cannot poison next valid issuance", async () =>
  as("owner", async () => {
    await cancel(randomUUID());
    const earlier = new Date(Date.now() - 1000).toISOString();
    const state = await start(randomUUID(), earlier);
    assert.equal(state.started, true);
    assert.ok(
      new Date(state.expires_at).getTime() <=
        new Date(earlier).getTime() + 25000,
    );
  }));
test("queued start older than its 25-second lease does not begin", async () =>
  as("owner", async () => {
    await denied(
      () => start(randomUUID(), new Date(Date.now() - 26000).toISOString()),
      "22023",
    );
  }));
