import { AppError } from "./errors";

// Preserve actionable failures without exposing upstream messages or credentials.
export function loginError(error: { status?: number; code?: string }) {
  if (error.status === 429)
    return new AppError(
      429,
      "rate_limited",
      "試行回数が多くなっています。時間を置いて再試行してください",
    );
  if (error.code === "email_not_confirmed")
    return new AppError(
      401,
      "email_not_confirmed",
      "メールアドレスの確認が完了していません。登録時の確認メールを開いてください",
    );
  if (error.status === 0 || (error.status !== undefined && error.status >= 500))
    return new AppError(
      503,
      "auth_unavailable",
      "認証サービスに接続できません。時間を置いて再試行してください",
    );
  return new AppError(
    401,
    "login_failed",
    "ログインできませんでした。メールアドレスとパスワードを確認してください",
  );
}
