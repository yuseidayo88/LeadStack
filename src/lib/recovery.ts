import type { SupabaseClient } from "@supabase/supabase-js";
// getClaims verifies the JWT. Never authorize using user-editable metadata or query params.
export async function hasRecentRecovery(db: SupabaseClient) {
  const { data, error } = await db.auth.getClaims();
  if (error || !data) return false;
  const now = Math.floor(Date.now() / 1000);
  const amr = data.claims.amr as
    { method?: string; timestamp?: number }[] | undefined;
  return (
    Array.isArray(amr) &&
    amr.some(
      (a) =>
        a.method === "recovery" &&
        typeof a.timestamp === "number" &&
        a.timestamp <= now &&
        now - a.timestamp <= 900,
    )
  );
}
