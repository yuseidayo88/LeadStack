"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Phone,
  Mail,
  FileText,
  Handshake,
  RefreshCw,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/layout/workspace";
import { api, useApi, type Paginated, message } from "@/lib/client-api";
import {
  type Activity,
  activityLabels,
  callResultLabels,
  label,
  dateTime,
  localInputDate,
  toTimestamp,
} from "@/lib/crm/display";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Loading,
  ErrorState,
  Empty,
  Pagination,
  StatusBadge,
  Busy,
  SelectFilter,
  query,
} from "./common";
import { Lookup } from "./lookup";
export function ActivityDialog({
  companyId,
  phone,
  initialType = "call",
}: {
  companyId: string;
  phone?: string | null;
  initialType?: string;
}) {
  const { base, canWrite, members, profile, refresh } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const next = useApi<{ company: { id: string; name: string } | null }>(
    open ? `${base}/companies/${companyId}/next` : null,
  );
  const nextCompany = next.data?.company;
  const [result, setResult] = useState("connected");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [type, setType] = useState(initialType);
  const [contact, setContact] = useState("");
  const [callback, setCallback] = useState(false);
  if (!canWrite) return null;
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const goNext =
      (e.nativeEvent as SubmitEvent).submitter?.getAttribute("name") === "next";
    const fd = new FormData(e.currentTarget);
    const str = (key: string) => String(fd.get(key) || "").trim();
    try {
      const body: Record<string, unknown> = {
        company_id: companyId,
        contact_id: contact || null,
        type,
        title: str("title") || null,
        content: str("content") || null,
        occurred_at: toTimestamp(str("occurred_at")),
      };
      if (type === "call")
        Object.assign(body, {
          phone_number: str("phone_number") || null,
          result: str("result") || null,
          started_at: toTimestamp(str("started_at")),
          ended_at: toTimestamp(str("ended_at")),
          duration_seconds: str("duration_seconds")
            ? Number(str("duration_seconds"))
            : null,
          ...(callback
            ? {
                callback: {
                  title: str("callback_title"),
                  due_at: toTimestamp(str("callback_due")),
                  assigned_user_id: str("callback_owner"),
                },
              }
            : {}),
        });
      await api(`${base}/activities`, "POST", body);
      toast.success(
        callback && type === "call"
          ? "活動と再架電タスクを保存しました"
          : "活動を保存しました",
      );
      setOpen(false);
      await refresh();
      if (goNext && nextCompany) router.push(`/companies/${nextCompany.id}`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          setOpen(v);
          if (v) {
            setType(initialType);
            setCallback(false);
            setResult("connected");
            setError("");
            setContact("");
          }
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          {initialType === "call" ? <Phone /> : <Plus />}
          {initialType === "call" ? "架電を記録" : "活動を追加"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>営業活動を記録</DialogTitle>
          <DialogDescription>
            会話の内容と次のアクションを残しましょう。日時は日本時間です。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className="field-label">活動の種類</span>
              <select
                className="native-select"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                {Object.entries(activityLabels)
                  .filter(([k]) => k !== "status_change")
                  .map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span className="field-label">活動日時</span>
              <Input
                type="datetime-local"
                name="occurred_at"
                defaultValue={localInputDate(new Date().toISOString())}
                required
              />
            </label>
            <div className="sm:col-span-2">
              <Lookup
                resource="contacts"
                label="企業担当者"
                companyId={companyId}
                value={contact}
                onChange={setContact}
              />
            </div>
            <label className="sm:col-span-2">
              <span className="field-label">件名</span>
              <Input
                name="title"
                maxLength={300}
                placeholder="例：業務課題のヒアリング"
              />
            </label>
            {type === "call" && (
              <>
                <label>
                  <span className="field-label">架電先電話番号</span>
                  <Input
                    name="phone_number"
                    defaultValue={phone || ""}
                    maxLength={200}
                  />
                </label>
                <label>
                  <span className="field-label">架電結果</span>
                  <select
                    name="result"
                    className="native-select"
                    value={result}
                    onChange={(e) => {
                      setResult(e.target.value);
                      if (e.target.value === "callback") setCallback(true);
                    }}
                  >
                    {Object.entries(callResultLabels).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <details className="rounded-md border p-3 sm:col-span-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    通話時間の詳細（任意）
                  </summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label>
                      <span className="field-label">開始日時</span>
                      <Input type="datetime-local" name="started_at" />
                    </label>
                    <label>
                      <span className="field-label">終了日時</span>
                      <Input type="datetime-local" name="ended_at" />
                    </label>
                    <label>
                      <span className="field-label">通話時間（秒）</span>
                      <Input
                        type="number"
                        name="duration_seconds"
                        min={0}
                        step={1}
                      />
                    </label>
                  </div>
                </details>
              </>
            )}
            <label className="sm:col-span-2">
              <span className="field-label">活動メモ</span>
              <Textarea
                name="content"
                maxLength={10000}
                rows={4}
                placeholder="お話しした内容、わかった課題、次に確認すること…"
              />
            </label>
            {type === "call" && (
              <div className="space-y-4 rounded-lg border bg-muted/40 p-4 sm:col-span-2">
                <label className="flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={callback}
                    disabled={result === "callback"}
                    onChange={(e) => setCallback(e.target.checked)}
                  />
                  次回の再架電タスクを作成
                </label>
                {callback && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="sm:col-span-2">
                      <span className="field-label">再架電タスク名</span>
                      <Input
                        name="callback_title"
                        required
                        defaultValue="再架電・フォロー"
                        maxLength={300}
                      />
                    </label>
                    <label>
                      <span className="field-label">再架電日時</span>
                      <Input
                        name="callback_due"
                        type="datetime-local"
                        required
                      />
                    </label>
                    <label>
                      <span className="field-label">再架電の担当営業</span>
                      <select
                        name="callback_owner"
                        className="native-select"
                        defaultValue={profile.id}
                      >
                        {members.map((m) => (
                          <option key={m.user_id} value={m.user_id}>
                            {m.profile?.name || "メンバー"}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </div>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-destructive">
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
            <Button disabled={busy}>
              <Busy busy={busy}>活動を保存</Busy>
            </Button>
            {nextCompany && (
              <Button
                name="next"
                title={`会社名順の次の企業：${nextCompany.name}`}
                disabled={busy}
                variant="outline"
              >
                保存して次の企業へ
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function ActivityTimeline({
  companyId,
  phone,
}: {
  companyId: string;
  phone?: string | null;
}) {
  const { base, members } = useWorkspace();
  const [page, setPage] = useState(1);
  const [type, setType] = useState("");
  const rows = useApi<Paginated<Activity>>(
    `${base}/activities?${query({ company_id: companyId, page, type })}`,
  );
  return (
    <section className="surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <h2 className="font-semibold">営業活動</h2>
        <div className="flex gap-2">
          <SelectFilter
            label="活動の種類"
            value={type}
            onChange={(v) => {
              setType(v);
              setPage(1);
            }}
            options={Object.entries(activityLabels).map(([value, label]) => ({
              value,
              label,
            }))}
          />
          <ActivityDialog
            companyId={companyId}
            phone={phone}
            initialType="memo"
          />
        </div>
      </div>
      {rows.error ? (
        <ErrorState error={rows.error} retry={() => void rows.mutate()} />
      ) : !rows.data ? (
        <Loading />
      ) : !rows.data.data.length ? (
        <Empty
          title="活動はまだありません"
          description="架電や商談の内容を記録して、チームに共有しましょう。"
        />
      ) : (
        <ol className="px-5 py-6">
          {rows.data.data.map((a, i) => {
            const Icon =
              a.type === "call"
                ? Phone
                : a.type === "meeting"
                  ? Handshake
                  : a.type === "email"
                    ? Mail
                    : a.type === "status_change"
                      ? RefreshCw
                      : FileText;
            return (
              <li key={a.id} className="relative flex gap-4 pb-8 last:pb-0">
                {i < rows.data!.data.length - 1 && (
                  <span className="absolute bottom-0 left-[15px] top-8 w-px bg-border" />
                )}
                <div className="z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-white text-muted-foreground">
                  <Icon className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {a.title || label(activityLabels, a.type)}
                    </span>
                    <StatusBadge>{label(activityLabels, a.type)}</StatusBadge>
                    {a.call_details?.result && (
                      <StatusBadge value={a.call_details.result}>
                        {label(callResultLabels, a.call_details.result)}
                      </StatusBadge>
                    )}
                    <time className="ml-auto text-xs text-muted-foreground">
                      {dateTime(a.occurred_at)}
                    </time>
                  </div>
                  {a.content && (
                    <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">
                      {a.content}
                    </p>
                  )}
                  <p className="mt-3 text-xs text-muted-foreground">
                    {members.find((m) => m.user_id === a.user_id)?.profile
                      ?.name || "以前のメンバー"}
                    {a.call_details?.phone_number &&
                      ` · ${a.call_details.phone_number}`}
                    {a.call_details?.duration_seconds != null &&
                      ` · ${a.call_details.duration_seconds}秒`}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <Pagination page={page} count={rows.data?.count} onChange={setPage} />
    </section>
  );
}
