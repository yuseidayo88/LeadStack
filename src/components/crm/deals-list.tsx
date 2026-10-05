"use client";
import { useState } from "react";
import Link from "next/link";
import { Pencil, Search } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/layout/workspace";
import { api, useApi, message, type Paginated } from "@/lib/client-api";
import type { Tables } from "@/lib/database.types";
import {
  stageLabels,
  label,
  money,
  dateTime,
  options,
} from "@/lib/crm/display";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResourceDialog, DeleteDialog } from "./resource-dialog";
import {
  Empty,
  Loading,
  ErrorState,
  Pagination,
  SelectFilter,
  StatusBadge,
  useDebounced,
  query,
} from "./common";
type Deal = Tables<"deals"> & {
  company_name: string | null;
  contact_name: string | null;
};
export function DealsList({ companyId }: { companyId?: string }) {
  const { base, members, canWrite, refresh } = useWorkspace();
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const [stage, setStage] = useState("");
  const [owner, setOwner] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("created_at");
  const [busy, setBusy] = useState<string | null>(null);
  const result = useApi<Paginated<Deal>>(
    `${base}/deals?${query({ company_id: companyId, search: term, stage, assigned_user_id: owner, page, sort, direction: sort === "created_at" ? "desc" : "asc" })}`,
  );
  async function changeStage(id: string, value: string) {
    setBusy(id);
    try {
      await api(
        `${base}/deals/${id}`,
        "PATCH",
        { stage: value },
        undefined,
        undefined,
        result.data?.data.find((d) => d.id === id)?.updated_at,
      );
      toast.success("ステージを更新しました");
      await refresh();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="案件名を検索"
            placeholder="案件名を検索…"
            className="bg-white pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <ResourceDialog resource="deals" companyId={companyId} />
      </div>
      <div className="flex flex-wrap gap-2 border-b bg-slate-50/40 px-4 py-3">
        <SelectFilter
          label="ステージ"
          value={stage}
          onChange={(v) => {
            setStage(v);
            setPage(1);
          }}
          options={options(stageLabels)}
        />
        <SelectFilter
          label="担当営業"
          value={owner}
          onChange={(v) => {
            setOwner(v);
            setPage(1);
          }}
          options={members.map((m) => ({
            value: m.user_id,
            label: m.profile?.name || "メンバー",
          }))}
        />
        <select
          className="native-select w-auto"
          aria-label="商談の並び順"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setPage(1);
          }}
        >
          <option value="created_at">登録が新しい順</option>
          <option value="expected_close_date">成約予定日順</option>
          <option value="name">案件名順</option>
        </select>
      </div>
      {result.error ? (
        <ErrorState error={result.error} retry={() => void result.mutate()} />
      ) : !result.data ? (
        <Loading />
      ) : !result.data.data.length ? (
        <Empty
          title={
            stage || search || owner
              ? "条件に一致する商談はありません"
              : "商談はまだありません"
          }
          description="ヒアリングから成約まで、商談の進み具合を管理しましょう。"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[950px]">
            <thead>
              <tr>
                <th>案件名 / 企業</th>
                <th>ステージ</th>
                <th>企業担当者</th>
                <th>担当営業</th>
                <th>初期費用</th>
                <th>月額費用</th>
                <th>成約予定</th>
                <th>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {result.data.data.map((d) => (
                <tr key={d.id}>
                  <td>
                    <ResourceDialog
                      resource="deals"
                      record={d}
                      companyId={companyId}
                      trigger={
                        <button className="block text-left font-medium hover:text-primary">
                          {d.name}
                        </button>
                      }
                    />
                    {!canWrite && <p className="font-medium">{d.name}</p>}
                    <Link
                      href={`/companies/${d.company_id}`}
                      className="mt-1 block text-xs text-muted-foreground hover:text-primary"
                    >
                      {d.company_name || "企業詳細"}
                    </Link>
                    {d.stage === "lost" && d.lost_reason && (
                      <p className="mt-1 max-w-64 text-xs text-muted-foreground">
                        失注理由：{d.lost_reason}
                      </p>
                    )}
                  </td>
                  <td>
                    {canWrite ? (
                      <select
                        aria-label={`${d.name}のステージ`}
                        value={d.stage}
                        disabled={busy === d.id}
                        className="native-select h-8 w-28 text-xs"
                        onChange={(e) => void changeStage(d.id, e.target.value)}
                      >
                        {Object.entries(stageLabels).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <StatusBadge value={d.stage}>
                        {label(stageLabels, d.stage)}
                      </StatusBadge>
                    )}
                  </td>
                  <td className="text-xs">{d.contact_name || "未設定"}</td>
                  <td className="text-xs">
                    {members.find((m) => m.user_id === d.owner_user_id)?.profile
                      ?.name || "—"}
                  </td>
                  <td className="whitespace-nowrap font-mono text-xs">
                    {money(d.initial_price)}
                  </td>
                  <td className="whitespace-nowrap font-mono text-xs">
                    {money(d.monthly_price)}
                  </td>
                  <td className="whitespace-nowrap text-xs">
                    {dateTime(d.expected_close_date, true)}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      <ResourceDialog
                        resource="deals"
                        record={d}
                        companyId={companyId}
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`${d.name}を編集`}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                        }
                      />
                      <DeleteDialog resource="deals" id={d.id} name={d.name} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} count={result.data?.count} onChange={setPage} />
    </section>
  );
}
