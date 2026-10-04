"use client";
import { useState } from "react";
import { useWorkspace } from "@/components/layout/workspace";
import { useApi, type Paginated } from "@/lib/client-api";
import type { Tables } from "@/lib/database.types";
import { proposalDrafts } from "@/lib/crm/proposal-drafts";
import {
  proposalTypeLabels,
  processLabels,
  painLabels,
  label,
} from "@/lib/crm/display";
import { ResourceDialog } from "./resource-dialog";
import { Button } from "@/components/ui/button";
import { ErrorState } from "./common";
export function ProposalDrafter({ companyId }: { companyId: string }) {
  const { base, canWrite } = useWorkspace();
  const processes = useApi<Paginated<Tables<"business_processes">>>(
    `${base}/business_processes?company_id=${companyId}&pageSize=100`,
  );
  const pains = useApi<Paginated<Tables<"pain_points">>>(
    `${base}/pain_points?company_id=${companyId}&pageSize=100`,
  );
  const tools = useApi<Paginated<Tables<"company_tools">>>(
    `${base}/company_tools?company_id=${companyId}&pageSize=100`,
  );
  const [ids, setIds] = useState(["", "", ""]);
  const [confirmed, setConfirmed] = useState(false);
  if (!canWrite) return null;
  const error = processes.error || pains.error || tools.error;
  if (error) return <ErrorState error={error} />;
  const drafts = proposalDrafts(
    processes.data?.data.find((r) => r.id === ids[0]),
    pains.data?.data.find((r) => r.id === ids[1]),
    tools.data?.data.find((r) => r.id === ids[2]),
  );
  const choices = [
    {
      title: "根拠となる業務",
      rows: processes.data?.data.map((r) => ({
        id: r.id,
        name: label(processLabels, r.process_type),
      })),
    },
    {
      title: "根拠となる課題",
      rows: pains.data?.data.map((r) => ({
        id: r.id,
        name: label(painLabels, r.type),
      })),
    },
    {
      title: "根拠となる利用ツール",
      rows: tools.data?.data.map((r) => ({ id: r.id, name: r.tool_name })),
    },
  ];
  return (
    <details className="surface p-4">
      <summary className="cursor-pointer font-medium">
        ヒアリングから下書きを作成
      </summary>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          登録情報を選択してください。業務・課題から構築と自動化、利用ツールから継続活用の検討案を作成します。自動保存はしません。
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {choices.map((c, i) => (
            <label key={c.title}>
              <span className="field-label">{c.title}</span>
              <select
                className="native-select"
                value={ids[i]}
                onChange={(e) => {
                  setIds(ids.map((v, j) => (j === i ? e.target.value : v)));
                  setConfirmed(false);
                }}
              >
                <option value="">選択しない</option>
                {c.rows?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {[processes, pains, tools].some((r) => (r.data?.count || 0) > 100) && (
          <p>選択肢は直近100件です。</p>
        )}
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          選択した登録情報をヒアリングで確認済み
        </label>
        {confirmed && (
          <div className="flex flex-wrap gap-2">
            {drafts.length ? (
              drafts.map((d) => (
                <ResourceDialog
                  key={d.type}
                  resource="proposals"
                  companyId={companyId}
                  defaults={d}
                  trigger={
                    <Button variant="outline">
                      {label(proposalTypeLabels, d.type)}の下書きを確認
                    </Button>
                  }
                />
              ))
            ) : (
              <p>根拠となる情報を選択してください。</p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
