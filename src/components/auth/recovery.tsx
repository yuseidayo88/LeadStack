"use client";
import { authEmailUnavailableMessage } from "@/lib/auth-email";
import { useState } from "react";
import Link from "next/link";
import { api, message } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function LoginRecovery({ emailReady }: { emailReady: boolean }) {
  const [mode, setMode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/api/auth/${mode}`, "POST", {
        email: new FormData(e.currentTarget).get("email"),
      });
      setSent(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (!emailReady)
    return (
      <p
        role="status"
        className="mt-6 border-t pt-4 text-sm text-muted-foreground"
      >
        {authEmailUnavailableMessage}
      </p>
    );
  return (
    <div className="mt-6 border-t pt-4 space-y-3">
      <div className="flex flex-wrap gap-3">
        {[
          ["reset-password", "パスワードを忘れた方"],
          ["resend-confirmation", "確認メールを再送"],
        ].map(([key, name]) => (
          <button
            key={key}
            className="text-xs text-primary hover:underline"
            disabled={busy}
            onClick={() => {
              setMode(key);
              setSent(false);
              setError("");
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {mode && (
        <form onSubmit={submit} className="space-y-3">
          <h2 className="font-medium">
            {mode === "reset-password"
              ? "パスワードの再設定"
              : "確認メールの再送"}
          </h2>
          {sent ? (
            <p role="status" className="text-sm">
              対象のアカウントがある場合にメールを送信します。迷惑メールも確認し、このブラウザでリンクを開いてください。
            </p>
          ) : (
            <>
              <label className="block">
                <span className="field-label">送信先メールアドレス</span>
                <Input
                  type="email"
                  name="email"
                  required
                  maxLength={254}
                  autoComplete="email"
                />
              </label>
              <Button disabled={busy} variant="outline">
                {busy ? "送信中…" : "メールを送信"}
              </Button>
            </>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
export function ResetPasswordForm() {
  const [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const fd = new FormData(e.currentTarget);
    try {
      const result = await api<{ signedOut: boolean }>(
        "/api/auth/update-password",
        "POST",
        {
          password: fd.get("password"),
          confirmation: fd.get("confirmation"),
        },
      );
      setDone(true);
      if (!result.signedOut)
        setError(
          "パスワードは更新済みですが、全端末のログアウトを完了できませんでした。設定画面からログアウトしてください。",
        );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-md p-6 py-16 space-y-5">
      <h1 className="text-2xl font-semibold">パスワードを再設定</h1>
      {done ? (
        <p role="status">
          パスワードを更新しました。新しいパスワードでログインしてください。
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p>12文字以上の新しいパスワードを設定してください。</p>
          {[
            ["password", "新しいパスワード"],
            ["confirmation", "新しいパスワード（確認）"],
          ].map(([name, title]) => (
            <label key={name} className="block">
              <span className="field-label">{title}</span>
              <Input
                name={name}
                type="password"
                minLength={12}
                maxLength={128}
                required
                autoComplete="new-password"
                disabled={busy}
              />
            </label>
          ))}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <Button disabled={busy}>
            {busy ? "更新中…" : "パスワードを更新"}
          </Button>
        </form>
      )}
      {done && error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Link className="block text-primary" href="/login">
        ログインへ戻る
      </Link>
    </main>
  );
}
