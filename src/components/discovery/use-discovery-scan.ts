"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScanCriteria } from "@/lib/discovery/contracts";
import {
  parseScanCheckpoint,
  readScanEvents,
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

export function useDiscoveryScan({
  base,
  criteria,
  onSaved,
}: {
  base: string;
  criteria: ScanCriteria;
  onSaved: () => void;
}) {
  const storageKey = `leadstack.discovery.scan.v1.${base}`;
  const scope = JSON.stringify(criteria);
  const [checkpoint, setCheckpoint] = useState<ScanCheckpoint | null>(() => {
    try {
      return parseScanCheckpoint(localStorage.getItem(storageKey), base);
    } catch {
      return null;
    }
  });
  const [running, setRunning] = useState(false);
  const [waitingUntil, setWaitingUntil] = useState<string | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const onSavedRef = useRef(onSaved);
  const current = checkpoint?.scope === scope ? checkpoint : null;

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const cancel = useCallback(() => {
    generation.current += 1;
    active.current?.abort();
    active.current = null;
    setRunning(false);
    setWaitingUntil(null);
    setError("");
  }, []);

  useEffect(
    () => () => {
      generation.current += 1;
      active.current?.abort();
      active.current = null;
    },
    [],
  );

  async function start(resume = false) {
    if (active.current) return;
    const previous = resume ? current?.event : null;
    if (resume && !previous?.resumeToken) return;
    const run = ++generation.current;
    const controller = new AbortController();
    active.current = controller;
    const valid = () =>
      generation.current === run && !controller.signal.aborted;
    let token = previous?.resumeToken ?? undefined;
    let nextAllowedAt =
      previous?.nextAllowedAt ?? checkpoint?.event.nextAllowedAt;
    let lastRefresh = 0;
    let lastSaved = previous?.saved ?? 0;
    setRunning(true);
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
        const response = await fetch(`${base}/company-discovery`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "scan",
            criteria,
            ...(token ? { resumeToken: token } : {}),
          }),
          signal: controller.signal,
        });
        const terminal = await readScanEvents(response, (event) => {
          if (!valid()) return;
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
        if (
          terminal.type === "paused" &&
          terminal.reason === "time_limit" &&
          terminal.resumeToken
        ) {
          onSavedRef.current();
          token = terminal.resumeToken;
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
      if (valid()) setError(message(failure));
    } finally {
      if (valid()) {
        active.current = null;
        setRunning(false);
        setWaitingUntil(null);
        onSavedRef.current();
      }
      controller.abort();
    }
  }

  function stop() {
    cancel();
    onSavedRef.current();
  }

  return {
    event: current?.event ?? null,
    running,
    waitingUntil,
    error,
    start,
    stop,
    cancel,
    canResume: !!current?.event.resumeToken,
  };
}
