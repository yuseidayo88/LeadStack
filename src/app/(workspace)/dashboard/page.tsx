"use client";
import Link from "next/link";
import {
  Phone,
  UserRoundCheck,
  CalendarCheck,
  Handshake,
  Trophy,
  ArrowRight,
  Plus,
  Search,
  ListTodo,
} from "lucide-react";
import { useWorkspace } from "@/components/layout/workspace";
import { useApi } from "@/lib/client-api";
import type { Tables } from "@/lib/database.types";
import {
  dateTime,
  stageLabels,
  label,
  taskTypeLabels,
} from "@/lib/crm/display";
import { Button } from "@/components/ui/button";
import {
  PageHeader,
  Loading,
  ErrorState,
  StatusBadge,
} from "@/components/crm/common";
import { ResourceDialog } from "@/components/crm/resource-dialog";
import {
  dashboardActions,
  dashboardDeadline,
  dashboardDeadlineLabels,
} from "@/lib/crm/dashboard-actions";
import { TaskComplete } from "@/components/crm/tasks-list";
type Task = Tables<"tasks"> & { company_name: string | null };
type Dashboard = {
  date: string;
  timezone: string;
  counts: {
    calls_today: number;
    connected_today: number;
    appointments_today: number;
    open_deals: number;
    won_deals: number;
    pipeline: Record<string, number>;
  };
  tasks: Task[];
  callbacks: Task[];
  overdue: Task[];
  missingNext: { id: string; name: string; last_contact_at: string | null }[];
};
export default function DashboardPage() {
  const { base } = useWorkspace();
  const result = useApi<Dashboard>(`${base}/dashboard`);
  if (result.error)
    return (
      <div className="page">
        <ErrorState error={result.error} retry={() => void result.mutate()} />
      </div>
    );
  if (!result.data) return <Loading />;
  const d = result.data;
  const stats = [
    {
      label: "今日の架電",
      value: d.counts.calls_today,
      unit: "件",
      icon: Phone,
      note: "組織全体",
    },
    {
      label: "担当者接続",
      value: d.counts.connected_today,
      unit: "件",
      icon: UserRoundCheck,
      note: "今日・組織全体",
    },
    {
      label: "アポイント",
      value: d.counts.appointments_today,
      unit: "件",
      icon: CalendarCheck,
      note: "今日・組織全体",
    },
    {
      label: "進行中の商談",
      value: d.counts.open_deals,
      unit: "件",
      icon: Handshake,
      note: "組織全体",
    },
    {
      label: "成約",
      value: d.counts.won_deals,
      unit: "件",
      icon: Trophy,
      note: "累計・組織全体",
    },
  ];
  const actions = dashboardActions(d.overdue, d.tasks, d.callbacks);
  const limited = [d.overdue, d.tasks, d.callbacks].some(
    (rows) => rows.length === 30,
  );
  const total = Object.values(d.counts.pipeline).reduce((sum, n) => sum + n, 0);
  return (
    <div className="page">
      <PageHeader
        title="ダッシュボード"
        action={
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/discover">
                <Search />
                企業を探す
              </Link>
            </Button>
            <ResourceDialog
              resource="companies"
              trigger={
                <Button variant="outline">
                  <Plus />
                  企業を登録
                </Button>
              }
            />
          </div>
        }
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-primary" />
        {new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "long",
          day: "numeric",
          weekday: "long",
        }).format(new Date(`${d.date}T00:00:00+09:00`))}{" "}
        · 日本時間
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {stats.map(({ label, value, unit, icon: Icon, note }) => (
          <div className="surface px-4 py-3" key={label}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-slate-600">{label}</p>
              <Icon className="size-4 text-muted-foreground" />
            </div>
            <p className="text-2xl font-semibold tracking-tight">
              {value.toLocaleString()}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {unit}
              </span>
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>
          </div>
        ))}
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[1.3fr_1fr]">
        <div className="space-y-5">
          <ActionList tasks={actions} date={d.date} limited={limited} />
          <details className="surface p-4">
            <summary className="cursor-pointer font-semibold">
              次のタスクがない担当企業（表示{d.missingNext.length}社）
            </summary>
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                自分の担当・対象外と終了を除く・先頭30件
              </p>
              {d.missingNext.length ? (
                d.missingNext.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between gap-3"
                  >
                    <Link href={`/companies/${c.id}`} className="text-primary">
                      {c.name}
                    </Link>
                    <ResourceDialog resource="tasks" companyId={c.id} />
                  </div>
                ))
              ) : (
                <p>該当する企業はありません。</p>
              )}
            </div>
          </details>
        </div>
        <details className="surface">
          <summary className="cursor-pointer px-4 py-3 font-semibold">
            商談パイプライン{" "}
            <span className="text-xs font-normal text-muted-foreground">
              組織全体 · {total}件
            </span>
          </summary>
          <div className="flex items-center justify-between border-t px-4 py-3">
            <div>
              <h2 className="text-sm font-medium">ステージ別の商談数</h2>
            </div>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              aria-label="商談一覧へ"
            >
              <Link href="/deals">
                <ArrowRight />
              </Link>
            </Button>
          </div>
          <div className="space-y-5 p-5">
            {Object.entries(stageLabels).map(([key, name], i) => {
              const n = d.counts.pipeline[key] || 0;
              return (
                <div key={key}>
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2">
                      <span className="flex size-5 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                        {i + 1}
                      </span>
                      {name}
                    </span>
                    <span className="font-medium">
                      {n}{" "}
                      <span className="font-normal text-muted-foreground">
                        件
                      </span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${key === "lost" ? "bg-slate-300" : key === "won" ? "bg-teal-700" : "bg-teal-500/70"}`}
                      style={{ width: `${total ? (n / total) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {total === 0 && (
            <p className="border-t p-5 text-xs leading-5 text-muted-foreground">
              まだ商談がありません。企業詳細から商談を作成すると、ここで進捗を確認できます。
            </p>
          )}
        </details>
      </div>
    </div>
  );
}
function ActionList({
  tasks,
  date,
  limited,
}: {
  tasks: Task[];
  date: string;
  limited: boolean;
}) {
  return (
    <section
      className="surface overflow-hidden"
      aria-labelledby="dashboard-actions-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2
            id="dashboard-actions-title"
            className="flex items-center gap-2 font-semibold"
          >
            <ListTodo className="size-4 text-muted-foreground" />
            対応するタスク{" "}
            <span className="text-sm text-primary">{tasks.length}件</span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            自分の未完了：今日・期限超過・再架電。期限の近い順に表示します。
          </p>
        </div>
        <Button asChild variant="link" size="sm">
          <Link href="/tasks?period=all">
            タスク一覧
            <ArrowRight />
          </Link>
        </Button>
      </div>
      {tasks.length ? (
        <ul className="divide-y" aria-label="対応するタスク">
          {tasks.map((task) => {
            const deadline = dashboardDeadline(task.due_at, date);
            return (
              <li key={task.id} className="flex items-start gap-2 px-4 py-3">
                <TaskComplete task={task} />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="break-words font-medium">{task.title}</p>
                  <Link
                    href={`/companies/${task.company_id}`}
                    className="block break-words text-sm text-primary hover:underline"
                  >
                    {task.company_name || "企業詳細"}
                  </Link>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={`rounded px-2 py-0.5 ${deadline === "overdue" ? "bg-red-50 text-red-700" : deadline === "today" ? "bg-teal-50 text-teal-800" : "bg-muted text-muted-foreground"}`}
                    >
                      {dashboardDeadlineLabels[deadline]}
                    </span>
                    {task.due_at && (
                      <time dateTime={task.due_at}>
                        {dateTime(task.due_at)}
                      </time>
                    )}
                    <StatusBadge>
                      {label(taskTypeLabels, task.type)}
                    </StatusBadge>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          今日・期限超過のタスクと再架電予定はありません。
        </p>
      )}
      {limited && (
        <p className="border-t p-4 text-xs text-muted-foreground">
          各区分の先頭30件をまとめて表示しています。全件はタスク一覧で確認できます。
        </p>
      )}
    </section>
  );
}
