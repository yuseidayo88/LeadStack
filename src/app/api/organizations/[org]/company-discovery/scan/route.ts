import { requireOrganization } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { scanInput } from "@/lib/discovery/schemas";
import { startCompanyScan } from "@/lib/discovery/scan";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ org: string }> };

export async function POST(request: Request, context: Context) {
  return handle(async () => {
    const input = scanInput.parse(await readJson(request));
    const { org } = await context.params;
    const { db } = await requireOrganization(org, true);
    return startCompanyScan(db, org, input, request.signal);
  });
}
