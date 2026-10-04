import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { databaseError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
export async function GET() {
  return handle(async () => {
    const { db } = await requireUser();
    const { data, error } = await db.rpc("my_invitations");
    if (error) databaseError(error);
    return Response.json({ data });
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    const input = z
      .strictObject({ invitation_id: z.uuid() })
      .parse(await readJson(request));
    const { db } = await requireUser();
    const { data, error } = await db.rpc("accept_invitation", input);
    if (error) databaseError(error);
    return Response.json({ data: { organization_id: data } });
  });
}
