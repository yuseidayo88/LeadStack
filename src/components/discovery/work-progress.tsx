"use client";

import { useEffect, useState } from "react";

/** A count of completed work, not an invented percentage of elapsed time. */
export function WorkProgress({
  label,
  value,
  total,
  description,
}: {
  label: string;
  value: number | null;
  total: number;
  description: string;
}) {
  const maximum = Math.max(1, total);
  const completed =
    value === null ? null : Math.max(0, Math.min(value, maximum));
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {description}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={maximum}
        aria-valuenow={completed ?? undefined}
        aria-valuetext={description}
        className="h-2 overflow-hidden rounded-full bg-primary/10"
      >
        <div
          aria-hidden="true"
          className={`h-full rounded-full bg-primary ${completed === null ? "w-1/3 motion-safe:animate-pulse" : "motion-safe:transition-[width] motion-safe:duration-300"}`}
          style={
            completed === null
              ? undefined
              : { width: `${(completed / maximum) * 100}%` }
          }
        />
      </div>
    </div>
  );
}

export function ProgressClock({
  startedAt,
  running,
  waitingUntil,
}: {
  startedAt: number | null;
  running: boolean;
  waitingUntil?: string | null;
}) {
  if (!running || startedAt === null) return null;
  return <RunningClock startedAt={startedAt} waitingUntil={waitingUntil} />;
}

function RunningClock({
  startedAt,
  waitingUntil,
}: {
  startedAt: number;
  waitingUntil?: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const remaining = waitingUntil
    ? Math.max(0, Math.ceil((Date.parse(waitingUntil) - now) / 1000))
    : null;
  return (
    <p className="text-xs tabular-nums text-muted-foreground">
      経過{" "}
      {elapsed >= 60
        ? `${Math.floor(elapsed / 60)}分${elapsed % 60}秒`
        : `${elapsed}秒`}
      {remaining !== null &&
        ` · ${remaining > 0 ? `次の確認まであと${remaining}秒` : "次の確認を準備中"}`}
    </p>
  );
}
