"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { discoveryFilterChips } from "@/lib/discovery/saved-searches";
import type { DiscoveryFilters } from "@/lib/discovery/targeting";

export function DiscoveryFilterChips({
  filters,
  onChange,
}: {
  filters: DiscoveryFilters;
  onChange: (change: Partial<DiscoveryFilters>) => void;
}) {
  const chips = discoveryFilterChips(filters);
  if (!chips.length) return null;
  return (
    <div
      className="min-w-0 space-y-2 border-t pt-3"
      role="group"
      aria-label="指定中の検索条件"
    >
      <p className="text-xs text-muted-foreground">
        指定中の条件 · 個別に解除できます
      </p>
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <Button
            key={chip.id}
            type="button"
            variant="secondary"
            size="sm"
            className="h-auto min-h-8 max-w-full min-w-0 py-1 text-xs"
            title={chip.label}
            aria-label={`${chip.label}の条件を解除`}
            onClick={() => onChange(chip.clear)}
          >
            <span className="min-w-0 truncate">{chip.label}</span>
            <X aria-hidden="true" />
          </Button>
        ))}
      </div>
    </div>
  );
}
