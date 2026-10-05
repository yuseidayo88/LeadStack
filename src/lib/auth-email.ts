// Server-side operational switch. Enable only after SMTP and delivery checks succeed.
export function authEmailReady() {
  return process.env.AUTH_EMAIL_READY === "true";
}
export const authEmailUnavailableMessage =
  "認証メール機能は準備中です。新規登録・確認メールの再送・パスワード再設定は現在利用できません。確認済みアカウントでのログインは利用できます。お困りの場合は管理者にお問い合わせください。";
