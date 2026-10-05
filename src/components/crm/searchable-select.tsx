"use client";

import { useState, type AriaAttributes } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type SearchableSelectOption = { value: string; label: string };

type SearchableSelectProps = Pick<
  AriaAttributes,
  "aria-invalid" | "aria-describedby"
> & {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  allowCustom?: boolean;
  id?: string;
  className?: string;
};

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("ja").trim();
}

export function SearchableSelect({
  value,
  onChange,
  options,
  label,
  placeholder = "選択してください",
  disabled = false,
  required = false,
  allowCustom = false,
  id,
  className,
  ...aria
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const choices = [...new Map(options.map((o) => [o.value, o])).values()];
  if (!required && !choices.some((o) => o.value === "")) {
    choices.unshift({ value: "", label: "未設定" });
  }
  // Keep previously saved free text visible when the suggested list changes.
  if (value && !choices.some((o) => o.value === value)) {
    choices.push({ value, label: value });
  }
  const current = choices.find((o) => o.value === value);
  const term = normalize(search);
  const visible = choices.filter(
    (o) =>
      (!required || o.value !== "") &&
      (!term ||
        normalize(o.label).includes(term) ||
        normalize(o.value).includes(term)),
  );
  const customValue = search.trim();
  const canAddCustom =
    allowCustom &&
    customValue.length > 0 &&
    !choices.some(
      (o) => normalize(o.value) === term || normalize(o.label) === term,
    );

  function choose(next: string) {
    if (disabled) return;
    onChange(next);
    setOpen(false);
  }

  function changeOpen(next: boolean) {
    if (disabled && next) return;
    if (next) setSearch("");
    setOpen(next);
  }

  return (
    <Popover open={open && !disabled} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          {...aria}
          id={id}
          type="button"
          role="combobox"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open && !disabled}
          aria-required={required || undefined}
          disabled={disabled}
          variant="outline"
          title={current?.label || placeholder}
          className={cn(
            "min-w-0 w-full justify-between border-input bg-white font-normal",
            className,
          )}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              changeOpen(true);
            }
          }}
        >
          <span className={cn("truncate", !current && "text-muted-foreground")}>
            {current?.label || placeholder}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        aria-label={`${label}を選択`}
        className="flex max-h-[min(360px,var(--radix-popover-content-available-height))] w-[max(220px,var(--radix-popover-trigger-width))] max-w-[calc(100vw-24px)] flex-col overflow-hidden p-0"
      >
        <Command
          shouldFilter={false}
          defaultValue={`option:${value}`}
          label={`${label}を検索`}
          className="min-h-0"
        >
          <CommandInput
            placeholder={
              allowCustom ? `${label}を検索・入力…` : `${label}を検索…`
            }
            value={search}
            onValueChange={setSearch}
            maxLength={200}
          />
          <CommandList
            label={`${label}の候補`}
            className="min-h-0 flex-1 overscroll-contain"
          >
            {visible.map((option) => (
              <CommandItem
                key={option.value}
                // cmdk infers a value from text when given an empty string.
                // Prefix every value so selecting "unset" is unambiguous.
                value={`option:${option.value}`}
                onSelect={() => choose(option.value)}
                className="cursor-pointer"
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0",
                    option.value !== value && "opacity-0",
                  )}
                />
                <span className="min-w-0 break-words">{option.label}</span>
              </CommandItem>
            ))}
            {canAddCustom && (
              <CommandItem
                value="custom-value"
                onSelect={() => choose(customValue)}
                className="cursor-pointer"
              >
                <Plus aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 break-words">
                  「{customValue}」を設定
                </span>
              </CommandItem>
            )}
            {!visible.length && !canAddCustom && (
              <p
                role="status"
                className="px-3 py-6 text-center text-sm text-muted-foreground"
              >
                該当する候補がありません
              </p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
