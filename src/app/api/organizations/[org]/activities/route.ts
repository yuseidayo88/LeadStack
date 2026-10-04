import { requireOrganization } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { listSchema } from "@/lib/crm/schemas";
import { listActivities, recordActivity } from "@/lib/crm/repository";
type Context = { params: Promise<{ org: string }> };
export async function GET(request: Request, context: Context) {
  return handle(async () => {
    const { org } = await context.params;
    const { db } = await requireOrganization(org);
    return Response.json(
      await listActivities(
        db,
        org,
        listSchema.parse(Object.fromEntries(new URL(request.url).searchParams)),
      ),
    );
  });
}
export async function POST(request: Request, context: Context) {
  return handle(async () => {
    const { org } = await context.params;
    const input = await readJson(request);
    const { db } = await requireOrganization(org, true);
    return Response.json(
      { data: { id: await recordActivity(db, org, input) } },
      { status: 201 },
    );
  });
}
