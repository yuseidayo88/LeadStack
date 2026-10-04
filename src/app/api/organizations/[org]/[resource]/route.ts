import { requireOrganization } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { resourceSchema, listSchema } from "@/lib/crm/schemas";
import { listRecords, createRecord } from "@/lib/crm/repository";
type Context = { params: Promise<{ org: string; resource: string }> };
export async function GET(request: Request, context: Context) {
  return handle(async () => {
    const { org, resource } = await context.params;
    const table = resourceSchema.parse(resource);
    const { db } = await requireOrganization(org);
    return Response.json(
      await listRecords(
        db,
        org,
        table,
        listSchema.parse(Object.fromEntries(new URL(request.url).searchParams)),
      ),
    );
  });
}
export async function POST(request: Request, context: Context) {
  return handle(async () => {
    const { org, resource } = await context.params;
    const input = await readJson(request);
    const table = resourceSchema.parse(resource);
    const { db } = await requireOrganization(org, true);
    return Response.json(
      { data: await createRecord(db, org, table, input) },
      { status: 201 },
    );
  });
}
