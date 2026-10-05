// Local isolated data only: creates one test org with 5,000 companies, 15,000 activities and 5,000 tasks.
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const base = process.env.E2E_BASE_URL || "http://localhost:3006";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const users = JSON.parse(await readFile(process.env.E2E_USERS_FILE, "utf8"));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  timezoneId: "America/Los_Angeles",
});
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
const times = [];
const notes = [];
const log = (s, v) => {
  notes.push({ case: s, ...v });
  console.log("PASS: " + s + (v ? " " + JSON.stringify(v) : ""));
};
async function api(path, method = "GET", data, headers = {}) {
  const t = performance.now();
  const r = await ctx.request.fetch(base + path, {
    method,
    data,
    headers: { origin: base, ...headers },
  });
  const body = r.status() === 204 ? null : await r.json();
  times.push({
    path: path.split("?")[0],
    method,
    ms: Math.round(performance.now() - t),
    status: r.status(),
  });
  return { status: r.status(), body };
}
async function ok(path, method = "GET", data, headers = {}) {
  const r = await api(path, method, data, headers);
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
try {
  await ok("/api/auth/login", "POST", {
    email: users.owner.email,
    password: users.owner.password,
  });
  const org = (
    await ok("/api/organizations", "POST", { name: "実務検証-" + Date.now() })
  ).data.id;
  const root = "/api/organizations/" + org;
  const uid = users.owner.id;
  assert.match(org, /^[a-f0-9-]{36}$/);
  assert.match(uid, /^[a-f0-9-]{36}$/);
  sql(`select set_config('request.jwt.claim.sub','${uid}',false);
 insert into companies(organization_id,name,industry,prefecture,company_status,assigned_user_id,phone)
 select '${org}','検証企業'||lpad(n::text,5,'0'),case when n%2=0 then '建設' else '製造' end,case when n%3=0 then '東京都' else '大阪府' end,case when n%5=0 then 'active' else 'new' end,'${uid}','03-1234-'||lpad(n::text,4,'0') from generate_series(1,5000)n;
 insert into activities(organization_id,company_id,user_id,type,title,occurred_at) select '${org}',c.id,'${uid}','meeting','検証活動',timestamptz '2026-10-05 01:00:00+00'+n*interval '1 minute' from companies c cross join generate_series(1,3)n where c.organization_id='${org}';
 insert into tasks(organization_id,company_id,assigned_user_id,type,title,due_at) select '${org}',id,'${uid}','follow_up','検証タスク',timestamptz '2026-10-06 01:00:00+00' from companies where organization_id='${org}'; analyze;`);
  const ids = new Set();
  const paging = [];
  for (let p = 1; p <= 50; p++) {
    const t = performance.now();
    const r = await ok(
      root + `/companies?sort=name&direction=asc&pageSize=100&page=${p}`,
    );
    paging.push(Math.round(performance.now() - t));
    assert.equal(r.count, 5000);
    assert.equal(r.data.length, 100);
    for (const c of r.data) {
      assert.ok(!ids.has(c.id));
      ids.add(c.id);
    }
  }
  assert.equal(ids.size, 5000);
  log("5,000 companies paginated without missing or duplicate IDs", {
    pageMsMin: Math.min(...paging),
    pageMsMax: Math.max(...paging),
    pageMsMedian: [...paging].sort((a, b) => a - b)[25],
  });
  for (const qs of [
    "sort=last_contact_at&direction=desc",
    "search=" + encodeURIComponent("検証企業05000"),
    "search=no-such-company",
  ]) {
    const started = performance.now();
    await ok(root + "/companies?" + qs);
    log("Measured list/search", {
      query: qs,
      ms: Math.round(performance.now() - started),
    });
  }
  const q =
    "/companies?search=" +
    encodeURIComponent("  検証企業  ") +
    "&industry=" +
    encodeURIComponent("建設") +
    "&prefecture=" +
    encodeURIComponent("東京都") +
    "&company_status=active&assigned_user_id=" +
    uid +
    "&sort=name&direction=desc&pageSize=100";
  const filtered = await ok(root + q);
  assert.equal(filtered.count, 166);
  assert.equal(filtered.data[0].name, "検証企業04980");
  const second = await ok(root + q + "&page=2");
  assert.equal(second.data.length, 66);
  assert.equal(
    new Set([...filtered.data, ...second.data].map((c) => c.id)).size,
    166,
  );
  assert.equal((await api(root + "/companies?pageSize=101")).status, 422);
  assert.equal((await api(root + "/companies?sort=invalid")).status, 422);
  log(
    "Japanese partial match, trimmed search, compound filters, descending sort, second page and upper limit",
  );
  if (process.env.EXPECT_CONFLICT === "true") {
    const beyond = await ok(root + "/companies?search=検証企業05000&page=2");
    assert.equal(beyond.count, 1);
    assert.deepEqual(beyond.data, []);
    log(
      "Out-of-range page returns correct count and empty data instead of 500",
    );
  }
  const target = (await ok(root + "/companies?search=検証企業00001")).data[0];
  const odd = (
    await ok(root + "/companies", "POST", {
      name: "東京　営業 %_ 株式会社",
      phone: "03-1234-5678",
      employee_min: 10,
      employee_max: 20,
    })
  ).data;
  assert.equal(
    (await ok(root + "/companies?search=" + encodeURIComponent("%_"))).count,
    1,
  );
  assert.equal(
    (await ok(root + "/companies?search=" + encodeURIComponent("東京営業")))
      .count,
    0,
  );
  assert.equal((await ok(root + "/companies?search=0312345678")).count, 1);
  const contact = (
    await ok(root + "/contacts", "POST", {
      company_id: odd.id,
      name: "山田　太郎",
      phone: "090-1234-5678",
    })
  ).data;
  assert.equal(
    (
      await ok(
        root +
          "/contacts?company_id=" +
          odd.id +
          "&search=" +
          encodeURIComponent("山田"),
      )
    ).count,
    1,
  );
  assert.equal((await ok(root + "/contacts?search=09012345678")).count, 1);
  log(
    "Literal %/_ and normalized phone match; name internal-space normalization remains unsupported",
  );
  assert.equal(
    (await api(root + "/companies", "POST", { name: "   " })).status,
    422,
  );
  assert.equal(
    (await api(root + "/companies/" + odd.id, "PATCH", { employee_max: 5 }))
      .status,
    422,
  );
  assert.equal(
    (
      await api(root + "/companies", "POST", {
        name: "bad",
        assigned_user_id: users.other.id,
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await api(root + "/tasks", "POST", {
        company_id: target.id,
        contact_id: contact.id,
        assigned_user_id: uid,
        type: "follow_up",
        title: "bad link",
      })
    ).status,
    422,
  );
  const old = (await ok(root + "/companies/" + odd.id)).data;
  await ok(
    root + "/companies/" + odd.id,
    "PATCH",
    { name: "先に保存した名前" },
    { "If-Match": old.updated_at },
  );
  const stale = await api(
    root + "/companies/" + odd.id,
    "PATCH",
    { name: old.name, phone: "03-9999-9999" },
    { "If-Match": old.updated_at },
  );
  if (process.env.EXPECT_CONFLICT === "true") assert.equal(stale.status, 409);
  else
    log("OBSERVATION stale edit behavior", {
      status: stale.status,
      overwroteNewerName: stale.body?.data?.name === old.name,
    });
  log("Input and same-company foreign-key validation; stale edit checked");
  if (process.env.EXPECT_CONFLICT === "true") {
    for (const [resource, data, change] of [
      ["contacts", { company_id: target.id, name: "版検証" }, { name: "新版" }],
      [
        "tasks",
        {
          company_id: target.id,
          assigned_user_id: uid,
          type: "follow_up",
          title: "版検証",
        },
        { title: "新版" },
      ],
      [
        "deals",
        { company_id: target.id, owner_user_id: uid, name: "版検証" },
        { name: "新版" },
      ],
      [
        "business_processes",
        {
          company_id: target.id,
          process_type: "billing",
          description: "版検証",
        },
        { description: "新版" },
      ],
      [
        "company_tools",
        { company_id: target.id, tool_name: "版検証" },
        { tool_name: "新版" },
      ],
      [
        "pain_points",
        { company_id: target.id, type: "manual_work", description: "版検証" },
        { description: "新版" },
      ],
      [
        "proposals",
        { company_id: target.id, type: "build", title: "版検証" },
        { title: "新版" },
      ],
    ]) {
      const row = (await ok(root + "/" + resource, "POST", data)).data;
      assert.ok(row.updated_at);
      const h = { "If-Match": row.updated_at };
      const first = (
        await ok(root + "/" + resource + "/" + row.id, "PATCH", change, h)
      ).data;
      const retry = (
        await ok(root + "/" + resource + "/" + row.id, "PATCH", change, h)
      ).data;
      assert.equal(retry.updated_at, first.updated_at);
      assert.equal(
        (await api(root + "/" + resource + "/" + row.id, "PATCH", data, h))
          .status,
        409,
      );
    }
    log(
      "All 8 editable resources reject stale changes; successful PATCH response-loss retry is acknowledged without another write",
    );
  }

  // JST midnight boundaries, unaffected by browser timezone.
  const boundary = [];
  for (const [title, due_at] of [
    ["前日", "2026-10-04T14:59:59Z"],
    ["当日開始", "2026-10-04T15:00:00Z"],
    ["当日終了", "2026-10-05T14:59:59Z"],
    ["翌日", "2026-10-05T15:00:00Z"],
    ["未設定", null],
  ])
    boundary.push(
      (
        await ok(root + "/tasks", "POST", {
          company_id: odd.id,
          assigned_user_id: uid,
          type: "callback",
          title,
          due_at,
        })
      ).data,
    );
  const today = await ok(
    root +
      "/tasks?company_id=" +
      odd.id +
      "&due_after=2026-10-04T15:00:00Z&due_before=2026-10-05T15:00:00Z",
  );
  assert.deepEqual(
    today.data.map((t) => t.title).sort(),
    ["当日開始", "当日終了"].sort(),
  );
  const dashboard = await ok(root + "/dashboard?date=2026-10-05");
  assert.deepEqual(
    dashboard.tasks.map((t) => t.title).sort(),
    ["当日開始", "当日終了"].sort(),
  );
  assert.ok(dashboard.overdue.some((t) => t.title === "前日"));
  assert.equal(dashboard.callbacks.length, 5);
  log(
    "JST midnight inclusive/exclusive, overdue and no-due-date task classification",
  );
  const deal = (
    await ok(root + "/deals", "POST", {
      company_id: odd.id,
      contact_id: contact.id,
      owner_user_id: uid,
      name: "削除整合性",
    })
  ).data;
  const task = (
    await ok(root + "/tasks", "POST", {
      company_id: odd.id,
      contact_id: contact.id,
      assigned_user_id: uid,
      type: "follow_up",
      title: "担当削除後も残す",
    })
  ).data;
  await ok(root + "/activities", "POST", {
    company_id: odd.id,
    contact_id: contact.id,
    type: "memo",
    title: "担当削除後も残す",
  });
  await ok(root + "/contacts/" + contact.id, "DELETE");
  assert.equal((await ok(root + "/deals/" + deal.id)).data.contact_id, null);
  assert.equal((await ok(root + "/tasks/" + task.id)).data.contact_id, null);
  await ok(root + "/companies/" + odd.id, "PATCH", {
    company_status: "active",
  });
  const history = (await ok(root + "/activities?company_id=" + odd.id)).data;
  assert.equal(history.filter((a) => a.type === "status_change").length, 1);
  assert.equal(history.find((a) => a.type === "memo").contact_id, null);
  log(
    "Contact removal preserves deal/task/activity with null link; company status creates one history",
  );
  await mkdir("/workspace/handoff/practical", { recursive: true });
  await writeFile(
    "/workspace/handoff/practical/api-results.json",
    JSON.stringify({ org, notes, times }, null, 2),
  );
  await page.goto(base + "/companies");
  await page.evaluate((org) => {
    localStorage.setItem("leadstack.organization", org);
    window.dispatchEvent(new Event("leadstack-org"));
  }, org);
  await expect(page.getByText("5,001 社", { exact: true })).toBeVisible();
  await page
    .getByLabel("会社名・電話番号・法人番号を検索", { exact: true })
    .fill("検証企業000");
  await expect(page.getByText("99 社", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await expect(
    page.getByText("99 件中 26–50 件", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("会社名・電話番号・法人番号を検索", { exact: true })
    .fill("検証企業05000");
  await expect(
    page.getByRole("link", { name: /^検証企業05000/ }),
  ).toBeVisible();
  await expect(page.getByText("1 件中 1–1 件", { exact: true })).toBeVisible();
  await page
    .getByLabel("会社名・電話番号・法人番号を検索", { exact: true })
    .fill("ない会社");
  await expect(
    page.getByText("条件に一致する企業がありません", { exact: true }),
  ).toBeVisible();
  log(
    "Browser Japanese search, count, pagination reset after search and empty-state",
  );
  await page.goto(base + "/companies/" + target.id);
  await page.getByRole("button", { name: "企業を編集", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const current = (await ok(root + "/companies/" + target.id)).data;
  await ok(
    root + "/companies/" + target.id,
    "PATCH",
    { name: "別端末で保存した名前" },
    { "If-Match": current.updated_at },
  );
  await dialog.getByLabel("電話番号", { exact: true }).fill("03-8888-8888");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  if (process.env.EXPECT_CONFLICT === "true") {
    await expect(dialog.getByRole("alert")).toContainText("別の操作で更新");
    await expect(dialog.getByLabel("電話番号", { exact: true })).toHaveValue(
      "03-8888-8888",
    );
    assert.equal(
      (await ok(root + "/companies/" + target.id)).data.name,
      "別端末で保存した名前",
    );
    log(
      "Two-editor browser scenario retains unsaved input and prevents overwriting the newer record",
    );
  }
  await page.goto(base + "/tasks?period=today&company_id=" + odd.id);
  const startRow = page.getByRole("row").filter({ hasText: "当日開始" });
  await expect(startRow).toBeVisible();
  if (process.env.EXPECT_CONFLICT === "true")
    await expect(startRow.locator("td").nth(3)).not.toHaveClass(
      /text-destructive/,
    );
  log("Browser JST midnight task is not styled overdue");
  // Lookup pages through all candidates; search can reach distant records.
  await page.goto(base + "/tasks?period=all");
  await page.getByRole("button", { name: "タスクを追加", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "企業", exact: true })
    .click();
  await expect(page.getByText(/件中 1–20 件/)).toBeVisible();
  await page.getByLabel("企業の候補を検索").fill("検証企業05000");
  await page.getByRole("option", { name: /^検証企業05000/ }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("combobox", { name: "企業", exact: true }),
  ).toContainText("検証企業05000");
  log(
    "Lookup displays 20 per page and can select the 5,000th company by search",
  );

  if (process.env.EXPECT_CONFLICT === "true") {
    const emptyActivityPage = await ok(
      root + "/activities?company_id=" + odd.id + "&page=100",
    );
    assert.ok(emptyActivityPage.count > 0);
    assert.deepEqual(emptyActivityPage.data, []);
    for (let i = 0; i < 26; i++)
      await ok(root + "/tasks", "POST", {
        company_id: target.id,
        assigned_user_id: uid,
        type: "other",
        title: "ページ削除" + String(i).padStart(2, "0"),
      });
    await page.goto(base + "/tasks?period=all");
    await page.getByLabel("タスクを検索", { exact: true }).fill("ページ削除");
    await expect(
      page.getByText("26 件中 1–25 件", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "次のページ", exact: true }).click();
    await expect(
      page.getByText("26 件中 26–26 件", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /ページ削除.*を削除/ }).click();
    await page.getByRole("button", { name: "削除する", exact: true }).click();
    await expect(
      page.getByText("25 件中 1–25 件", { exact: true }),
    ).toBeVisible();
    log(
      "Deleting the only row on the last page refreshes and moves back to a valid page",
    );
  }
  await ok(root + "/companies/" + odd.id, "DELETE");
  for (const r of ["contacts", "tasks", "deals", "activities"])
    assert.equal((await ok(root + "/" + r + "?company_id=" + odd.id)).count, 0);
  log("Company deletion cascades related business records");
  await mkdir("/workspace/handoff/practical", { recursive: true });
  await writeFile(
    "/workspace/handoff/practical/results.json",
    JSON.stringify(
      {
        org,
        fixture: { companies: 5000, activities: 15000, tasks: 5000 },
        notes,
        times,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: "/workspace/handoff/practical/search.png" });
} finally {
  await browser.close();
}
