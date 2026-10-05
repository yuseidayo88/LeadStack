import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
let db, org, otherOrg;
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
async function candidate(extra = {}, target = org) {
  const d = {
    corporate_number: String(++number),
    name: `検証企業${number}`,
    ...extra,
  };
  return scalar(
    "insert into company_candidates(organization_id,corporate_number,name,prefecture_code,prefecture,location,phone,website_url,employee_number,industry_codes,industry_labels,provenance) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id",
    [
      target,
      d.corporate_number,
      d.name,
      d.prefecture_code ?? null,
      d.prefecture ?? null,
      d.location ?? null,
      d.phone ?? null,
      d.website_url ?? null,
      d.employee_number ?? null,
      d.industry_codes ?? [],
      d.industry_labels ?? [],
      JSON.stringify(d.provenance ?? {}),
    ],
  );
}
const preview = (selected, target = org) =>
  scalar("select preview_company_candidates($1,$2)", [target, selected]);
const confirm = (selected, confirmed = false, token = null, target = org) =>
  scalar("select import_company_candidates($1,$2,$3,$4)", [
    target,
    selected,
    confirmed,
    token,
  ]);
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
  otherOrg = await as("other", () =>
    scalar("select create_organization('検索組織B')"),
  );
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

test("discovery tables have RLS, immutable evidence grants and invoker public RPCs", async () => {
  for (const table of [
    "public.company_candidates",
    "public.company_candidate_imports",
    "private.discovery_rate_limits",
    "private.company_candidate_counts",
  ]) {
    assert.equal(
      await scalar(
        "select relrowsecurity from pg_class where oid=$1::regclass",
        [table],
      ),
      true,
    );
    assert.equal(
      await scalar("select has_table_privilege('anon',$1,'SELECT')", [table]),
      false,
    );
  }
  for (const privilege of ["INSERT", "UPDATE", "DELETE"])
    assert.equal(
      await scalar(
        "select has_table_privilege('authenticated','public.company_candidate_imports',$1)",
        [privilege],
      ),
      false,
    );
  for (const signature of [
    "public.preview_company_candidates(uuid,uuid[])",
    "public.import_company_candidates(uuid,uuid[],boolean,text)",
    "public.reserve_company_discovery_request(uuid,text)",
  ])
    assert.equal(
      await scalar("select prosecdef from pg_proc where oid=$1::regprocedure", [
        signature,
      ]),
      false,
    );
});

test("writers can save candidates but discovery alone creates no CRM companies", () =>
  as("sales", async () => {
    const before = await scalar("select count(*)::int from companies");
    const id = await candidate({ name: "保存のみ" });
    assert.equal(await scalar("select count(*)::int from companies"), before);
    assert.equal((await preview([id])).items.length, 1);
    assert.equal(
      await scalar(
        "select enrichment_status from company_candidates where id=$1",
        [id],
      ),
      null,
    );
    assert.equal(await scalar("select count(*)::int from companies"), before);
  }));

test("candidate tenant isolation covers read, write, preview and import", async () => {
  const id = await as("other", () => candidate({}, otherOrg));
  await as("owner", async () => {
    assert.equal(
      await scalar("select count(*)::int from company_candidates where id=$1", [
        id,
      ]),
      0,
    );
    await denied(() => candidate({}, otherOrg));
    assert.equal(
      (
        await db.query(
          "update company_candidates set name='不可' where id=$1 returning id",
          [id],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          "delete from company_candidates where id=$1 returning id",
          [id],
        )
      ).rows.length,
      0,
    );
    await denied(() => preview([id]), "P0002");
    await denied(() => confirm([id]), "P0002");
    await denied(() => confirm([id], false, null, otherOrg));
  });
});

test("viewers can read candidates and evidence but cannot mutate or import", async () => {
  const id = await as("owner", () => candidate());
  await as("viewer", async () => {
    assert.equal(
      await scalar("select count(*)::int from company_candidates where id=$1", [
        id,
      ]),
      1,
    );
    await denied(() => candidate());
    assert.equal(
      (
        await db.query(
          "update company_candidates set name='不可' where id=$1 returning id",
          [id],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          "delete from company_candidates where id=$1 returning id",
          [id],
        )
      ).rows.length,
      0,
    );
    await denied(() => preview([id]));
    await denied(() => confirm([id]));
    await denied(() =>
      db.query("select reserve_company_discovery_request($1,'acquire')", [org]),
    );
  });
});

test("anonymous calls and direct private evidence writes are denied", async () => {
  await db.exec("set role anon");
  try {
    await denied(() => db.query("select * from company_candidates"));
    await denied(() =>
      db.query("select preview_company_candidates($1,'{}')", [org]),
    );
    await denied(() =>
      db.query("select import_company_candidates($1,'{}')", [org]),
    );
    await denied(() =>
      db.query("select reserve_company_discovery_request($1,'acquire')", [org]),
    );
  } finally {
    await db.exec("reset role");
  }
  await as("owner", () =>
    denied(() => db.query("delete from company_candidate_imports")),
  );
});

test("candidate identity, corporate shape and CRM link integrity are enforced", () =>
  as("owner", async () => {
    const id = await candidate();
    const other = await candidate();
    const otherCompany = (await confirm([other])).items[0].company_id;
    await denied(
      () =>
        db.query(
          "update company_candidates set id=gen_random_uuid() where id=$1",
          [id],
        ),
      "23514",
    );
    await denied(() =>
      db.query("update company_candidates set organization_id=$2 where id=$1", [
        id,
        otherOrg,
      ]),
    );
    await denied(
      () =>
        db.query(
          "update company_candidates set corporate_number='1234567890123' where id=$1",
          [id],
        ),
      "23514",
    );
    await denied(
      () =>
        db.query("update company_candidates set company_id=$2 where id=$1", [
          id,
          otherCompany,
        ]),
      "23514",
    );
    await denied(() => candidate({ corporate_number: "bad" }), "23514");
    await denied(() => candidate({ employee_number: -1 }), "23514");
    await denied(
      () => candidate({ website_url: "javascript:alert(1)" }),
      "23514",
    );
  }));

test("1 to 50 unique existing candidate IDs are required", () =>
  as("owner", async () => {
    const id = await candidate();
    for (const selected of [[], [id, id], [null], Array(51).fill(id)])
      await denied(() => confirm(selected), "22023");
    await denied(
      () => confirm(["ffffffff-ffff-4fff-8fff-ffffffffffff"]),
      "P0002",
    );
  }));

test("explicit import maps fields and provenance; retries never duplicate rows", () =>
  as("sales", async () => {
    const id = await candidate({
      name: "完全データ企業",
      prefecture_code: "13",
      prefecture: "東京都",
      location: "東京都千代田区1",
      phone: "03-1234-9876",
      website_url: "https://example.test",
      employee_number: 123,
      industry_codes: ["D"],
      industry_labels: ["建設業"],
      provenance: {
        employee_number: {
          source: "gbiz",
          retrieved_at: "2026-10-05T00:00:00Z",
        },
      },
    });
    const p = await preview([id]);
    const result = await confirm([id], false, p.review_token);
    assert.equal(result.created_count, 1);
    assert.equal(result.existing_count, 0);
    const company = (
      await db.query("select * from companies where id=$1", [
        result.items[0].company_id,
      ])
    ).rows[0];
    assert.equal(company.employee_min, 123);
    assert.equal(company.employee_max, 123);
    assert.equal(company.industry, "建設業");
    assert.equal(company.phone, "03-1234-9876");
    assert.equal(company.prefecture, "東京都");
    assert.equal(company.address, "東京都千代田区1");
    assert.ok(company.source.includes("Gビズインフォ"));
    const replay = await confirm([id], false, p.review_token);
    assert.equal(replay.created_count, 0);
    assert.equal(replay.items[0].company_id, company.id);
    const snapshot = await scalar(
      "select candidate_snapshot from company_candidate_imports where company_id=$1",
      [company.id],
    );
    assert.equal(snapshot.provenance.employee_number.source, "gbiz");
    await db.query(
      "update company_candidates set employee_number=456,provenance='{}' where id=$1",
      [id],
    );
    assert.equal(
      await scalar("select employee_min from companies where id=$1", [
        company.id,
      ]),
      123,
    );
    await db.query("delete from company_candidates where id=$1", [id]);
    assert.equal(
      await scalar(
        "select count(*)::int from company_candidate_imports where company_id=$1",
        [company.id],
      ),
      1,
    );
    assert.equal(
      (
        await scalar(
          "select candidate_snapshot from company_candidate_imports where company_id=$1",
          [company.id],
        )
      ).employee_number,
      123,
    );
  }));

test("unknown fields remain null rather than zero or invented values", () =>
  as("owner", async () => {
    const id = await candidate();
    const imported = (await confirm([id])).items[0].company_id;
    assert.deepEqual(
      (
        await db.query(
          "select phone,website_url,employee_min,employee_max from companies where id=$1",
          [imported],
        )
      ).rows[0],
      {
        phone: null,
        website_url: null,
        employee_min: null,
        employee_max: null,
      },
    );
  }));

test("exact corporate match links existing CRM without overwriting human edits", () =>
  as("owner", async () => {
    const corporate = String(++number);
    const existing = await scalar(
      "insert into companies(organization_id,corporate_number,name,phone) values($1,$2,'手動修正済み','0123456789') returning id",
      [org, corporate],
    );
    const id = await candidate({
      corporate_number: corporate,
      name: "取得名",
      phone: "0399999999",
    });
    assert.equal((await preview([id])).items[0].company_id, existing);
    const result = await confirm([id]);
    assert.equal(result.items[0].company_id, existing);
    assert.equal(result.created_count, 0);
    assert.equal(
      await scalar("select name from companies where id=$1", [existing]),
      "手動修正済み",
    );
    assert.equal(
      await scalar("select phone from companies where id=$1", [existing]),
      "0123456789",
    );
  }));

test("normalized name/phone duplicates require reviewed confirmation; boolean alone fails", () =>
  as("owner", async () => {
    await db.query(
      "insert into companies(organization_id,name,phone) values($1,'株式会社 同名','０３－１１１１－２２２２')",
      [org],
    );
    const id = await candidate({ name: "株式会社同名", phone: "03-1111-2222" });
    const p = await preview([id]);
    assert.equal(p.items[0].duplicates.length, 1);
    await denied(() => confirm([id]), "40001");
    await denied(() => confirm([id], true), "40001");
    await denied(() => confirm([id], false, p.review_token), "40001");
    assert.equal((await confirm([id], true, p.review_token)).created_count, 1);
  }));

test("stale candidate or duplicate review aborts the entire batch", () =>
  as("owner", async () => {
    const first = await candidate({ name: "原子性保護候補" });
    const second = await candidate({ name: "後から重複" });
    const p = await preview([first, second]);
    await db.query(
      "insert into companies(organization_id,name) values($1,'後から重複')",
      [org],
    );
    await denied(() => confirm([first, second], true, p.review_token), "40001");
    assert.equal(
      await scalar(
        "select count(*)::int from companies where name='原子性保護候補'",
      ),
      0,
    );
    const p2 = await preview([first, second]);
    await db.query(
      "update company_candidates set phone='0111111111' where id=$1",
      [first],
    );
    await denied(
      () => confirm([first, second], true, p2.review_token),
      "40001",
    );
  }));

test("import provenance cannot be read by another organization or edited by writers", async () => {
  const evidence = await scalar(
    "select id from company_candidate_imports where organization_id=$1 limit 1",
    [org],
  );
  await as("other", async () =>
    assert.equal(
      await scalar(
        "select count(*)::int from company_candidate_imports where id=$1",
        [evidence],
      ),
      0,
    ),
  );
  await as("owner", () =>
    denied(() =>
      db.query(
        "update company_candidate_imports set candidate_snapshot='{}' where id=$1",
        [evidence],
      ),
    ),
  );
});

test("revoked sessions lose candidates, import and persistent rate limit access", async () => {
  await db.query("delete from auth.sessions where id=$1", [ids.admin]);
  try {
    await as("admin", async () => {
      assert.equal(
        await scalar("select count(*)::int from company_candidates"),
        0,
      );
      await denied(() => candidate());
      await denied(() => preview([]));
      await denied(() => confirm([]));
      await denied(() =>
        db.query("select reserve_company_discovery_request($1,'acquire')", [
          org,
        ]),
      );
    });
  } finally {
    await db.query("insert into auth.sessions values($1,$1,null)", [ids.admin]);
  }
});

test("remote acquisition and enrichment budgets persist by organization", async () => {
  await as("sales", async () => {
    await db.query("select reserve_company_discovery_request($1,'acquire')", [
      org,
    ]);
    assert.equal(
      await scalar("select reserve_company_discovery_request($1,'acquire')", [
        org,
      ]),
      false,
    );
    for (let i = 0; i < 20; i++)
      await db.query("select reserve_company_discovery_request($1,'enrich')", [
        org,
      ]);
    assert.equal(
      await scalar("select reserve_company_discovery_request($1,'enrich')", [
        org,
      ]),
      false,
    );
    await denied(
      () =>
        db.query("select reserve_company_discovery_request($1,'invalid')", [
          org,
        ]),
      "22023",
    );
    await denied(() =>
      db.query("select reserve_company_discovery_request($1,'enrich')", [
        otherOrg,
      ]),
    );
    await denied(() => db.query("select * from private.discovery_rate_limits"));
  });
  await as("admin", async () =>
    assert.equal(
      await scalar("select reserve_company_discovery_request($1,'acquire')", [
        org,
      ]),
      false,
    ),
  );
  await db.query(
    "update private.discovery_rate_limits set expires_at=now()-interval '1 second' where organization_id=$1",
    [org],
  );
  await as("admin", () =>
    db.query("select reserve_company_discovery_request($1,'acquire')", [org]),
  );
  await as("other", () =>
    db.query("select reserve_company_discovery_request($1,'acquire')", [
      otherOrg,
    ]),
  );
});

test("candidate quota caps direct inserts at 5000, allows refresh and releases deleted capacity", () =>
  as("owner", async () => {
    const quotaOrg = await scalar(
      "select create_organization('候補数上限検証')",
    );
    await db.query(
      "insert into company_candidates(organization_id,corporate_number,name) select $1,(8000000000000+i)::text,'上限候補'||i from generate_series(1,5000)i",
      [quotaOrg],
    );
    assert.equal(
      await scalar(
        "select count(*)::int from company_candidates where organization_id=$1",
        [quotaOrg],
      ),
      5000,
    );
    await denied(() => candidate({}, quotaOrg), "P0429");
    await db.query(
      "insert into company_candidates(organization_id,corporate_number,name) values($1,'8000000000001','更新できる') on conflict(organization_id,corporate_number) do update set name=excluded.name",
      [quotaOrg],
    );
    assert.equal(
      await scalar(
        "select name from company_candidates where organization_id=$1 and corporate_number='8000000000001'",
        [quotaOrg],
      ),
      "更新できる",
    );
    await db.query(
      "delete from company_candidates where organization_id=$1 and corporate_number='8000000000001'",
      [quotaOrg],
    );
    await candidate({}, quotaOrg);
    assert.equal(
      await scalar(
        "select count(*)::int from company_candidates where organization_id=$1",
        [quotaOrg],
      ),
      5000,
    );
  }));

test("same-name and same-phone selected candidates require explicit review", () =>
  as("owner", async () => {
    const first = await candidate({ name: "選択内重複企業" });
    const second = await candidate({ name: "選択内 重複企業" });
    const p = await preview([first, second]);
    assert.equal(p.items[0].selected_duplicates.length, 1);
    assert.equal(p.items[0].duplicates.length, 0);
    await denied(() => confirm([first, second]), "40001");
    assert.equal(
      (await confirm([first, second], true, p.review_token)).created_count,
      2,
    );
  }));

test("corrected CRM corporate numbers do not block candidate refresh or rewrite import evidence", () =>
  as("owner", async () => {
    const id = await candidate();
    const oldCompany = (await confirm([id])).items[0].company_id;
    await db.query("update companies set corporate_number=$2 where id=$1", [
      oldCompany,
      String(++number),
    ]);
    await db.query(
      "update company_candidates set phone='0459998888' where id=$1",
      [id],
    );
    assert.equal(
      await scalar("select company_id from company_candidates where id=$1", [
        id,
      ]),
      null,
    );
    assert.equal(
      await scalar(
        "select count(*)::int from company_candidate_imports where company_id=$1",
        [oldCompany],
      ),
      1,
    );
    const p = await preview([id]);
    const newCompany = (await confirm([id], true, p.review_token)).items[0]
      .company_id;
    assert.notEqual(newCompany, oldCompany);
  }));
