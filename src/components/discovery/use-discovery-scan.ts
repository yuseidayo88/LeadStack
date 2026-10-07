"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScanCriteria } from "@/lib/discovery/contracts";
import {
  activeScanStorageKey,
  clearActiveScanRun,
  parseActiveScanRun,
  parseScanCheckpoint,
  readScanEvents,
  requestScanCancellation,
  shouldContinueScan,
  type ActiveScanRun,
  type ScanCheckpoint,
} from "@/lib/discovery/scan-client";
import { message } from "@/lib/client-api";

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function getTabId() {
  const key = "leadstack.discovery.tab.v1";
  const existing = sessionStorage.getItem(key);
  if (existing && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(existing))
    return existing;
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return id;
}

export function useDiscoveryScan({
  base,
  actorId,
  criteria,
  onSaved,
}: {
  base: string;
  actorId: string;
  criteria: ScanCriteria;
  onSaved: () => void | Promise<unknown>;
}) {
  const storageKey = `leadstack.discovery.scan.v1.${base}`;
  const activeStorageKey = activeScanStorageKey(base);
  const scope = JSON.stringify(criteria);
  const [checkpoint, setCheckpoint] = useState<ScanCheckpoint | null>(() => {
    try {
      return parseScanCheckpoint(localStorage.getItem(storageKey), base);
    } catch {
      return null;
    }
  });
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [started, setStarted] = useState<{ scope: string; at: number } | null>(
    null,
  );
  const [waitingUntil, setWaitingUntil] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [cancellation, setCancellation] = useState<
    "idle" | "pending" | "failed"
  >("idle");
  const generation = useRef(0);
  const mountedBase = useRef<string | null>(null);
  const mountGeneration = useRef(0);
  const readyRef = useRef(false);
  const tabId = useRef("");
  const active = useRef<AbortController | null>(null);
  const activeRun = useRef<ActiveScanRun | null>(null);
  const cancellations = useRef(new Map<string, Promise<boolean>>());
  const onSavedRef = useRef(onSaved);
  const current =
    checkpoint?.base === base && checkpoint.scope === scope ? checkpoint : null;

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const cancelRun = useCallback((run: ActiveScanRun) => {
    const key = `${run.base}/${run.runId}`;
    const pending = cancellations.current.get(key);
    const isCurrent = () =>
      activeRun.current?.runId === run.runId &&
      activeRun.current.base === run.base;
    if (isCurrent() && mountedBase.current === run.base)
      setCancellation("pending");
    if (pending) return pending;
    const request = requestScanCancellation(run)
      .then(() => {
        try {
          clearActiveScanRun(localStorage, run);
        } catch {}
        if (isCurrent()) {
          activeRun.current = null;
          if (mountedBase.current === run.base) {
            setCancellation("idle");
            onSavedRef.current();
          }
        }
        return true;
      })
      .catch(() => {
        // Keep the recovery marker and block new work until a terminal server
        // state is acknowledged. A local abort alone is never a stop receipt.
        if (isCurrent() && mountedBase.current === run.base)
          setCancellation("failed");
        return false;
      })
      .finally(() => cancellations.current.delete(key));
    cancellations.current.set(key, request);
    return request;
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    const controller = active.current;
    active.current = null;
    const run = activeRun.current;
    // Dispatch the durable cancellation independently, before closing our reader.
    const confirmation = run ? cancelRun(run) : Promise.resolve(true);
    controller?.abort();
    if (mountedBase.current !== null) {
      setRunning(false);
      setFinishing(false);
      setWaitingUntil(null);
      if (!run) setCancellation("idle");
    }
    return confirmation;
  }, [cancelRun]);

  useEffect(() => {
    const mount = ++mountGeneration.current;
    mountedBase.current = base;
    readyRef.current = false;
    activeRun.current = null;
    const initialize = async () => {
      // Defer state publication until after mounting; Strict Mode's discarded
      // mount must neither overwrite the new marker nor enable controls early.
      await Promise.resolve();
      if (mountGeneration.current !== mount) return;
      setReady(false);
      setRunning(false);
      setFinishing(false);
      setStarted(null);
      setWaitingUntil(null);
      setCancellation("idle");
      try {
        tabId.current = getTabId();
        setCheckpoint(
          parseScanCheckpoint(localStorage.getItem(storageKey), base),
        );
        const abandoned = parseActiveScanRun(
          localStorage.getItem(activeStorageKey),
          base,
        );
        // Merely opening another tab to view candidates must not cancel its owner.
        if (
          abandoned?.tabId === tabId.current &&
          abandoned.actorId === actorId
        ) {
          activeRun.current = abandoned;
          await cancelRun(abandoned);
        }
        if (mountGeneration.current !== mount) return;
        readyRef.current = true;
        setReady(true);
      } catch {
        if (mountGeneration.current === mount)
          setError(
            "検索の停止状態を保存できません。ブラウザーのサイトデータ保存を有効にして再読み込みしてください。",
          );
      }
    };
    void initialize();
    const leave = () => {
      void cancel();
    };
    const otherTabStarted = (event: StorageEvent) => {
      if (event.key !== activeStorageKey || !event.newValue || !active.current)
        return;
      const newer = parseActiveScanRun(event.newValue, base);
      if (!newer || newer.tabId === tabId.current) return;
      try {
        // A queued event can refer to a marker already replaced by our next run.
        if (
          parseActiveScanRun(localStorage.getItem(activeStorageKey), base)
            ?.runId !== newer.runId
        )
          return;
      } catch {}
      void cancel();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("storage", otherTabStarted);
    return () => {
      mountGeneration.current += 1;
      readyRef.current = false;
      mountedBase.current = null;
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("storage", otherTabStarted);
      void cancel();
    };
  }, [activeStorageKey, actorId, base, cancel, cancelRun, storageKey]);

  async function start(resume = false) {
    if (!readyRef.current || active.current || activeRun.current) return;
    const previous = resume ? current?.event : null;
    if (resume && !previous?.resumeToken) return;
    const run = ++generation.current;
    const controller = new AbortController();
    active.current = controller;
    const valid = () =>
      generation.current === run &&
      mountedBase.current === base &&
      !controller.signal.aborted;
    let token = previous?.resumeToken ?? undefined;
    let nextAllowedAt =
      previous?.nextAllowedAt ?? checkpoint?.event.nextAllowedAt;
    let lastRefresh = 0;
    let lastSaved = previous?.saved ?? 0;
    setRunning(true);
    setFinishing(false);
    setStarted({ scope, at: Date.now() });
    setRequestPending(true);
    setError("");
    if (!resume) {
      setCheckpoint(null);
      try {
        localStorage.removeItem(storageKey);
      } catch {}
    }
    try {
      while (valid()) {
        if (nextAllowedAt && Date.parse(nextAllowedAt) > Date.now()) {
          setWaitingUntil(nextAllowedAt);
          await abortableDelay(
            Date.parse(nextAllowedAt) - Date.now(),
            controller.signal,
          );
        }
        if (!valid()) return;
        setWaitingUntil(null);
        setRequestPending(true);
        const chunk: ActiveScanRun = {
          version: 1,
          base,
          runId: crypto.randomUUID(),
          tabId: tabId.current,
          actorId,
          issuedAt: new Date().toISOString(),
        };
        // Persistence must succeed before the request can create a server job.
        localStorage.setItem(activeStorageKey, JSON.stringify(chunk));
        activeRun.current = chunk;
        const response = await fetch(`${base}/company-discovery/scan`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "scan",
            criteria,
            runId: chunk.runId,
            issuedAt: chunk.issuedAt,
            ...(token ? { resumeToken: token } : {}),
          }),
          signal: controller.signal,
        });
        const terminal = await readScanEvents(response, (event) => {
          if (!valid()) return;
          setRequestPending(false);
          const next: ScanCheckpoint = {
            version: 1,
            base,
            scope,
            event,
            savedAt: Date.now(),
          };
          setCheckpoint(next);
          try {
            localStorage.setItem(storageKey, JSON.stringify(next));
          } catch {}
          if (event.saved > lastSaved && Date.now() - lastRefresh >= 2000) {
            onSavedRef.current();
            lastRefresh = Date.now();
            lastSaved = event.saved;
          }
        });
        if (!valid()) return;
        // A terminal line without EOF is not sufficient: keep the job marker
        // until the response has really ended, or cancel it on any stream error.
        if (activeRun.current?.runId === chunk.runId) activeRun.current = null;
        try {
          clearActiveScanRun(localStorage, chunk);
        } catch {}
        if (shouldContinueScan(terminal)) {
          onSavedRef.current();
          token = terminal.resumeToken ?? undefined;
          nextAllowedAt = terminal.nextAllowedAt;
          continue;
        }
        if (terminal.type === "error")
          setError(
            terminal.message ||
              "外部情報の取得に失敗しました。再開してお試しください。",
          );
        break;
      }
    } catch (failure) {
      if (valid()) {
        setError(message(failure));
        const unfinished = activeRun.current;
        if (unfinished) await cancelRun(unfinished);
      }
    } finally {
      if (valid()) {
        setFinishing(true);
        setRunning(false);
        setWaitingUntil(null);
        try {
          await onSavedRef.current();
        } catch {
          if (valid())
            setError(
              "検索結果の一覧を更新できませんでした。再読み込みしてください。",
            );
        } finally {
          if (valid()) {
            active.current = null;
            setFinishing(false);
          }
        }
      }
      controller.abort();
    }
  }

  function stop() {
    void cancel();
    onSavedRef.current();
  }

  return {
    event: current?.event ?? null,
    running,
    finishing,
    requestPending,
    startedAt: started?.scope === scope ? started.at : null,
    waitingUntil,
    error,
    cancellation,
    blocked: !ready || finishing || cancellation !== "idle",
    start,
    stop,
    cancel,
    canResume: ready && !!current?.event.resumeToken && cancellation === "idle",
  };
}
