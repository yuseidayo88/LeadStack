import { requireOrganization } from "@/lib/auth";
import { handle } from "@/lib/http";
import { databaseError } from "@/lib/errors";
import { uuid } from "@/lib/crm/schemas";
export async function GET(
  _request: Request,
  context: { params: Promise<{ org: string; id: string }> },
) {
  return handle(async () => {
    const { org, id } = await context.params;
    const { db } = await requireOrganization(org);
    const { data, error } = await db.rpc("next_company", {
      org,
      company: uuid.parse(id),
    });
    if (error) databaseError(error);
    return Response.json({ company: data?.[0] || null });
  });
}
