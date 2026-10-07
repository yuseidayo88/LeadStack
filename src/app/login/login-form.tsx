"use client";
import { LoginRecovery } from "@/components/auth/recovery";
import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Layers, ArrowRight, CheckCircle2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api, message } from "@/lib/client-api";
import { safeNext } from "@/lib/navigation";
import { Busy } from "@/components/crm/common";
export function LoginForm({ emailReady }: { emailReady: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const fd = new FormData(e.currentTarget);
    try {
      const result = await api<{ confirmationRequired?: boolean }>(
        `/api/auth/${signup ? "signup" : "login"}`,
        "POST",
        {
          email: fd.get("email"),
          password: fd.get("password"),
          ...(signup ? { name: fd.get("name") } : {}),
        },
      );
      if (result.confirmationRequired) {
        setConfirm(true);
        setBusy(false);
      } else {
        router.replace(safeNext(params.get("next")));
        router.refresh();
      }
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <div className="min-h-screen">
      <main className="flex min-h-screen items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-[360px]">
          <div className="mb-8 flex items-center gap-2 font-semibold">
            <Layers className="text-primary" />
            LeadStack
          </div>
          {confirm ? (
            <div role="status" className="space-y-4">
              <CheckCircle2 className="size-10 text-primary" />
              <h1 className="text-2xl font-semibold">メールをご確認ください</h1>
              <p className="leading-6 text-muted-foreground">
                確認リンクからメールアドレスを認証して、利用を開始してください。
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setConfirm(false);
                  setSignup(false);
                }}
              >
                ログインへ戻る
              </Button>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-semibold">
                {signup ? "アカウントを作成" : "ログイン"}
              </h1>
              <p className="mb-8 mt-2 text-sm text-muted-foreground">
                {signup
                  ? "お名前・メールアドレス・パスワードを入力してください。"
                  : "メールアドレスとパスワードを入力してください。"}
              </p>
              {params.get("error") === "configuration" && (
                <p role="alert" className="mb-4 text-sm text-destructive">
                  現在準備中です。管理者にお問い合わせください。
                </p>
              )}
              {params.get("error") === "confirmation" && (
                <p role="alert" className="mb-4 text-sm text-destructive">
                  メールの確認リンクを処理できませんでした。登録を行ったブラウザでリンクを開いてください。確認済みの場合はログインしてください。
                </p>
              )}
              <form onSubmit={submit} className="space-y-5">
                {signup && (
                  <label className="block">
                    <span className="field-label">お名前</span>
                    <Input
                      name="name"
                      autoComplete="name"
                      maxLength={200}
                      required
                      placeholder="山田 太郎"
                    />
                  </label>
                )}
                <label className="block">
                  <span className="field-label">メールアドレス</span>
                  <Input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    placeholder="you@company.co.jp"
                  />
                </label>
                <label className="block">
                  <span className="field-label">パスワード</span>
                  <Input
                    name="password"
                    type="password"
                    autoComplete={signup ? "new-password" : "current-password"}
                    minLength={signup ? 12 : 1}
                    maxLength={128}
                    required
                  />
                  {signup && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      12文字以上で設定してください。
                    </span>
                  )}
                </label>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button className="w-full" size="lg" disabled={busy}>
                  <Busy busy={busy}>
                    {signup ? "アカウントを作成" : "ログイン"}
                    <ArrowRight className="size-4" />
                  </Busy>
                </Button>
              </form>
              <p className="mt-7 text-center text-sm text-muted-foreground">
                {signup
                  ? "アカウントをお持ちですか？"
                  : "はじめてご利用ですか？"}
                <button
                  className="ml-2 font-medium text-primary hover:underline"
                  disabled={busy || !emailReady}
                  onClick={() => {
                    setSignup(!signup);
                    setError("");
                  }}
                >
                  {signup ? "ログイン" : "新規登録"}
                </button>
              </p>
            </>
          )}
          <LoginRecovery emailReady={emailReady} />
        </div>
      </main>
    </div>
  );
}
