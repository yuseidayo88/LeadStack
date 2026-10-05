"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Pencil, Check, RotateCcw, Circle, Search } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/layout/workspace";
import { api, useApi, message, type Paginated } from "@/lib/client-api";
import type { Tables } from "@/lib/database.types";
import {
  taskTypeLabels,
  taskStatusLabels,
  dateTime,
  options,
  label,
} from "@/lib/crm/display";
import { dayRange, tokyoDate } from "@/lib/dates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ResourceDialog, DeleteDialog } from "./resource-dialog";
import {
  PageHeader,
  Empty,
  Loading,
  ErrorState,
  Pagination,
  SelectFilter,
  StatusBadge,
  useDebounced,
  query,
} from "./common";
type Task = Tables<"tasks"> & {
  company_name: string | null;
  contact_name: string | null;
};
export function TaskComplete({
  task,
}: {
  task: Pick<Tables<"tasks">, "id" | "title" | "status" | "updated_at">;
}) {
  const { base, canWrite, refresh } = useWorkspace();
  const [busy, setBusy] = useState(false);
  if (!canWrite) return <Circle className="size-4 text-muted-foreground" />;
  const done = task.status === "completed";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`${task.title}を${done ? "未完了に戻す" : "完了する"}`}
      disabled={busy || task.status === "cancelled"}
      onClick={async () => {
        setBusy(true);
        try {
          await api(
            `${base}/tasks/${task.id}`,
            "PATCH",
            {
              status: done ? "todo" : "completed",
            },
            undefined,
            undefined,
            task.updated_at,
          );
          toast.success(done ? "未完了に戻しました" : "タスクを完了しました");
          await refresh();
        } catch (e) {
          toast.error(message(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {done ? (
        <RotateCcw className="size-4 text-primary" />
      ) : (
        <Check className="size-4 text-muted-foreground" />
      )}
    </Button>
  );
}
export function TasksList() {
  const { base, members, profile } = useWorkspace();
  const params = useSearchParams();
  const companyId = params.get("company_id") || undefined;
  const [period, setPeriod] = useState(params.get("period") || "today");
  const [status, setStatus] = useState("todo");
  const [owner, setOwner] = useState(profile.id);
  const [type, setType] = useState(params.get("type") || "");
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const [page, setPage] = useState(1);
  const { start, end } = dayRange(tokyoDate());
  const result = useApi<Paginated<Task>>(
    `${base}/tasks?${query({ company_id: companyId, search: term, status, type, assigned_user_id: owner, page, sort: "due_at", direction: "asc", due_before: period === "today" ? end : period === "overdue" ? start : undefined, due_after: period === "today" ? start : period === "upcoming" ? end : undefined })}`,
  );
  return (
    <div className="page">
      <PageHeader
        title="タスク"
        description="今日やることを明確に。フォローの機会を逃さずに。"
        action={<ResourceDialog resource="tasks" companyId={companyId} />}
      />
      {companyId && (
        <p className="flex gap-3 text-xs text-muted-foreground">
          企業で絞り込み中
          <Link
            href="/tasks"
            className="text-primary"
            onClick={() => {
              setPage(1);
            }}
          >
            すべての企業を表示
          </Link>
        </p>
      )}
      <div className="surface overflow-hidden">
        <Tabs
          value={period}
          onValueChange={(v) => {
            setPeriod(v);
            setPage(1);
          }}
        >
          <div className="overflow-x-auto border-b px-4 pt-2">
            <TabsList className="h-11 w-max gap-5 bg-transparent p-0">
              {[
                ["today", "今日"],
                ["overdue", "期限切れ"],
                ["upcoming", "今後"],
                ["all", "すべて・期限未設定"],
              ].map(([key, l]) => (
                <TabsTrigger
                  key={key}
                  value={key}
                  className="h-full rounded-none border-0 border-b-2 border-transparent bg-transparent px-1 shadow-none data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:shadow-none"
                >
                  {l}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value={period} className="mt-0">
            <div className="flex flex-wrap gap-2 border-b p-4">
              <div className="relative w-full sm:w-56">
                <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input
                  className="bg-white pl-9"
                  placeholder="タスクを検索…"
                  aria-label="タスクを検索"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
              <SelectFilter
                label="担当営業"
                value={owner}
                onChange={(v) => {
                  setOwner(v);
                  setPage(1);
                }}
                options={members.map((m) => ({
                  value: m.user_id,
                  label: m.profile?.name || "メンバー",
                }))}
              />
              <SelectFilter
                label="種類"
                value={type}
                onChange={(v) => {
                  setType(v);
                  setPage(1);
                }}
                options={options(taskTypeLabels)}
              />
              <SelectFilter
                label="状態"
                value={status}
                onChange={(v) => {
                  setStatus(v);
                  setPage(1);
                }}
                options={options(taskStatusLabels)}
              />
            </div>
            {result.error ? (
              <ErrorState
                error={result.error}
                retry={() => void result.mutate()}
              />
            ) : !result.data ? (
              <Loading />
            ) : !result.data.data.length ? (
              <Empty
                title="対象のタスクはありません"
                description="期間や担当営業を切り替えるか、新しいタスクを追加してください。"
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table min-w-[750px]">
                  <thead>
                    <tr>
                      <th>
                        <span className="sr-only">完了操作</span>
                      </th>
                      <th>タスク / 企業</th>
                      <th>種類</th>
                      <th>期限（日本時間）</th>
                      <th>担当営業</th>
                      <th>状態</th>
                      <th>
                        <span className="sr-only">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.data.map((t) => (
                      <tr key={t.id}>
                        <td className="w-10">
                          <TaskComplete task={t} />
                        </td>
                        <td>
                          <p
                            className={
                              t.status === "completed"
                                ? "text-muted-foreground line-through"
                                : "font-medium"
                            }
                          >
                            {t.title}
                          </p>
                          <Link
                            href={`/companies/${t.company_id}`}
                            className="mt-1 block text-xs text-muted-foreground hover:text-primary"
                          >
                            {t.company_name || "企業詳細"}
                            {t.contact_name && ` / ${t.contact_name}`}
                          </Link>
                          {t.description && (
                            <p className="mt-1 max-w-md whitespace-pre-wrap text-xs text-muted-foreground">
                              {t.description}
                            </p>
                          )}
                        </td>
                        <td>
                          <StatusBadge>
                            {label(taskTypeLabels, t.type)}
                          </StatusBadge>
                        </td>
                        <td
                          className={`whitespace-nowrap text-xs ${t.status === "todo" && t.due_at && Date.parse(t.due_at) < Date.parse(start) ? "text-destructive" : "text-muted-foreground"}`}
                        >
                          {dateTime(t.due_at)}
                        </td>
                        <td className="text-xs">
                          {members.find((m) => m.user_id === t.assigned_user_id)
                            ?.profile?.name || "—"}
                        </td>
                        <td>
                          <StatusBadge value={t.status}>
                            {label(taskStatusLabels, t.status)}
                          </StatusBadge>
                        </td>
                        <td>
                          <div className="flex gap-1">
                            <ResourceDialog
                              resource="tasks"
                              record={t}
                              companyId={companyId}
                              trigger={
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`${t.title}を編集`}
                                >
                                  <Pencil className="size-3.5" />
                                </Button>
                              }
                            />
                            <DeleteDialog
                              resource="tasks"
                              id={t.id}
                              name={t.title}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination
              page={page}
              count={result.data?.count}
              onChange={setPage}
            />
          </TabsContent>
        </Tabs>
      </div>
      <p className="text-xs text-muted-foreground">
        日付の区切りは日本時間（JST）です。
      </p>
    </div>
  );
}
