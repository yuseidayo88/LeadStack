import { z } from "zod";
import { requireOrganization } from "@/lib/auth";
import { AppError, databaseError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { roles } from "@/lib/crm/schemas";
const change = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("invite"),
    email: z.email().max(254),
    role: z.enum(["admin", "sales", "viewer"]),
  }),
  z.strictObject({
    action: z.literal("role"),
    user_id: z.uuid(),
    role: z.enum(roles),
  }),
  z.strictObject({ action: z.literal("remove"), user_id: z.uuid() }),
  z.strictObject({ action: z.literal("revoke"), invitation_id: z.uuid() }),
]);
type Context = { params: Promise<{ org: string }> };
export async function GET(_request: Request, context: Context) {
  return handle(async () => {
    const { org } = await context.params;
    const { db, role } = await requireOrganization(org);
    const members = await db
      .from("organization_members")
      .select("*")
      .eq("organization_id", org)
      .order("created_at");
    if (members.error) databaseError(members.error);
    const profiles = await db
      .from("profiles")
      .select("id,name,email,avatar_url")
      .in(
        "id",
        members.data.map((m) => m.user_id),
      );
    if (profiles.error) databaseError(profiles.error);
    const invitations = ["owner", "admin"].includes(role)
      ? await db
          .from("organization_invitations")
          .select("*")
          .eq("organization_id", org)
          .is("accepted_at", null)
          .gt("expires_at", new Date().toISOString())
      : { data: [], error: null };
    if (invitations.error) databaseError(invitations.error);
    return Response.json({
      data: members.data.map((m) => ({
        ...m,
        profile: profiles.data.find((p) => p.id === m.user_id),
      })),
      invitations: invitations.data,
    });
  });
}
export async function POST(request: Request, context: Context) {
  return handle(async () => {
    const input = change.parse(await readJson(request));
    const { org } = await context.params;
    const { db, role } = await requireOrganization(org, true);
    if (!["owner", "admin"].includes(role))
      throw new AppError(403, "forbidden", "メンバー管理権限が必要です");
    const result =
      input.action === "invite"
        ? await db.rpc("invite_member", {
            org,
            invite_email: input.email,
            invite_role: input.role,
          })
        : input.action === "revoke"
          ? await db.rpc("revoke_invitation", {
              org,
              invitation_id: input.invitation_id,
            })
          : await db.rpc("manage_member", {
              org,
              member_id: input.user_id,
              new_role: input.action === "role" ? input.role : undefined,
            });
    if (result.error) databaseError(result.error);
    return Response.json({ ok: true, data: result.data });
  });
}
