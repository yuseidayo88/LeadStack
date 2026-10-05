import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
for (const version of ["published", "improvements"])
  test(version + " account and privilege boundaries", async () => {
    const db = new PGlite();
    const user = {
      owner: "00000000-0000-4000-8000-000000000001",
      other: "00000000-0000-4000-8000-000000000002",
      admin: "00000000-0000-4000-8000-000000000003",
      pending: "00000000-0000-4000-8000-000000000004",
    };
    const scalar = async (sql, p = []) =>
      Object.values((await db.query(sql, p)).rows[0])[0];
    async function as(id, fn) {
      await db.exec("set role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        id,
      ]);
      try {
        return await fn();
      } finally {
        await db.exec("reset role");
      }
    }
    const denied = async (fn) => assert.rejects(fn, (e) => e.code === "42501");
    try {
      await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;grant usage on schema public,auth to authenticated,anon;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
      const files = (await readdir("supabase/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of version === "published" ? files.slice(0, 4) : files)
        await db.exec(await readFile("supabase/migrations/" + f, "utf8"));
      for (const [name, id] of Object.entries(user))
        await db.query("insert into auth.users values($1,$2,$3,$4)", [
          id,
          name + "@example.test",
          JSON.stringify({ name, role: "owner" }),
          name === "pending" ? null : "2026-01-01T00:00:00Z",
        ]);
      const org = await as(user.owner, () =>
        scalar("select create_organization('A')"),
      );
      const otherOrg = await as(user.other, () =>
        scalar("select create_organization('B')"),
      );
      await db.query(
        "insert into organization_members(organization_id,user_id,role) values($1,$2,'admin')",
        [org, user.admin],
      );
      const company = await as(user.owner, () =>
        scalar(
          "insert into companies(organization_id,name) values($1,'A') returning id",
          [org],
        ),
      );
      await as(user.admin, async () => {
        await db.query("select set_config('request.jwt.claims',$1,false)", [
          JSON.stringify({
            sub: user.admin,
            user_metadata: { role: "owner", organization_id: org },
          }),
        ]);
        await denied(() =>
          scalar("select manage_member($1,$2,'owner')", [org, user.admin]),
        );
        await denied(() =>
          scalar("select invite_member($1,'fake@example.test','admin')", [org]),
        );
        await denied(() =>
          db.query(
            "update organization_members set role='owner' where user_id=$1",
            [user.admin],
          ),
        );
        await denied(() =>
          db.query(
            "insert into activities(organization_id,company_id,user_id,type) values($1,$2,$3,'memo')",
            [org, company, user.owner],
          ),
        );
        await denied(() =>
          db.query(
            "update profiles set email='hijack@example.test' where id=$1",
            [user.admin],
          ),
        );
        assert.equal(
          (
            await db.query(
              "update profiles set name='hijack' where id=$1 returning id",
              [user.owner],
            )
          ).rows.length,
          0,
        );
      });
      const invite = await as(user.owner, () =>
        scalar("select invite_member($1,'PENDING@example.test','sales')", [
          org,
        ]),
      );
      await as(user.pending, () =>
        denied(() => scalar("select accept_invitation($1)", [invite])),
      );
      await as(user.other, () =>
        denied(() => scalar("select accept_invitation($1)", [invite])),
      );
      await db.query(
        "update auth.users set email_confirmed_at=now() where id=$1",
        [user.pending],
      );
      assert.equal(
        await as(user.pending, () =>
          scalar("select accept_invitation($1)", [invite]),
        ),
        org,
      );
      await as(user.pending, () =>
        denied(() => scalar("select accept_invitation($1)", [invite])),
      );
      await as(user.owner, () =>
        scalar("select manage_member($1,$2,null)", [org, user.pending]),
      );
      await as(user.pending, async () => {
        assert.equal(
          await scalar("select count(*)::int from companies where id=$1", [
            company,
          ]),
          0,
        );
        await denied(() =>
          db.query(
            "insert into companies(organization_id,name) values($1,'denied')",
            [org],
          ),
        );
      });
      await as(user.owner, async () => {
        assert.equal(
          await scalar(
            "select count(*)::int from organization_members where organization_id=$1",
            [otherOrg],
          ),
          0,
        );
        await denied(() =>
          scalar("select invite_member($1,'test@example.test','sales')", [
            otherOrg,
          ]),
        );
      });
      assert.equal(
        await scalar(
          "select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon',p.oid,'EXECUTE')",
        ),
        0,
      );
    } finally {
      await db.close();
    }
  });
