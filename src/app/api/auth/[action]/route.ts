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
    if (
      ![
        "login",
        "signup",
        "logout",
        "reset-password",
        "resend-confirmation",
        "update-password",
      ].includes(action)
    )
      throw new AppError(404, "not_found", "操作が見つかりません");
    const db = await createClient();
    if (action === "logout") {
      const { error } = await db.auth.signOut({ scope: "local" });
      if (error)
        throw new AppError(502, "auth_error", "ログアウトに失敗しました");
      return Response.json({ ok: true });
    }
    if (action === "reset-password" || action === "resend-confirmation") {
      const { email } = z
        .strictObject({ email: credentials.shape.email })
        .parse(input);
      const site = process.env.NEXT_PUBLIC_SITE_URL;
      if (!site)
        throw new AppError(
          503,
          "configuration_required",
          "サイトの URL が未設定です",
        );
      const redirectTo = new URL("/auth/callback", site);
      if (action === "reset-password")
        redirectTo.searchParams.set("next", "/reset-password");
      const { error } =
        action === "reset-password"
          ? await db.auth.resetPasswordForEmail(email, {
              redirectTo: redirectTo.toString(),
            })
          : await db.auth.resend({
              type: "signup",
              email,
              options: { emailRedirectTo: redirectTo.toString() },
            });
      if (
        error &&
        ["email_address_not_authorized", "email_provider_disabled"].includes(
          error.code || "",
        )
      )
        throw new AppError(
          503,
          "mail_configuration",
          "メール送信の設定を管理者に確認してください",
        );
      if (error?.status === 429)
        throw new AppError(
          429,
          "rate_limited",
          "送信回数の上限です。時間を置いて再試行してください",
        );
      if (error && (!error.status || error.status >= 500))
        throw new AppError(
          503,
          "auth_unavailable",
          "メール送信を受け付けられません。時間を置いて再試行してください",
        );
      // Identical response for absent / already confirmed accounts.
      return Response.json({ ok: true });
    }
    if (action === "update-password") {
      const data = z
        .strictObject({
          password: signup.shape.password,
          confirmation: z.string(),
        })
        .refine((v) => v.password === v.confirmation, {
          message: "パスワードが一致しません",
          path: ["confirmation"],
        })
        .parse(input);
      const {
        data: { user },
        error: authError,
      } = await db.auth.getUser();
      if (authError || !user)
        throw new AppError(
          401,
          "unauthorized",
          "リンクの有効期限が切れています。再設定メールをもう一度お申し込みください",
        );
      const { error } = await db.auth.updateUser({ password: data.password });
      if (error)
        throw new AppError(
          error.status === 429 ? 429 : 422,
          "password_update_failed",
          "パスワードを更新できませんでした。別のパスワードを指定するか、リンクを再取得してください",
        );
      await db.auth.signOut({ scope: "local" });
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
