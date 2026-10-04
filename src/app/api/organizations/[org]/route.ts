import { z } from "zod";
import { requireOrganization } from "@/lib/auth";
import { AppError, databaseError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ org: string }> },
) {
  return handle(async () => {
    const { org } = await context.params;
    const input = z
      .strictObject({ name: z.string().trim().min(1).max(200) })
      .parse(await readJson(request));
    const { db, role } = await requireOrganization(org, true);
    if (!["owner", "admin"].includes(role))
      throw new AppError(403, "forbidden", "組織の管理権限が必要です");
    const { data, error } = await db
      .from("organizations")
      .update(input)
      .eq("id", org)
      .select()
      .single();
    if (error) databaseError(error);
    return Response.json({ data });
  });
}
