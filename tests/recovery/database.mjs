// Recovery verification, newly written; not the original missing DB suite.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
let db;
const ids = Object.fromEntries(
  ["owner", "other", "sales", "viewer", "admin"].map((k, i) => [
    k,
    `00000000-0000-4000-8000-00000000000${i + 1}`,
  ]),
);
let org, otherOrg, company, otherCompany, contact;
async function as(user, fn) {
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    ids[user],
  ]);
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: ids[user], session_id: ids[user] }),
  ]);
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
  for (const [name, id] of Object.entries(ids))
    await db.query(
      "insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,$2,$3,now())",
      [id, `${name}@example.test`, JSON.stringify({ name })],
    );
  for (const id of Object.values(ids))
    await db.query("insert into auth.sessions values($1,$1,null)", [id]);
  org = await as("owner", () =>
    scalar("select public.create_organization('組織A')"),
  );
  otherOrg = await as("other", () =>
    scalar("select public.create_organization('組織B')"),
  );
  for (const role of ["sales", "viewer", "admin"])
    await db.query(
      "insert into public.organization_members values($1,$2,$3,now())",
      [org, ids[role], role],
    );
  company = await as("owner", () =>
    scalar(
      "insert into public.companies(organization_id,name) values($1,'企業A') returning id",
      [org],
    ),
  );
  otherCompany = await as("other", () =>
    scalar(
      "insert into public.companies(organization_id,name) values($1,'企業B') returning id",
      [otherOrg],
    ),
  );
  contact = await as("sales", () =>
    scalar(
      "insert into public.contacts(organization_id,company_id,name) values($1,$2,'担当者') returning id",
      [org, company],
    ),
  );
});
after(async () => {
  await db?.close();
});
test("all 18 public tables enable RLS", async () => {
  const rows = (
    await db.query(
      "select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'",
    )
  ).rows;
  assert.equal(rows.length, 18);
  assert.ok(rows.every((r) => r.relrowsecurity));
});
test("company overview uses invoker security", async () => {
  assert.ok(
    (
      await scalar(
        "select reloptions from pg_class where oid='public.company_overview'::regclass",
      )
    ).includes("security_invoker=true"),
  );
});
test("organization A cannot read B through table or overview", async () =>
  as("owner", async () => {
    for (const table of ["companies", "company_overview"])
      assert.equal(
        await scalar(`select count(*)::int from public.${table} where id=$1`, [
          otherCompany,
        ]),
        0,
      );
  }));
test("cross organization insertion denied", async () =>
  as("sales", () =>
    denied(() =>
      db.query(
        "insert into public.companies(organization_id,name) values($1,'denied')",
        [otherOrg],
      ),
    ),
  ));
test("cross organization update and delete affect zero rows", async () =>
  as("owner", async () => {
    assert.equal(
      (
        await db.query(
          "update public.companies set name='denied' where id=$1 returning id",
          [otherCompany],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          "delete from public.companies where id=$1 returning id",
          [otherCompany],
        )
      ).rows.length,
      0,
    );
  }));
test("viewer can read but cannot insert or update", async () =>
  as("viewer", async () => {
    assert.equal(
      await scalar("select count(*)::int from public.companies where id=$1", [
        company,
      ]),
      1,
    );
    await denied(() =>
      db.query(
        "insert into public.companies(organization_id,name) values($1,'denied')",
        [org],
      ),
    );
    assert.equal(
      (
        await db.query(
          "update public.companies set name='denied' where id=$1 returning id",
          [company],
        )
      ).rows.length,
      0,
    );
  }));
test("anonymous users cannot access customer data or organization RPC", async () => {
  await db.exec("set role anon");
  try {
    await denied(() => db.query("select * from public.companies"));
    await denied(() => db.query("select public.create_organization('denied')"));
  } finally {
    await db.exec("reset role");
  }
});
test("composite foreign keys reject another tenant company", async () =>
  as("sales", () =>
    denied(
      () =>
        db.query(
          "insert into public.contacts(organization_id,company_id,name) values($1,$2,'denied')",
          [org, otherCompany],
        ),
      "23503",
    ),
  ));
test("manual call atomically records call and callback", async () =>
  as("sales", async () => {
    const activity = await scalar("select public.record_activity($1,$2,$3)", [
      org,
      company,
      JSON.stringify({
        type: "call",
        contact_id: contact,
        result: "callback",
        content: "要折返し",
        callback: { title: "折返し", due_at: "2026-10-05T09:00:00+09:00" },
      }),
    ]);
    assert.equal(
      await scalar(
        "select result from public.call_details where activity_id=$1",
        [activity],
      ),
      "callback",
    );
    assert.equal(
      await scalar(
        "select count(*)::int from public.tasks where company_id=$1 and type='callback'",
        [company],
      ),
      1,
    );
  }));
test("invalid callback rolls the whole activity back", async () =>
  as("sales", async () => {
    const before = await scalar("select count(*)::int from public.activities");
    await denied(
      () =>
        db.query("select public.record_activity($1,$2,$3)", [
          org,
          company,
          JSON.stringify({
            type: "call",
            result: "callback",
            callback: {
              title: "bad",
              due_at: "2026-10-05T01:00:00Z",
              assigned_user_id: ids.other,
            },
          }),
        ]),
      "23503",
    );
    assert.equal(
      await scalar("select count(*)::int from public.activities"),
      before,
    );
  }));
test("task completion and deal progression work", async () =>
  as("sales", async () => {
    await db.query(
      "update public.tasks set status='completed' where company_id=$1",
      [company],
    );
    assert.equal(
      await scalar(
        "select count(*)::int from public.tasks where company_id=$1 and status='completed'",
        [company],
      ),
      1,
    );
    const id = await scalar(
      "insert into public.deals(organization_id,company_id,owner_user_id,name) values($1,$2,$3,'提案商談') returning id",
      [org, company, ids.sales],
    );
    await db.query("update public.deals set stage='won' where id=$1", [id]);
    assert.equal(
      await scalar("select stage from public.deals where id=$1", [id]),
      "won",
    );
  }));
test("hearing and build/automate/keep proposals persist without integrations", async () =>
  as("sales", async () => {
    await db.query(
      "insert into public.business_processes(organization_id,company_id,process_type,description) values($1,$2,'billing','手作業')",
      [org, company],
    );
    for (const type of ["build", "automate", "keep"])
      await db.query(
        "insert into public.proposals(organization_id,company_id,type,title) values($1,$2,$3,$3)",
        [org, company, type],
      );
    assert.equal(
      await scalar(
        "select count(*)::int from public.proposals where company_id=$1",
        [company],
      ),
      3,
    );
  }));
test("company status change generates history", async () =>
  as("sales", async () => {
    await db.query(
      "update public.companies set company_status='active' where id=$1",
      [company],
    );
    assert.equal(
      await scalar(
        "select count(*)::int from public.activities where company_id=$1 and type='status_change'",
        [company],
      ),
      1,
    );
  }));
test("last owner cannot be demoted", async () =>
  as("owner", () =>
    denied(
      () =>
        db.query("select public.manage_member($1,$2,'sales')", [
          org,
          ids.owner,
        ]),
      "23514",
    ),
  ));
test("sales cannot invite or promote members", async () =>
  as("sales", async () => {
    await denied(() =>
      db.query("select public.invite_member($1,'new@example.test','viewer')", [
        org,
      ]),
    );
    await denied(() =>
      db.query("select public.manage_member($1,$2,'owner')", [org, ids.sales]),
    );
  }));
test("admin cannot promote self to owner", async () =>
  as("admin", () =>
    denied(() =>
      db.query("select public.manage_member($1,$2,'owner')", [org, ids.admin]),
    ),
  ));
test("member removal reassigns active tasks and deals", async () =>
  as("owner", async () => {
    await db.query("select public.manage_member($1,$2,null)", [org, ids.sales]);
    assert.equal(
      await scalar(
        "select count(*)::int from public.tasks where assigned_user_id=$1",
        [ids.sales],
      ),
      0,
    );
    assert.equal(
      await scalar(
        "select count(*)::int from public.deals where owner_user_id=$1",
        [ids.sales],
      ),
      0,
    );
  }));
test("dashboard denies other organization", async () =>
  as("owner", () =>
    denied(() =>
      db.query(
        "select public.dashboard_counts($1,'2026-10-04T00:00:00Z','2026-10-05T00:00:00Z')",
        [otherOrg],
      ),
    ),
  ));

const csvRows = (name, extra = {}) => [
  { row: 2, data: { name, ...extra }, errors: [] },
];
const previewImport = (rows, target = org) =>
  scalar("select public.preview_company_import($1,$2)", [
    target,
    JSON.stringify(rows),
  ]);
const confirmImport = (id, rows = [2], target = org) =>
  scalar("select public.confirm_company_import($1,$2,$3)", [target, id, rows]);
test("CSV preview does not create companies; confirmation preserves phone and retry is idempotent", () =>
  as("owner", async () => {
    const before = await scalar(
      "select count(*)::int from companies where organization_id=$1",
      [org],
    );
    const p = await previewImport(
      csvRows("CSV新規企業", { phone: "0312345678" }),
    );
    assert.equal(
      await scalar(
        "select count(*)::int from companies where organization_id=$1",
        [org],
      ),
      before,
    );
    const ids = await confirmImport(p.id);
    assert.equal(ids.length, 1);
    assert.equal(
      await scalar("select phone from companies where id=$1", [ids[0]]),
      "0312345678",
    );
    assert.deepEqual(await confirmImport(p.id), ids);
    assert.equal(
      await scalar(
        "select count(*)::int from companies where organization_id=$1",
        [org],
      ),
      before + 1,
    );
  }));
test("CSV duplicates are tenant scoped and file duplicates are shown", () =>
  as("owner", async () => {
    const p = await previewImport([
      {
        row: 2,
        data: { name: " CSV新規企業 ", phone: "03-1234-5678" },
        errors: [],
      },
      { row: 3, data: { name: "CSV新規企業" }, errors: [] },
    ]);
    assert.equal(p.rows[0].duplicates.length, 1);
    assert.deepEqual(p.rows[0].fileDuplicates, [3]);
    const other = await previewImport(csvRows("企業B"));
    assert.equal(other.rows[0].duplicates.length, 0);
  }));
test("CSV preview and confirmation deny viewers and foreign organizations", async () => {
  const p = await as("owner", () => previewImport(csvRows("秘密候補")));
  await as("viewer", () => denied(() => previewImport(csvRows("不可"))));
  await as("viewer", () => denied(() => confirmImport(p.id)));
  await as("other", () => denied(() => confirmImport(p.id)));
  await as("other", () =>
    denied(() => confirmImport(p.id, [2], otherOrg), "P0002"),
  );
  await as("admin", () => denied(() => confirmImport(p.id), "P0002"));
});
test("CSV invalid rows, unknown row selections and expiry cannot be confirmed", () =>
  as("owner", async () => {
    const p = await previewImport([
      { row: 2, data: { name: null }, errors: ["会社名必須"] },
    ]);
    await denied(() => confirmImport(p.id), "22023");
    await denied(() => confirmImport(p.id, [3]), "22023");
    await db.query(
      "update private.company_import_previews set expires_at=now()-interval '1 minute' where id=$1",
      [p.id],
    );
    await denied(() => confirmImport(p.id), "P0002");
  }));
test("CSV rejects a stale duplicate preview and rolls back the full import", () =>
  as("owner", async () => {
    const p = await previewImport([
      { row: 2, data: { name: "原子性確認企業" }, errors: [] },
      { row: 3, data: { name: "競合企業" }, errors: [] },
    ]);
    await db.query(
      "insert into companies(organization_id,name) values($1,$2)",
      [org, "競合企業"],
    );
    await denied(() => confirmImport(p.id, [2, 3]), "40001");
    assert.equal(
      await scalar(
        "select count(*)::int from companies where name='原子性確認企業'",
      ),
      0,
    );
  }));
test("CSV corporate-number conflict rolls back all selected rows", () =>
  as("owner", async () => {
    const p = await previewImport([
      {
        row: 2,
        data: { name: "法人番号A", corporate_number: "1234567890123" },
        errors: [],
      },
      {
        row: 3,
        data: { name: "法人番号B", corporate_number: "1234567890123" },
        errors: [],
      },
    ]);
    await denied(() => confirmImport(p.id, [2, 3]), "23505");
    assert.equal(
      await scalar(
        "select count(*)::int from companies where name='法人番号A'",
      ),
      0,
    );
  }));
test("true last contact ignores internal memos, status changes and unanswered calls", () =>
  as("owner", async () => {
    const c = await scalar(
      "insert into companies(organization_id,name) values($1,'接触日時検証') returning id",
      [org],
    );
    for (const payload of [
      { type: "email", occurred_at: "2026-10-01T00:00:00Z" },
      {
        type: "call",
        result: "connected",
        occurred_at: "2026-10-02T00:00:00Z",
      },
      {
        type: "call",
        result: "no_answer",
        occurred_at: "2026-10-03T00:00:00Z",
      },
      { type: "memo", occurred_at: "2026-10-04T00:00:00Z" },
    ])
      await scalar("select record_activity($1,$2,$3)", [
        org,
        c,
        JSON.stringify(payload),
      ]);
    await db.query("update companies set company_status='active' where id=$1", [
      c,
    ]);
    assert.equal(
      new Date(
        await scalar(
          "select last_contact_at from company_overview where id=$1",
          [c],
        ),
      ).toISOString(),
      "2026-10-02T00:00:00.000Z",
    );
  }));
test("callback result requires callback date at the database boundary", () =>
  as("owner", () =>
    denied(
      () =>
        scalar("select record_activity($1,$2,$3)", [
          org,
          company,
          JSON.stringify({ type: "call", result: "callback" }),
        ]),
      "22023",
    ),
  ));
test("next-company sequence is tenant scoped and returns empty for a foreign company", () =>
  as("owner", async () => {
    assert.deepEqual(
      (await db.query("select * from next_company($1,$2)", [org, otherCompany]))
        .rows,
      [],
    );
    const rows = (
      await db.query("select * from next_company($1,$2)", [org, company])
    ).rows;
    for (const row of rows)
      assert.equal(
        await scalar("select organization_id from companies where id=$1", [
          row.id,
        ]),
        org,
      );
  }));

test("private import preview rows retain RLS and new RPCs deny anonymous execution", async () => {
  assert.equal(
    await scalar(
      "select relrowsecurity from pg_class where oid='private.company_import_previews'::regclass",
    ),
    true,
  );
  const p = await as("owner", () => previewImport(csvRows("非公開プレビュー")));
  await as("admin", async () =>
    assert.equal(
      await scalar(
        "select count(*)::int from private.company_import_previews where id=$1",
        [p.id],
      ),
      0,
    ),
  );
  await db.exec("set role anon");
  try {
    await denied(() => previewImport(csvRows("不可")));
    await denied(() => confirmImport(p.id));
    await denied(() =>
      db.query("select * from next_company($1,$2)", [org, company]),
    );
  } finally {
    await db.exec("reset role");
  }
});

test("revoked or missing sessions lose table/view/private-preview and definer RPC access", async () => {
  await db.query("delete from auth.sessions where id=$1", [ids.owner]);
  try {
    await as("owner", async () => {
      for (const t of [
        "companies",
        "company_overview",
        "company_search",
        "contact_search",
        "profiles",
        "improvement_types",
        "organization_members",
        "private.company_import_previews",
      ])
        assert.equal(await scalar(`select count(*)::int from ${t}`), 0);
      await denied(() => scalar("select create_organization('revoked')"));
      await denied(() => previewImport(csvRows("revoked")));
      assert.equal(
        (await db.query("select * from my_invitations()")).rows.length,
        0,
      );
    });
  } finally {
    await db.query("insert into auth.sessions values($1,$1,null)", [ids.owner]);
  }
  await as("owner", async () => {
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: ids.owner }),
    ]);
    assert.equal(await scalar("select count(*)::int from companies"), 0);
  });
});
test("activity retry returns one activity and one callback, conflicting retry fails", () =>
  as("owner", async () => {
    const body = {
      request_id: "00000000-0000-4000-8000-000000001234",
      type: "call",
      result: "callback",
      callback: { title: "retry", due_at: "2026-10-06T01:00:00Z" },
    };
    const run = (b) =>
      scalar("select record_activity($1,$2,$3)", [
        org,
        company,
        JSON.stringify(b),
      ]);
    const id = await run(body);
    assert.equal(await run(body), id);
    assert.equal(
      await scalar("select count(*)::int from tasks where title='retry'"),
      1,
    );
    await denied(() => run({ ...body, title: "changed" }), "40001");
  }));
test("auth throttle persists denied attempts and applies canonical subject budgets", async () => {
  await db.exec("set role anon");
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        await scalar("select allow_auth_attempt('login',$1)", ["a".repeat(64)]),
        true,
      );
    assert.equal(
      await scalar("select allow_auth_attempt('login',$1)", ["a".repeat(64)]),
      false,
    );
    await denied(() =>
      scalar("select count(*)::int from private.auth_attempts"),
    );
  } finally {
    await db.exec("reset role");
  }
  await db.exec(
    "update private.auth_attempts set expires_at=now()-interval '1 second'",
  );
  assert.equal(
    await scalar("select allow_auth_attempt('login',$1)", ["a".repeat(64)]),
    true,
  );
});
test("CSV direct RPC frequency guard is enforced", () =>
  as("owner", async () => {
    await db.exec("reset role");
    await db.exec("delete from private.operation_limits");
    await db.exec("set role authenticated");
    for (let i = 0; i < 20; i++) await previewImport(csvRows("limit-" + i));
    await denied(() => previewImport(csvRows("too-many")), "P0429");
  }));

test("search projections normalize fullwidth phones while preserving original values", async () => {
  await db.query("update companies set phone=$1 where id=$2", [
    "０３（１２３４）－５６７８",
    company,
  ]);
  await db.query("update contacts set phone=$1 where id=$2", [
    "０９０－１２３４－５６７８",
    contact,
  ]);
  await as("owner", async () => {
    assert.equal(
      await scalar("select search_phone from company_search where id=$1", [
        company,
      ]),
      "0312345678",
    );
    assert.equal(
      await scalar("select phone from company_search where id=$1", [company]),
      "０３（１２３４）－５６７８",
    );
    assert.equal(
      await scalar("select search_phone from contact_search where id=$1", [
        contact,
      ]),
      "09012345678",
    );
  });
});
test("search views use invoker security, deny anonymous access and have SELECT-only authenticated grants", async () => {
  for (const view of ["company_search", "contact_search"]) {
    assert.ok(
      (
        await scalar("select reloptions from pg_class where oid=$1::regclass", [
          view,
        ])
      ).includes("security_invoker=true"),
    );
    assert.equal(
      await scalar("select has_table_privilege('anon',$1,'SELECT')", [view]),
      false,
    );
    for (const operation of ["INSERT", "UPDATE", "DELETE"])
      assert.equal(
        await scalar("select has_table_privilege('authenticated',$1,$2)", [
          view,
          operation,
        ]),
        false,
      );
  }
  await as("other", async () => {
    assert.equal(
      await scalar("select count(*)::int from company_search where id=$1", [
        company,
      ]),
      0,
    );
    assert.equal(
      await scalar("select count(*)::int from contact_search where id=$1", [
        contact,
      ]),
      0,
    );
  });
  await as("viewer", async () => {
    assert.equal(
      await scalar("select count(*)::int from company_search where id=$1", [
        company,
      ]),
      1,
    );
    assert.equal(
      await scalar("select count(*)::int from contact_search where id=$1", [
        contact,
      ]),
      1,
    );
  });
});
