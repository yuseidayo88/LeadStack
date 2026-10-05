// Acceptance extension: run after authenticated-e2e in the disposable local fixture.
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const base = process.env.E2E_BASE_URL || "http://localhost:3005";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const users = JSON.parse(await readFile(process.env.E2E_USERS_FILE, "utf8"));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.setDefaultTimeout(15000);
const checks = [];
const log = (s) => {
  checks.push(s);
  console.log("PASS: " + s);
};
async function req(path, method = "GET", data, context = ctx) {
  const r = await context.request.fetch(base + path, {
    method,
    data,
    headers: { origin: base },
  });
  return {
    status: r.status(),
    body: r.status() === 204 ? null : await r.json(),
  };
}
async function ok(path, method = "GET", data, context = ctx) {
  const r = await req(path, method, data, context);
  assert.ok(
    r.status >= 200 && r.status < 300,
    `${method} ${path}: ${r.status} ${r.body?.error?.code}`,
  );
  return r.body;
}
function sql(q) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "leadstack-e2e-db",
      "psql",
      "-h",
      "/tmp",
      "-p",
      "5432",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: q, encoding: "utf8" },
  ).trim();
}
function norm(x) {
  if (Array.isArray(x)) return x.map(norm);
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, norm(v)]),
    );
  if (
    typeof x === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:/.test(x) &&
    Number.isFinite(Date.parse(x))
  )
    return new Date(x).toISOString();
  return x;
}
const tables = [
  "companies",
  "contacts",
  "activities",
  "tasks",
  "deals",
  "business_processes",
  "company_tools",
  "pain_points",
  "proposals",
];
try {
  await ok("/api/auth/login", "POST", {
    email: users.owner.email,
    password: users.owner.password,
  });
  const org = (await ok("/api/organizations")).data.find((o) =>
      o.name.startsWith("E2E組織-"),
    ).id,
    root = "/api/organizations/" + org;
  const company = (await ok(root + "/companies")).data.find((c) =>
    c.name.startsWith("E2E企業-"),
  );
  assert.ok(company);
  if (
    !(await ok(root + "/members")).data.some(
      (m) => m.user_id === users.viewer.id,
    )
  ) {
    await ok(root + "/members", "POST", {
      action: "invite",
      email: users.viewer.email,
      role: "viewer",
    });
    const joinCtx = await browser.newContext();
    await ok(
      "/api/auth/login",
      "POST",
      { email: users.viewer.email, password: users.viewer.password },
      joinCtx,
    );
    const inv = (
      await ok("/api/invitations", "GET", undefined, joinCtx)
    ).data.find((i) => i.organization_name.startsWith("E2E組織-"));
    await ok("/api/invitations", "POST", { invitation_id: inv.id }, joinCtx);
    await joinCtx.close();
  }

  assert.match(org, /^[a-f0-9-]{36}$/);
  async function snapshot() {
    const snap = {};
    for (const table of tables) {
      const suffix = table === "activities" ? "&company_id=" + company.id : "";
      const data =
        table === "activities"
          ? (
              await Promise.all(
                (await ok(root + "/companies?pageSize=100")).data.map((c) =>
                  ok(root + "/activities?pageSize=100&company_id=" + c.id),
                ),
              )
            ).flatMap((r) => r.data)
          : (await ok(root + "/" + table + "?pageSize=100" + suffix)).data;
      const rows = JSON.parse(
        sql(
          `select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.${table} t where organization_id='${org}'`,
        ),
      );
      assert.equal(data.length, rows.length, table + " count");
      for (const row of rows) {
        const a = data.find((r) => r.id === row.id);
        assert.ok(a, table + " missing API row");
        for (const [k, v] of Object.entries(row))
          assert.deepEqual(norm(a[k]), norm(v), table + "." + k);
      }
      snap[table] = norm(rows);
    }
    const calls = JSON.parse(
      sql(
        `select coalesce(jsonb_agg(to_jsonb(c) order by activity_id),'[]') from call_details c join activities a on a.id=c.activity_id where a.organization_id='${org}'`,
      ),
    );
    const acts = (
      await Promise.all(
        (await ok(root + "/companies?pageSize=100")).data.map((c) =>
          ok(root + "/activities?pageSize=100&company_id=" + c.id),
        ),
      )
    ).flatMap((r) => r.data);
    for (const c of calls)
      assert.deepEqual(
        norm(acts.find((a) => a.id === c.activity_id).call_details),
        norm(c),
      );
    snap.call_details = norm(calls);
    const members = (await ok(root + "/members")).data;
    const dbmembers = JSON.parse(
      sql(
        `select jsonb_agg(to_jsonb(m) order by user_id) from organization_members m where organization_id='${org}'`,
      ),
    );
    for (const row of dbmembers) {
      const m = members.find((v) => v.user_id === row.user_id);
      for (const [k, v] of Object.entries(row))
        assert.deepEqual(norm(m[k]), norm(v));
    }
    snap.members = norm(dbmembers);
    return snap;
  }
  const editTarget = (await ok(root + "/contacts")).data.find(
    (c) => c.name === "検証担当者",
  );
  await ok(root + "/contacts/" + editTarget.id, "PATCH", {
    notes: "以前のメモ",
    email: "local-acceptance@example.test",
  });
  await page.goto(base + "/companies/" + company.id);
  await page
    .getByRole("button", { name: "検証担当者を編集", exact: true })
    .click();
  const d = page.getByRole("dialog");
  const longText = "日本語の保存確認・見積と請求\n空行も保持\n\n"
    .repeat(180)
    .trim();
  await d.getByLabel("メモ", { exact: true }).fill(longText);
  await d.getByLabel("メールアドレス", { exact: true }).fill("");
  const beforeContact = (await ok(root + "/contacts")).data.find(
    (c) => c.name === "検証担当者",
  );
  let failures = 0;
  await page.route("**" + root + "/contacts/*", async (route) => {
    if (route.request().method() === "PATCH" && failures++ === 0)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "fixture_failure", message: "一時的に保存できません" },
        }),
      });
    return route.continue();
  });
  await d.getByRole("button", { name: "保存", exact: true }).click();
  await expect(d.getByRole("alert")).toContainText("一時的");
  await expect(d.getByLabel("メモ", { exact: true })).toHaveValue(longText);
  assert.equal(
    (await ok(root + "/contacts/" + beforeContact.id)).data.notes,
    beforeContact.notes,
  );
  await d.getByRole("button", { name: "保存", exact: true }).click();
  await expect(d).not.toBeVisible();
  await page.unroute("**" + root + "/contacts/*");
  const changed = (await ok(root + "/contacts/" + beforeContact.id)).data;
  assert.equal(changed.notes, longText);
  assert.equal(changed.email, null);
  log(
    "UI long Japanese/newlines and empty→null edit survives rejected response/retry; existing DB unchanged on failure",
  );
  // Preserve the exact business rows across browser reload and a new authenticated session.
  const before = await snapshot();
  await page.reload();
  await expect(page.getByText(longText, { exact: true })).toBeVisible();
  await ok("/api/auth/logout", "POST", {});
  assert.equal((await req(root + "/companies")).status, 401);
  await page.goto(base + "/login");
  await page
    .getByLabel("メールアドレス", { exact: true })
    .fill(users.owner.email);
  await page.locator("input[name=password]").fill(users.owner.password);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page.waitForURL("**/dashboard");
  await page.goto(base + "/companies/" + company.id);
  await expect(page.getByText(longText, { exact: true })).toBeVisible();
  for (const [tab, table, key] of [
    ["営業活動", "activities", "content"],
    ["商談", "deals", "name"],
    ["業務ヒアリング", "business_processes", "description"],
    ["改善提案", "proposals", "title"],
  ]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    const value = before[table].find(
      (r) => r.company_id === company.id && r[key],
    )?.[key];
    assert.ok(value);
    await expect(page.getByText(value, { exact: true }).first()).toBeVisible();
  }
  assert.deepEqual(await snapshot(), before);
  log(
    "9 CRM tables + call details + membership match DB field-for-field after reload and logout/UI login/re-display",
  );
  // A callback FK failure must roll back the activity and call detail too.
  const counts = () =>
    sql(
      `select (select count(*) from activities where organization_id='${org}')||','||(select count(*) from call_details c join activities a on a.id=c.activity_id where a.organization_id='${org}')||','||(select count(*) from tasks where organization_id='${org}')`,
    );
  const countBefore = counts();
  for (const bad of [
    { duration_seconds: -1 },
    { occurred_at: "not-a-date" },
    { started_at: "2026-10-07T02:00:00Z", ended_at: "2026-10-07T01:00:00Z" },
    { title: "長".repeat(301) },
  ]) {
    assert.equal(
      (
        await req(root + "/activities", "POST", {
          company_id: company.id,
          type: "call",
          ...bad,
        })
      ).status,
      422,
    );
    assert.equal(counts(), countBefore);
  }
  log(
    "Negative duration, invalid datetime, end-before-start and overlong title rejected without changing rows",
  );

  assert.equal(
    (
      await req(root + "/activities", "POST", {
        company_id: company.id,
        type: "call",
        result: "callback",
        callback: {
          title: "失敗する折返し",
          due_at: "2026-10-07T01:00:00Z",
          assigned_user_id: users.other.id,
        },
      })
    ).status,
    422,
  );
  assert.equal(counts(), countBefore);
  log(
    "Real API callback foreign-key failure leaves no partial activity, call or task rows",
  );
  // Actual CSV preview and concurrent confirmation; no customer data or outbound email.
  const total = () =>
    Number(
      sql(`select count(*) from companies where organization_id='${org}'`),
    );
  const start = total();
  const preview = await ok(root + "/company-import", "POST", {
    action: "preview",
    csv: '会社名,電話番号,事業内容\n受入CSV,0312345678,"日本語\n二行目"\n,0999,不正行',
  });
  assert.equal(total(), start);
  assert.equal(
    (
      await req(root + "/company-import", "POST", {
        action: "confirm",
        id: preview.id,
        rows: [2, 3],
        confirmed: true,
      })
    ).status,
    422,
  );
  assert.equal(total(), start);
  const body = {
    action: "confirm",
    id: preview.id,
    rows: [2],
    confirmed: true,
  };
  const race = await Promise.all([
    ok(root + "/company-import", "POST", body),
    ok(root + "/company-import", "POST", body),
  ]);
  assert.deepEqual(race[0].ids, race[1].ids);
  assert.equal(total(), start + 1);
  const row = (await ok(root + "/companies/" + race[0].ids[0])).data;
  assert.equal(row.phone, "0312345678");
  assert.equal(row.business_description, "日本語\n二行目");
  assert.equal(
    sql(
      `select count(*) from companies where id='${row.id}' and phone='0312345678'`,
    ),
    "1",
  );
  assert.equal(
    (await req(root + "/company-import", "POST", { ...body, csv: "tamper" }))
      .status,
    422,
  );
  const edited = await ok(root + "/company-import", "POST", {
    action: "preview",
    csv: "会社名,電話番号\n受入CSV修正,03-1234-5678",
  });
  assert.notEqual(edited.id, preview.id);
  assert.ok(edited.rows[0].duplicates.some((v) => v.id === row.id));
  sql(
    `update private.company_import_previews set expires_at=now()-interval '1 second' where id='${edited.id}'`,
  );
  assert.equal(
    (
      await req(root + "/company-import", "POST", {
        action: "confirm",
        id: edited.id,
        rows: [2],
        confirmed: true,
      })
    ).status,
    410,
  );
  assert.equal(total(), start + 1);
  const stale = await ok(root + "/company-import", "POST", {
    action: "preview",
    csv: "会社名\n巻戻し確認\n候補変更",
  });
  await ok(root + "/companies", "POST", { name: "候補変更" });
  const c = total();
  assert.equal(
    (
      await req(root + "/company-import", "POST", {
        action: "confirm",
        id: stale.id,
        rows: [2, 3],
        confirmed: true,
      })
    ).status,
    409,
  );
  assert.equal(total(), c);
  assert.equal(
    sql(
      `select count(*) from companies where organization_id='${org}' and name='巻戻し確認'`,
    ),
    "0",
  );
  log(
    "CSV DB counts/values: preview read-only, invalid-row atomic failure, concurrent confirm once, immutable input, edited preview, phone duplicate, expiry and stale-preview rollback",
  );
  // Owner changes viewer to sales in the real settings UI, then removes the member.
  await page.goto(base + "/settings");
  await page
    .getByRole("button", { name: "E2E viewer権限を変更", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .locator("select[name=role]")
    .selectOption("sales");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "権限を変更", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  assert.equal(
    sql(
      `select role from organization_members where organization_id='${org}' and user_id='${users.viewer.id}'`,
    ),
    "sales",
  );
  const memberCtx = await browser.newContext();
  await ok(
    "/api/auth/login",
    "POST",
    { email: users.viewer.email, password: users.viewer.password },
    memberCtx,
  );
  assert.equal(
    (
      await req(
        root + "/members",
        "POST",
        { action: "role", user_id: users.viewer.id, role: "owner" },
        memberCtx,
      )
    ).status,
    403,
  );
  const task = (
    await ok(
      root + "/tasks",
      "POST",
      {
        company_id: company.id,
        assigned_user_id: users.viewer.id,
        type: "follow_up",
        title: "引継ぎタスク",
      },
      memberCtx,
    )
  ).data;
  const deal = (
    await ok(
      root + "/deals",
      "POST",
      {
        company_id: company.id,
        owner_user_id: users.viewer.id,
        name: "引継ぎ商談",
      },
      memberCtx,
    )
  ).data;
  await page
    .getByRole("button", { name: "E2E viewerメンバーを削除", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "削除する", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  assert.equal(
    (await req(root + "/companies", "GET", undefined, memberCtx)).status,
    403,
  );
  assert.equal(
    (await ok(root + "/tasks/" + task.id)).data.assigned_user_id,
    users.owner.id,
  );
  assert.equal(
    (await ok(root + "/deals/" + deal.id)).data.owner_user_id,
    users.owner.id,
  );
  await memberCtx.close();
  assert.equal(
    (
      await req(root + "/members", "POST", {
        action: "remove",
        user_id: users.owner.id,
      })
    ).status,
    422,
  );
  log(
    "Member role UI persists; sales cannot escalate; removal revokes access and reassigns active work; last owner protected",
  );
  await ok(root + "/companies/" + company.id, "PATCH", {
    company_status: "closed",
  });
  assert.ok(
    (await ok(root + "/companies?company_status=closed")).data.some(
      (r) => r.id === company.id,
    ),
  );
  assert.equal(
    (await ok(root + "/contacts?company_id=" + company.id)).count,
    before.contacts.filter((c) => c.company_id === company.id).length,
  );
  log(
    "Closed company status preserves related records (not a separate archive system)",
  );
  await mkdir("/workspace/handoff/acceptance", { recursive: true });
  await writeFile(
    "/workspace/handoff/acceptance/persistence.json",
    JSON.stringify(
      {
        source: "1f862d4",
        org,
        checks,
        matchedCounts: Object.fromEntries(
          Object.entries(before).map(([k, v]) => [k, v.length]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
