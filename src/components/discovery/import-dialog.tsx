"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Download } from "lucide-react";
import { useWorkspace } from "@/components/layout/workspace";
import { api, ApiError, message } from "@/lib/client-api";
import type {
  Candidate,
  ImportPreview,
  ImportResult,
} from "@/lib/discovery/contracts";
import { ActivityDialog } from "@/components/crm/activity";
import { Busy, Loading } from "@/components/crm/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DiscoveryImportDialog({
  ids,
  candidates,
  open,
  onOpenChange,
  onImported,
}: {
  ids: string[];
  candidates: Candidate[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<void>;
}) {
  const { base, canWrite } = useWorkspace();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [confirmedDuplicates, setConfirmedDuplicates] = useState(false);
  const inFlight = useRef(false);
  const idsKey = ids.join(",");
  useEffect(() => {
    const abort = new AbortController();
    inFlight.current = true;
    api<ImportPreview>(
      `${base}/company-discovery`,
      "POST",
      { action: "preview", ids: idsKey.split(",") },
      abort.signal,
    )
      .then((response) => {
        if (!abort.signal.aborted) setPreview(response);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(message(error));
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          inFlight.current = false;
          setBusy(false);
        }
      });
    return () => abort.abort();
  }, [base, idsKey]);

  async function inspect() {
    if (inFlight.current || !ids.length || !canWrite) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setConfirmedDuplicates(false);
    try {
      setPreview(
        await api<ImportPreview>(`${base}/company-discovery`, "POST", {
          action: "preview",
          ids,
        }),
      );
    } catch (error) {
      setError(message(error));
      if (error instanceof ApiError && error.code === "preview_changed") {
        setPreview(null);
        setConfirmedDuplicates(false);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function save() {
    if (inFlight.current || !preview || !canWrite) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await api<ImportResult>(
        `${base}/company-discovery`,
        "POST",
        {
          action: "import",
          ids,
          reviewToken: preview.review_token,
          confirmedDuplicates,
          confirmed: true,
        },
      );
      setResult(saved);
      await onImported();
    } catch (error) {
      setError(message(error));
      if (error instanceof ApiError && error.code === "preview_changed") {
        setPreview(null);
        setConfirmedDuplicates(false);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const hasDuplicates =
    preview?.items.some(
      (item) =>
        !item.company_id &&
        (item.duplicates.length > 0 || item.selected_duplicates.length > 0),
    ) ?? false;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {result ? "営業リストに取り込みました" : "営業リストへの取込を確認"}
          </DialogTitle>
          <DialogDescription>
            候補を確認してから企業として登録します。同じ法人番号の企業は既存企業に紐づき、登録済みの情報は上書きしません。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-3 text-destructive"
          >
            {error}
          </p>
        )}
        {result ? (
          <div className="space-y-4">
            <p
              role="status"
              className="flex items-center gap-2 rounded-md bg-teal-50 p-3 text-teal-900"
            >
              <CheckCircle2 className="size-5 shrink-0" />
              新規 {result.created_count} 社・既存企業への紐づけ{" "}
              {result.existing_count} 社
            </p>
            <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
              {result.items.map((item) => {
                const candidate = candidates.find(
                  (row) => row.id === item.candidate_id,
                );
                const name =
                  candidate?.name ??
                  preview?.items.find(
                    (row) => row.candidate_id === item.candidate_id,
                  )?.name ??
                  "企業";
                return (
                  <li
                    key={item.candidate_id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <Link
                      className="font-medium text-primary hover:underline"
                      href={`/companies/${item.company_id}`}
                    >
                      {name}
                    </Link>
                    <ActivityDialog
                      companyId={item.company_id}
                      companyName={
                        item.created
                          ? name
                          : candidate?.crm_company_name || name
                      }
                      phone={
                        item.created
                          ? candidate?.phone
                          : candidate?.crm_company_phone
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ) : preview ? (
          <div className="space-y-4">
            <p className="text-sm">
              {preview.items.length}{" "}
              社を確認中。類似企業がある場合はリンク先で内容を確認してください。
            </p>
            <div className="max-h-80 overflow-auto rounded-md border">
              <table className="data-table min-w-[480px]">
                <thead>
                  <tr>
                    <th scope="col">候補企業</th>
                    <th scope="col">重複の確認</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.items.map((item) => (
                    <tr key={item.candidate_id}>
                      <td className="font-medium">{item.name}</td>
                      <td className="text-xs">
                        {item.company_id ? (
                          <Link
                            className="text-primary hover:underline"
                            href={`/companies/${item.company_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            登録済みの企業を開く（別タブ）
                          </Link>
                        ) : !item.duplicates.length &&
                          !item.selected_duplicates.length ? (
                          "重複候補なし"
                        ) : (
                          <ul className="space-y-2">
                            {item.duplicates.map((duplicate) => (
                              <li key={duplicate.id}>
                                <Link
                                  className="font-medium text-primary hover:underline"
                                  href={`/companies/${duplicate.id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {duplicate.name}（別タブ）
                                </Link>
                                <p className="mt-1 text-muted-foreground">
                                  {duplicate.reason === "phone"
                                    ? "電話番号が一致"
                                    : "企業名が一致"}
                                </p>
                              </li>
                            ))}
                            {item.selected_duplicates.map((duplicate) => (
                              <li key={duplicate.candidate_id}>
                                <p className="font-medium">
                                  選択中の候補：{duplicate.name}
                                </p>
                                <p className="mt-1 text-muted-foreground">
                                  {duplicate.reason === "phone"
                                    ? "電話番号が一致"
                                    : "企業名が一致"}
                                </p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {hasDuplicates && (
              <label className="flex items-start gap-2 rounded-md border bg-slate-50 p-3 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={confirmedDuplicates}
                  onChange={(event) =>
                    setConfirmedDuplicates(event.target.checked)
                  }
                  disabled={busy}
                />
                <span>
                  類似する既存企業を確認しました。別の法人として新規登録します。選択を変更する場合は、一度閉じて候補の選択を調整してください。
                </span>
              </label>
            )}
          </div>
        ) : busy ? (
          <Loading label="既存企業との重複を確認中" />
        ) : (
          <div className="rounded-md bg-slate-50 p-4">
            <p>{ids.length} 社を選択しています。</p>
            <p className="mt-2 text-sm text-muted-foreground">
              まず、営業リストに同じ法人番号や類似企業がないか確認します。
            </p>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {result ? "閉じる" : "キャンセル"}
          </Button>
          {result ? (
            <Button asChild>
              <Link href="/companies">営業リストを開く</Link>
            </Button>
          ) : preview ? (
            <Button
              onClick={() => void save()}
              disabled={
                busy || !canWrite || (hasDuplicates && !confirmedDuplicates)
              }
            >
              <Busy busy={busy}>
                <Download />
                確認して取り込む
              </Busy>
            </Button>
          ) : (
            <Button
              onClick={() => void inspect()}
              disabled={busy || !canWrite || !ids.length}
            >
              <Busy busy={busy}>重複を確認する</Busy>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
