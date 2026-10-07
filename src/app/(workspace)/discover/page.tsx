"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  ArrowUpDown,
  Building2,
  Download,
  ExternalLink,
  RefreshCw,
  Phone,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/layout/workspace";
import { api, message, type ApiError } from "@/lib/client-api";
import type {
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
import { PhoneResearchDialog } from "@/components/discovery/phone-research-dialog";
import { PHONE_RESEARCH_BATCH_LIMIT } from "@/lib/discovery/phone-research";
import { TargetingFilters } from "@/components/discovery/targeting-filters";
import { DiscoveryScanPanel } from "@/components/discovery/scan-panel";
import { useDiscoveryScan } from "@/components/discovery/use-discovery-scan";
import {
  hasScanCriteria,
  scanCriteriaFromFilters,
} from "@/lib/discovery/scan-client";
import {
  defaultDiscoveryFilters,
  matchingBusinessKeywords,
  parseDiscoveryFilters,
  targetingFilterError,
  targetingPresets,
  type DiscoveryFilters,
} from "@/lib/discovery/targeting";
import { industryOptions } from "@/lib/discovery/industries";
import { DiscoveryImportDialog } from "@/components/discovery/import-dialog";
import {
  employeeLabel,
  fetchedLabel,
  PhoneLink,
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
const subscribeToHydration = () => () => {};
const clientHydrationSnapshot = () => true;
const serverHydrationSnapshot = () => false;
export default function DiscoverCompanies() {
  const { base } = useWorkspace();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    clientHydrationSnapshot,
    serverHydrationSnapshot,
  );
  if (!hydrated) return <Loading label="検索条件を読み込み中" />;
  // Remount every piece of search, selection and acquisition state on org switch.
  return <OrganizationDiscovery key={base} />;
}

function OrganizationDiscovery() {
  const { base, canWrite, refresh, profile } = useWorkspace();
  const filtersKey = `leadstack.discovery.filters.v1.${base}`;
  // The parent mounts this component only after hydration. Restore once so a
  // different tab cannot change the results underneath an existing selection.
  const [filters, setFilters] = useState<DiscoveryFilters>(() => {
    try {
      return parseDiscoveryFilters(window.localStorage.getItem(filtersKey));
    } catch {
      return { ...defaultDiscoveryFilters };
    }
  });
  const { search, prefecture, industry, sort, direction } = filters;
  const filterSnapshot = JSON.stringify(filters);
  const appliedSnapshot = useDebounced(filterSnapshot);
  const filtersSettling = filterSnapshot !== appliedSnapshot;
  const filterError = targetingFilterError(filters);
  const applied = JSON.parse(appliedSnapshot) as DiscoveryFilters;
  const queryFilterError = targetingFilterError(applied);
  const keywords = applied.businessKeywords;
  const preset = targetingPresets.find((item) => item.id === filters.presetId);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionRecords, setSelectionRecords] = useState<
    Record<string, Candidate>
  >({});
  const [focused, setFocused] = useState<Candidate | null>(null);
  const [importIds, setImportIds] = useState<string[] | null>(null);
  const [phoneResearch, setPhoneResearch] = useState<Candidate[] | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [refreshDetails, setRefreshDetails] = useState(false);
  const inFlight = useRef(false);
  const rows = useSWR<DiscoveryListResponse, ApiError>(
    queryFilterError || filtersSettling
      ? null
      : `${base}/company-discovery?${query({
          search: applied.search,
          prefecture: applied.prefecture,
          industry: applied.industry,
          hasPhone: applied.hasPhone ? "true" : undefined,
          hasWebsite: applied.hasWebsite ? "true" : undefined,
          hasEmployees: applied.hasEmployees ? "true" : undefined,
          employeeMin: applied.employeeMin || undefined,
          employeeMax: applied.employeeMax || undefined,
          includeUnknownEmployees: applied.includeUnknownEmployees
            ? "true"
            : "false",
          includeUnknownIndustry: applied.includeUnknownIndustry
            ? "true"
            : "false",
          businessKeywords: keywords || undefined,
          page,
          pageSize: 20,
          view: "summary",
          sort: applied.sort,
          direction: applied.direction,
        })}`,
    (url: string) => api<DiscoveryListResponse>(url),
    {
      keepPreviousData: false,
      revalidateOnFocus: false,
      shouldRetryOnError: (error) => error.status >= 500,
      errorRetryCount: 2,
      dedupingInterval: 2000,
    },
  );
  const criteria = {
    ...scanCriteriaFromFilters(filters),
    ...(refreshDetails ? { refreshDetails: true } : {}),
  };
  const scan = useDiscoveryScan({
    base,
    actorId: profile.id,
    criteria,
    // Keep the scan's finishing state until the resulting list has settled.
    // SWR exposes failures through rows.error; avoid unhandled refresh promises.
    onSaved: () =>
      rows.mutate().then(
        () => undefined,
        () => undefined,
      ),
  });
  const data = rows.data;
  const hasFilters =
    !!search ||
    !!prefecture ||
    !!industry ||
    filters.hasPhone ||
    filters.hasWebsite ||
    filters.hasEmployees ||
    !!filters.employeeMin ||
    !!filters.employeeMax ||
    !!filters.businessKeywords ||
    !filters.includeUnknownEmployees ||
    filters.includeUnknownIndustry ||
    !!filters.presetId;
  const allSelected =
    !!data?.data.length && data.data.every((row) => selected.includes(row.id));

  function resetPage() {
    setPage(1);
    setSelected([]);
    setSelectionRecords({});
  }
  function changeFilters(change: Partial<DiscoveryFilters>) {
    const next = { ...filters, ...change };
    if (change.hasEmployees) next.includeUnknownEmployees = false;
    else if (change.includeUnknownEmployees) next.hasEmployees = false;
    if (
      JSON.stringify(scanCriteriaFromFilters(next)) !==
      JSON.stringify(scanCriteriaFromFilters(filters))
    )
      scan.cancel();
    setFilters(next);
    // Invalid drafts remain editable but must not replace the last valid saved search.
    if (!targetingFilterError(next)) {
      try {
        window.localStorage.setItem(
          filtersKey,
          JSON.stringify({ version: 1, filters: next }),
        );
      } catch {}
    }
    resetPage();
  }
  function clear() {
    changeFilters({ ...defaultDiscoveryFilters });
  }
  function order(next: Sort) {
    changeFilters({
      sort: next,
      direction: sort === next && direction === "asc" ? "desc" : "asc",
    });
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
  function startScan(resume: boolean) {
    if (
      !canWrite ||
      !data?.configured ||
      filterError ||
      filtersSettling ||
      removing
    )
      return;
    resetPage();
    void scan.start(resume);
    const progress = document.getElementById("discovery-search-progress");
    requestAnimationFrame(() => {
      if (progress?.isConnected)
        progress.scrollIntoView({
          block: "start",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "instant"
            : "smooth",
        });
    });
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

      <div className="surface space-y-3 p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">企業の検索条件</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              所在地は法人の住所です。検索条件はこのブラウザに組織ごとに保存します。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <a href="#candidate-list">候補を見る</a>
            </Button>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clear}>
                <X />
                条件をクリア
              </Button>
            )}
          </div>
        </div>
        <fieldset className="grid gap-3 md:grid-cols-[minmax(180px,.8fr)_minmax(220px,1fr)_minmax(200px,1.3fr)]">
          <div>
            <label className="field-label" htmlFor="discovery-prefecture">
              都道府県
            </label>
            <SearchableSelect
              id="discovery-prefecture"
              label="都道府県"
              options={prefectureOptions}
              value={prefecture}
              onChange={(value) => {
                changeFilters({ prefecture: value });
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
                ...(data?.industryOptions ?? [
                  ...industryOptions,
                  { value: "unknown", label: "業種：未確認" },
                ]),
              ]}
              value={industry}
              onChange={(value) => {
                changeFilters({ industry: value });
              }}
            />
          </div>
          <label>
            <span className="field-label">企業名・法人番号（任意）</span>
            <div className="relative">
              <Search
                className="absolute left-3 top-2.5 size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                className="bg-white pl-9"
                placeholder="任意：企業名が分からなくても検索できます"
                value={search}
                maxLength={200}
                onChange={(event) => {
                  changeFilters({ search: event.target.value });
                }}
              />
            </div>
          </label>
        </fieldset>
        <TargetingFilters
          filters={filters}
          disabled={false}
          error={filterError}
          onChange={changeFilters}
        />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-3">
          {Object.entries(presenceLabels).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={filters[key as Presence]}
                onChange={(event) => {
                  changeFilters({ [key]: event.target.checked });
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <DiscoveryScanPanel
          scan={scan}
          canWrite={canWrite}
          configured={data?.configured}
          hasCriteria={hasScanCriteria(criteria)}
          requiresPhone={filters.hasPhone}
          disabled={!!filterError || filtersSettling || removing}
          resultsUpdating={rows.isValidating}
          resultsError={!!rows.error}
          refreshDetails={refreshDetails}
          onRefreshDetailsChange={(value) => {
            void scan.cancel();
            setRefreshDetails(value);
          }}
          onStart={startScan}
        />
        {preset && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              企業名でさらに絞る（任意）
            </summary>
            <div
              className="mt-2 flex flex-wrap gap-2"
              role="group"
              aria-label="企業名で取得する候補"
            >
              {preset.nameHints.map((hint) => (
                <Button
                  key={hint}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={search === hint}
                  onClick={() => changeFilters({ search: hint })}
                  className="h-7 px-2 text-xs"
                >
                  {hint}
                </Button>
              ))}
            </div>
          </details>
        )}
        {search && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>「{search}」を企業名・法人番号の条件に指定しています。</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => changeFilters({ search: "" })}
              className="h-7 px-2 text-xs"
            >
              企業名・法人番号の条件だけ解除
            </Button>
          </div>
        )}
      </div>

      <section
        id="candidate-list"
        className="surface scroll-mt-4 overflow-hidden"
        aria-labelledby="candidate-list-title"
        aria-busy={
          scan.running ||
          scan.finishing ||
          scan.cancellation === "pending" ||
          rows.isValidating ||
          filtersSettling
        }
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
            disabled={rows.isValidating || !!filterError || filtersSettling}
          >
            <RefreshCw
              className={rows.isValidating ? "animate-spin" : undefined}
            />
            再読み込み
          </Button>
        </div>
        <div className="space-y-2 border-b bg-slate-50/50 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <p>
            表示件数は取得済み候補の件数です。全国の企業や検索条件に合う企業の全件数ではありません。
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              架電リストの作成：候補を選択 →「電話番号を調べる」→
              出典を確認して保存 →
              営業リストへ取込。Gビズインフォの電話番号はないため、公式サイトから補完します。
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => changeFilters({ hasPhone: !filters.hasPhone })}
              aria-pressed={filters.hasPhone}
            >
              <Phone />
              {filters.hasPhone
                ? "電話番号の絞込みを解除"
                : "電話番号ありを表示"}
            </Button>
          </div>
        </div>
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
              disabled={scan.running || scan.blocked}
              onClick={() => {
                const records = {
                  ...selectionRecords,
                  ...Object.fromEntries(
                    (data?.data ?? []).map((row) => [row.id, row]),
                  ),
                };
                setPhoneResearch(
                  selected
                    .slice(0, PHONE_RESEARCH_BATCH_LIMIT)
                    .map((id) => records[id])
                    .filter((row): row is Candidate => !!row),
                );
              }}
            >
              <Phone />
              電話番号を調べる
              {selected.length > PHONE_RESEARCH_BATCH_LIMIT
                ? "（先頭10社）"
                : ""}
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
        {filterError ? (
          <Empty
            title="検索条件を確認してください"
            description="上の入力エラーを修正すると、企業候補を検索します。"
          />
        ) : filtersSettling ? (
          <Loading label="検索条件を反映中" />
        ) : rows.error ? (
          <ErrorState error={rows.error} retry={() => void rows.mutate()} />
        ) : !data ||
          (!data.data.length &&
            (scan.running ||
              scan.finishing ||
              scan.cancellation === "pending" ||
              rows.isValidating)) ? (
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
                      {candidate.business_summary && (
                        <p
                          className="mt-1 line-clamp-2 max-w-72 text-xs text-muted-foreground"
                          title={candidate.business_summary}
                        >
                          {candidate.business_summary}
                        </p>
                      )}
                      {keywords &&
                        (
                          candidate.matched_business_keywords ??
                          matchingBusinessKeywords(candidate, keywords)
                        ).length > 0 && (
                          <p className="mt-1 max-w-72 text-[11px] text-muted-foreground">
                            名称・事業内容に一致：
                            {(
                              candidate.matched_business_keywords ??
                              matchingBusinessKeywords(candidate, keywords)
                            ).join("・")}
                          </p>
                        )}
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
                      {!candidate.phone && candidate.enrichment_checked_at && (
                        <button
                          className="mt-1 block text-xs text-primary hover:underline"
                          onClick={() => setFocused(candidate)}
                        >
                          サイトの調査結果
                        </button>
                      )}
                    </td>
                    <td className="text-xs">
                      <WebsiteLink value={candidate.website_url} />
                    </td>
                    <td className="whitespace-nowrap text-right text-xs">
                      {candidate.employee_number == null ? (
                        <span className="text-muted-foreground">未確認</span>
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
                : "条件を指定して企業を探しましょう"
            }
            description={
              data.totalCached
                ? "上の「条件に合う企業を探す」で外部の企業を確認できます。見つからない場合は人数・業種が未確認の企業を含めるか、条件を広げてください。"
                : "都道府県・業種・人数などを指定し、「条件に合う企業を探す」を押してください。企業名は空欄で使えます。"
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
        {!filterError && (
          <Pagination
            page={page}
            count={data?.count}
            pageSize={data?.pageSize ?? 20}
            onChange={setPage}
          />
        )}
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
      {phoneResearch && (
        <PhoneResearchDialog
          base={base}
          candidates={phoneResearch}
          onClose={() => {
            setPhoneResearch(null);
            void rows.mutate();
          }}
          onUpdated={(candidate) => {
            setSelectionRecords((current) => ({
              ...current,
              [candidate.id]: candidate,
            }));
            void rows.mutate(
              (current) =>
                current
                  ? {
                      ...current,
                      data: current.data.map((row) =>
                        row.id === candidate.id ? candidate : row,
                      ),
                    }
                  : current,
              { revalidate: false },
            );
          }}
          onDetail={(candidate) => {
            setPhoneResearch(null);
            setFocused({ ...candidate, list_summary: true });
            void rows.mutate();
          }}
          onImport={(candidates) => {
            setPhoneResearch(null);
            setSelectionRecords((current) => ({
              ...current,
              ...Object.fromEntries(candidates.map((row) => [row.id, row])),
            }));
            setImportIds(candidates.map((row) => row.id));
            void rows.mutate();
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
