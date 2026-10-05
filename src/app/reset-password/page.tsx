import { hasRecentRecovery } from "@/lib/recovery";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { ResetPasswordForm } from "@/components/auth/recovery";
export default async function ResetPasswordPage() {
  const db = await createClient({ readOnly: true });
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user || !(await hasRecentRecovery(db)))
    redirect("/login?error=confirmation");
  return <ResetPasswordForm />;
}
