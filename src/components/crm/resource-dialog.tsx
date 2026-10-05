"use client";
import { useId, useState, useRef, type ReactNode } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/layout/workspace";
import { api, ApiError, message } from "@/lib/client-api";
import { localInputDate, toTimestamp } from "@/lib/crm/display";
import type { Resource } from "@/lib/crm/schemas";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fields, resourceNames, type Field } from "./resource-fields";
import { Busy } from "./common";
import { Lookup } from "./lookup";
import { cn } from "@/lib/utils";
export type RecordData = { id?: string; [key: string]: unknown };
export function ResourceDialog({
  resource,
  record,
  companyId,
  trigger,
  onSaved,
  defaults,
}: {
  resource: Resource;
  record?: RecordData;
  companyId?: string;
  trigger?: ReactNode;
  onSaved?: (record: RecordData) => void;
  defaults?: RecordData;
}) {
  const { canWrite } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  if (!canWrite) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!saving) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        {trigger || (
          <Button size="sm" variant={record ? "outline" : "default"}>
            {record ? <Pencil /> : <Plus />}
            {resourceNames[resource]}
            {record ? "を編集" : "を追加"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            {resourceNames[resource]}
            {record ? "を編集" : "を追加"}
          </DialogTitle>
          <DialogDescription>
            必要な情報を入力してください。* は必須項目です。
          </DialogDescription>
        </DialogHeader>
        <RecordForm
          key={record?.id || "new"}
          resource={resource}
          record={record}
          companyId={companyId}
          defaults={defaults}
          onBusy={setSaving}
          cancel={() => setOpen(false)}
          saved={(r) => {
            setOpen(false);
            onSaved?.(r);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
function RecordForm({
  resource,
  record,
  companyId,
  defaults,
  cancel,
  saved,
  onBusy,
}: {
  resource: Resource;
  record?: RecordData;
  companyId?: string;
  defaults?: RecordData;
  onBusy: (busy: boolean) => void;
  cancel: () => void;
  saved: (r: RecordData) => void;
}) {
  const { base, profile, members, refresh } = useWorkspace();
  const uid = useId();
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const result: Record<string, string | boolean> = {
      company_id: companyId || String(record?.company_id || ""),
      contact_id: String(record?.contact_id || ""),
    };
    for (const f of fields[resource]) {
      const value =
        record?.[f.key] ??
        defaults?.[f.key] ??
        f.default ??
        (f.required && f.type === "member" ? profile.id : "");
      result[f.key] =
        f.type === "datetime-local"
          ? localInputDate(String(value || ""))
          : f.type === "checkbox"
            ? Boolean(value)
            : String(value);
    }
    const config = (record?.automation_config ??
      defaults?.automation_config) as {
      trigger?: string;
      steps?: string[];
      tools?: string[];
    } | null;
    result.auto_trigger = config?.trigger || "";
    result.auto_steps = config?.steps?.join("\n") || "";
    result.auto_tools = config?.tools?.join("\n") || "";
    return result;
  });
  const submitting = useRef(false);
  const creationId = useRef("");
  const editVersion = useRef(
    record?.updated_at ? String(record.updated_at) : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  function set(key: string, value: string | boolean) {
    setValues((v) => ({
      ...v,
      [key]: value,
      ...(key === "company_id" ? { contact_id: "" } : {}),
    }));
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current) return;
    setError("");
    setFieldErrors({});
    if (resource !== "companies" && !values.company_id) {
      setError("企業を選択してください");
      return;
    }
    if (
      resource === "proposals" &&
      values.type === "automate" &&
      !String(values.auto_trigger).trim() &&
      (String(values.auto_steps).trim() || String(values.auto_tools).trim())
    ) {
      setError(
        "自動化の手順やツールを保存するには、きっかけを入力してください",
      );
      return;
    }
    if (!creationId.current) creationId.current = crypto.randomUUID();
    submitting.current = true;
    setBusy(true);
    onBusy(true);
    try {
      const data: Record<string, unknown> = {};
      for (const f of fields[resource]) {
        const value = values[f.key];
        data[f.key] =
          f.type === "checkbox"
            ? Boolean(value)
            : value === ""
              ? null
              : f.type === "number"
                ? Number(value)
                : f.type === "datetime-local"
                  ? toTimestamp(String(value))
                  : String(value).trim();
      }
      if (resource !== "companies") data.company_id = values.company_id;
      if (["tasks", "deals"].includes(resource))
        data.contact_id = values.contact_id || null;
      if (resource === "proposals") {
        data.generated_by =
          record?.generated_by || defaults?.generated_by || "human";
        data.automation_config =
          values.type === "automate" && values.auto_trigger
            ? {
                trigger: String(values.auto_trigger).trim(),
                steps: String(values.auto_steps)
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
                tools: String(values.auto_tools)
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : null;
      }
      const result = await api<{ data: RecordData }>(
        `${base}/${resource}${record?.id ? `/${record.id}` : ""}`,
        record ? "PATCH" : "POST",
        data,
        undefined,
        record ? undefined : creationId.current,
        editVersion.current,
      );
      toast.success(`${resourceNames[resource]}を保存しました`);
      saved(result.data);
      void refresh().catch(() =>
        toast.error(
          "保存済みですが一覧を更新できませんでした。画面を再読み込みしてください",
        ),
      );
    } catch (e) {
      setError(message(e));
      if (e instanceof ApiError) setFieldErrors(e.fields);
    } finally {
      submitting.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  const memberOptions = Object.fromEntries(
    members.map((m) => [
      m.user_id,
      m.profile?.name || m.profile?.email || "メンバー",
    ]),
  );
  return (
    <form onSubmit={submit} className="space-y-5">
      <fieldset
        disabled={busy}
        className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2"
      >
        {resource !== "companies" && !companyId && (
          <div className="sm:col-span-2">
            <Lookup
              resource="companies"
              label="企業"
              required
              value={String(values.company_id)}
              onChange={(v) => set("company_id", v)}
            />
          </div>
        )}
        {fields[resource].map((f) => (
          <FieldInput
            key={f.key}
            field={f.type === "member" ? { ...f, options: memberOptions } : f}
            id={`${uid}-${f.key}`}
            value={values[f.key]}
            set={(v) => set(f.key, v)}
            errors={fieldErrors[f.key]}
          />
        ))}
        {["tasks", "deals"].includes(resource) && values.company_id && (
          <div className="sm:col-span-2">
            <Lookup
              key={String(values.company_id)}
              resource="contacts"
              label="企業担当者"
              value={String(values.contact_id)}
              onChange={(v) => set("contact_id", v)}
              companyId={String(values.company_id)}
            />
          </div>
        )}
        {resource === "proposals" && values.type === "automate" && (
          <div className="space-y-4 rounded-md border bg-muted/40 p-4 sm:col-span-2">
            <p className="text-sm font-medium">自動化の設計</p>
            <p className="text-xs text-muted-foreground">
              実行される設定ではなく、お客様に提案する流れを記録します。
            </p>
            {[
              {
                key: "auto_trigger",
                label: "きっかけ",
                hint: "例：問い合わせメールを受信",
              },
              {
                key: "auto_steps",
                label: "処理の流れ",
                type: "textarea",
                hint: "1行に1ステップを入力",
              },
              {
                key: "auto_tools",
                label: "利用ツール",
                type: "textarea",
                hint: "1行に1ツールを入力",
              },
            ].map((f) => (
              <FieldInput
                key={f.key}
                field={f as Field}
                id={`${uid}-${f.key}`}
                value={values[f.key]}
                set={(v) => set(f.key, v)}
              />
            ))}
          </div>
        )}
      </fieldset>
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
          onClick={cancel}
        >
          キャンセル
        </Button>
        <Button disabled={busy} type="submit">
          <Busy busy={busy}>保存</Busy>
        </Button>
      </DialogFooter>
    </form>
  );
}
export function FieldInput({
  field: f,
  id,
  value,
  set,
  errors,
}: {
  field: Field;
  id: string;
  value: string | boolean;
  set: (v: string | boolean) => void;
  errors?: string[];
}) {
  const props = {
    id,
    name: f.key,
    required: f.required,
    "aria-invalid": !!errors,
    "aria-describedby": f.hint || errors ? `${id}-hint` : undefined,
  };
  return (
    <div className={cn(f.wide && "sm:col-span-2")}>
      <label htmlFor={id} className="field-label">
        {f.label}
        {f.required && (
          <span aria-hidden="true" className="ml-1 text-destructive">
            *
          </span>
        )}
      </label>
      {f.type === "checkbox" ? (
        <input
          {...props}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => set(e.target.checked)}
          className="size-4"
        />
      ) : f.type === "textarea" ? (
        <Textarea
          {...props}
          value={String(value)}
          onChange={(e) => set(e.target.value)}
          rows={3}
          maxLength={10000}
        />
      ) : f.type === "select" || f.type === "member" ? (
        <select
          {...props}
          className="native-select"
          value={String(value)}
          onChange={(e) => set(e.target.value)}
        >
          {!f.required && <option value="">未設定</option>}
          {f.required && !value && <option value="">選択してください</option>}
          {Object.entries(f.options || {}).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      ) : (
        <>
          <Input
            {...props}
            type={f.type || "text"}
            value={String(value)}
            onChange={(e) => set(e.target.value)}
            maxLength={f.key === "title" || f.key === "name" ? 200 : 1000}
            min={f.type === "number" ? (f.min ?? 0) : undefined}
            max={f.max}
            step={f.type === "number" ? 1 : undefined}
            list={f.suggestions ? `${id}-list` : undefined}
          />
          {f.suggestions && (
            <datalist id={`${id}-list`}>
              {f.suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </>
      )}
      {(errors || f.hint) && (
        <p
          id={`${id}-hint`}
          className={cn(
            "mt-1 text-xs",
            errors ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {errors?.join("、") || f.hint}
        </p>
      )}
    </div>
  );
}
export function DeleteDialog({
  resource,
  id,
  name,
  onDeleted,
}: {
  resource: Resource;
  id: string;
  name: string;
  onDeleted?: () => void;
}) {
  const { base, canWrite, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!canWrite) return null;
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(`${base}/${resource}/${id}`, "DELETE");
      toast.success("削除しました");
      setOpen(false);
      onDeleted?.();
      await refresh();
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
        if (!busy) setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`${name}を削除`}>
          <Trash2 className="size-4 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{resourceNames[resource]}を削除しますか？</DialogTitle>
          <DialogDescription>
            「{name}」を削除します。
            {resource === "companies"
              ? "この企業の担当者・活動・タスク・商談・ヒアリング・提案も削除されます。"
              : ""}
            この操作は取り消せません。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            キャンセル
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Busy busy={busy}>削除する</Busy>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
