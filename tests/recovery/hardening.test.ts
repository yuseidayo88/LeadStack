import { expect, test, vi, afterEach } from "vitest";
import { matchesCreatedRecord } from "@/lib/crm/create-retry";
import { authCookieOptions } from "@/lib/supabase/cookie-options";
afterEach(() => vi.unstubAllEnvs());
test("retry acknowledges normalized DB timestamps and JSON ordering but rejects changed values", () => {
  const input = {
    title: "折返し",
    due_at: "2026-10-05T10:00:00+09:00",
    automation_config: { steps: ["A", "B"], trigger: "X" },
  };
  expect(
    matchesCreatedRecord(input, {
      ...input,
      due_at: "2026-10-05T01:00:00+00:00",
      id: "extra",
      automation_config: { trigger: "X", steps: ["A", "B"] },
    }),
  ).toBe(true);
  expect(matchesCreatedRecord(input, { ...input, title: "別の保存内容" })).toBe(
    false,
  );
  expect(
    matchesCreatedRecord(input, {
      ...input,
      automation_config: { trigger: "X", steps: ["B", "A"] },
    }),
  ).toBe(false);
});
test("production auth cookies are Secure, HttpOnly, SameSite=Lax", () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://leadstack.example");
  expect(authCookieOptions()).toEqual({
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3005");
  expect(authCookieOptions().secure).toBe(false);
});
