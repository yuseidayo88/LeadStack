"use client";
import Link from "next/link";
import type { CompanySummary } from "@/lib/crm/display";
import { companyStatusLabels, dateTime, label } from "@/lib/crm/display";
import { phoneHref } from "@/lib/crm/search";
import { ActivityDialog } from "./activity";
import { StatusBadge } from "./common";

export function CompaniesMobileList({
  companies,
  selected,
  visible,
  canWrite,
  all,
  sort,
  direction,
  onToggle,
  onTogglePage,
  onSort,
}: {
  companies: CompanySummary[];
  selected: string[];
  visible: string[];
  canWrite: boolean;
  all: boolean;
  sort: string;
  direction: string;
  onToggle: (id: string, checked: boolean) => void;
  onTogglePage: (checked: boolean) => void;
  onSort: (sort: string, direction: string) => void;
}) {
  const has = (key: string) => visible.includes(key);
  return (
    <div className="md:hidden">
      <div className="flex flex-wrap items-center gap-3 border-b p-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="このページの企業をすべて選択"
            checked={all}
            onChange={(event) => onTogglePage(event.target.checked)}
          />
          このページを選択
        </label>
        <label className="min-w-0 flex-1">
          <span className="field-label">並び順</span>
          <select
            aria-label="営業リストの並び順"
            className="native-select"
            value={`${sort}:${direction}`}
            onChange={(event) => {
              const [key, order] = event.target.value.split(":");
              onSort(key, order);
            }}
          >
            <option value="created_at:desc">登録が新しい順</option>
            <option value="created_at:asc">登録が古い順</option>
            <option value="name:asc">会社名：昇順</option>
            <option value="name:desc">会社名：降順</option>
            <option value="last_contact_at:desc">最終接触：新しい順</option>
            <option value="last_contact_at:asc">最終接触：古い順</option>
          </select>
        </label>
      </div>
      <ul aria-label="営業リスト" className="divide-y">
        {companies.map((company) => (
          <li
            key={company.id}
            className={`min-w-0 space-y-3 p-4 ${selected.includes(company.id) ? "bg-teal-50/40" : ""}`}
          >
            <div className="flex items-start gap-3">
              <input
                className="mt-1"
                type="checkbox"
                aria-label={`${company.name}を選択`}
                checked={selected.includes(company.id)}
                onChange={(event) => onToggle(company.id, event.target.checked)}
              />
              <Link
                href={`/companies/${company.id}`}
                className="min-w-0 break-words font-medium text-primary hover:underline"
              >
                {company.name}
              </Link>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              {has("phone") && (
                <p className="text-sm">
                  {phoneHref(company.phone) ? (
                    <a
                      className="font-mono text-primary hover:underline"
                      href={phoneHref(company.phone)}
                    >
                      {company.phone}
                    </a>
                  ) : (
                    company.phone || "電話番号：未登録"
                  )}
                </p>
              )}
              {canWrite && (
                <ActivityDialog
                  companyId={company.id}
                  companyName={company.name}
                  phone={company.phone}
                />
              )}
            </div>
            {has("status") && (
              <StatusBadge value={company.company_status}>
                {label(companyStatusLabels, company.company_status)}
              </StatusBadge>
            )}
            {has("task") &&
              (company.next_task ? (
                <Link
                  className="block space-y-1 rounded-md bg-muted/50 p-3 text-sm hover:text-primary"
                  href={`/tasks?company_id=${company.id}`}
                >
                  <p className="break-words">次回：{company.next_task.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {dateTime(company.next_task.due_at)}
                  </p>
                </Link>
              ) : (
                <p className="text-xs text-muted-foreground">
                  次回タスク：未設定
                </p>
              ))}
            {visible.some((key) =>
              ["industry", "region", "size", "owner", "last"].includes(key),
            ) && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  企業情報
                </summary>
                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
                  {has("industry") && (
                    <>
                      <dt>業種</dt>
                      <dd className="break-words">
                        {company.industry || "未登録"}
                      </dd>
                    </>
                  )}
                  {has("region") && (
                    <>
                      <dt>地域</dt>
                      <dd className="break-words">
                        {[company.prefecture, company.city]
                          .filter(Boolean)
                          .join(" ") || "未登録"}
                      </dd>
                    </>
                  )}
                  {has("size") && (
                    <>
                      <dt>従業員数</dt>
                      <dd>
                        {company.employee_min != null ||
                        company.employee_max != null
                          ? `${company.employee_min ?? "?"}〜${company.employee_max ?? "?"}名`
                          : "未登録"}
                      </dd>
                    </>
                  )}
                  {has("owner") && (
                    <>
                      <dt>担当営業</dt>
                      <dd className="break-words">
                        {company.assigned_user_name || "未設定"}
                      </dd>
                    </>
                  )}
                  {has("last") && (
                    <>
                      <dt>最終接触</dt>
                      <dd>
                        {company.last_contact_at
                          ? dateTime(company.last_contact_at, true)
                          : "未接触"}
                      </dd>
                    </>
                  )}
                </dl>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
