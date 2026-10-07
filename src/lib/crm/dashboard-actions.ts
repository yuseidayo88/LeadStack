import { dayRange } from "@/lib/dates";

type Action = {
  id: string;
  status: string;
  due_at: string | null;
  updated_at: string;
};

function newerVersion(current: string, previous: string) {
  const difference = Date.parse(current) - Date.parse(previous);
  if (difference !== 0) return difference > 0;
  // Postgres updated_at retains microseconds that Date.parse truncates.
  const fraction = (value: string) =>
    (value.match(/\.(\d+)/)?.[1] || "").padEnd(9, "0");
  return fraction(current) > fraction(previous);
}

export function dashboardActions<T extends Action>(
  ...groups: readonly T[][]
): T[] {
  const unique = new Map<string, T>();
  for (const task of groups.flat()) {
    const previous = unique.get(task.id);
    if (!previous || newerVersion(task.updated_at, previous.updated_at))
      unique.set(task.id, task);
  }
  const due = (task: T) => (task.due_at ? Date.parse(task.due_at) : Infinity);
  return [...unique.values()]
    .filter((task) => task.status === "todo")
    .sort((a, b) => due(a) - due(b) || a.id.localeCompare(b.id));
}

export function dashboardDeadline(dueAt: string | null, date: string) {
  if (!dueAt) return "unscheduled";
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return "unscheduled";
  const { start, end } = dayRange(date);
  return due < Date.parse(start)
    ? "overdue"
    : due < Date.parse(end)
      ? "today"
      : "upcoming";
}

export const dashboardDeadlineLabels = {
  overdue: "期限超過",
  today: "今日",
  upcoming: "今後",
  unscheduled: "期限未設定",
};
