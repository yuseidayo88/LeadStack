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
  PhoneCall,
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
  Empty,
  StatusBadge,
} from "@/components/crm/common";
import { ResourceDialog } from "@/components/crm/resource-dialog";
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
};
export default function DashboardPage() {
  const { base, profile } = useWorkspace();
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
  const total = Object.values(d.counts.pipeline).reduce((sum, n) => sum + n, 0);
  return (
    <div className="page">
      <PageHeader
        title="ダッシュボード"
        description={`${profile.name}さん、今日の営業活動を確認しましょう。`}
        action={
          <ResourceDialog
            resource="companies"
            trigger={
              <Button>
                <Plus />
                企業を登録
              </Button>
            }
          />
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
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        {stats.map(({ label, value, unit, icon: Icon, note }) => (
          <div className="surface p-4 md:p-5" key={label}>
            <div className="mb-4 flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-slate-600">{label}</p>
              <Icon className="size-4 text-muted-foreground" />
            </div>
            <p className="text-3xl font-semibold tracking-tight">
              {value.toLocaleString()}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {unit}
              </span>
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">{note}</p>
          </div>
        ))}
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[1.3fr_1fr]">
        <div className="space-y-5">
          <TaskSection
            title="今日のタスク"
            tasks={d.tasks}
            href="/tasks"
            kind="today"
          />
          <TaskSection
            title="再架電予定"
            tasks={d.callbacks}
            href="/tasks?type=callback&period=all"
            kind="callback"
          />
        </div>
        <section className="surface">
          <div className="flex items-center justify-between border-b p-5">
            <div>
              <h2 className="font-semibold">商談パイプライン</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                組織全体 · {total} 件の商談
              </p>
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
        </section>
      </div>
    </div>
  );
}
function TaskSection({
  title,
  tasks,
  href,
  kind,
}: {
  title: string;
  tasks: Task[];
  href: string;
  kind: string;
}) {
  return (
    <section className="surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold">
          {kind === "today" ? (
            <ListTodo className="size-4 text-muted-foreground" />
          ) : (
            <PhoneCall className="size-4 text-muted-foreground" />
          )}
          {title}
        </h2>
        <Button asChild variant="link" size="sm">
          <Link href={href}>
            すべて見る
            <ArrowRight />
          </Link>
        </Button>
      </div>
      {tasks.length ? (
        <div className="divide-y">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-start gap-3 px-4 py-3">
              <TaskComplete task={t} />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.title}</p>
                <Link
                  href={`/companies/${t.company_id}`}
                  className="mt-1 block truncate text-xs text-muted-foreground hover:text-primary"
                >
                  {t.company_name || "企業詳細"}
                </Link>
              </div>
              <div className="shrink-0 space-y-1 text-right">
                <p className="text-xs text-muted-foreground">
                  {dateTime(t.due_at)}
                </p>
                <StatusBadge>{label(taskTypeLabels, t.type)}</StatusBadge>
              </div>
            </div>
          ))}
          {tasks.length === 30 && (
            <p className="p-4 text-xs text-muted-foreground">
              先頭30件を表示しています。タスク一覧で全件確認できます。
            </p>
          )}
        </div>
      ) : (
        <Empty
          title={
            kind === "today"
              ? "今日のタスクはありません"
              : "再架電の予定はありません"
          }
          description={
            kind === "today"
              ? "自分に割り当てられた今日のタスクが表示されます。"
              : "架電記録から、次回の再架電を予約できます。"
          }
        />
      )}
    </section>
  );
}
