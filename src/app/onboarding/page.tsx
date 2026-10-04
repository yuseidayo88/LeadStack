"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Layers, Building2, ArrowRight } from "lucide-react";
import { api, useApi, message } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Busy, ErrorState, Loading } from "@/components/crm/common";
import { selectOrganization } from "@/components/layout/workspace";
import { roleLabels, type Role } from "@/lib/crm/display";
type Invitation = {
  id: string;
  organization_name: string;
  role: Role;
  expires_at: string;
};
export default function Onboarding() {
  const router = useRouter();
  const invitations = useApi<{ data: Invitation[] }>("/api/invitations");
  const organizations = useApi<{ data: { id: string; name: string }[] }>(
    "/api/organizations",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = new FormData(e.currentTarget).get("name");
    setBusy(true);
    setError("");
    try {
      const result = await api<{ data: { id: string } }>(
        "/api/organizations",
        "POST",
        { name },
      );
      selectOrganization(result.data.id);
      router.replace("/dashboard");
      router.refresh();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  async function accept(id: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ data: { organization_id: string } }>(
        "/api/invitations",
        "POST",
        { invitation_id: id },
      );
      selectOrganization(result.data.organization_id);
      router.replace("/dashboard");
      router.refresh();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <Link
        href="/dashboard"
        className="mb-12 flex items-center gap-2 text-xl font-semibold"
      >
        <Layers className="text-primary" />
        LeadStack
      </Link>
      <p className="text-xs font-semibold tracking-widest text-primary">
        GET STARTED
      </p>
      <h1 className="mt-3 text-2xl font-semibold">
        チームのワークスペースを用意
      </h1>
      <p className="mt-3 leading-6 text-muted-foreground">
        組織を作成するか、届いている招待から参加できます。
        <br />
        企業や商談の情報は、組織ごとに管理されます。
      </p>
      <section className="surface mt-8 p-6">
        <div className="mb-5 flex items-center gap-2">
          <Building2 className="size-5 text-primary" />
          <h2 className="font-semibold">組織を作成</h2>
        </div>
        <form onSubmit={create} className="space-y-4">
          <label className="block">
            <span className="field-label">組織名</span>
            <Input
              name="name"
              required
              maxLength={200}
              placeholder="株式会社〇〇 営業部"
            />
          </label>
          <Button disabled={busy} className="w-full">
            <Busy busy={busy}>
              ワークスペースを作成
              <ArrowRight className="size-4" />
            </Busy>
          </Button>
        </form>
      </section>
      {error && (
        <p role="alert" className="mt-4 text-destructive">
          {error}
        </p>
      )}
      <section className="mt-8">
        <h2 className="mb-3 font-semibold">あなたへの招待</h2>
        {invitations.error ? (
          <ErrorState
            error={invitations.error}
            retry={() => void invitations.mutate()}
          />
        ) : !invitations.data ? (
          <Loading />
        ) : invitations.data.data.length ? (
          invitations.data.data.map((inv) => (
            <div
              className="surface mb-3 flex items-center justify-between gap-4 p-4"
              key={inv.id}
            >
              <div>
                <p className="font-medium">{inv.organization_name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {roleLabels[inv.role]}として招待されています
                </p>
              </div>
              <Button disabled={busy} onClick={() => void accept(inv.id)}>
                参加する
              </Button>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            現在、招待はありません。招待を受けたメールアドレスでログインしてください。
          </p>
        )}
      </section>
      {!!organizations.data?.data.length && (
        <Button asChild variant="outline" className="mt-8">
          <Link href="/dashboard">ワークスペースへ戻る</Link>
        </Button>
      )}
      <Button
        variant="ghost"
        className="mt-8 ml-2"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api("/api/auth/logout", "POST", {});
            router.replace("/login");
            router.refresh();
          } catch (e) {
            setError(message(e));
            setBusy(false);
          }
        }}
      >
        ログアウト
      </Button>
    </main>
  );
}
