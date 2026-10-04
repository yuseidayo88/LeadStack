import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { databaseError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
export async function GET() {
  return handle(async () => {
    const { db, user } = await requireUser();
    const members = await db
      .from("organization_members")
      .select("*")
      .eq("user_id", user.id);
    if (members.error) databaseError(members.error);
    if (!members.data.length) return Response.json({ data: [] });
    const orgs = await db
      .from("organizations")
      .select("*")
      .in(
        "id",
        members.data.map((m) => m.organization_id),
      )
      .order("name");
    if (orgs.error) databaseError(orgs.error);
    return Response.json({
      data: orgs.data.map((org) => ({
        ...org,
        role: members.data.find((m) => m.organization_id === org.id)!.role,
      })),
    });
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    const { name } = z
      .strictObject({ name: z.string().trim().min(1).max(200) })
      .parse(await readJson(request));
    const { db } = await requireUser();
    const { data, error } = await db.rpc("create_organization", {
      org_name: name,
    });
    if (error) databaseError(error);
    return Response.json({ data: { id: data } }, { status: 201 });
  });
}
