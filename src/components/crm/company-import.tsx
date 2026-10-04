"use client";
import { useState } from "react";
import { useWorkspace } from "@/components/layout/workspace";
import { api, message } from "@/lib/client-api";
import { csvColumns, type CsvRecord } from "@/lib/crm/company-csv-columns";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
type Preview = {
  id: string;
  rows: (CsvRecord & {
    duplicates: { id: string; name: string; corporate: boolean }[];
    fileDuplicates: number[];
  })[];
};
export function CompanyImport() {
  const { base, canWrite, refresh } = useWorkspace();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null),
    [encoding, setEncoding] = useState("utf-8");
  const [preview, setPreview] = useState<Preview | null>(null),
    [selected, setSelected] = useState<number[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [done, setDone] = useState<number | null>(null);
  if (!canWrite) return null;
  function reset() {
    setPreview(null);
    setSelected([]);
    setConfirmed(false);
    setError("");
    setDone(null);
  }
  async function inspect() {
    if (!file) return;
    setBusy(true);
    reset();
    try {
      if (file.size > 600000) throw new Error("CSVは600KB以内・500件までです");
      let csv;
      try {
        csv = new TextDecoder(encoding, { fatal: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw new Error(
          "文字コードを確認してください。UTF-8またはShift_JISを選択できます",
        );
      }
      const p = await api<Preview>(`${base}/company-import`, "POST", {
        action: "preview",
        csv,
      });
      setPreview(p);
      setSelected(
        p.rows
          .filter(
            (r) =>
              !r.errors.length &&
              !r.duplicates.length &&
              !r.fileDuplicates.length,
          )
          .map((r) => r.row),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!preview || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ ids: string[] }>(`${base}/company-import`, "POST", {
        action: "confirm",
        id: preview.id,
        rows: selected,
        confirmed: true,
      });
      setDone(r.ids.length);
      setPreview(null);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          setOpen(v);
          if (v) {
            reset();
            setFile(null);
          }
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">CSV取込</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>企業CSVを確認して取り込む</DialogTitle>
          <DialogDescription>
            自分を担当営業として新規登録します。既存企業との統合・更新はしません。プレビューは30分間有効です。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            対応列：{Object.keys(csvColumns).join("、")}
            。会社名は必須。電話番号・法人番号は文字列のまま取り込みます。表計算ソフトで既に失われた先頭ゼロは復元できません。
          </p>
          <a
            className="text-primary underline"
            download="企業取込見本.csv"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent("\uFEFF" + Object.keys(csvColumns).join(",") + "\r\n見本株式会社,0312345678,,建設業,東京都,千代田区,,,,手動リスト\r\n")}`}
          >
            CSV見本をダウンロード
          </a>
          <fieldset disabled={busy} className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1">
              <span className="field-label">CSVファイル</span>
              <input
                className="block max-w-full text-sm"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  setFile(e.target.files?.[0] || null);
                  reset();
                }}
              />
            </label>
            <label>
              <span className="field-label">文字コード</span>
              <select
                className="native-select"
                value={encoding}
                onChange={(e) => {
                  setEncoding(e.target.value);
                  reset();
                }}
              >
                <option value="utf-8">UTF-8</option>
                <option value="shift_jis">Shift_JIS</option>
              </select>
            </label>
            <Button disabled={!file || busy} onClick={inspect}>
              プレビュー
            </Button>
          </fieldset>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {done !== null && <p role="status">{done}件の企業を登録しました。</p>}
          {preview && (
            <>
              <p>
                {preview.rows.length}件中 {selected.length}
                件を登録予定。エラー行は修正後に再取込してください。重複候補は初期選択から除外しています。同じ法人番号は登録できません。
              </p>
              <div className="overflow-auto max-h-80 border rounded">
                <table className="w-full min-w-[650px] text-sm">
                  <thead>
                    <tr>
                      <th>登録</th>
                      <th>行</th>
                      <th>会社名</th>
                      <th>電話番号</th>
                      <th>確認事項</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.row} className="border-t">
                        <td className="p-2">
                          <input
                            type="checkbox"
                            aria-label={`${r.row}行目を登録`}
                            disabled={
                              busy ||
                              r.errors.length > 0 ||
                              r.duplicates.some((d) => d.corporate)
                            }
                            checked={selected.includes(r.row)}
                            onChange={(e) => {
                              setSelected((s) =>
                                e.target.checked
                                  ? [...s, r.row].sort((a, b) => a - b)
                                  : s.filter((n) => n !== r.row),
                              );
                              setConfirmed(false);
                            }}
                          />
                        </td>
                        <td>{r.row}</td>
                        <td className="p-2 max-w-64 break-words">
                          {r.data.name}
                        </td>
                        <td>{r.data.phone}</td>
                        <td className="p-2 max-w-72 break-words">
                          {r.errors.join(" / ")}
                          {r.duplicates.length > 0 &&
                            `登録済み候補：${r.duplicates.map((d) => d.name).join("、")}`}
                          {r.fileDuplicates.length > 0 &&
                            ` CSV内候補：${r.fileDuplicates.join("、")}行目`}
                          {!r.errors.length &&
                            !r.duplicates.length &&
                            !r.fileDuplicates.length &&
                            "登録可能"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || !selected.length}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                選択した行と重複候補を確認しました
              </label>
              <Button
                disabled={busy || !confirmed || !selected.length}
                onClick={save}
              >
                {busy ? "登録中…" : `${selected.length}件を登録する`}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
