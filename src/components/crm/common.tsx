"use client";
import { type ReactNode, useEffect, useState } from "react";
import {
  AlertCircle,
  Inbox,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ApiError, message } from "@/lib/client-api";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "./searchable-select";
export function Loading({ label = "読み込み中" }: { label?: string }) {
  return (
    <div role="status" className="space-y-4 p-6">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-8 w-1/3" />
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-5 text-red-800"
    >
      <div className="flex items-center gap-2">
        <AlertCircle className="size-4" />
        {message(error)}
      </div>
      {error instanceof ApiError && error.status === 401 ? (
        <Button asChild variant="outline">
          <a href="/login">ログインし直す</a>
        </Button>
      ) : (
        retry && (
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            再試行
          </Button>
        )
      )}
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "space-y-2 px-4 py-4 text-sm text-muted-foreground"
          : "flex flex-col items-center gap-3 px-6 py-7 text-center"
      }
    >
      {!compact && (
        <div className="rounded-xl bg-muted p-3 text-muted-foreground">
          <Inbox className="size-6" />
        </div>
      )}
      <p className="font-medium">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action}
    </div>
  );
}
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
export function StatusBadge({
  value,
  children,
}: {
  value?: string | null;
  children: ReactNode;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "whitespace-nowrap border-transparent font-normal",
        value === "won" ||
          value === "completed" ||
          value === "accepted" ||
          value === "appointment"
          ? "bg-emerald-50 text-emerald-800"
          : value === "lost" || value === "rejected"
            ? "bg-red-50 text-red-800"
            : value === "active" ||
                value === "proposal" ||
                value === "negotiation" ||
                value === "connected"
              ? "bg-teal-50 text-teal-800"
              : "bg-slate-100 text-slate-600",
      )}
    >
      {children}
    </Badge>
  );
}
export function Pagination({
  page,
  count,
  pageSize = 25,
  onChange,
}: {
  page: number;
  count?: number;
  pageSize?: number;
  onChange: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil((count ?? 0) / pageSize));
  useEffect(() => {
    if (count !== undefined && page > pages) onChange(pages);
  }, [count, page, pages, onChange]);
  if (count === 0) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-t px-4 py-3 text-xs text-muted-foreground">
      <span>
        {count === undefined
          ? "読み込み中…"
          : count === 0
            ? "0 件"
            : `${count.toLocaleString()} 件中 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, count)} 件`}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="前のページ"
          disabled={count === undefined || page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <span>
          {page} / {pages}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="次のページ"
          disabled={count === undefined || page >= pages}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
export function Busy({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
    </>
  );
}
export function useDebounced<T>(value: T, delay = 300) {
  const [result, setResult] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setResult(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return result;
}
export function query(
  values: Record<string, string | number | null | undefined>,
) {
  const q = new URLSearchParams();
  Object.entries(values).forEach(([k, v]) => {
    if (v !== "" && v != null) q.set(k, String(v));
  });
  return q.toString();
}
export function SelectFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <SearchableSelect
      className="w-auto max-w-full"
      label={label}
      value={value}
      onChange={onChange}
      options={[{ value: "", label: `${label}：すべて` }, ...options]}
    />
  );
}
