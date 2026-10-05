import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { AppError, databaseError } from "./errors";
export async function throttleAuth(
  db: SupabaseClient<Database>,
  operation: "login" | "signup" | "recovery",
  email: string,
) {
  const subject = createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
  const { data, error } = await db.rpc("allow_auth_attempt", {
    operation,
    subject,
  });
  if (error) databaseError(error);
  if (!data)
    throw new AppError(
      429,
      "rate_limited",
      operation === "recovery"
        ? "送信申込みが多くなっています。15分以上置いて再試行してください"
        : "試行回数が多くなっています。時間を置いて再試行してください",
    );
}
