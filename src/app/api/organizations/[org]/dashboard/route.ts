import { z } from "zod";
import { requireOrganization } from "@/lib/auth";
import { databaseError } from "@/lib/errors";
import { handle } from "@/lib/http";
import { dayRange, tokyoDate } from "@/lib/dates";
export async function GET(
  request: Request,
  context: { params: Promise<{ org: string }> },
) {
  return handle(async () => {
    const { org } = await context.params;
    const date = z.iso
      .date()
      .parse(new URL(request.url).searchParams.get("date") || tokyoDate());
    const { start, end } = dayRange(date);
    const { db, user } = await requireOrganization(org);
    const [counts, tasks, callbacks, overdue, missingNext] = await Promise.all([
      db.rpc("dashboard_counts", { org, day_start: start, day_end: end }),
      db
        .from("tasks")
        .select("*")
        .eq("organization_id", org)
        .eq("assigned_user_id", user.id)
        .eq("status", "todo")
        .gte("due_at", start)
        .lt("due_at", end)
        .order("due_at")
        .limit(30),
      db
        .from("tasks")
        .select("*")
        .eq("organization_id", org)
        .eq("assigned_user_id", user.id)
        .eq("status", "todo")
        .eq("type", "callback")
        .order("due_at", { nullsFirst: false })
        .limit(30),
      db
        .from("tasks")
        .select("*")
        .eq("organization_id", org)
        .eq("assigned_user_id", user.id)
        .eq("status", "todo")
        .lt("due_at", start)
        .order("due_at")
        .limit(30),
      db
        .from("company_overview")
        .select("id,name,last_contact_at")
        .eq("organization_id", org)
        .eq("assigned_user_id", user.id)
        .is("next_task", null)
        .not("company_status", "in", "(closed,not_target)")
        .order("last_contact_at", { nullsFirst: true })
        .limit(30),
    ]);
    for (const r of [counts, tasks, callbacks, overdue, missingNext])
      if (r.error) databaseError(r.error);
    const companyIds = [
      ...new Set(
        [
          ...(tasks.data || []),
          ...(callbacks.data || []),
          ...(overdue.data || []),
        ].map((t) => t.company_id),
      ),
    ];
    const companies = companyIds.length
      ? await db
          .from("companies")
          .select("id,name")
          .eq("organization_id", org)
          .in("id", companyIds)
      : { data: [], error: null };
    if (companies.error) databaseError(companies.error);
    const names = new Map(companies.data.map((c) => [c.id, c.name]));
    return Response.json({
      date,
      timezone: "Asia/Tokyo",
      counts: counts.data,
      tasks: tasks.data?.map((t) => ({
        ...t,
        company_name: names.get(t.company_id) || null,
      })),
      missingNext: missingNext.data,
      overdue: overdue.data?.map((t) => ({
        ...t,
        company_name: names.get(t.company_id) || null,
      })),
      callbacks: callbacks.data?.map((t) => ({
        ...t,
        company_name: names.get(t.company_id) || null,
      })),
    });
  });
}
