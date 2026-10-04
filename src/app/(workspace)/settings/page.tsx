"use client";
import { useState } from "react";
import Link from "next/link";
import {
  Users,
  Settings2,
  UserRound,
  Plug,
  MailPlus,
  ShieldCheck,
  Pencil,
  Trash2,
  Plus,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/layout/workspace";
import { api, useApi, message } from "@/lib/client-api";
import type { Tables } from "@/lib/database.types";
import {
  type Member,
  type Role,
  roleLabels,
  dateTime,
} from "@/lib/crm/display";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  PageHeader,
  ErrorState,
  Loading,
  Busy,
  StatusBadge,
} from "@/components/crm/common";
export default function SettingsPage() {
  const { org, profile, base, isAdmin, refresh } = useWorkspace();
  return (
    <div className="page">
      <PageHeader
        title="設定"
        description="ワークスペースとチームの情報を管理します。"
      />
      <div className="grid items-start gap-6 xl:grid-cols-[1fr_1.35fr]">
        <div className="space-y-6">
          <section className="surface">
            <SectionTitle icon={Settings2} title="組織情報" />
            <div className="p-5">
              <NameForm
                key={org.name}
                label="組織名"
                initial={org.name}
                path={base}
                editable={isAdmin}
                onSaved={refresh}
              />
              <p className="mt-4 text-xs text-muted-foreground">
                あなたの権限：{roleLabels[org.role]}
              </p>
              <Button asChild variant="link" size="sm" className="mt-3 px-0">
                <Link href="/onboarding">
                  <Plus />
                  組織を作成・届いた招待を確認
                  <ArrowUpRight />
                </Link>
              </Button>
            </div>
          </section>
          <section className="surface">
            <SectionTitle icon={UserRound} title="自分のプロフィール" />
            <div className="p-5">
              <NameForm
                key={profile.name}
                label="お名前"
                initial={profile.name}
                path="/api/profile"
                editable
                onSaved={refresh}
              />
              <p className="mb-1 mt-5 text-xs text-muted-foreground">
                メールアドレス
              </p>
              <p className="break-all text-sm">{profile.email}</p>
            </div>
          </section>
          <section className="surface">
            <SectionTitle icon={Plug} title="外部サービス連携" />
            <div className="divide-y">
              {[
                ["Zoom Phone", "架電の開始・通話履歴の自動記録"],
                ["OpenAI", "ヒアリングをもとに改善案を生成"],
                ["n8n", "業務の自動化フローを連携"],
              ].map(([name, desc]) => (
                <div
                  key={name}
                  className="flex items-center justify-between gap-4 p-5"
                >
                  <div>
                    <h3 className="font-medium">{name}</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {desc}
                    </p>
                  </div>
                  <StatusBadge>準備中</StatusBadge>
                </div>
              ))}
              <p className="p-5 text-xs leading-5 text-muted-foreground">
                現在は手動で架電記録・改善提案を登録できます。外部サービスの契約やAPIキーは必要ありません。
              </p>
            </div>
          </section>
        </div>
        <MembersSection />
      </div>
    </div>
  );
}
function SectionTitle({
  icon: Icon,
  title,
}: {
  icon: typeof Users;
  title: string;
}) {
  return (
    <h2 className="flex items-center gap-2 border-b px-5 py-4 font-semibold">
      <Icon className="size-4 text-muted-foreground" />
      {title}
    </h2>
  );
}
function NameForm({
  label,
  initial,
  path,
  editable,
  onSaved,
}: {
  label: string;
  initial: string;
  path: string;
  editable: boolean;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const name = new FormData(e.currentTarget).get("name");
        try {
          await api(path, "PATCH", { name });
          toast.success("変更を保存しました");
          await onSaved();
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block">
        <span className="field-label">{label}</span>
        <Input
          name="name"
          required
          maxLength={200}
          defaultValue={initial}
          disabled={!editable || busy}
        />
      </label>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {editable && (
        <Button size="sm" variant="outline" disabled={busy}>
          <Busy busy={busy}>変更を保存</Busy>
        </Button>
      )}
    </form>
  );
}
function MembersSection() {
  const { base, org, isAdmin, profile } = useWorkspace();
  const result = useApi<{
    data: Member[];
    invitations: Tables<"organization_invitations">[];
  }>(`${base}/members`);
  const members = result.data?.data || [];
  const canManage = (m: Member) =>
    isAdmin && (org.role === "owner" || ["sales", "viewer"].includes(m.role));
  return (
    <section className="surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          <Users className="size-4 text-muted-foreground" />
          メンバー
          <span className="text-xs font-normal text-muted-foreground">
            {members.length}名
          </span>
        </h2>
        {isAdmin && <MemberAction action="invite" />}
      </div>
      {result.error ? (
        <ErrorState error={result.error} retry={() => void result.mutate()} />
      ) : !result.data ? (
        <Loading />
      ) : (
        <>
          <div className="divide-y">
            {members.map((m) => (
              <div key={m.user_id} className="flex items-center gap-3 p-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-slate-600">
                  {m.profile?.name?.slice(0, 1) || "?"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {m.profile?.name || "メンバー"}
                    {m.user_id === profile.id && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        あなた
                      </span>
                    )}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {m.profile?.email}
                  </p>
                </div>
                <StatusBadge>{roleLabels[m.role as Role]}</StatusBadge>
                {canManage(m) && (
                  <div className="flex gap-1">
                    <MemberAction action="role" member={m} />
                    <MemberAction action="remove" member={m} />
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="border-t bg-muted/20 p-5">
            <p className="flex items-center gap-2 text-xs font-medium">
              <ShieldCheck className="size-4 text-primary" />
              組織の情報は、所属するメンバーだけが閲覧できます。
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              営業：企業・商談などの編集 ／ 閲覧のみ：データの参照
              <br />
              管理者：営業・閲覧メンバーの管理 ／ オーナー：すべての管理
              <br />
              組織には最低1名のオーナーが必要です。
            </p>
          </div>
          {isAdmin && (
            <div className="border-t p-5">
              <h3 className="mb-3 text-sm font-medium">招待中</h3>
              <p className="mb-4 text-xs leading-5 text-muted-foreground">
                招待メールは送信されません。相手にアプリのURLを共有してください。招待先のメールアドレスで新規登録・ログインすると「組織を作成・招待を確認」から参加できます。
              </p>
              {result.data.invitations.length ? (
                <div className="space-y-3">
                  {result.data.invitations.map((inv) => (
                    <div
                      className="flex items-center justify-between gap-3 rounded border bg-white p-3"
                      key={inv.id}
                    >
                      <div className="min-w-0">
                        <p className="break-all text-xs font-medium">
                          {inv.email}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {roleLabels[inv.role as Role]} · 期限{" "}
                          {dateTime(inv.expires_at, true)}
                        </p>
                      </div>
                      <MemberAction action="revoke" invitation={inv} />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  招待中のメンバーはいません。
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
function MemberAction({
  action,
  member,
  invitation,
}: {
  action: "invite" | "role" | "remove" | "revoke";
  member?: Member;
  invitation?: Tables<"organization_invitations">;
}) {
  const { base, org, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titles = {
    invite: "メンバーを招待",
    role: "権限を変更",
    remove: "メンバーを削除",
    revoke: "招待を取り消す",
  };
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const body =
        action === "invite"
          ? { action, email: fd.get("email"), role: fd.get("role") }
          : action === "role"
            ? { action, user_id: member?.user_id, role: fd.get("role") }
            : action === "remove"
              ? { action, user_id: member?.user_id }
              : { action, invitation_id: invitation?.id };
      await api(`${base}/members`, "POST", body);
      toast.success(
        action === "invite" ? "招待を登録しました" : "変更を保存しました",
      );
      setOpen(false);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const allowedRoles =
    action === "invite"
      ? org.role === "owner"
        ? ["admin", "sales", "viewer"]
        : ["sales", "viewer"]
      : org.role === "owner"
        ? ["owner", "admin", "sales", "viewer"]
        : ["sales", "viewer"];
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          setOpen(v);
          setError("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={action === "invite" ? "default" : "ghost"}
          size={action === "invite" ? "sm" : "icon-sm"}
          aria-label={`${member?.profile?.name || invitation?.email || ""}${titles[action]}`}
        >
          {action === "invite" ? (
            <>
              <MailPlus />
              招待
            </>
          ) : action === "role" ? (
            <Pencil className="size-3.5" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titles[action]}</DialogTitle>
          <DialogDescription>
            {action === "invite"
              ? "招待先と権限を指定してください。招待メールは送信されないため、相手にアプリのURLを共有してください。"
              : action === "remove"
                ? `${member?.profile?.name}さんの組織へのアクセス権を削除します。担当タスク・商談は操作したあなたへ引き継がれます。`
                : action === "role"
                  ? `${member?.profile?.name}さんに適用する権限を選んでください。`
                  : `${invitation?.email}への招待を取り消します。`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          {action === "invite" && (
            <label className="block">
              <span className="field-label">招待先メールアドレス</span>
              <Input name="email" type="email" required maxLength={254} />
            </label>
          )}
          {["invite", "role"].includes(action) && (
            <label className="block">
              <span className="field-label">権限</span>
              <select
                name="role"
                className="native-select"
                defaultValue={member?.role || "sales"}
              >
                {allowedRoles.map((role) => (
                  <option key={role} value={role}>
                    {roleLabels[role as Role]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              キャンセル
            </Button>
            <Button
              variant={
                action === "remove" || action === "revoke"
                  ? "destructive"
                  : "default"
              }
              disabled={busy}
            >
              <Busy busy={busy}>
                {action === "invite"
                  ? "招待を登録"
                  : action === "role"
                    ? "権限を変更"
                    : action === "remove"
                      ? "削除する"
                      : "招待を取り消す"}
              </Busy>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
