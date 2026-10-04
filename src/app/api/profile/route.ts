import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { databaseError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
export async function GET() {
  return handle(async () => {
    const { db, user } = await requireUser();
    const { data, error } = await db
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();
    if (error) databaseError(error);
    return Response.json({ data });
  });
}
export async function PATCH(request: Request) {
  return handle(async () => {
    const input = z
      .strictObject({
        name: z.string().trim().min(1).max(200),
        avatar_url: z.url().startsWith("https://").nullable().optional(),
      })
      .parse(await readJson(request));
    const { db, user } = await requireUser();
    const { data, error } = await db
      .from("profiles")
      .update(input)
      .eq("id", user.id)
      .select()
      .single();
    if (error) databaseError(error);
    return Response.json({ data });
  });
}
