"use client";
import { useState } from "react";
import {
  Pencil,
  Lightbulb,
  ArrowRight,
  UserRound,
  CheckCircle2,
} from "lucide-react";
import { useWorkspace } from "@/components/layout/workspace";
import { useApi, type Paginated } from "@/lib/client-api";
import type { Tables } from "@/lib/database.types";
import type { Resource } from "@/lib/crm/schemas";
import {
  processLabels,
  painLabels,
  proposalTypeLabels,
  proposalStatusLabels,
  toolPolicyLabels,
  label,
} from "@/lib/crm/display";
import { Button } from "@/components/ui/button";
import {
  ResourceDialog,
  DeleteDialog,
  type RecordData,
} from "./resource-dialog";
import {
  Loading,
  ErrorState,
  Empty,
  Pagination,
  StatusBadge,
  query,
} from "./common";
export function Recommendations({
  industry,
  companyId,
}: {
  industry: string | null;
  companyId: string;
}) {
  const { base } = useWorkspace();
  const result = useApi<{
    data: (Tables<"industry_recommendations"> & {
      improvement: Tables<"improvement_types">;
    })[];
  }>(industry ? `${base}/recommendations?${query({ industry })}` : null);
  return (
    <section className="surface overflow-hidden">
      <div className="border-b bg-teal-50/40 p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <Lightbulb className="size-4 text-primary" />
          架電前の提案仮説
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {industry || "業種未設定"}の標準テンプレート ·
          実際の課題はヒアリングで確認
        </p>
      </div>
      {!industry ? (
        <p className="p-5 text-sm text-muted-foreground">
          企業の業種を設定すると、参考となる質問を表示します。
        </p>
      ) : result.error ? (
        <ErrorState error={result.error} retry={() => void result.mutate()} />
      ) : !result.data ? (
        <Loading />
      ) : !result.data.data.length ? (
        <p className="p-5 text-sm text-muted-foreground">
          この業種の標準テンプレートはありません。ヒアリングから提案を登録できます。
        </p>
      ) : (
        <div className="divide-y">
          {result.data.data.map((r, i) => (
            <div className="flex gap-3 p-4" key={r.id}>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-teal-50 text-[11px] font-semibold text-teal-800">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{r.improvement.name}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {r.improvement.default_question}
                </p>
                <ResourceDialog
                  resource="proposals"
                  companyId={companyId}
                  defaults={{
                    title: r.improvement.name,
                    description: r.improvement.description || "",
                  }}
                  trigger={
                    <Button variant="link" size="xs" className="mt-1 px-0">
                      提案の下書きを作成
                      <ArrowRight />
                    </Button>
                  }
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
export function CompanyRecords({
  resource,
  companyId,
  title,
  type,
}: {
  resource: Exclude<Resource, "companies" | "tasks" | "deals">;
  companyId: string;
  title: string;
  type?: string;
}) {
  const { base } = useWorkspace();
  const [page, setPage] = useState(1);
  const result = useApi<Paginated<RecordData & { id: string }>>(
    `${base}/${resource}?${query({ company_id: companyId, page, type })}`,
  );
  return (
    <section className="surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b p-4">
        <h2 className="font-semibold">
          {title}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {result.data?.count ?? "—"}
          </span>
        </h2>
        <ResourceDialog
          resource={resource}
          companyId={companyId}
          defaults={type ? { type } : undefined}
        />
      </div>
      {result.error ? (
        <ErrorState error={result.error} retry={() => void result.mutate()} />
      ) : !result.data ? (
        <Loading />
      ) : !result.data.data.length ? (
        <Empty
          title={`${title}はまだありません`}
          description={
            resource === "contacts"
              ? "窓口や決裁者の情報を登録しましょう。"
              : "わかったことから記録していきましょう。"
          }
        />
      ) : (
        <div className="divide-y">
          {result.data.data.map((r) => (
            <RecordCard
              key={r.id}
              resource={resource}
              record={r}
              companyId={companyId}
            />
          ))}
        </div>
      )}
      <Pagination page={page} count={result.data?.count} onChange={setPage} />
    </section>
  );
}
function RecordCard({
  resource,
  record: r,
  companyId,
}: {
  resource: Resource;
  record: RecordData & { id: string };
  companyId: string;
}) {
  const str = (key: string) => String(r[key] || "");
  const name =
    str("name") ||
    str("title") ||
    str("tool_name") ||
    label(
      resource === "business_processes" ? processLabels : painLabels,
      str("process_type") || str("type"),
    );
  const details =
    resource === "contacts"
      ? [
          [
            "部署 / 役職",
            [str("department"), str("position")].filter(Boolean).join(" / "),
          ],
          ["電話", str("phone")],
          ["メール", str("email")],
          ["メモ", str("notes")],
        ]
      : resource === "business_processes"
        ? [
            ["現在の運用", str("current_method")],
            ["業務内容", str("description")],
            ["負担", r.pain_level ? `${r.pain_level} / 5` : ""],
            ["メモ", str("notes")],
          ]
        : resource === "company_tools"
          ? [
              ["用途", str("category")],
              ["利用状況", str("usage_description")],
            ]
          : resource === "pain_points"
            ? [
                ["詳細", str("description")],
                ["深刻度", r.severity ? `${r.severity} / 5` : ""],
              ]
            : [
                ["内容", str("description")],
                ["理由", str("reason")],
                ["期待する効果", str("expected_benefit")],
              ];
  const config = r.automation_config as {
    trigger: string;
    steps: string[];
    tools: string[];
  } | null;
  return (
    <article className="p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {resource === "contacts" && (
            <UserRound className="size-4 text-muted-foreground" />
          )}
          <h3 className="font-medium">{name}</h3>
          {resource === "contacts" && Boolean(r.is_decision_maker) && (
            <StatusBadge value="won">
              <CheckCircle2 className="size-3" />
              決裁者
            </StatusBadge>
          )}
          {resource === "company_tools" && (
            <StatusBadge>
              {label(toolPolicyLabels, str("keep_or_replace"))}
            </StatusBadge>
          )}
          {resource === "proposals" && (
            <StatusBadge value={str("status")}>
              {label(proposalStatusLabels, str("status"))}
            </StatusBadge>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <ResourceDialog
            resource={resource}
            record={r}
            companyId={companyId}
            trigger={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${name}を編集`}
              >
                <Pencil className="size-3.5 text-muted-foreground" />
              </Button>
            }
          />
          <DeleteDialog resource={resource} id={r.id} name={name} />
        </div>
      </div>
      <dl className="space-y-2">
        {details
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div
              key={k}
              className="grid grid-cols-[90px_1fr] gap-3 text-xs leading-5"
            >
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="whitespace-pre-wrap break-words">{v}</dd>
            </div>
          ))}
      </dl>
      {config && (
        <div className="mt-4 rounded-md border bg-muted/30 p-3 text-xs">
          <p className="mb-2 font-medium">自動化フロー：{config.trigger}</p>
          <ol className="ml-4 list-decimal space-y-1 text-slate-600">
            {config.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <p className="mt-3 text-muted-foreground">
            利用ツール：{config.tools.join(" / ") || "未設定"}
          </p>
        </div>
      )}
    </article>
  );
}
export function Hearing({ companyId }: { companyId: string }) {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <div className="space-y-5">
        <CompanyRecords
          resource="business_processes"
          companyId={companyId}
          title="現在の業務"
        />
        <CompanyRecords
          resource="company_tools"
          companyId={companyId}
          title="利用ツール"
        />
      </div>
      <CompanyRecords
        resource="pain_points"
        companyId={companyId}
        title="業務の課題"
      />
    </div>
  );
}
export function Proposals({ companyId }: { companyId: string }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          ヒアリングをもとに、最適な改善方法を整理しましょう。
        </p>
        <Button
          variant="outline"
          disabled
          title="AIによる提案生成は今後対応予定です"
        >
          AIで改善案を生成（準備中）
        </Button>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-3">
        {Object.entries(proposalTypeLabels).map(([type, title]) => (
          <CompanyRecords
            key={type}
            resource="proposals"
            companyId={companyId}
            type={type}
            title={title}
          />
        ))}
      </div>
    </div>
  );
}
