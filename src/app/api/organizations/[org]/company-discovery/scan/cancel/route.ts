import { requireOrganization } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { scanCancelInput } from "@/lib/discovery/schemas";
import { cancelScanRun } from "@/lib/discovery/scan-jobs";

export const runtime = "nodejs";
type Context = { params: Promise<{ org: string }> };

export async function POST(request: Request, context: Context) {
  return handle(async () => {
    const input = scanCancelInput.parse(await readJson(request, 1024));
    const { org } = await context.params;
    const { db } = await requireOrganization(org, true);
    // Do not inherit the original stream's abort signal: the cancellation
    // acknowledgment represents a committed DB tombstone, not a UI abort.
    const state = await cancelScanRun(db, org, input.runId);
    return Response.json({
      data: { runId: input.runId, status: state.status },
    });
  });
}
