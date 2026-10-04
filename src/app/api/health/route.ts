import { supabaseConfig } from "@/lib/supabase/config";
export async function GET() {
  const configured = !!supabaseConfig();
  return Response.json(
    {
      service: "leadstack",
      status: configured ? "configured" : "configuration_required",
      databaseVerified: false,
    },
    {
      status: configured ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
