import "server-only";
import { createClient } from "@/lib/supabase/server";
import { AppError, databaseError } from "@/lib/errors";
import { uuid, roles } from "@/lib/crm/schemas";
import { z } from "zod";
export async function requireUser() {
  const db = await createClient();
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user)
    throw new AppError(401, "unauthorized", "ログインしてください");
  return { db, user };
}
export async function requireOrganization(
  organizationId: string,
  write = false,
) {
  const org = uuid.parse(organizationId);
  const { db, user } = await requireUser();
  const { data, error } = await db
    .from("organization_members")
    .select("role")
    .eq("organization_id", org)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) databaseError(error);
  if (!data)
    throw new AppError(403, "forbidden", "この組織へのアクセス権がありません");
  const role = z.enum(roles).parse(data.role);
  if (write && role === "viewer")
    throw new AppError(403, "read_only", "閲覧専用のユーザーです");
  return { db, user, org, role };
}
