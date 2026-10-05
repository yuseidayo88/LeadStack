import { expect, test, vi, beforeEach } from "vitest";
import { parseCsv, previewCsv } from "@/lib/crm/company-csv";
import { activitySchema } from "@/lib/crm/schemas";
import { proposalDrafts } from "@/lib/crm/proposal-drafts";
import type { Tables } from "@/lib/database.types";
const mocks = vi.hoisted(() => ({
  getClaims: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  resend: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: mocks,
    rpc: async () => ({ data: true, error: null }),
  }),
}));
import { GET as callback } from "@/app/auth/callback/route";
import { POST } from "@/app/api/auth/[action]/route";
async function call(
  action: string,
  data: unknown,
  origin = "http://localhost:3000",
) {
  return POST(
    new Request(`http://localhost:3000/api/auth/${action}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(data),
    }),
    { params: Promise.resolve({ action }) },
  );
}
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
  vi.stubEnv("AUTH_EMAIL_READY", "true");
  vi.resetAllMocks();
  mocks.getClaims.mockResolvedValue({
    data: {
      claims: {
        amr: [{ method: "recovery", timestamp: Math.floor(Date.now() / 1000) }],
      },
    },
    error: null,
  });
});
test("CSV preserves BOM Japanese, quoted commas, escaped quotes, embedded newlines and phone zero", () => {
  const rows = previewCsv(
    '\uFEFF会社名,電話番号,事業内容\r\n"日本,商事",0312345678,"説明""引用""\n二行目"\r\n',
  );
  expect(rows[0]).toEqual({
    row: 2,
    data: {
      name: "日本,商事",
      phone: "0312345678",
      business_description: '説明"引用"\n二行目',
    },
    errors: [],
  });
});
test.each(['a\n"bad', 'a\nx"bad', 'a\n"bad"x'])(
  "rejects malformed CSV %s",
  (v) => expect(() => parseCsv(v)).toThrow(),
);
test("CSV labels invalid rows and rejects missing/duplicate/unknown headers", () => {
  expect(
    previewCsv("会社名,法人番号,Webサイト\n,123,javascript:alert(1)")[0].errors
      .length,
  ).toBe(3);
  for (const v of [
    "電話番号\n0123",
    "会社名,会社名\na,b",
    "会社名,組織ID\na,b",
  ])
    expect(() => previewCsv(v)).toThrow();
});
test("CSV limits 500 rows and does not coerce formula text", () => {
  expect(() =>
    previewCsv("会社名\n" + Array(501).fill("A").join("\n")),
  ).toThrow();
  expect(previewCsv('会社名,電話番号\n会社,"=""031234"""')[0].data.phone).toBe(
    '="031234"',
  );
});
test("callback outcome requires a dated callback", () => {
  const v = {
    company_id: "00000000-0000-4000-8000-000000000001",
    type: "call",
    result: "callback",
  };
  expect(activitySchema.safeParse(v).success).toBe(false);
  expect(
    activitySchema.safeParse({
      ...v,
      callback: { title: "再架電", due_at: "2026-10-05T01:00:00Z" },
    }).success,
  ).toBe(true);
});
test("drafts only use supplied evidence and do not claim quantified outcomes", () => {
  expect(proposalDrafts()).toEqual([]);
  const tool = {
    tool_name: "既存台帳",
    keep_or_replace: "unknown",
    usage_description: "案件記録",
  } as Tables<"company_tools">;
  const drafts = proposalDrafts(undefined, undefined, tool);
  expect(drafts.map((d) => d.type)).toEqual(["keep"]);
  expect(drafts[0].reason).toContain("案件記録");
  expect(drafts[0].reason).toContain("仮説");
  expect(drafts[0].description).toContain("継続を決定したものではありません");
  const pain = {
    type: "manual_work",
    description: "二重入力",
  } as Tables<"pain_points">;
  expect(proposalDrafts(undefined, pain, tool).map((d) => d.type)).toEqual([
    "build",
    "automate",
    "keep",
  ]);
});
test.each(["reset-password", "resend-confirmation"])(
  "%s rejects cross-origin and invalid email before Auth",
  async (action) => {
    expect(
      (await call(action, { email: "x@example.test" }, "https://evil.example"))
        .status,
    ).toBe(403);
    expect((await call(action, { email: "bad" })).status).toBe(422);
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(mocks.resend).not.toHaveBeenCalled();
  },
);
test("reset uses configured PKCE callback with safe recovery destination", async () => {
  mocks.resetPasswordForEmail.mockResolvedValue({ error: null });
  expect(
    (await call("reset-password", { email: " x@example.test " })).status,
  ).toBe(200);
  expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith("x@example.test", {
    redirectTo: "http://localhost:3000/auth/callback?next=%2Freset-password",
  });
});
test("resend is signup only and does not expose account existence", async () => {
  mocks.resend.mockResolvedValue({
    error: { status: 400, message: "Account does not exist" },
  });
  const r = await call("resend-confirmation", { email: "x@example.test" });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true });
  expect(mocks.resend).toHaveBeenCalledWith({
    type: "signup",
    email: "x@example.test",
    options: { emailRedirectTo: "http://localhost:3000/auth/callback" },
  });
});
test.each([
  [429, 429],
  [503, 503],
  [0, 503],
])("mail failure %i is handled", async (status, expected) => {
  mocks.resetPasswordForEmail.mockResolvedValue({
    error: { status, message: "SECRET" },
  });
  const r = await call("reset-password", { email: "x@example.test" });
  expect(r.status).toBe(expected);
  expect(await r.text()).not.toContain("SECRET");
});
test("password update requires verified user and matching strong password", async () => {
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: {} });
  expect(
    (
      await call("update-password", {
        password: "new-password12",
        confirmation: "new-password12",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await call("update-password", {
        password: "new-password12",
        confirmation: "wrong",
      })
    ).status,
  ).toBe(422);
  expect(
    (await call("update-password", { password: "weak", confirmation: "weak" }))
      .status,
  ).toBe(422);
  expect(mocks.updateUser).not.toHaveBeenCalled();
});
test("password update changes only current user and clears local session", async () => {
  mocks.getUser.mockResolvedValue({
    data: { user: { id: "fixture" } },
    error: null,
  });
  mocks.updateUser.mockResolvedValue({ error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  expect(
    (
      await call("update-password", {
        password: "new-password12",
        confirmation: "new-password12",
      })
    ).status,
  ).toBe(200);
  expect(mocks.updateUser).toHaveBeenCalledWith({ password: "new-password12" });
  expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });
});

test("callback handles valid, expired and missing codes without external redirects", async () => {
  mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
  const good = await callback(
    new Request(
      "http://localhost:3000/auth/callback?code=local-fixture&next=/reset-password",
    ),
  );
  expect(good.headers.get("location")).toBe(
    "http://localhost:3000/reset-password",
  );
  expect(good.headers.get("cache-control")).toBe("private, no-store");
  const unsafe = await callback(
    new Request(
      "http://localhost:3000/auth/callback?code=local-fixture&next=https://evil.example",
    ),
  );
  expect(unsafe.headers.get("location")).toBe(
    "http://localhost:3000/dashboard",
  );
  mocks.exchangeCodeForSession.mockResolvedValue({
    error: { message: "expired" },
  });
  const expired = await callback(
    new Request("http://localhost:3000/auth/callback?code=used"),
  );
  expect(expired.headers.get("location")).toBe(
    "http://localhost:3000/login?error=confirmation",
  );
  const missing = await callback(
    new Request("http://localhost:3000/auth/callback"),
  );
  expect(missing.headers.get("location")).toBe(
    "http://localhost:3000/login?error=confirmation",
  );
});

test("Shift_JIS Japanese decodes without losing leading phone zero; wrong UTF-8 fails", () => {
  const bytes = Buffer.from(
    "89ef8ed096bc2c9364986294d48d860d0a8a948eae89ef8ed08365835883672c303331323334353637380d0a",
    "hex",
  );
  expect(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ).toThrow();
  const decoded = new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
  expect(previewCsv(decoded)[0]).toEqual({
    row: 2,
    data: { name: "株式会社テスト", phone: "0312345678" },
    errors: [],
  });
});

test.each(["email_address_not_authorized", "email_provider_disabled"])(
  "reports mail configuration error %s without claiming success",
  async (code) => {
    mocks.resetPasswordForEmail.mockResolvedValue({
      error: { status: 403, code, message: "UPSTREAM" },
    });
    const response = await call("reset-password", { email: "x@example.test" });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("mail_configuration");
  },
);

test.each(
  [
    [],
    [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }],
    [{ method: "recovery", timestamp: Math.floor(Date.now() / 1000) - 901 }],
    [{ method: "recovery", timestamp: Math.floor(Date.now() / 1000) + 60 }],
  ].map((amr) => ({ amr })),
)(
  "password reset rejects ordinary, absent, stale or future recovery claims",
  async ({ amr }) => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "fixture" } },
      error: null,
    });
    mocks.getClaims.mockResolvedValue({
      data: { claims: { amr } },
      error: null,
    });
    expect(
      (
        await call("update-password", {
          password: "valid-new-password12",
          confirmation: "valid-new-password12",
        })
      ).status,
    ).toBe(403);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  },
);
test("password reset fails closed when verified claims unavailable", async () => {
  mocks.getUser.mockResolvedValue({
    data: { user: { id: "fixture" } },
    error: null,
  });
  mocks.getClaims.mockResolvedValue({
    data: null,
    error: { message: "invalid" },
  });
  expect(
    (
      await call("update-password", {
        password: "valid-new-password12",
        confirmation: "valid-new-password12",
      })
    ).status,
  ).toBe(403);
});
test.each(["aaaaaaaaaaaa", "abcdabcdabcd", "password1234"])(
  "signup rejects trivially repeated or common password",
  async (password) => {
    expect(
      (
        await call("signup", {
          email: "fixture@example.test",
          name: "fixture",
          password,
        })
      ).status,
    ).toBe(422);
  },
);

test.each([undefined, "false", "TRUE", "1"])(
  "mail setup %s fails closed before contacting Auth",
  async (setting) => {
    vi.stubEnv("AUTH_EMAIL_READY", setting);
    for (const action of ["signup", "reset-password", "resend-confirmation"]) {
      const r = await call(action, {
        email: "person@example.test",
        password: "valid-password12",
        name: "fixture",
      });
      expect(r.status).toBe(503);
      expect((await r.json()).error.code).toBe("email_not_ready");
    }
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(mocks.resend).not.toHaveBeenCalled();
  },
);
