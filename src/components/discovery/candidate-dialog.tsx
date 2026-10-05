"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Globe, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { Candidate } from "@/lib/discovery/contracts";
import { api, message, type ApiError } from "@/lib/client-api";
import { useWorkspace } from "@/components/layout/workspace";
import { ActivityDialog } from "@/components/crm/activity";
import { Busy } from "@/components/crm/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  employeeLabel,
  fetchedLabel,
  PhoneLink,
  WebsiteLink,
  safeWebsite,
} from "./display";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function SourceDetails({ candidate }: { candidate: Candidate }) {
  const provenance = object(candidate.provenance);
  const gbiz = object(
    provenance.gbiz ?? provenance.gBizINFO ?? candidate.provenance,
  );
  const metadata = object(gbiz.metadata);
  const sources = object(metadata.source);
  const fieldSources = object(provenance.fieldSources);
  const manual = object(provenance.manual);
  const overrides = Array.isArray(provenance.manualOverrides)
    ? provenance.manualOverrides
    : [];
  const sourceFields = [
    ["name", "企業名"],
    ["location", "所在地"],
    ["industry", "業種"],
    ["business_summary", "事業内容"],
    ["company_url", "Webサイト"],
    ["employee_number", "従業員数"],
  ];
  const sourceUrl = `https://info.gbiz.go.jp/hojin/ichiran?hojinBango=${candidate.corporate_number}`;
  return (
    <div className="space-y-3 rounded-md border bg-slate-50 p-4 text-xs">
      <p className="font-medium">出典・取得情報</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">基本情報</dt>
        <dd>Gビズインフォ</dd>
        <dt className="text-muted-foreground">基本情報の取得日時</dt>
        <dd>{fetchedLabel(candidate.fetched_at)}（日本時間）</dd>
        <dt className="text-muted-foreground">元データ更新日</dt>
        <dd>{candidate.source_updated_at || "未確認"}</dd>
        {sourceUrl && (
          <>
            <dt className="text-muted-foreground">取得元</dt>
            <dd className="min-w-0 break-all">
              <WebsiteLink value={sourceUrl} />
            </dd>
          </>
        )}
        {sourceFields.map(([key, label]) => {
          const field = key === "company_url" ? "website_url" : key;
          const detail = object(fieldSources[field]);
          const source = detail.source ?? sources[key];
          return !overrides.includes(field) && typeof source === "string" ? (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{label}の出典</dt>
              <dd className="break-words">
                {source}
                {typeof detail.retrievedAt === "string" && (
                  <span className="block text-muted-foreground">
                    取得：{fetchedLabel(detail.retrievedAt)}
                  </span>
                )}
                {typeof detail.sourceUpdatedAt === "string" && (
                  <span className="block text-muted-foreground">
                    元情報の更新：{detail.sourceUpdatedAt}
                  </span>
                )}
              </dd>
            </div>
          ) : null;
        })}
        {[
          ["phone", "電話番号"],
          ["website_url", "Webサイト"],
          ["employee_number", "従業員数"],
        ].map(([key, label]) =>
          overrides.includes(key) ? (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{label}の確認</dt>
              <dd>
                メンバーが確認・保存
                {typeof manual.updatedAt === "string"
                  ? `（${fetchedLabel(manual.updatedAt)}）`
                  : ""}
              </dd>
            </div>
          ) : null,
        )}
      </dl>
      <p className="leading-relaxed text-muted-foreground">
        取得日時と情報の更新日は異なります。従業員数の単体・連結などの集計範囲は、元の出典で確認してください。空欄は未確認です。
      </p>
    </div>
  );
}

type CandidateDialogProps = {
  candidate: Candidate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (candidate: Candidate) => Promise<void>;
};

export function CandidateDialog(props: CandidateDialogProps) {
  const { base } = useWorkspace();
  const details = useSWR<{ candidate: Candidate }, ApiError>(
    props.open && props.candidate.list_summary
      ? `${base}/company-discovery/${props.candidate.id}`
      : null,
    (url: string) => api<{ candidate: Candidate }>(url),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  );
  if (!props.open) return null;
  const candidate = props.candidate.list_summary
    ? details.data?.candidate
    : props.candidate;
  if (!candidate || (props.candidate.list_summary && details.isValidating)) {
    return (
      <Dialog open onOpenChange={props.onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{props.candidate.name}</DialogTitle>
            <DialogDescription>企業情報と出典を確認します。</DialogDescription>
          </DialogHeader>
          {details.error ? (
            <div className="space-y-3">
              <p role="alert" className="text-sm text-destructive">
                {message(details.error)}
              </p>
              <Button variant="outline" onClick={() => void details.mutate()}>
                詳細を再読み込み
              </Button>
            </div>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              詳細を読み込み中…
            </p>
          )}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <CandidateDialogContent
      {...props}
      candidate={candidate}
      key={candidate.id}
    />
  );
}

function CandidateDialogContent({
  candidate: initial,
  open,
  onOpenChange,
  onUpdated,
}: CandidateDialogProps) {
  const { base, canWrite } = useWorkspace();
  const [candidate, setCandidate] = useState(initial);
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [website, setWebsite] = useState(initial.website_url ?? "");
  const [employees, setEmployees] = useState(
    initial.employee_number == null ? "" : String(initial.employee_number),
  );
  const [busy, setBusy] = useState<"save" | "enrich" | null>(null);
  const [error, setError] = useState("");
  const running = useRef(false);
  const proposal = candidate.enrichment_result;
  const changed =
    phone.trim() !== (candidate.phone ?? "") ||
    website.trim() !== (candidate.website_url ?? "") ||
    employees !==
      (candidate.employee_number == null
        ? ""
        : String(candidate.employee_number));

  async function enrich() {
    if (running.current || !canWrite) return;
    running.current = true;
    setBusy("enrich");
    setError("");
    try {
      const result = await api<{ candidate: Candidate }>(
        `${base}/company-discovery`,
        "POST",
        { action: "enrich", id: candidate.id },
      );
      setCandidate(result.candidate);
      await onUpdated(result.candidate);
    } catch (error) {
      setError(message(error));
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (running.current || !canWrite) return;
    if (website.trim() && !safeWebsite(website.trim())) {
      setError(
        "Webサイトは http:// または https:// から始まるURLを入力してください。",
      );
      return;
    }
    const employeeNumber = employees.trim() === "" ? null : Number(employees);
    if (
      employeeNumber !== null &&
      (!Number.isSafeInteger(employeeNumber) || employeeNumber < 0)
    ) {
      setError(
        "従業員数は0以上の整数を入力してください。不明な場合は空欄にします。",
      );
      return;
    }
    running.current = true;
    setBusy("save");
    setError("");
    try {
      const result = await api<{ candidate: Candidate }>(
        `${base}/company-discovery`,
        "POST",
        {
          action: "update",
          id: candidate.id,
          expectedUpdatedAt: candidate.updated_at,
          phone: phone.trim() || null,
          website_url: website.trim() || null,
          employee_number: employeeNumber,
        },
      );
      setCandidate(result.candidate);
      setPhone(result.candidate.phone ?? "");
      setWebsite(result.candidate.website_url ?? "");
      setEmployees(
        result.candidate.employee_number == null
          ? ""
          : String(result.candidate.employee_number),
      );
      toast.success("候補の情報を保存しました");
      await onUpdated(result.candidate);
    } catch (error) {
      setError(message(error));
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-5 leading-relaxed">
            {candidate.name}
          </DialogTitle>
          <DialogDescription>
            法人番号 {candidate.corporate_number} ·
            営業リストへの取込前に情報を確認できます。
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted-foreground">所在地</dt>
          <dd>{candidate.location || candidate.prefecture || "未確認"}</dd>
          <dt className="text-muted-foreground">業種</dt>
          <dd>{candidate.industry_labels.join("・") || "未確認"}</dd>
          <dt className="text-muted-foreground">電話番号</dt>
          <dd>
            <PhoneLink value={candidate.phone} />
          </dd>
          <dt className="text-muted-foreground">Webサイト</dt>
          <dd className="min-w-0">
            <WebsiteLink value={candidate.website_url} />
          </dd>
          <dt className="text-muted-foreground">従業員数</dt>
          <dd>{employeeLabel(candidate.employee_number)}</dd>
        </dl>
        <section
          aria-label="事業内容"
          className="space-y-2 rounded-md border p-4 text-sm"
        >
          <h3 className="font-medium">事業内容</h3>
          {candidate.business_summary ? (
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">
              {candidate.business_summary}
            </p>
          ) : (
            <p className="text-muted-foreground">
              事業内容は未取得または未掲載です。候補の再取得や公式サイトで確認できます。
            </p>
          )}
          {candidate.business_summary_truncated && (
            <p className="text-xs text-muted-foreground">
              長い事業内容の一部を表示しています。全文は下の取得元リンクで確認してください。
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Gビズインフォに掲載された説明です。実際の対象業務や、改善の必要性は企業への確認が必要です。
          </p>
        </section>
        {candidate.company_id && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-teal-50 p-3">
            <Link
              href={`/companies/${candidate.company_id}`}
              className="font-medium text-primary hover:underline"
            >
              営業リストの企業を開く
            </Link>
            <ActivityDialog
              companyId={candidate.company_id}
              companyName={candidate.crm_company_name || candidate.name}
              phone={candidate.crm_company_phone}
            />
          </div>
        )}
        <SourceDetails candidate={candidate} />

        {canWrite && (
          <div className="space-y-4 border-t pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-medium">不足する情報を確認</h2>
                <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  公式Webサイトの公開情報から電話番号・従業員数の候補を探します。内容を確認してから保存してください。
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void enrich()}
                disabled={!!busy || !candidate.website_url || changed}
              >
                <Busy busy={busy === "enrich"}>
                  <Globe />
                  公式サイトを確認
                </Busy>
              </Button>
            </div>
            {!candidate.website_url && (
              <p className="text-xs text-muted-foreground">
                公式Webサイトが未確認です。確認できたURLを下の入力欄に保存すると、公開情報を調べられます。
              </p>
            )}
            {changed && (
              <p className="text-xs text-muted-foreground">
                入力内容を先に保存すると、公式サイトを確認できます。
              </p>
            )}
            {proposal && (
              <div
                className="space-y-3 rounded-md border bg-slate-50 p-4"
                role="status"
              >
                <p className="font-medium">公式サイトの確認結果</p>
                <p className="text-xs leading-relaxed">
                  {proposal.message ||
                    (proposal.status === "found"
                      ? "情報の候補が見つかりました。企業全体の情報か確認してください。"
                      : "公開情報から確認できませんでした。手動で入力できます。")}
                </p>
                {(proposal.phone || proposal.employeeNumber != null) && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <dt>電話番号の候補</dt>
                    <dd>{proposal.phone || "未確認"}</dd>
                    <dt>従業員数の候補</dt>
                    <dd>{employeeLabel(proposal.employeeNumber)}</dd>
                  </dl>
                )}
                {proposal.evidence && (
                  <p className="break-words rounded bg-white p-3 text-xs leading-relaxed">
                    {proposal.evidence}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  確認日時 {fetchedLabel(proposal.checkedAt)}
                </p>
                {proposal.sourceUrl && (
                  <WebsiteLink value={proposal.sourceUrl} />
                )}
                {(proposal.phone || proposal.employeeNumber != null) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => {
                      if (proposal.phone) setPhone(proposal.phone);
                      if (proposal.employeeNumber != null)
                        setEmployees(String(proposal.employeeNumber));
                    }}
                  >
                    確認した候補を入力欄に反映
                  </Button>
                )}
              </div>
            )}
            <form onSubmit={(event) => void save(event)} className="space-y-4">
              <fieldset disabled={!!busy} className="grid gap-3 sm:grid-cols-2">
                <label>
                  <span className="field-label">電話番号</span>
                  <Input
                    type="tel"
                    maxLength={50}
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="未確認"
                  />
                </label>
                <label>
                  <span className="field-label">従業員数（名）</span>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    max={Number.MAX_SAFE_INTEGER}
                    value={employees}
                    onChange={(event) => setEmployees(event.target.value)}
                    placeholder="未確認"
                  />
                </label>
                <label className="sm:col-span-2">
                  <span className="field-label">公式Webサイト</span>
                  <Input
                    type="url"
                    maxLength={2000}
                    value={website}
                    onChange={(event) => setWebsite(event.target.value)}
                    placeholder="https://example.co.jp"
                  />
                </label>
              </fieldset>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-sm text-xs text-muted-foreground">
                  保存先は検索候補です。取込済み企業の情報を変更する場合は、営業リストから編集してください。
                </p>
                <Button type="submit" disabled={!!busy || !changed}>
                  <Busy busy={busy === "save"}>
                    <RefreshCw />
                    確認して保存
                  </Busy>
                </Button>
              </div>
            </form>
          </div>
        )}
        {!canWrite && (
          <p className="text-xs text-muted-foreground">
            閲覧権限で表示しています。情報の補完や営業リストへの取込は営業メンバー・管理者が行えます。
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
