import { z } from "zod";
import { requireOrganization } from "@/lib/auth";
import { getCandidateDetail } from "@/lib/discovery/service";
import { handle } from "@/lib/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ org: string; id: string }> };

export async function GET(_request: Request, context: Context) {
  return handle(async () => {
    const { org, id } = await context.params;
    z.uuid().parse(id);
    const { db } = await requireOrganization(org);
    return Response.json({ candidate: await getCandidateDetail(db, org, id) });
  });
}
