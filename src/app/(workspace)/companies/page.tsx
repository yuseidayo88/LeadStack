"use client";
import { ActivityDialog } from "@/components/crm/activity";
import { phoneHref } from "@/lib/crm/search";
import { CompanyImport } from "@/components/crm/company-import";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Search,
  SlidersHorizontal,
  ArrowUpDown,
  Plus,
  Building2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/components/layout/workspace";
import { useApi, type Paginated } from "@/lib/client-api";
import {
  type CompanySummary,
  companyStatusLabels,
  dateTime,
  label,
  options,
  industries,
  prefectures,
} from "@/lib/crm/display";
import { ResourceDialog } from "@/components/crm/resource-dialog";
import {
  PageHeader,
  Loading,
  Empty,
  ErrorState,
  Pagination,
  StatusBadge,
  SelectFilter,
  useDebounced,
  query,
} from "@/components/crm/common";
const columns = {
  industry: "業種",
  region: "地域",
  size: "従業員数",
  phone: "電話番号",
  owner: "担当営業",
  status: "ステータス",
  task: "次回タスク",
  last: "最終接触",
};
export default function Companies() {
  const { base, members, canWrite } = useWorkspace();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("created_at");
  const [direction, setDirection] = useState("desc");
  const [visible, setVisible] = useState(Object.keys(columns));
  const [selected, setSelected] = useState<string[]>([]);
  const rows = useApi<Paginated<CompanySummary>>(
    `${base}/companies?${query({ ...filters, search: term, page, sort, direction })}`,
  );
  function filter(key: string, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
    setSelected([]);
  }
  function order(key: string) {
    setSort(key);
    setDirection(sort === key && direction === "asc" ? "desc" : "asc");
    setPage(1);
  }
  const has = (key: string) => visible.includes(key);
  const all =
    !!rows.data?.data.length &&
    rows.data.data.every((r) => selected.includes(r.id));
  const action = (
    <ResourceDialog
      resource="companies"
      onSaved={(r) => router.push(`/companies/${r.id}`)}
      trigger={
        <Button>
          <Plus />
          新規企業登録
        </Button>
      }
    />
  );
  return (
    <div className="page">
      <PageHeader
        title="企業"
        description="最終接触：接続・折返し・アポイントの架電、メール、打合せ。社内メモ・状態変更・不通は含みません。"
        action={
          <div className="flex flex-wrap gap-2">
            <CompanyImport key={base} />
            {action}
          </div>
        }
      />
      <div className="surface overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <div className="relative min-w-52 flex-1 md:max-w-sm">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="会社名・電話番号・法人番号を検索"
              className="bg-white pl-9"
              placeholder="会社名・電話番号・法人番号…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
                setSelected([]);
              }}
            />
          </div>
          <span className="mr-auto text-xs text-muted-foreground">
            {rows.data?.count.toLocaleString() ?? "—"} 社
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <SlidersHorizontal />
                表示列
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>表示する列</DropdownMenuLabel>
              {Object.entries(columns).map(([key, name]) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={has(key)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(v) =>
                    setVisible(
                      v ? [...visible, key] : visible.filter((c) => c !== key),
                    )
                  }
                >
                  {name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex flex-wrap gap-2 border-b bg-slate-50/40 px-4 py-3">
          <SelectFilter
            label="業種"
            value={filters.industry || ""}
            onChange={(v) => filter("industry", v)}
            options={industries.map((v) => ({ value: v, label: v }))}
          />
          <SelectFilter
            label="地域"
            value={filters.prefecture || ""}
            onChange={(v) => filter("prefecture", v)}
            options={prefectures.map((v) => ({ value: v, label: v }))}
          />
          <SelectFilter
            label="担当営業"
            value={filters.assigned_user_id || ""}
            onChange={(v) => filter("assigned_user_id", v)}
            options={members.map((m) => ({
              value: m.user_id,
              label: m.profile?.name || "メンバー",
            }))}
          />
          <SelectFilter
            label="ステータス"
            value={filters.company_status || ""}
            onChange={(v) => filter("company_status", v)}
            options={options(companyStatusLabels)}
          />
          {(search || Object.values(filters).some(Boolean)) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setFilters({});
                setPage(1);
                setSelected([]);
              }}
            >
              <X />
              クリア
            </Button>
          )}
        </div>
        {selected.length > 0 && (
          <div className="flex items-center gap-3 border-b bg-teal-50 px-4 py-2 text-xs text-teal-800">
            <span>{selected.length} 社を選択中</span>
            <Button size="xs" variant="ghost" onClick={() => setSelected([])}>
              選択を解除
            </Button>
          </div>
        )}
        {rows.error ? (
          <ErrorState error={rows.error} retry={() => void rows.mutate()} />
        ) : !rows.data ? (
          <Loading />
        ) : rows.data.data.length ? (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[850px]">
              <thead>
                <tr>
                  <th className="w-10">
                    <input
                      type="checkbox"
                      aria-label="このページの企業をすべて選択"
                      checked={all}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? rows.data!.data.map((r) => r.id)
                            : [],
                        )
                      }
                    />
                  </th>
                  <th
                    aria-sort={
                      sort === "name"
                        ? direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      className="flex items-center gap-2"
                      onClick={() => order("name")}
                    >
                      会社名
                      <ArrowUpDown className="size-3" />
                    </button>
                  </th>
                  {Object.entries(columns)
                    .filter(([k]) => has(k))
                    .map(([k, l]) => (
                      <th key={k}>
                        {k === "last" ? (
                          <button
                            className="flex items-center gap-2"
                            onClick={() => order("last_contact_at")}
                          >
                            {l}
                            <ArrowUpDown className="size-3" />
                          </button>
                        ) : (
                          l
                        )}
                      </th>
                    ))}
                  {canWrite && <th>架電</th>}
                </tr>
              </thead>
              <tbody>
                {rows.data.data.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer"
                    data-state={
                      selected.includes(c.id) ? "selected" : undefined
                    }
                    onClick={(e) => {
                      if (
                        e.currentTarget.contains(e.target as Node) &&
                        !(e.target as HTMLElement).closest("a,button,input")
                      )
                        router.push(`/companies/${c.id}`);
                    }}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${c.name}を選択`}
                        checked={selected.includes(c.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, c.id]
                              : selected.filter((id) => id !== c.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <Link
                        href={`/companies/${c.id}`}
                        className="flex min-w-44 items-center gap-2.5 font-medium hover:text-primary"
                      >
                        <span className="rounded border bg-slate-50 p-1.5 text-muted-foreground">
                          <Building2 className="size-4" />
                        </span>
                        {c.name}
                      </Link>
                    </td>
                    {has("industry") && (
                      <td className="whitespace-nowrap text-xs">
                        {c.industry || "—"}
                      </td>
                    )}
                    {has("region") && (
                      <td className="whitespace-nowrap text-xs">
                        {[c.prefecture, c.city].filter(Boolean).join(" ") ||
                          "—"}
                      </td>
                    )}
                    {has("size") && (
                      <td className="whitespace-nowrap text-xs">
                        {c.employee_min != null || c.employee_max != null
                          ? `${c.employee_min ?? "?"}〜${c.employee_max ?? "?"}名`
                          : "—"}
                      </td>
                    )}
                    {has("phone") && (
                      <td className="whitespace-nowrap font-mono text-xs">
                        {phoneHref(c.phone) ? (
                          <a
                            className="hover:text-primary hover:underline"
                            href={phoneHref(c.phone)}
                          >
                            {c.phone}
                          </a>
                        ) : (
                          c.phone || "—"
                        )}
                      </td>
                    )}
                    {has("owner") && (
                      <td className="whitespace-nowrap text-xs">
                        {c.assigned_user_name || "未設定"}
                      </td>
                    )}
                    {has("status") && (
                      <td>
                        <StatusBadge value={c.company_status}>
                          {label(companyStatusLabels, c.company_status)}
                        </StatusBadge>
                      </td>
                    )}
                    {has("task") && (
                      <td className="max-w-48 text-xs">
                        {c.next_task ? (
                          <Link
                            href={`/tasks?company_id=${c.id}`}
                            className="block hover:text-primary"
                          >
                            <p className="truncate">{c.next_task.title}</p>
                            <p className="mt-1 text-muted-foreground">
                              {dateTime(c.next_task.due_at)}
                            </p>
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    )}
                    {has("last") && (
                      <td className="whitespace-nowrap text-xs text-muted-foreground">
                        {c.last_contact_at
                          ? dateTime(c.last_contact_at, true)
                          : "未接触"}
                      </td>
                    )}
                    {canWrite && (
                      <td>
                        <ActivityDialog
                          companyId={c.id}
                          companyName={c.name}
                          phone={c.phone}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={
              search || Object.values(filters).some(Boolean)
                ? "条件に一致する企業がありません"
                : "最初の企業を登録しましょう"
            }
            description="企業情報を登録すると、活動・ヒアリング・提案をまとめて管理できます。"
            action={canWrite ? action : undefined}
          />
        )}
        <Pagination
          page={page}
          count={rows.data?.count}
          onChange={(p) => {
            setPage(p);
            setSelected([]);
          }}
        />
      </div>
    </div>
  );
}
