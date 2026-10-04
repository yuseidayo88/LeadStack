import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WorkspaceProvider } from "@/components/layout/workspace";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const db = await createClient({ readOnly: true });
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}
