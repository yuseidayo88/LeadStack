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
import { useDebounced, query } from "./common";
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
  const rows = useApi<Paginated<{ id: string; name: string }>>(
    open
      ? `${base}/${resource}?${query({ search: term, pageSize: 20, company_id: companyId, sort: "name", direction: "asc" })}`
      : null,
  );
  const selected = useApi<{ data: { name: string } }>(
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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-labelledby={id}
            className="w-full justify-between bg-white font-normal"
          >
            <span className="truncate">
              {value
                ? selected.data?.data.name ||
                  (selected.error ? "取得できません" : "読み込み中…")
                : `${label}を選択`}
            </span>
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] max-w-[85vw] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={`${label}を検索…`}
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
              ) : !rows.data ? (
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
                    {r.name}
                    {value === r.id && <Check className="ml-auto size-4" />}
                  </CommandItem>
                ))
              ) : (
                <p className="p-4 text-xs text-muted-foreground">
                  該当する{label}がありません。
                </p>
              )}
              {rows.data && rows.data.count > 20 && (
                <p className="p-3 text-xs text-muted-foreground">
                  上位20件を表示。名前で絞り込んでください。
                </p>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
