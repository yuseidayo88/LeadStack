"use client";

import { useEffect, useState } from "react";
import { Bookmark, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type DiscoveryFilters,
  targetingFilterError,
} from "@/lib/discovery/targeting";
import {
  addSavedSearch,
  discoveryFilterChips,
  parseSavedSearches,
  savedSearchesKey,
  SAVED_SEARCH_LIMIT,
  type SavedSearch,
  type SearchScope,
} from "@/lib/discovery/saved-searches";

type Props = SearchScope & {
  filters: DiscoveryFilters;
  disabled: boolean;
  onApply: (filters: DiscoveryFilters) => void;
};
const storageFailure =
  "ブラウザーに保存できませんでした。ブラウザーの保存設定・空き容量を確認してください。";

export function SavedDiscoverySearches({
  base,
  actorId,
  filters,
  disabled,
  onApply,
}: Props) {
  const scope = { base, actorId };
  const key = savedSearchesKey(scope);
  const [items, setItems] = useState<SavedSearch[]>(() => {
    try {
      return parseSavedSearches(localStorage.getItem(key), scope);
    } catch {
      return [];
    }
  });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const chips = discoveryFilterChips(filters);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        try {
          setItems(
            parseSavedSearches(localStorage.getItem(key), { base, actorId }),
          );
        } catch {
          /* Keep the current view when storage is unavailable. */
        }
      }
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [key, base, actorId]);

  async function write(
    change: (current: SavedSearch[]) => SavedSearch[],
    notice: string,
  ) {
    setSaving(true);
    setError("");
    try {
      const persist = () => {
        let current: SavedSearch[];
        try {
          current = parseSavedSearches(localStorage.getItem(key), scope);
        } catch {
          throw new Error(storageFailure);
        }
        const next = change(current);
        try {
          localStorage.setItem(
            key,
            JSON.stringify({ version: 1, ...scope, items: next }),
          );
        } catch {
          throw new Error(storageFailure);
        }
        setItems(next);
      };
      if (navigator.locks) await navigator.locks.request(key, persist);
      else persist();
      setOpen(false);
      toast.success(notice);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : storageFailure);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div
      className="min-w-0 space-y-2"
      role="region"
      aria-label="保存した検索条件"
    >
      <details className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">
          保存した検索条件（{items.length}件）
        </summary>
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                disabled ||
                saving ||
                !!targetingFilterError(filters) ||
                !chips.length
              }
              onClick={() => {
                setName(
                  chips
                    .map((chip) => chip.label)
                    .join("・")
                    .slice(0, 40),
                );
                setError("");
                setOpen(true);
              }}
            >
              <Bookmark />
              条件を保存
            </Button>
            <span className="text-xs text-muted-foreground">
              よく使う条件 {items.length}/{SAVED_SEARCH_LIMIT}件
            </span>
          </div>
          {!!items.length && (
            <div className="flex flex-wrap gap-2">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex min-w-0 max-w-full items-center rounded-md border"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-w-0 flex-1 shrink justify-start"
                    disabled={disabled || saving}
                    aria-label={`保存条件「${item.name}」を呼び出す`}
                    title={item.name}
                    onClick={() => onApply({ ...item.filters })}
                  >
                    <span className="truncate">{item.name}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={saving}
                    aria-label={`保存条件「${item.name}」を削除`}
                    onClick={() =>
                      void write(
                        (current) =>
                          current.filter((saved) => saved.id !== item.id),
                        "保存した条件を削除しました",
                      )
                    }
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {!!items.length && (
            <p className="text-xs text-muted-foreground">
              呼び出すと取得済み候補を絞り込みます。外部の企業検索は検索ボタンで開始します。
            </p>
          )}
          {error && !open && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </details>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!saving) {
            setOpen(value);
            if (!value) setError("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>検索条件を保存</DialogTitle>
            <DialogDescription>
              このブラウザーの、現在の利用者・組織専用に保存します。別の端末には同期されません。
            </DialogDescription>
          </DialogHeader>
          <form
            className="min-w-0 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void write(
                (current) =>
                  addSavedSearch(current, name, filters, crypto.randomUUID()),
                "検索条件を保存しました",
              );
            }}
          >
            <label className="block">
              <span className="field-label">条件名</span>
              <Input
                autoFocus
                value={name}
                maxLength={40}
                required
                disabled={saving}
                placeholder="例：東京都・設備工事・10〜50人"
                onChange={(event) => setName(event.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? "saved-search-error" : undefined}
              />
            </label>
            <p className="break-words text-xs leading-relaxed text-muted-foreground">
              {chips.map((chip) => chip.label).join(" / ")}
            </p>
            {error && (
              <p
                id="saved-search-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setOpen(false);
                  setError("");
                }}
              >
                キャンセル
              </Button>
              <Button type="submit" disabled={saving || !name.trim()}>
                {saving ? "保存中…" : "保存する"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
