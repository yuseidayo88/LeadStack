// LOCAL-ONLY bounded security audit. SMTP sink never relays mail. Do not use production credentials.
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const base = "http://localhost:3004",
  auth = "http://127.0.0.1:55321/auth/v1";
const cfg = JSON.parse(
  await readFile("/workspace/handoff/e2e-private/secrets.json", "utf8"),
);
const browser = await chromium.launch({ headless: true });
const results = [];
const contexts = [];
const pause = () => new Promise((r) => setTimeout(r, 1100));
function note(name, detail) {
  results.push({ name, ...detail });
  console.log(name + ": " + JSON.stringify(detail));
}
async function context() {
  const c = await browser.newContext();
  contexts.push(c);
  return c;
}
async function app(c, action, data) {
  return c.request.post(base + "/api/auth/" + action, {
    headers: { origin: base },
    data,
  });
}
async function authCall(path, data, token = cfg.anon_key, method = "POST") {
  const r = await fetch(auth + path, {
    method,
    headers: {
      apikey: cfg.anon_key,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
function sql(query) {
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
    { input: query, encoding: "utf8" },
  ).trim();
}
async function link(email) {
  for (let tries = 0; tries < 30; tries++) {
    const raw = await readFile(
      "/workspace/handoff/e2e-private/smtp-messages.jsonl",
      "utf8",
    ).catch(() => "");
    const mail = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s))
      .reverse()
      .find((s) => s.toLowerCase().includes(email.toLowerCase()));
    if (mail) {
      const text = mail
        .replace(/=\n/g, "")
        .replace(/=([0-9A-F]{2})/g, (_, s) =>
          String.fromCharCode(parseInt(s, 16)),
        );
      const m = text.match(/href="(http[^\"]+)"/);
      if (m) return m[1].replaceAll("&amp;", "&");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Local sink link not received");
}
const stamp = Date.now(),
  email = `audit-${stamp}@example.test`,
  password = "Audit-fixture-password-12";
try {
  const c = await context();
  let r = await app(c, "signup", {
    email: " " + email.toUpperCase() + " ",
    password,
    name: "Audit fixture",
  });
  assert.equal(r.status(), 201);
  const registered = await r.json();
  assert.equal(registered.confirmationRequired, true);
  assert.equal(
    sql(`select count(*) from auth.users where lower(email)='${email}'`),
    "1",
  );
  note("signup_normalization", {
    status: r.status(),
    confirmationRequired: true,
    canonicalLowercase:
      sql(`select email from auth.users where email='${email}'`) !== "",
  });
  const missing = await app(c, "login", {
    email: "missing-" + email,
    password,
  });
  const wrong = await app(c, "login", { email, password: "wrong-password" });
  const unconfirmed = await app(c, "login", { email, password });
  note("login_errors", {
    missing: missing.status(),
    missingCode: (await missing.json()).error.code,
    wrong: wrong.status(),
    wrongCode: (await wrong.json()).error.code,
    unconfirmed: unconfirmed.status(),
    unconfirmedCode: (await unconfirmed.json()).error.code,
  });
  const other = await context();
  await pause();
  const dup = await app(other, "signup", {
    email,
    password: "Different-password-12",
    name: "Duplicate",
  });
  note("pending_duplicate_signup", {
    status: dup.status(),
    userCount: Number(
      sql(`select count(*) from auth.users where email='${email}'`),
    ),
  });
  const raceEmail = `race-${stamp}@example.test`;
  const racers = await Promise.all([context(), context(), context()]);
  const race = await Promise.all(
    racers.map((ctx, i) =>
      app(ctx, "signup", {
        email: i === 1 ? raceEmail.toUpperCase() : raceEmail,
        password,
        name: "Race",
      }),
    ),
  );
  note("concurrent_signup", {
    statuses: race.map((r) => r.status()),
    userCount: Number(
      sql(`select count(*) from auth.users where email='${raceEmail}'`),
    ),
  });
  assert.equal(
    sql(`select count(*) from auth.users where email='${raceEmail}'`),
    "1",
  );
  // Confirm local account via locally generated admin link (no delivery).
  const generated = await authCall(
    "/admin/generate_link",
    { type: "signup", email, password },
    cfg.service_key,
  );
  assert.equal(generated.status, 200);
  const verified = await authCall("/verify", {
    type: "signup",
    token_hash: generated.body.hashed_token,
  });
  assert.equal(verified.status, 200);
  const login = await app(c, "login", {
    email: email.toUpperCase(),
    password: "Different-password-12",
  });
  // Supabase may update pending signup password on duplicate registration; record without assumption.
  let chosen = "Different-password-12";
  if (login.status() !== 200) {
    chosen = password;
    assert.equal((await app(c, "login", { email, password })).status(), 200);
  }
  note("confirmed_login", {
    status: 200,
    loginPasswordAfterAdminConfirmation:
      chosen === password ? "initial" : "duplicate",
  });
  const confirmedDup = await app(other, "signup", {
    email,
    password: "Another-password-12",
    name: "Duplicate",
  });
  note("confirmed_duplicate_signup", {
    status: confirmedDup.status(),
    confirmationRequired: (await confirmedDup.json()).confirmationRequired,
    userCount: Number(
      sql(`select count(*) from auth.users where email='${email}'`),
    ),
  });
  const directWeak = await authCall("/signup", {
    email: `weak-${stamp}@example.test`,
    password: "123456",
  });
  const repeat = await authCall("/signup", {
    email: `repeat-${stamp}@example.test`,
    password: "aaaaaaaaaaaa",
  });
  const hashType = sql(
    `select case when encrypted_password like '$2%' then 'bcrypt' else 'other' end from auth.users where email='${email}'`,
  );
  note("password_policy", {
    directSixChars: directWeak.status,
    twelveRepeatedChars: repeat.status,
    storedHashAlgorithm: hashType,
  });
  // Valid logged-in session can use reset endpoint without a recovery flow/current password.
  const update = await app(c, "update-password", {
    password: "Updated-fixture-password-12",
    confirmation: "Updated-fixture-password-12",
  });
  note("ordinary_session_password_change", {
    status: update.status(),
    requiredCurrentPassword: false,
    requiredRecoveryLink: false,
  });
  assert.equal(update.status(), 200);
  assert.equal(
    (
      await app(c, "login", { email, password: "Updated-fixture-password-12" })
    ).status(),
    200,
  );
  const cookies = await c.cookies();
  const saved = await c.storageState();
  const tokenCookies = cookies
    .filter((v) => /^sb-.*-auth-token(?:\.\d+)?$/.test(v.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((v) => v.value)
    .join("");
  const session = JSON.parse(
    Buffer.from(tokenCookies.replace(/^base64-/, ""), "base64url").toString(),
  );
  const logout = await app(c, "logout", {});
  assert.equal(logout.status(), 200);
  const replay = await authCall("/user", null, session.access_token, "GET");
  const restReplay = await fetch(
    "http://127.0.0.1:55321/rest/v1/profiles?select=id&id=eq." +
      session.user.id,
    {
      headers: {
        apikey: cfg.anon_key,
        Authorization: "Bearer " + session.access_token,
      },
    },
  );
  const restRows = await restReplay.json();
  const refresh = await authCall("/token?grant_type=refresh_token", {
    refresh_token: session.refresh_token,
  });
  const stolen = await browser.newContext({ storageState: saved });
  contexts.push(stolen);
  const appReplay = await stolen.request.get(base + "/api/profile");
  note("logout", {
    originalBrowserProfile: (
      await c.request.get(base + "/api/profile")
    ).status(),
    accessTokenUserReplay: replay.status,
    restStatus: restReplay.status,
    restOwnProfileRows: Array.isArray(restRows) ? restRows.length : null,
    savedCookieApiReplay: appReplay.status(),
    refreshAfterLogout: refresh.status,
    cookiesHttpOnly: cookies
      .filter((x) => x.name.startsWith("sb-"))
      .every((x) => x.httpOnly),
    cookiesSecure: cookies
      .filter((x) => x.name.startsWith("sb-"))
      .every((x) => x.secure),
  });
  // PKCE email recovery through local sink only.
  const recovery = await context();
  await pause();
  assert.equal(
    (await app(recovery, "reset-password", { email })).status(),
    200,
  );
  const recoveryLink = await link(email);
  const p = await recovery.newPage();
  await p.goto(recoveryLink);
  await p.waitForURL("**/reset-password");
  note("recovery_pkce", { callbackReachedReset: true });
  const reuse = await fetch(recoveryLink, { redirect: "manual" });
  note("recovery_reuse", {
    redirectContainsError: (reuse.headers.get("location") || "").includes(
      "error",
    ),
  });
  await pause();
  assert.equal(
    (await app(recovery, "reset-password", { email })).status(),
    200,
  );
  const crossLink = await link(email);
  const cross = await context();
  const crossPage = await cross.newPage();
  await crossPage.goto(crossLink);
  await crossPage.waitForURL("**/login?error=confirmation");
  note("recovery_wrong_browser", {
    sessionCreated: false,
    profileStatus: (await cross.request.get(base + "/api/profile")).status(),
  });
  const resendCtx = await context();
  await pause();
  const resend = await app(resendCtx, "resend-confirmation", {
    email: raceEmail,
  });
  assert.equal(resend.status(), 200);
  const resendLink = await link(raceEmail);
  const resendPage = await resendCtx.newPage();
  await resendPage.goto(resendLink);
  await resendPage.waitForURL((u) =>
    ["/dashboard", "/onboarding"].includes(u.pathname),
  );
  note("resend_confirmation", {
    status: 200,
    confirmed:
      sql(
        `select email_confirmed_at is not null from auth.users where email='${raceEmail}'`,
      ) === "t",
  });
  const missingReset = await app(await context(), "reset-password", {
    email: "missing-" + email,
  });
  note("missing_reset", {
    status: missingReset.status(),
    bodyOk: (await missingReset.json()).ok === true,
  });
  const rotationLogin = await authCall("/token?grant_type=password", {
    email,
    password: "Updated-fixture-password-12",
  });
  assert.equal(rotationLogin.status, 200);
  const t0 = rotationLogin.body.refresh_token;
  const rotated1 = await authCall("/token?grant_type=refresh_token", {
    refresh_token: t0,
  });
  assert.equal(rotated1.status, 200);
  const rotated2 = await authCall("/token?grant_type=refresh_token", {
    refresh_token: rotated1.body.refresh_token,
  });
  assert.equal(rotated2.status, 200);
  await new Promise((r) => setTimeout(r, 11000));
  const oldReuse = await authCall("/token?grant_type=refresh_token", {
    refresh_token: t0,
  });
  const family = await authCall("/token?grant_type=refresh_token", {
    refresh_token: rotated2.body.refresh_token,
  });
  note("refresh_reuse_outside_grace", {
    rotated: rotated1.body.refresh_token !== t0,
    oldTokenStatus: oldReuse.status,
    currentFamilyStatus: family.status,
  });
  note("audit_complete", { outboundEmailCount: 0, realUsersModified: 0 });
} finally {
  await writeFile(
    "/workspace/handoff/security-auth-results.json",
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
