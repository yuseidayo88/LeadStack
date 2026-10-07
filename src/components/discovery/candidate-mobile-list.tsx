"use client";

import Link from "next/link";
import type { Candidate } from "@/lib/discovery/contracts";
import { ActivityDialog } from "@/components/crm/activity";
import { Button } from "@/components/ui/button";
import { employeeLabel, fetchedLabel, PhoneLink, WebsiteLink } from "./display";

export function CandidateMobileList({
  candidates,
  selected,
  canWrite,
  allSelected,
  sort,
  direction,
  onToggle,
  onTogglePage,
  onSort,
  onFocus,
  onImport,
}: {
  candidates: Candidate[];
  selected: string[];
  canWrite: boolean;
  allSelected: boolean;
  sort: string;
  direction: string;
  onToggle: (id: string, checked: boolean) => void;
  onTogglePage: (checked: boolean) => void;
  onSort: (
    sort: "name" | "employee_number" | "fetched_at",
    direction: "asc" | "desc",
  ) => void;
  onFocus: (candidate: Candidate) => void;
  onImport: (id: string) => void;
}) {
  return (
    <div className="md:hidden">
      <div className="flex flex-wrap items-center gap-3 border-b p-4">
        {canWrite && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="このページの候補をすべて選択"
              checked={allSelected}
              onChange={(event) => onTogglePage(event.target.checked)}
            />
            このページを選択
          </label>
        )}
        <label className="min-w-0 flex-1 text-xs">
          <span className="field-label">候補の並び順</span>
          <select
            aria-label="候補の並び順"
            className="native-select"
            value={`${sort}:${direction}`}
            onChange={(event) => {
              const [key, order] = event.target.value.split(":");
              onSort(
                key as "name" | "employee_number" | "fetched_at",
                order as "asc" | "desc",
              );
            }}
          >
            <option value="fetched_at:desc">取得が新しい順</option>
            <option value="fetched_at:asc">取得が古い順</option>
            <option value="name:asc">企業名：昇順</option>
            <option value="name:desc">企業名：降順</option>
            <option value="employee_number:asc">従業員数：少ない順</option>
            <option value="employee_number:desc">従業員数：多い順</option>
          </select>
        </label>
      </div>
      <ul className="divide-y" aria-label="企業候補">
        {candidates.map((candidate) => (
          <li
            key={candidate.id}
            className={`min-w-0 space-y-3 p-4 ${selected.includes(candidate.id) ? "bg-teal-50/40" : ""}`}
          >
            <div className="flex items-start gap-3">
              {canWrite && (
                <input
                  className="mt-1"
                  type="checkbox"
                  aria-label={`${candidate.name}を選択`}
                  checked={selected.includes(candidate.id)}
                  disabled={
                    selected.length >= 50 && !selected.includes(candidate.id)
                  }
                  onChange={(event) =>
                    onToggle(candidate.id, event.target.checked)
                  }
                />
              )}
              <div className="min-w-0 flex-1">
                <button
                  className="break-words text-left font-medium text-primary hover:underline"
                  onClick={() => onFocus(candidate)}
                >
                  {candidate.name}
                </button>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {candidate.location ||
                    candidate.prefecture ||
                    "所在地：未確認"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {candidate.industry_labels.join("・") || "業種：未確認"} ·
                  従業員数 {employeeLabel(candidate.employee_number)}
                </p>
              </div>
            </div>
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">電話番号</dt>
              <dd>
                <PhoneLink value={candidate.phone} />
              </dd>
              <dt className="text-muted-foreground">Web</dt>
              <dd className="min-w-0">
                <WebsiteLink value={candidate.website_url} />
              </dd>
            </dl>
            <p className="text-xs text-muted-foreground">
              取得 {fetchedLabel(candidate.fetched_at)}（日本時間）
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onFocus(candidate)}
              >
                詳細・出典を確認
              </Button>
              {candidate.company_id ? (
                <>
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/companies/${candidate.company_id}`}>
                      登録済み企業へ
                    </Link>
                  </Button>
                  {canWrite && (
                    <ActivityDialog
                      companyId={candidate.company_id}
                      companyName={candidate.crm_company_name || candidate.name}
                      phone={candidate.crm_company_phone}
                    />
                  )}
                </>
              ) : canWrite ? (
                <Button size="sm" onClick={() => onImport(candidate.id)}>
                  営業リストに取り込む
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">未取込</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
