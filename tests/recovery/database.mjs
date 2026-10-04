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
test("all 16 public tables enable RLS", async () => {
  const rows = (
    await db.query(
      "select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'",
    )
  ).rows;
  assert.equal(rows.length, 16);
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
            callback: { title: "bad", assigned_user_id: ids.other },
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
