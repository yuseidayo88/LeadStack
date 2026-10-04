import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/navigation";
import { NextResponse } from "next/server";
function redirect(url: URL) {
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = process.env.NEXT_PUBLIC_SITE_URL || url.origin;
  const code = url.searchParams.get("code");
  if (code) {
    const db = await createClient();
    const { error } = await db.auth.exchangeCodeForSession(code);
    if (!error)
      return redirect(new URL(safeNext(url.searchParams.get("next")), origin));
  }
  return redirect(new URL("/login?error=confirmation", origin));
}
