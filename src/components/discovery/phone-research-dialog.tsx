"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Phone, Square } from "lucide-react";
import { api, message } from "@/lib/client-api";
import type {
  Candidate,
  PhoneResearchResponse,
} from "@/lib/discovery/contracts";
import {
  runPhoneResearch,
  phoneResearchLabel,
  type PhoneResearchItem,
} from "@/lib/discovery/phone-research";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchedLabel, WebsiteLink } from "./display";
import { ProgressClock, WorkProgress } from "./work-progress";

type Props = {
  base: string;
  candidates: Candidate[];
  onClose: () => void;
  onUpdated: (candidate: Candidate) => void;
  onDetail: (candidate: Candidate) => void;
  onImport: (candidates: Candidate[]) => void;
};

export function PhoneResearchDialog({
  base,
  candidates,
  onClose,
  onUpdated,
  onDetail,
  onImport,
}: Props) {
  const [phase, setPhase] = useState<
    "idle" | "running" | "stopping" | "complete" | "stopped" | "error"
  >("idle");
  const [items, setItems] = useState<Record<string, PhoneResearchItem>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [elapsed, setElapsed] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const mounted = useRef(true);
  const stop = useRef(false);
  const inFlight = useRef(false);
  const savingRef = useRef(false);
  const busy = phase === "running" || phase === "stopping";
  useEffect(() => {
    mounted.current = true;
    const leave = () => {
      stop.current = true;
    };
    window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false;
      stop.current = true;
      window.removeEventListener("pagehide", leave);
    };
  }, []);

  async function start() {
    if (inFlight.current || savingRef.current) return;
    inFlight.current = true;
    stop.current = false;
    setPhase("running");
    setStartedAt(Date.now());
    setElapsed(0);
    setVerified({});
    setSaveErrors({});
    setItems({});
    const started = performance.now();
    try {
      const reason = await runPhoneResearch({
        ids: candidates.map((row) => row.id),
        // A timeout stops the queue. The single in-flight server operation may
        // still save its evidence; a later run retrieves that cached result.
        request: (id) =>
          api<PhoneResearchResponse>(
            `${base}/company-discovery`,
            "POST",
            { action: "research_phone", id },
            AbortSignal.timeout(30_000),
          ),
        shouldStop: () => stop.current || !mounted.current,
        onStart: (id) => {
          if (mounted.current) setActiveId(id);
        },
        onResult: (item) => {
          if (!mounted.current) return;
          setItems((current) => ({ ...current, [item.id]: item }));
          if (item.result) onUpdated(item.result.candidate);
        },
      });
      if (mounted.current) setPhase(reason);
    } catch (error) {
      if (mounted.current) {
        setSaveErrors({ batch: message(error) });
        setPhase("error");
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setActiveId(null);
        setElapsed(Math.round((performance.now() - started) / 1000));
      }
    }
  }

  async function confirm(candidate: Candidate) {
    if (!verified[candidate.id] || inFlight.current || savingRef.current)
      return;
    savingRef.current = true;
    setSaving(candidate.id);
    setSaveErrors((current) => ({ ...current, [candidate.id]: "" }));
    try {
      const result = await api<{ candidate: Candidate }>(
        `${base}/company-discovery`,
        "POST",
        {
          action: "confirm_phone",
          id: candidate.id,
          expectedUpdatedAt: candidate.updated_at,
          confirmed: true,
        },
        AbortSignal.timeout(30_000),
      );
      if (!mounted.current) return;
      setItems((current) => ({
        ...current,
        [candidate.id]: {
          id: candidate.id,
          result: {
            candidate: result.candidate,
            outcome: current[candidate.id]?.result?.outcome ?? "existing_phone",
          },
        },
      }));
      onUpdated(result.candidate);
    } catch (error) {
      if (mounted.current)
        setSaveErrors((current) => ({
          ...current,
          [candidate.id]: message(error),
        }));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(null);
    }
  }

  const completed = Object.values(items);
  const checked = completed.filter(
    (item) => item.result?.outcome === "checked",
  ).length;
  const cached = completed.filter(
    (item) => item.result?.outcome === "cached",
  ).length;
  const ready = completed.flatMap((item) =>
    item.result?.candidate.phone || item.result?.candidate.crm_company_phone
      ? [item.result.candidate]
      : [],
  );
  const found = completed.filter(
    (item) =>
      item.result?.candidate.enrichment_result?.phone &&
      !item.result.candidate.phone &&
      !item.result.candidate.crm_company_phone,
  ).length;
  const locked = busy || saving !== null;
  const status =
    phase === "idle"
      ? "開始すると公式サイトを1社ずつ調べます。"
      : phase === "stopping"
        ? "停止中… 今の1社の結果を保存してから停止します。"
        : busy
          ? `電話番号を調査中… ${completed.length} / ${candidates.length}社の結果を確認済み`
          : phase === "complete"
            ? "調査が完了しました。"
            : phase === "stopped"
              ? "調査を停止しました。取得済みの結果は保存されています。"
              : "調査を中断しました。取得済みの結果は保存されています。";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] w-[calc(100vw_-_2rem)] max-w-none grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:max-w-3xl"
        showCloseButton={!locked}
      >
        <DialogHeader>
          <DialogTitle>電話番号を調べる</DialogTitle>
          <DialogDescription>
            選択した{candidates.length}
            社を対象に、登録された公式サイトを確認します。1回10社・組織全体で1時間20社まで。24時間以内の結果は再利用します。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="flex items-center gap-2 font-medium"
          >
            {busy && (
              <span aria-hidden="true" className="motion-safe:animate-spin">
                <LoaderCircle className="size-4" />
              </span>
            )}
            {status}
          </p>
          {phase !== "idle" && (
            <>
              <WorkProgress
                label="電話番号調査の進捗"
                value={completed.length}
                total={candidates.length}
                description={`${completed.length} / ${candidates.length}社 · 残り${Math.max(0, candidates.length - completed.length)}社`}
              />
              <ProgressClock startedAt={startedAt} running={busy} />
            </>
          )}
          {phase !== "idle" && (
            <p className="text-xs text-muted-foreground">
              新規サイト調査 {checked}社 · 結果の再利用 {cached}社 · 電話候補{" "}
              {found}社 · 電話番号あり {ready.length}社
              {!busy && ` · 所要時間 ${elapsed}秒`}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            社名・所在地と代表電話を出典ページで確認してから保存してください。公式URLがない企業は、企業詳細から入力できます。
          </p>
          {saveErrors.batch && (
            <p role="alert" className="text-destructive">
              {saveErrors.batch}
            </p>
          )}
        </div>
        <div
          className="min-h-0 space-y-3 overflow-y-auto pr-1"
          aria-label="電話番号の調査結果"
          aria-busy={busy}
        >
          {candidates.map((initial) => {
            const item = items[initial.id];
            const result = item?.result;
            const candidate = result?.candidate ?? initial;
            const proposal = candidate.enrichment_result;
            const label =
              activeId === initial.id
                ? "調査中…"
                : result
                  ? phoneResearchLabel(result)
                  : item?.error
                    ? "調査できませんでした"
                    : phase === "idle"
                      ? "未調査"
                      : busy
                        ? "待機中"
                        : "未実行";
            const canConfirm =
              result &&
              !candidate.phone &&
              !candidate.crm_company_phone &&
              proposal?.phone &&
              proposal.status === "found" &&
              candidate.enrichment_status === "complete";
            return (
              <article
                key={initial.id}
                aria-label={candidate.name}
                className="rounded-md border p-3 text-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words font-medium">
                      {candidate.name}
                    </h3>
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {candidate.location || "所在地未確認"} · 法人番号{" "}
                      {candidate.corporate_number}
                    </p>
                  </div>
                  <span className="text-xs font-medium text-primary">
                    {label}
                  </span>
                </div>
                {item?.error && (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {item.error}
                  </p>
                )}
                {result && (
                  <div className="mt-2 space-y-2">
                    {(candidate.phone || candidate.crm_company_phone) && (
                      <p className="font-mono">
                        {candidate.crm_company_phone || candidate.phone}
                        {candidate.crm_company_phone && (
                          <span className="ml-2 font-sans text-xs text-muted-foreground">
                            営業リストに保存済み
                          </span>
                        )}
                      </p>
                    )}
                    {result.outcome === "cached" && (
                      <p className="text-xs text-muted-foreground">
                        保存済みの確認結果を表示しています。
                      </p>
                    )}
                    {proposal &&
                      !candidate.phone &&
                      !candidate.crm_company_phone && (
                        <div className="space-y-1 text-xs">
                          {proposal.phone && (
                            <p className="text-sm">
                              電話番号の候補：
                              <span className="font-mono">
                                {proposal.phone}
                              </span>
                            </p>
                          )}
                          {proposal.message && <p>{proposal.message}</p>}
                          {proposal.evidence && (
                            <p className="break-words text-muted-foreground">
                              根拠：{proposal.evidence}
                            </p>
                          )}
                          {proposal.sourceUrl && (
                            <p className="flex flex-wrap items-center gap-2">
                              出典：
                              <WebsiteLink value={proposal.sourceUrl} />
                            </p>
                          )}
                          <p className="text-muted-foreground">
                            確認日時 {fetchedLabel(proposal.checkedAt)}
                            （日本時間）
                          </p>
                        </div>
                      )}
                    {canConfirm && (
                      <div className="flex flex-wrap items-center gap-3 border-t pt-2">
                        <label className="flex items-start gap-2 text-xs">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={!!verified[candidate.id]}
                            disabled={locked}
                            onChange={(event) =>
                              setVerified((current) => ({
                                ...current,
                                [candidate.id]: event.target.checked,
                              }))
                            }
                          />
                          <span>出典の社名・所在地・代表電話を確認した</span>
                        </label>
                        <Button
                          size="sm"
                          disabled={locked || !verified[candidate.id]}
                          onClick={() => void confirm(candidate)}
                        >
                          {saving === candidate.id
                            ? "保存中…"
                            : "電話番号を保存"}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                {saveErrors[candidate.id] && (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {saveErrors[candidate.id]}
                  </p>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  className="mt-2 h-7 px-2 text-xs"
                  onClick={() => onDetail(candidate)}
                >
                  企業詳細で確認・修正
                </Button>
              </article>
            );
          })}
        </div>
        <DialogFooter className="flex-wrap gap-2">
          {busy ? (
            <Button
              variant="outline"
              disabled={phase === "stopping"}
              onClick={() => {
                stop.current = true;
                setPhase("stopping");
              }}
            >
              <Square />
              {phase === "stopping" ? "停止中…" : "調査を停止"}
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={locked} onClick={onClose}>
                閉じる
              </Button>
              {phase === "idle" ? (
                <Button onClick={() => void start()}>
                  <Phone />
                  {candidates.length}社の調査を開始
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={locked}
                  onClick={() => void start()}
                >
                  結果を再確認・未実行分を調査
                </Button>
              )}
              {ready.length > 0 && (
                <Button disabled={locked} onClick={() => onImport(ready)}>
                  電話番号ありの{ready.length}社を取り込む
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
