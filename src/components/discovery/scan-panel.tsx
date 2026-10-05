"use client";

import { Search, Square, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Busy } from "@/components/crm/common";
import type { useDiscoveryScan } from "@/components/discovery/use-discovery-scan";

type Props = {
  scan: ReturnType<typeof useDiscoveryScan>;
  canWrite: boolean;
  configured: boolean | undefined;
  hasCriteria: boolean;
  requiresPhone: boolean;
  disabled: boolean;
  onStart: (resume: boolean) => void;
};

export function DiscoveryScanPanel({
  scan,
  canWrite,
  configured,
  hasCriteria,
  requiresPhone,
  disabled,
  onStart,
}: Props) {
  const canStart =
    canWrite && configured && hasCriteria && !disabled && !scan.running;
  const event = scan.event;
  return (
    <div
      id="discovery-search-progress"
      className="scroll-mt-4 space-y-3 rounded-md bg-slate-50 p-3"
      aria-label="外部の企業検索"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">企業名が分からなくても探せます</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            都道府県・業種・人数・業務キーワードで検索。一致20社を目安に、最大200社の情報を順に確認します。
          </p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onStart(false)} disabled={!canStart}>
              <Busy busy={scan.running}>
                <Search />
                条件に合う企業を探す
              </Busy>
            </Button>
            {scan.running ? (
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
      {(event || scan.running) && (
        <div role="status" className="space-y-1 border-t pt-2 text-xs">
          <p className="font-medium">
            確認 {event?.scanned ?? 0} / 200 社 · 条件一致 {event?.matched ?? 0}{" "}
            / {event?.target ?? 20} 社
          </p>
          {scan.waitingUntil ? (
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
      <p className="text-xs leading-relaxed text-muted-foreground">
        外部データを少しずつ確認するため、見つかった件数は全国の該当企業の総数ではありません。検索中も取得済み候補を確認できます。
      </p>
    </div>
  );
}
