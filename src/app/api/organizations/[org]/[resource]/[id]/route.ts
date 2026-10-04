import { requireOrganization } from "@/lib/auth";
import { handle, readJson, sameOrigin } from "@/lib/http";
import { resourceSchema } from "@/lib/crm/schemas";
import { getRecord, updateRecord, deleteRecord } from "@/lib/crm/repository";
type Context = {
  params: Promise<{ org: string; resource: string; id: string }>;
};
export async function GET(_request: Request, context: Context) {
  return handle(async () => {
    const { org, resource, id } = await context.params;
    const { db } = await requireOrganization(org);
    return Response.json({
      data: await getRecord(db, org, resourceSchema.parse(resource), id),
    });
  });
}
export async function PATCH(request: Request, context: Context) {
  return handle(async () => {
    const { org, resource, id } = await context.params;
    const input = await readJson(request);
    const { db } = await requireOrganization(org, true);
    return Response.json({
      data: await updateRecord(
        db,
        org,
        resourceSchema.parse(resource),
        id,
        input,
      ),
    });
  });
}
export async function DELETE(request: Request, context: Context) {
  return handle(async () => {
    sameOrigin(request);
    const { org, resource, id } = await context.params;
    const { db } = await requireOrganization(org, true);
    await deleteRecord(db, org, resourceSchema.parse(resource), id);
    return new Response(null, { status: 204 });
  });
}
