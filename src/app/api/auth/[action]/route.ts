import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { handle, readJson } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { loginError } from "@/lib/auth-errors";
const credentials = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(1).max(128),
});
const signup = credentials.extend({
  name: z.string().trim().min(1).max(200),
  password: z.string().min(12, "12文字以上で入力してください").max(128),
});
export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  return handle(async () => {
    const input = await readJson(request);
    const { action } = await context.params;
    if (!["login", "signup", "logout"].includes(action))
      throw new AppError(404, "not_found", "操作が見つかりません");
    const db = await createClient();
    if (action === "logout") {
      const { error } = await db.auth.signOut({ scope: "local" });
      if (error)
        throw new AppError(502, "auth_error", "ログアウトに失敗しました");
      return Response.json({ ok: true });
    }
    if (action === "signup") {
      const data = signup.parse(input);
      const site = process.env.NEXT_PUBLIC_SITE_URL;
      if (!site)
        throw new AppError(
          503,
          "configuration_required",
          "サイトの URL が未設定です",
        );
      const { data: result, error } = await db.auth.signUp({
        email: data.email,
        password: data.password,
        options: {
          data: { name: data.name },
          emailRedirectTo: new URL("/auth/callback", site).toString(),
        },
      });
      if (error)
        throw new AppError(
          error.status === 429 ? 429 : 422,
          "signup_failed",
          "登録を完了できませんでした。入力内容を確認し、時間を置いて再試行してください",
        );
      return Response.json(
        { confirmationRequired: !result.session },
        { status: 201 },
      );
    }
    const data = credentials.parse(input);
    const { error } = await db.auth.signInWithPassword(data);
    if (error) throw loginError(error);
    return Response.json({ ok: true });
  });
}
