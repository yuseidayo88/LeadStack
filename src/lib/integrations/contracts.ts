import type { z } from "zod";
import type { activitySchema, schemas } from "@/lib/crm/schemas";
export type CallEvent = {
  zoom_call_id: string;
  phase: "start" | "end";
  occurred_at: string;
  duration_seconds?: number;
};
export interface PhoneProvider {
  readonly name: string;
  startCall(phone: string): Promise<{ callId: string }>;
  normalizeEvent(payload: unknown): Promise<CallEvent>;
}
export type ManualCall = z.infer<typeof activitySchema>;
export type HearingContext = {
  industry: string | null;
  businessDescription: string | null;
  processes: z.infer<typeof schemas.business_processes>[];
  tools: z.infer<typeof schemas.company_tools>[];
  pains: z.infer<typeof schemas.pain_points>[];
  notes: string[];
};
export interface ProposalProvider {
  generate(
    context: HearingContext,
  ): Promise<z.infer<typeof schemas.proposals>[]>;
}
// V1 implements no remote calling, AI generation, or workflow execution.
export const integrationCapabilities = {
  zoomPhone: {
    enabled: false,
    reason: "Zoom Phone 連携は未導入です。架電結果を手動登録できます。",
  },
  aiProposals: {
    enabled: false,
    reason: "AI 生成は未導入です。業種テンプレートと手動提案を利用できます。",
  },
  n8n: {
    enabled: false,
    reason: "自動化案の保存に対応しています。ワークフローの実行は未導入です。",
  },
} as const;
