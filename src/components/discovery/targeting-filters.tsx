"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applyTargetingPreset,
  isTargetingPresetModified,
  targetingPresets,
  type DiscoveryFilters,
} from "@/lib/discovery/targeting";

type Props = {
  filters: DiscoveryFilters;
  disabled: boolean;
  error: string | null;
  onChange: (change: Partial<DiscoveryFilters>) => void;
};

export function TargetingFilters({
  filters,
  disabled,
  error,
  onChange,
}: Props) {
  const preset = targetingPresets.find((item) => item.id === filters.presetId);
  const modified = preset && isTargetingPresetModified(filters, preset);
  const hasEmployeeRange = !!filters.employeeMin || !!filters.employeeMax;
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            業務アプリ・AI連携の営業向け
          </span>
          {preset && (
            <span className="text-xs text-muted-foreground">
              {modified ? "条件を調整中" : "おすすめ条件を適用中"}
            </span>
          )}
        </div>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="営業向けのおすすめ条件"
        >
          {targetingPresets.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={preset?.id === item.id ? "default" : "outline"}
              aria-pressed={preset?.id === item.id}
              onClick={() => onChange(applyTargetingPreset(filters, item))}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        所在地を保ったまま人数・業種・業務キーワードを設定します。課題や導入意欲は商談で確認します。
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <span className="field-label">従業員数</span>
          <div className="flex items-center gap-2">
            <Input
              id="discovery-employee-min"
              aria-label="従業員数の下限"
              aria-describedby={error ? "discovery-targeting-error" : undefined}
              type="text"
              inputMode="numeric"
              maxLength={10}
              placeholder="下限なし"
              value={filters.employeeMin}
              onChange={(event) =>
                onChange({ employeeMin: event.target.value })
              }
              className="min-w-0 bg-white"
            />
            <span className="shrink-0 text-sm">〜</span>
            <Input
              id="discovery-employee-max"
              aria-label="従業員数の上限"
              aria-describedby={error ? "discovery-targeting-error" : undefined}
              type="text"
              inputMode="numeric"
              maxLength={10}
              placeholder="上限なし"
              value={filters.employeeMax}
              onChange={(event) =>
                onChange({ employeeMax: event.target.value })
              }
              className="min-w-0 bg-white"
            />
            <span className="shrink-0 text-sm">人</span>
          </div>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="従業員数の目安"
          >
            {[
              ["5", "20"],
              ["10", "50"],
              ["50", "100"],
            ].map(([min, max]) => (
              <Button
                key={min}
                type="button"
                size="sm"
                variant="outline"
                aria-pressed={
                  filters.employeeMin === min && filters.employeeMax === max
                }
                onClick={() => onChange({ employeeMin: min, employeeMax: max })}
                className="h-7 px-2 text-xs"
              >
                {min}〜{max}人
              </Button>
            ))}
            {(filters.employeeMin || filters.employeeMax) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => onChange({ employeeMin: "", employeeMax: "" })}
              >
                人数指定を解除
              </Button>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filters.includeUnknownEmployees}
              disabled={!hasEmployeeRange}
              onChange={(event) =>
                onChange({ includeUnknownEmployees: event.target.checked })
              }
            />
            従業員数が未確認の企業も含める
          </label>
          {!hasEmployeeRange && (
            <p className="text-xs text-muted-foreground">
              人数を指定したときに適用します。
            </p>
          )}
          {filters.hasEmployees && (
            <p className="text-xs text-muted-foreground">
              「従業員数あり」が優先され、未確認の企業は除外されます。
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-2">
          <label htmlFor="discovery-business-keywords" className="field-label">
            業務キーワード
          </label>
          <Input
            id="discovery-business-keywords"
            value={filters.businessKeywords}
            maxLength={200}
            placeholder="例：設備 空調 保守 点検"
            className="bg-white"
            aria-describedby="discovery-keyword-help"
            onChange={(event) =>
              onChange({ businessKeywords: event.target.value })
            }
          />
          <p
            id="discovery-keyword-help"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            企業名・事業内容のいずれかに一致。空白・読点・カンマで8語まで。未取得の事業内容は再取得で補完できます（掲載がある場合）。
          </p>
          {filters.industry && filters.industry !== "unknown" && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={filters.includeUnknownIndustry}
                onChange={(event) =>
                  onChange({ includeUnknownIndustry: event.target.checked })
                }
              />
              業種が未確認の企業も含める
            </label>
          )}
        </div>
      </div>
      {error && (
        <p
          id="discovery-targeting-error"
          role="alert"
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {preset && (
        <details className="rounded-md border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">
            {preset.label}：提案と初回ヒアリングの例
          </summary>
          <p className="mt-3 text-xs leading-relaxed">{preset.workflow}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed">
            {preset.questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            検索語への一致は営業適性を保証しません。事業内容・作業時間・担当者を確認し、小さな業務から提案します。
          </p>
        </details>
      )}
    </fieldset>
  );
}
