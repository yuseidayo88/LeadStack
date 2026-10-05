// New regression tests after source recovery; original tests were not recovered.
import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ signInWithPassword: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: mocks,
    rpc: async () => ({ data: true, error: null }),
  }),
}));
import { POST } from "@/app/api/auth/[action]/route";
import { safeNext } from "@/lib/navigation";
const call = (body: unknown, origin = "http://localhost:3000") =>
  POST(
    new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ action: "login" }) },
  );
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
  mocks.signInWithPassword.mockReset();
});
test("normalizes pasted email but preserves password verbatim", async () => {
  mocks.signInWithPassword.mockResolvedValue({ error: null });
  const result = await call({
    email: " person@example.test ",
    password: " password ",
  });
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.signInWithPassword).toHaveBeenCalledWith({
    email: "person@example.test",
    password: " password ",
  });
});
test.each([
  [{ status: 400, code: "invalid_credentials" }, 401, "login_failed"],
  [{ status: 400, code: "email_not_confirmed" }, 401, "email_not_confirmed"],
  [{ status: 429 }, 429, "rate_limited"],
  [{ status: 503 }, 503, "auth_unavailable"],
  [{ status: 0 }, 503, "auth_unavailable"],
])(
  "maps auth error %j to %i without leaking upstream details",
  async (error, status, code) => {
    mocks.signInWithPassword.mockResolvedValue({
      error: { ...error, message: "SENSITIVE_UPSTREAM_DETAIL" },
    });
    const result = await call({
      email: "person@example.test",
      password: "password",
    });
    expect(result.status).toBe(status);
    const body = await result.json();
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("SENSITIVE_UPSTREAM_DETAIL");
  },
);
test("cross-origin login is rejected before calling auth", async () => {
  expect(
    (
      await call(
        { email: "person@example.test", password: "password" },
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  expect(mocks.signInWithPassword).not.toHaveBeenCalled();
});
test("invalid input is rejected before calling auth", async () => {
  expect((await call({ email: "bad", password: "" })).status).toBe(422);
  expect(mocks.signInWithPassword).not.toHaveBeenCalled();
});
test.each(["https://evil.example", "//evil.example", "/\\evil.example"])(
  "rejects external login destination %s",
  (value) => {
    expect(safeNext(value)).toBe("/dashboard");
  },
);
test("preserves a local login destination", () => {
  expect(safeNext("/companies?q=abc")).toBe("/companies?q=abc");
});
