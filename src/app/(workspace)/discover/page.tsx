"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  ArrowUpDown,
  Building2,
  Download,
  ExternalLink,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/layout/workspace";
import { api, message, useApi } from "@/lib/client-api";
import type {
  AcquireResponse,
  Candidate,
  DiscoveryListResponse,
} from "@/lib/discovery/contracts";
import { prefectures } from "@/lib/crm/display";
import {
  Busy,
  Empty,
  ErrorState,
  Loading,
  PageHeader,
  Pagination,
  query,
  useDebounced,
} from "@/components/crm/common";
import { SearchableSelect } from "@/components/crm/searchable-select";
import { ActivityDialog } from "@/components/crm/activity";
import { CandidateDialog } from "@/components/discovery/candidate-dialog";
import { DiscoveryImportDialog } from "@/components/discovery/import-dialog";
import {
  employeeLabel,
  fetchedLabel,
  PhoneLink,
  UnknownValue,
  WebsiteLink,
} from "@/components/discovery/display";
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

const prefectureOptions = [
  { value: "", label: "都道府県：すべて" },
  ...prefectures.map((label, index) => ({
    value: String(index + 1).padStart(2, "0"),
    label,
  })),
];
const presenceLabels = {
  hasPhone: "電話番号あり",
  hasWebsite: "Webサイトあり",
  hasEmployees: "従業員数あり",
};
type Presence = keyof typeof presenceLabels;
type Sort = "name" | "fetched_at" | "employee_number";
type AcquisitionCheckpoint = { scope: string; result: AcquireResponse };
const subscribeToStorage = (listener: () => void) => {
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
};
const emptyStorageSnapshot = () => null;
function parseCheckpoint(value: string | null): AcquisitionCheckpoint | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as AcquisitionCheckpoint;
    if (
      typeof parsed.scope !== "string" ||
      parsed.scope.length > 1000 ||
      !parsed.result
    )
      return null;
    const searchScope = JSON.parse(parsed.scope) as {
      prefecture: string;
      search: string;
    };
    if (
      typeof searchScope.prefecture !== "string" ||
      !/^(?:0[1-9]|[1-3]\d|4[0-7])?$/.test(searchScope.prefecture) ||
      typeof searchScope.search !== "string" ||
      searchScope.search.length > 200
    )
      return null;
    const result = parsed.result;
    if (
      !Number.isSafeInteger(result.page) ||
      result.page < 1 ||
      result.page > 10 ||
      !Number.isSafeInteger(result.fetched) ||
      result.fetched < 0 ||
      result.fetched > 20 ||
      !Number.isSafeInteger(result.detailsFailed) ||
      result.detailsFailed < 0 ||
      result.detailsFailed > 20 ||
      (result.nextPage !== null &&
        (!Number.isSafeInteger(result.nextPage) ||
          result.nextPage < 2 ||
          result.nextPage > 10)) ||
      typeof result.message !== "string" ||
      result.message.length > 1000
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export default function DiscoverCompanies() {
  const { base, canWrite, refresh } = useWorkspace();
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const [prefecture, setPrefecture] = useState("");
  const [industry, setIndustry] = useState("");
  const [presence, setPresence] = useState<Partial<Record<Presence, boolean>>>(
    {},
  );
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>("fetched_at");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionRecords, setSelectionRecords] = useState<
    Record<string, Candidate>
  >({});
  const [focused, setFocused] = useState<Candidate | null>(null);
  const [importIds, setImportIds] = useState<string[] | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [acquiring, setAcquiring] = useState(false);
  const [acquireError, setAcquireError] = useState("");
  const [acquired, setAcquired] = useState<AcquisitionCheckpoint | null>(null);
  const checkpointKey = `leadstack.discovery.v1.${base}`;
  const savedCheckpoint = useSyncExternalStore(
    subscribeToStorage,
    () => {
      try {
        return window.localStorage.getItem(checkpointKey);
      } catch {
        return null;
      }
    },
    emptyStorageSnapshot,
  );
  const rememberedAcquisition = acquired ?? parseCheckpoint(savedCheckpoint);
  const inFlight = useRef(false);
  const rows = useApi<DiscoveryListResponse>(
    `${base}/company-discovery?${query({
      search: term,
      prefecture,
      industry,
      hasPhone: presence.hasPhone ? "true" : undefined,
      hasWebsite: presence.hasWebsite ? "true" : undefined,
      hasEmployees: presence.hasEmployees ? "true" : undefined,
      page,
      pageSize: 20,
      sort,
      direction,
    })}`,
  );
  const data = rows.data;
  const remoteSearch = search.normalize("NFKC").trim();
  const scope = JSON.stringify({ prefecture, search: remoteSearch });
  const latestAcquisition =
    rememberedAcquisition?.scope === scope
      ? rememberedAcquisition.result
      : null;
  const canAcquire =
    canWrite &&
    data?.configured &&
    (!!prefecture || !!remoteSearch) &&
    !acquiring;
  const hasFilters =
    !!search ||
    !!prefecture ||
    !!industry ||
    Object.values(presence).some(Boolean);
  const allSelected =
    !!data?.data.length && data.data.every((row) => selected.includes(row.id));

  function resetPage() {
    setPage(1);
    setSelected([]);
    setSelectionRecords({});
  }
  function clear() {
    setSearch("");
    setPrefecture("");
    setIndustry("");
    setPresence({});
    resetPage();
  }
  function order(next: Sort) {
    setSort(next);
    setDirection(sort === next && direction === "asc" ? "desc" : "asc");
    setPage(1);
  }
  function toggle(id: string, checked: boolean) {
    if (checked && !selected.includes(id) && selected.length >= 50) {
      toast.error("一度に選択できる候補は50社までです");
      return;
    }
    if (checked) {
      const candidate = data?.data.find((row) => row.id === id);
      if (candidate)
        setSelectionRecords((current) => ({ ...current, [id]: candidate }));
    }
    setSelected((current) => {
      if (!checked) return current.filter((value) => value !== id);
      if (current.includes(id)) return current;
      if (current.length >= 50) {
        return current;
      }
      return [...current, id];
    });
  }
  function togglePage(checked: boolean) {
    if (!data) return;
    if (!checked) {
      const currentPage = new Set(data.data.map((row) => row.id));
      setSelected((current) => current.filter((id) => !currentPage.has(id)));
      return;
    }
    const next = [...new Set([...selected, ...data.data.map((row) => row.id)])];
    if (next.length > 50) toast.info("選択上限の50社まで選択しました");
    setSelected(next.slice(0, 50));
    setSelectionRecords((current) => ({
      ...current,
      ...Object.fromEntries(
        data.data
          .filter((row) => next.slice(0, 50).includes(row.id))
          .map((row) => [row.id, row]),
      ),
    }));
  }
  async function acquire(nextPage = 1) {
    if (!canAcquire || inFlight.current) return;
    inFlight.current = true;
    setAcquiring(true);
    setAcquireError("");
    try {
      const result = await api<AcquireResponse>(
        `${base}/company-discovery`,
        "POST",
        {
          action: "acquire",
          prefecture: prefecture || undefined,
          ...(/^\d{13}$/.test(remoteSearch)
            ? { corporateNumber: remoteSearch }
            : { name: remoteSearch || undefined }),
          page: nextPage,
        },
      );
      const checkpoint = { scope, result };
      setAcquired(checkpoint);
      try {
        window.localStorage.setItem(checkpointKey, JSON.stringify(checkpoint));
      } catch {}
      setPage(1);
      await rows.mutate();
      toast.success(`${result.fetched} 社の候補を取得しました`);
    } catch (error) {
      setAcquireError(message(error));
    } finally {
      inFlight.current = false;
      setAcquiring(false);
    }
  }
  async function imported() {
    setSelected([]);
    await Promise.all([rows.mutate(), refresh()]);
  }
  async function removeCandidates() {
    if (inFlight.current || !canWrite || !selected.length) return;
    inFlight.current = true;
    setRemoving(true);
    setRemoveError("");
    try {
      const result = await api<{ removed: number }>(
        `${base}/company-discovery`,
        "POST",
        { action: "remove", ids: selected, confirmed: true },
      );
      setSelected([]);
      setSelectionRecords({});
      setRemoveOpen(false);
      toast.success(`${result.removed} 社を取得済み候補から削除しました`);
      await rows.mutate();
    } catch (error) {
      setRemoveError(message(error));
    } finally {
      inFlight.current = false;
      setRemoving(false);
    }
  }
  const fetchButton = (
    <Button onClick={() => void acquire()} disabled={!canAcquire}>
      <Busy busy={acquiring}>
        <Download />
        Gビズインフォから候補を取得
      </Busy>
    </Button>
  );

  return (
    <div className="page">
      <PageHeader
        title="企業を探す"
        description="外部の企業情報を条件で絞り、確認した企業を営業リストに取り込みます。"
        action={
          <Button asChild variant="outline">
            <Link href="/companies">
              <Building2 />
              営業リスト
            </Link>
          </Button>
        }
      />

      <div className="surface space-y-4 p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">企業の検索条件</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              都道府県は法人の所在地で絞り込みます。業種・情報の有無は、取得済み候補に適用されます。
            </p>
          </div>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clear}
              disabled={acquiring}
            >
              <X />
              条件をクリア
            </Button>
          )}
        </div>
        <fieldset
          disabled={acquiring}
          className="grid gap-3 md:grid-cols-[minmax(200px,1.3fr)_minmax(180px,.8fr)_minmax(220px,1fr)]"
        >
          <label>
            <span className="field-label">企業名・法人番号</span>
            <div className="relative">
              <Search
                className="absolute left-3 top-2.5 size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                className="bg-white pl-9"
                placeholder="企業名または13桁の法人番号"
                value={search}
                maxLength={200}
                onChange={(event) => {
                  setSearch(event.target.value);
                  resetPage();
                }}
              />
            </div>
          </label>
          <div>
            <label className="field-label" htmlFor="discovery-prefecture">
              都道府県
            </label>
            <SearchableSelect
              id="discovery-prefecture"
              label="都道府県"
              options={prefectureOptions}
              value={prefecture}
              disabled={acquiring}
              onChange={(value) => {
                setPrefecture(value);
                resetPage();
              }}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="discovery-industry">
              業種（日本標準産業分類）
            </label>
            <SearchableSelect
              id="discovery-industry"
              label="業種"
              options={[
                { value: "", label: "業種：すべて" },
                ...(data?.industryOptions ?? []),
              ]}
              value={industry}
              disabled={acquiring}
              onChange={(value) => {
                setIndustry(value);
                resetPage();
              }}
            />
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-4">
          {Object.entries(presenceLabels).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!presence[key as Presence]}
                disabled={acquiring}
                onChange={(event) => {
                  setPresence((current) => ({
                    ...current,
                    [key]: event.target.checked,
                  }));
                  resetPage();
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <div className="space-y-3 rounded-md bg-slate-50 p-4">
          {data && !data.configured ? (
            <p role="status" className="text-sm">
              外部データの接続設定が必要です。取得済みの候補は検索できます。新しく取得するには管理者に接続設定を依頼してください。
            </p>
          ) : (
            <p className="text-sm leading-relaxed">
              新しい候補を探すには都道府県または企業名を指定して取得してください。1回につき最大20社を調べます。業種での絞り込みは取得後に反映されます。
            </p>
          )}
          {canWrite ? (
            <div className="flex flex-wrap items-center gap-3">
              {fetchButton}
              {!prefecture && !remoteSearch && (
                <span className="text-xs text-muted-foreground">
                  都道府県または企業名・法人番号を指定してください
                </span>
              )}
              {!latestAcquisition &&
                rememberedAcquisition?.result.nextPage &&
                canWrite && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={acquiring}
                    onClick={() => {
                      const previous = JSON.parse(
                        rememberedAcquisition.scope,
                      ) as { prefecture: string; search: string };
                      setPrefecture(previous.prefecture);
                      setSearch(previous.search);
                      resetPage();
                    }}
                  >
                    前回の取得条件を戻す（続きから取得できます）
                  </Button>
                )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              閲覧権限のため、取得済み候補の検索のみ利用できます。候補の取得・取込は営業メンバーまたは管理者に依頼してください。
            </p>
          )}
          {acquiring && (
            <p role="status" className="text-xs text-muted-foreground">
              企業の基本情報と業種・Webサイト・従業員数を確認しています。この処理には少し時間がかかります。
            </p>
          )}
          {acquireError && (
            <p role="alert" className="text-sm text-destructive">
              {acquireError}
            </p>
          )}
          {latestAcquisition && (
            <div role="status" className="space-y-2 border-t pt-3 text-sm">
              <p>{latestAcquisition.message}</p>
              {latestAcquisition.detailsFailed > 0 && (
                <p className="text-xs text-muted-foreground">
                  {latestAcquisition.detailsFailed}{" "}
                  社は詳細情報を取得できませんでした。取得できた基本情報を表示しています。
                </p>
              )}
              {latestAcquisition.nextPage !== null && canWrite && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canAcquire}
                  onClick={() => void acquire(latestAcquisition.nextPage!)}
                >
                  <Busy busy={acquiring}>
                    続きの候補を取得（{latestAcquisition.nextPage} 回目）
                  </Busy>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <section
        className="surface overflow-hidden"
        aria-labelledby="candidate-list-title"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div>
            <h2 id="candidate-list-title" className="font-semibold">
              取得済み候補{" "}
              <span className="ml-1 text-primary">
                {data?.count.toLocaleString() ?? "—"} 社
              </span>
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              組織内の取得済み {data?.totalCached.toLocaleString() ?? "—"}{" "}
              社から検索 · 最終取得 {fetchedLabel(data?.lastFetchedAt)}
              （日本時間）
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void rows.mutate()}
            disabled={rows.isValidating}
          >
            <RefreshCw
              className={rows.isValidating ? "animate-spin" : undefined}
            />
            再読み込み
          </Button>
        </div>
        <p className="border-b bg-slate-50/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          表示件数は取得済み候補の件数です。全国の企業や検索条件に合う企業の全件数ではありません。電話番号はGビズインフォには含まれず、公式サイトでの確認または手動入力が必要です。
        </p>
        {selected.length > 0 && canWrite && (
          <div className="flex flex-wrap items-center gap-3 border-b bg-teal-50 p-3 text-teal-900">
            <span className="text-sm font-medium">
              {selected.length} / 50 社を選択中
            </span>
            <Button size="sm" onClick={() => setImportIds([...selected])}>
              <Download />
              営業リストに取り込む
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRemoveError("");
                setRemoveOpen(true);
              }}
            >
              候補から削除
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
              選択解除
            </Button>
          </div>
        )}
        {rows.error ? (
          <ErrorState error={rows.error} retry={() => void rows.mutate()} />
        ) : !data ? (
          <Loading label="企業の候補を読み込み中" />
        ) : data.data.length ? (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[1060px]">
              <thead>
                <tr>
                  {canWrite && (
                    <th scope="col" className="w-10">
                      <input
                        type="checkbox"
                        aria-label="このページの候補をすべて選択"
                        checked={allSelected}
                        onChange={(event) => togglePage(event.target.checked)}
                      />
                    </th>
                  )}
                  <th
                    scope="col"
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
                      企業名
                      <ArrowUpDown className="size-3" />
                    </button>
                  </th>
                  <th scope="col">所在地・業種</th>
                  <th scope="col">電話番号</th>
                  <th scope="col">Webサイト</th>
                  <th
                    scope="col"
                    aria-sort={
                      sort === "employee_number"
                        ? direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      className="flex items-center gap-2"
                      onClick={() => order("employee_number")}
                    >
                      従業員数
                      <ArrowUpDown className="size-3" />
                    </button>
                  </th>
                  <th
                    scope="col"
                    aria-sort={
                      sort === "fetched_at"
                        ? direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      className="flex items-center gap-2"
                      onClick={() => order("fetched_at")}
                    >
                      取得日時
                      <ArrowUpDown className="size-3" />
                    </button>
                  </th>
                  <th scope="col">営業リスト</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((candidate) => (
                  <tr
                    key={candidate.id}
                    className={
                      selected.includes(candidate.id)
                        ? "bg-teal-50/40"
                        : undefined
                    }
                  >
                    {canWrite && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${candidate.name}を選択`}
                          checked={selected.includes(candidate.id)}
                          disabled={
                            selected.length >= 50 &&
                            !selected.includes(candidate.id)
                          }
                          onChange={(event) =>
                            toggle(candidate.id, event.target.checked)
                          }
                        />
                      </td>
                    )}
                    <td>
                      <button
                        className="block max-w-64 text-left font-medium text-primary hover:underline"
                        onClick={() => setFocused(candidate)}
                      >
                        {candidate.name}
                      </button>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {candidate.corporate_number}
                      </p>
                    </td>
                    <td className="max-w-60 text-xs">
                      <p
                        className="line-clamp-2"
                        title={candidate.location || undefined}
                      >
                        {candidate.location || candidate.prefecture || "未確認"}
                      </p>
                      <p
                        className="mt-1 line-clamp-2 text-muted-foreground"
                        title={candidate.industry_labels.join("・")}
                      >
                        {candidate.industry_labels.join("・") || "業種：未確認"}
                      </p>
                    </td>
                    <td className="text-xs">
                      <PhoneLink value={candidate.phone} />
                    </td>
                    <td className="text-xs">
                      <WebsiteLink value={candidate.website_url} />
                    </td>
                    <td className="whitespace-nowrap text-right text-xs">
                      {candidate.employee_number == null ? (
                        <UnknownValue />
                      ) : (
                        employeeLabel(candidate.employee_number)
                      )}
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted-foreground">
                      {fetchedLabel(candidate.fetched_at)}
                    </td>
                    <td>
                      {candidate.company_id ? (
                        <div className="space-y-2">
                          <Link
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            href={`/companies/${candidate.company_id}`}
                          >
                            登録済み
                            <ExternalLink className="size-3" />
                          </Link>
                          {canWrite && (
                            <ActivityDialog
                              companyId={candidate.company_id}
                              companyName={
                                candidate.crm_company_name || candidate.name
                              }
                              phone={candidate.crm_company_phone}
                            />
                          )}
                        </div>
                      ) : (
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          未取込
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={
              data.totalCached
                ? "条件に合う取得済み候補はありません"
                : "企業の候補を取得しましょう"
            }
            description={
              data.totalCached
                ? "条件を変えるか、都道府県や企業名を指定して外部から候補を取得してください。未確認の項目は「あり」の条件には含まれません。"
                : "上の検索条件で都道府県または企業名を指定し、Gビズインフォから候補を取得できます。"
            }
            action={
              hasFilters && data.totalCached ? (
                <Button variant="outline" onClick={clear}>
                  検索条件をクリア
                </Button>
              ) : undefined
            }
          />
        )}
        <Pagination
          page={page}
          count={data?.count}
          pageSize={data?.pageSize ?? 20}
          onChange={setPage}
        />
      </section>
      {focused && (
        <CandidateDialog
          key={focused.id}
          candidate={focused}
          open
          onOpenChange={(open) => {
            if (!open) setFocused(null);
          }}
          onUpdated={async (candidate) => {
            setFocused(candidate);
            await rows.mutate();
          }}
        />
      )}
      {importIds && (
        <DiscoveryImportDialog
          ids={importIds}
          candidates={Object.values({
            ...selectionRecords,
            ...Object.fromEntries(
              (data?.data ?? []).map((row) => [row.id, row]),
            ),
          })}
          open
          onOpenChange={(open) => {
            if (!open) setImportIds(null);
          }}
          onImported={imported}
        />
      )}
      <Dialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!removing) setRemoveOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>選択した候補を削除しますか？</DialogTitle>
            <DialogDescription>
              {selected.length}{" "}
              社を取得済み候補から削除します。営業リストに取り込んだ企業・活動記録は残ります。候補に手動で入力した情報は削除されます。
            </DialogDescription>
          </DialogHeader>
          {removeError && (
            <p role="alert" className="text-sm text-destructive">
              {removeError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={removing}
              onClick={() => setRemoveOpen(false)}
            >
              キャンセル
            </Button>
            <Button disabled={removing} onClick={() => void removeCandidates()}>
              <Busy busy={removing}>削除する</Busy>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
