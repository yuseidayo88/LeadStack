"use client";
import { phoneHref } from "@/lib/crm/search";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Building2, Phone, Globe, MapPin } from "lucide-react";
import { useWorkspace } from "@/components/layout/workspace";
import { useApi } from "@/lib/client-api";
import type { Tables } from "@/lib/database.types";
import { companyStatusLabels, label, money } from "@/lib/crm/display";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Loading, ErrorState, StatusBadge } from "@/components/crm/common";
import { ResourceDialog, DeleteDialog } from "@/components/crm/resource-dialog";
import { ActivityDialog, ActivityTimeline } from "@/components/crm/activity";
import {
  CompanyRecords,
  Recommendations,
  Hearing,
  Proposals,
} from "@/components/crm/company-sections";
import { DealsList } from "@/components/crm/deals-list";
export default function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const { base, members } = useWorkspace();
  const router = useRouter();
  const result = useApi<{ data: Tables<"companies"> }>(
    `${base}/companies/${id}`,
  );
  if (result.error)
    return (
      <div className="page">
        <Link href="/companies" className="text-primary">
          企業一覧に戻る
        </Link>
        <ErrorState error={result.error} retry={() => void result.mutate()} />
      </div>
    );
  if (!result.data) return <Loading />;
  const c = result.data.data;
  const info = [
    ["法人番号", c.corporate_number],
    ["業種", [c.industry, c.industry_subcategory].filter(Boolean).join(" / ")],
    ["所在地", [c.prefecture, c.city, c.address].filter(Boolean).join(" ")],
    [
      "従業員数",
      c.employee_min != null || c.employee_max != null
        ? `${c.employee_min ?? "?"}〜${c.employee_max ?? "?"}名`
        : null,
    ],
    ["資本金", money(c.capital)],
    [
      "担当営業",
      members.find((m) => m.user_id === c.assigned_user_id)?.profile?.name,
    ],
    ["流入元", c.source],
  ];
  return (
    <div className="page">
      <Link
        href="/companies"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
      >
        <ArrowLeft className="size-3.5" />
        企業一覧
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border bg-white p-3">
            <Building2 className="size-7 text-primary" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold">{c.name}</h1>
              <StatusBadge value={c.company_status}>
                {label(companyStatusLabels, c.company_status)}
              </StatusBadge>
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
              {c.industry && <span>{c.industry}</span>}
              {c.prefecture && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3" />
                  {c.prefecture} {c.city}
                </span>
              )}
              {c.phone && (
                <span className="inline-flex items-center gap-1">
                  <Phone className="size-3" />
                  {c.phone}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ResourceDialog resource="companies" record={c} />
          <ActivityDialog companyId={id} phone={c.phone} />
          <DeleteDialog
            resource="companies"
            id={id}
            name={c.name}
            onDeleted={() => router.replace("/companies")}
          />
        </div>
      </div>
      <Tabs defaultValue="overview">
        <div className="mb-5 overflow-x-auto border-b">
          <TabsList className="h-11 w-max gap-5 rounded-none bg-transparent p-0">
            {[
              ["overview", "概要"],
              ["activities", "営業活動"],
              ["hearing", "業務ヒアリング"],
              ["proposals", "改善提案"],
              ["deals", "商談"],
            ].map(([key, name]) => (
              <TabsTrigger
                key={key}
                value={key}
                className="h-full rounded-none border-0 border-b-2 border-transparent px-1 text-sm shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
              >
                {name}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview">
          <div className="grid items-start gap-5 xl:grid-cols-[1.4fr_1fr]">
            <div className="space-y-5">
              <section className="surface">
                <h2 className="border-b px-5 py-4 font-semibold">基本情報</h2>
                <div className="space-y-5 p-5">
                  <div className="flex flex-wrap gap-2">
                    {c.phone && (
                      <Button asChild variant="outline" size="sm">
                        <a href={phoneHref(c.phone)}>
                          <Phone />
                          {c.phone}
                        </a>
                      </Button>
                    )}
                    {c.website_url && (
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={c.website_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Globe />
                          Webサイト
                        </a>
                      </Button>
                    )}
                    {c.contact_url && (
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={c.contact_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          お問い合わせ
                        </a>
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      title="Zoom Phone連携は今後対応予定です"
                    >
                      Zoom Phoneで架電（準備中）
                    </Button>
                  </div>
                  <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
                    {info.map(([k, v]) => (
                      <div key={k}>
                        <dt className="mb-1 text-xs text-muted-foreground">
                          {k}
                        </dt>
                        <dd className="break-words text-sm">{v || "未設定"}</dd>
                      </div>
                    ))}
                  </dl>
                  {c.business_description && (
                    <div>
                      <h3 className="mb-2 text-xs text-muted-foreground">
                        事業内容
                      </h3>
                      <p className="whitespace-pre-wrap text-sm leading-6">
                        {c.business_description}
                      </p>
                    </div>
                  )}
                </div>
              </section>
              <CompanyRecords
                resource="contacts"
                companyId={id}
                title="企業担当者"
              />
            </div>
            <Recommendations industry={c.industry} companyId={id} />
          </div>
        </TabsContent>
        <TabsContent value="activities">
          <ActivityTimeline companyId={id} phone={c.phone} />
        </TabsContent>
        <TabsContent value="hearing">
          <Hearing companyId={id} />
        </TabsContent>
        <TabsContent value="proposals">
          <Proposals companyId={id} />
        </TabsContent>
        <TabsContent value="deals">
          <DealsList companyId={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
