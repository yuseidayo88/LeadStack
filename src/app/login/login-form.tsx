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
    <div className="grid min-h-screen lg:grid-cols-[0.9fr_1.1fr]">
      <aside className="hidden flex-col justify-between bg-[#113c38] p-12 text-white lg:flex">
        <div className="flex items-center gap-3 text-xl font-semibold">
          <Layers />
          LeadStack
        </div>
        <div className="max-w-md">
          <p className="mb-5 text-xs tracking-[0.2em] text-teal-200">
            YOUR SALES WORKSPACE
          </p>
          <h2 className="text-4xl font-semibold leading-relaxed tracking-tight">
            企業との接点を、
            <br />
            次の提案につなげる。
          </h2>
          <p className="mt-6 leading-7 text-teal-100/85">
            架電、ヒアリング、業務改善提案。
            <br />
            営業の情報と次のアクションを、ひとつの場所に。
          </p>
          <div className="mt-10 flex items-center gap-3 text-xs text-teal-100">
            <span className="rounded border border-white/20 px-3 py-2">
              企業管理
            </span>
            <ArrowRight className="size-4" />
            <span className="rounded border border-white/20 px-3 py-2">
              ヒアリング
            </span>
            <ArrowRight className="size-4" />
            <span className="rounded border border-white/20 px-3 py-2">
              改善提案
            </span>
          </div>
        </div>
        <p className="text-xs text-teal-100/60">チームの営業活動を、着実に。</p>
      </aside>
      <main className="flex items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-[360px]">
          <div className="mb-10 flex items-center gap-2 font-semibold lg:hidden">
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
              <p className="mb-3 text-xs font-semibold tracking-widest text-primary">
                WELCOME TO LEADSTACK
              </p>
              <h1 className="text-2xl font-semibold">
                {signup ? "アカウントを作成" : "おかえりなさい"}
              </h1>
              <p className="mb-8 mt-2 text-sm text-muted-foreground">
                {signup
                  ? "営業チームのワークスペースをはじめましょう。"
                  : "アカウントにログインして、業務をはじめましょう。"}
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
