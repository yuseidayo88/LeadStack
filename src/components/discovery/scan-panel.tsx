"use client";

import { Search, Square, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Busy } from "@/components/crm/common";
import type { useDiscoveryScan } from "@/components/discovery/use-discovery-scan";
import { scanProgressState } from "@/lib/discovery/progress";
import { ProgressClock, WorkProgress } from "./work-progress";

type Props = {
  scan: ReturnType<typeof useDiscoveryScan>;
  canWrite: boolean;
  configured: boolean | undefined;
  hasCriteria: boolean;
  requiresPhone: boolean;
  disabled: boolean;
  resultsUpdating: boolean;
  resultsError: boolean;
  onStart: (resume: boolean) => void;
};

export function DiscoveryScanPanel({
  scan,
  canWrite,
  configured,
  hasCriteria,
  requiresPhone,
  disabled,
  resultsUpdating,
  resultsError,
  onStart,
}: Props) {
  const canStart =
    canWrite &&
    configured &&
    hasCriteria &&
    !disabled &&
    !scan.running &&
    !scan.blocked;
  const event = scan.event;
  const progress = scanProgressState({
    ...scan,
    resultsUpdating,
    resultsError,
  });
  const progressVisible =
    !!event ||
    scan.running ||
    scan.finishing ||
    scan.startedAt !== null ||
    scan.cancellation !== "idle";
  const goalPending =
    scan.running && scan.requestPending && event?.reason === "target";
  return (
    <div
      id="discovery-search-progress"
      className="scroll-mt-4 space-y-3 rounded-md bg-slate-50 p-3"
      aria-label="外部の企業検索"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">条件に合う企業を検索</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            一致20社を目安に、最大200社を確認します。途中で停止・再開できます。
          </p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onStart(false)} disabled={!canStart}>
              <Busy busy={scan.running}>
                <Search />
                {scan.running
                  ? "検索中…"
                  : scan.finishing
                    ? "結果を反映中…"
                    : "条件に合う企業を探す"}
              </Busy>
            </Button>
            {scan.cancellation !== "idle" ? (
              <Button
                variant="outline"
                onClick={scan.stop}
                disabled={scan.cancellation === "pending"}
              >
                <Busy busy={scan.cancellation === "pending"}>
                  <Square />
                  {scan.cancellation === "pending"
                    ? "停止を確認中"
                    : "停止を再確認"}
                </Busy>
              </Button>
            ) : scan.running ? (
              <Button variant="outline" onClick={scan.stop}>
                <Square />
                検索を停止
              </Button>
            ) : (
              scan.canResume && (
                <Button
                  variant="outline"
                  onClick={() => onStart(true)}
                  disabled={!canStart}
                >
                  <Play />
                  {event?.reason === "target"
                    ? "さらに20社を探す"
                    : "保存済みの位置から再開"}
                </Button>
              )
            )}
          </div>
        )}
      </div>
      {!hasCriteria && (
        <p className="text-xs text-muted-foreground">
          都道府県・業種・従業員数・業務キーワード・企業名のいずれかを指定してください。
        </p>
      )}
      {configured === false && (
        <p role="status" className="text-xs">
          外部データの接続設定が必要です。取得済み候補は検索できます。新しく探すには管理者に接続設定を依頼してください。
        </p>
      )}
      {!canWrite && (
        <p className="text-xs text-muted-foreground">
          閲覧権限では取得済み候補を検索できます。外部検索・取込は営業メンバーまたは管理者に依頼してください。
        </p>
      )}
      {progressVisible && (
        <div className="space-y-3 border-t pt-3 text-xs">
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="font-medium"
          >
            {progress.label}
          </p>
          {progress.indeterminate && (
            <WorkProgress
              label="現在の処理"
              value={null}
              total={1}
              description={progress.label}
            />
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <WorkProgress
              label="企業情報の確認数"
              value={event?.scanned ?? 0}
              total={200}
              description={`${event?.scanned ?? 0} / 上限200社`}
            />
            <WorkProgress
              label="条件に合う企業"
              value={goalPending ? null : (event?.matched ?? 0)}
              total={event?.target || 20}
              description={
                goalPending
                  ? `${event?.matched ?? 0}社（次の目標を確認中）`
                  : `${event?.matched ?? 0} / 目標${event?.target || 20}社`
              }
            />
          </div>
          <p className="sr-only">
            確認 {event?.scanned ?? 0} / 200 社 · 条件一致 {event?.matched ?? 0}{" "}
            / {event?.target ?? 20} 社
          </p>
          {!!event?.reused && (
            <p className="text-muted-foreground">
              保存済み情報を再利用 {event.reused}社 · 新規取得・更新{" "}
              {event.saved}社
            </p>
          )}
          <ProgressClock
            startedAt={scan.startedAt}
            running={
              scan.running || scan.finishing || scan.cancellation === "pending"
            }
            waitingUntil={scan.waitingUntil}
          />
          {(scan.running || scan.finishing) && (
            <p className="text-muted-foreground">
              {goalPending
                ? "次の目標件数を確認しています。"
                : `条件一致${event?.target || 20}社に達するか、上限200社または取得範囲の最後まで確認すると終了します。`}{" "}
              上限まで残り{Math.max(0, 200 - (event?.scanned ?? 0))}
              社。取得先の応答で所要時間が変わります。
            </p>
          )}
          {scan.cancellation === "pending" ? (
            <p>停止を確認中です。確認が完了するまで再開できません。</p>
          ) : scan.cancellation === "failed" ? (
            <p role="alert" className="text-destructive">
              停止の確認ができませんでした。「停止を再確認」を押してください。1回の詳細取得・保存は最大5社・開始から25秒以内に制限されていますが、停止の確認が済むまで新しい検索・再開はできません。
            </p>
          ) : scan.waitingUntil ? (
            <p>アクセス間隔を空けて待機中です。自動で続きを確認します。</p>
          ) : scan.running ? (
            <p>
              一致した企業から下の候補に表示します。途中で停止しても保存済みの候補は残ります。
            </p>
          ) : event?.type === "progress" && scan.canResume ? (
            <p>検索は停止中です。同じ条件で続きから再開できます。</p>
          ) : event?.message && event.type !== "error" ? (
            <p>{event.message}</p>
          ) : scan.canResume ? (
            <p>検索は停止中です。同じ条件で続きから再開できます。</p>
          ) : null}
          {!!event &&
            (event.unknownEmployees > 0 || event.unknownIndustry > 0) && (
              <p className="text-muted-foreground">
                確認した企業で未掲載：従業員数 {event.unknownEmployees} 社・業種{" "}
                {event.unknownIndustry} 社
              </p>
            )}
          {!!event?.detailsFailed && (
            <p className="text-muted-foreground">
              情報取得失敗 {event.detailsFailed}{" "}
              回（未掲載の件数には含めません）
            </p>
          )}
        </div>
      )}
      {scan.error && (
        <p role="alert" className="text-sm text-destructive">
          {scan.error}
        </p>
      )}
      {requiresPhone && (
        <p className="text-xs text-muted-foreground">
          Gビズインフォに電話番号は含まれないため、「電話番号あり」では保存済みの電話番号がある候補が対象です。
        </p>
      )}
    </div>
  );
}
