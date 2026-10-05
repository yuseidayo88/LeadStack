"use client";
import { useState, useId } from "react";
import { ChevronsUpDown, Check } from "lucide-react";
import { useApi, type Paginated } from "@/lib/client-api";
import { useWorkspace } from "@/components/layout/workspace";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { useDebounced, query, Pagination } from "./common";
type LookupRecord = {
  id: string;
  name: string;
  phone?: string | null;
  prefecture?: string | null;
  city?: string | null;
  corporate_number?: string | null;
  department?: string | null;
  position?: string | null;
  email?: string | null;
};
function details(row: LookupRecord, resource: "companies" | "contacts") {
  return (
    resource === "companies"
      ? [
          [row.prefecture, row.city].filter(Boolean).join(" "),
          row.phone,
          row.corporate_number,
        ]
      : [
          [row.department, row.position].filter(Boolean).join(" "),
          row.phone,
          row.email,
        ]
  )
    .filter(Boolean)
    .join(" · ");
}
export function Lookup({
  resource,
  value,
  onChange,
  companyId,
  required = false,
  label,
}: {
  resource: "companies" | "contacts";
  value: string;
  onChange: (value: string) => void;
  companyId?: string;
  required?: boolean;
  label: string;
}) {
  const { base } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = useDebounced(search);
  const id = useId();
  const scope = `${base}/${resource}/${companyId || ""}/${term}`;
  const [paging, setPaging] = useState({ scope: "", page: 1 });
  const page = paging.scope === scope ? paging.page : 1;
  const waiting = search !== term;
  const hint =
    resource === "companies"
      ? "会社名・電話番号・法人番号"
      : "名前・電話番号・メール";
  const rows = useApi<Paginated<LookupRecord>>(
    open
      ? `${base}/${resource}?${query({ search: term, page, pageSize: 20, company_id: companyId, sort: "name", direction: "asc" })}`
      : null,
  );
  const selected = useApi<{ data: LookupRecord }>(
    value ? `${base}/${resource}/${value}` : null,
  );
  return (
    <div>
      <span id={id} className="field-label">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-1 text-destructive">
            *
          </span>
        )}
      </span>
      <Popover
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (v) {
            setSearch("");
            setPaging({ scope: "", page: 1 });
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-labelledby={id}
            className="h-auto min-h-9 w-full justify-between bg-white font-normal"
          >
            <span className="min-w-0 text-left">
              <span className="block truncate">
                {value
                  ? selected.data?.data.name ||
                    (selected.error ? "取得できません" : "読み込み中…")
                  : `${label}を選択`}
              </span>
              {value && selected.data && (
                <span className="block truncate text-xs text-muted-foreground">
                  {details(selected.data.data, resource)}
                </span>
              )}
            </span>
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[420px] max-w-[85vw] p-0" align="start">
          <Command shouldFilter={false} label={`${label}の候補を検索`}>
            <CommandInput
              aria-label={`${label}の候補を検索`}
              placeholder={`${hint}を検索…`}
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              {!required && (
                <CommandItem
                  onSelect={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  未設定
                </CommandItem>
              )}
              {rows.error ? (
                <p role="alert" className="p-4 text-xs text-destructive">
                  取得できませんでした。開き直して再試行してください。
                </p>
              ) : waiting || !rows.data ? (
                <p className="p-4 text-xs">読み込み中…</p>
              ) : rows.data.data.length ? (
                rows.data.data.map((r) => (
                  <CommandItem
                    key={r.id}
                    value={r.id}
                    onSelect={() => {
                      onChange(r.id);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{r.name}</span>
                      <span className="block break-words text-xs text-muted-foreground">
                        {details(r, resource)}
                      </span>
                    </span>
                    {value === r.id && <Check className="ml-auto size-4" />}
                  </CommandItem>
                ))
              ) : (
                <p className="p-4 text-xs text-muted-foreground">
                  該当する{label}がありません。
                </p>
              )}
            </CommandList>
          </Command>
          <Pagination
            page={page}
            pageSize={20}
            count={waiting || rows.error ? undefined : rows.data?.count}
            onChange={(page) => setPaging({ scope, page })}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
