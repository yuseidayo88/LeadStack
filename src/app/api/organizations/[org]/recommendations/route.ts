import { z } from "zod";
import { requireOrganization } from "@/lib/auth";
import { databaseError } from "@/lib/errors";
import { handle } from "@/lib/http";
export async function GET(
  request: Request,
  context: { params: Promise<{ org: string }> },
) {
  return handle(async () => {
    const { org } = await context.params;
    const industry = z
      .string()
      .min(1)
      .max(200)
      .parse(new URL(request.url).searchParams.get("industry"));
    const { db } = await requireOrganization(org);
    const recs = await db
      .from("industry_recommendations")
      .select("*")
      .eq("industry", industry)
      .order("priority");
    if (recs.error) databaseError(recs.error);
    if (!recs.data.length) return Response.json({ data: [] });
    const types = await db
      .from("improvement_types")
      .select("*")
      .in(
        "id",
        recs.data.map((r) => r.improvement_type_id),
      );
    if (types.error) databaseError(types.error);
    return Response.json({
      data: recs.data.map((r) => ({
        ...r,
        improvement: types.data.find((t) => t.id === r.improvement_type_id),
      })),
    });
  });
}
