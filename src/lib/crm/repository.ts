import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { AppError, databaseError } from "@/lib/errors";
import {
  schemas,
  parseRecord,
  uuid,
  type Resource,
  type ListOptions,
  activitySchema,
} from "./schemas";
export type DbClient = SupabaseClient<Database>;
const searchable: Record<Resource, string> = {
  companies: "name",
  contacts: "name",
  tasks: "title",
  deals: "name",
  business_processes: "process_type",
  company_tools: "tool_name",
  pain_points: "description",
  proposals: "title",
};
const sorts: Record<Resource, string[]> = {
  companies: ["name", "created_at", "updated_at", "last_contact_at"],
  contacts: ["name", "created_at", "updated_at"],
  tasks: ["created_at", "updated_at", "due_at"],
  deals: ["name", "created_at", "updated_at", "expected_close_date"],
  business_processes: ["created_at", "updated_at"],
  company_tools: ["created_at", "updated_at"],
  pain_points: ["created_at"],
  proposals: ["created_at", "updated_at"],
};
export async function listRecords(
  db: DbClient,
  org: string,
  resource: Resource,
  options: ListOptions,
) {
  if (!sorts[resource].includes(options.sort))
    throw new AppError(422, "sort", "並び替えの項目が正しくありません");
  let query =
    resource === "companies"
      ? db
          .from("company_overview")
          .select("*", { count: "exact" })
          .eq("organization_id", org)
      : db
          .from(resource)
          .select("*", { count: "exact" })
          .eq("organization_id", org);
  if (options.search)
    query = query.ilike(
      searchable[resource],
      `%${options.search.replace(/[\\%_]/g, "\\$&")}%`,
    );
  const filters: [string, string | undefined, boolean][] = [
    ["company_id", options.company_id, resource !== "companies"],
    ["industry", options.industry, resource === "companies"],
    ["prefecture", options.prefecture, resource === "companies"],
    ["company_status", options.company_status, resource === "companies"],
    [
      resource === "deals" ? "owner_user_id" : "assigned_user_id",
      options.assigned_user_id,
      ["companies", "tasks", "deals"].includes(resource),
    ],
    ["stage", options.stage, resource === "deals"],
    [
      "type",
      options.type,
      ["tasks", "pain_points", "proposals"].includes(resource),
    ],
    ["status", options.status, ["tasks", "proposals"].includes(resource)],
  ];
  for (const [column, value, allowed] of filters) {
    if (value === undefined) continue;
    if (!allowed)
      throw new AppError(
        422,
        "filter",
        "この一覧では指定された条件を使用できません",
      );
    query = query.eq(column, value);
  }
  if ((options.due_before || options.due_after) && resource !== "tasks")
    throw new AppError(422, "filter", "期限の条件はタスクで使用できます");
  if (options.due_before) query = query.lt("due_at", options.due_before);
  if (options.due_after) query = query.gte("due_at", options.due_after);
  const from = (options.page - 1) * options.pageSize;
  const { data, count, error } = await query
    .order(options.sort, {
      ascending: options.direction === "asc",
      nullsFirst: false,
    })
    .order("id")
    .range(from, from + options.pageSize - 1);
  if (error) databaseError(error);
  if ((resource === "deals" || resource === "tasks") && data?.length) {
    const linked = data as unknown as {
      company_id: string;
      contact_id: string | null;
    }[];
    const companyIds = [...new Set(linked.map((r) => r.company_id))];
    const contactIds = [
      ...new Set(
        linked
          .map((r) => r.contact_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const [companies, contacts] = await Promise.all([
      db
        .from("companies")
        .select("id,name")
        .eq("organization_id", org)
        .in("id", companyIds),
      contactIds.length
        ? db
            .from("contacts")
            .select("id,name")
            .eq("organization_id", org)
            .in("id", contactIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (companies.error) databaseError(companies.error);
    if (contacts.error) databaseError(contacts.error);
    const companyNames = new Map(companies.data.map((c) => [c.id, c.name]));
    const contactNames = new Map(contacts.data.map((c) => [c.id, c.name]));
    return {
      data: data.map((r, i) => ({
        ...r,
        company_name: companyNames.get(linked[i].company_id) || null,
        contact_name: contactNames.get(linked[i].contact_id || "") || null,
      })),
      count,
      page: options.page,
      pageSize: options.pageSize,
    };
  }
  return { data, count, page: options.page, pageSize: options.pageSize };
}
export async function getRecord(
  db: DbClient,
  org: string,
  resource: Resource,
  id: string,
) {
  const { data, error } = await db
    .from(resource)
    .select("*")
    .eq("organization_id", org)
    .eq("id", uuid.parse(id))
    .maybeSingle();
  if (error) databaseError(error);
  if (!data) throw new AppError(404, "not_found", "データが見つかりません");
  return data;
}
// Usable from future CSV/list acquisition jobs with the caller's authorized client.
export async function createCompany(db: DbClient, org: string, input: unknown) {
  parseRecord("companies", input);
  const { data, error } = await db
    .from("companies")
    .insert({
      ...schemas.companies.parse(input),
      organization_id: uuid.parse(org),
    })
    .select()
    .single();
  if (error) databaseError(error);
  return data;
}
export async function createRecord(
  db: DbClient,
  org: string,
  resource: Resource,
  input: unknown,
) {
  uuid.parse(org);
  switch (resource) {
    case "companies":
      return createCompany(db, org, input);
    case "contacts": {
      const { data, error } = await db
        .from("contacts")
        .insert({ ...schemas.contacts.parse(input), organization_id: org })
        .select()
        .single();
      if (error) databaseError(error);
      return data;
    }
    case "tasks": {
      const { data, error } = await db
        .from("tasks")
        .insert({ ...schemas.tasks.parse(input), organization_id: org })
        .select()
        .single();
      if (error) databaseError(error);
      return data;
    }
    case "deals": {
      const { data, error } = await db
        .from("deals")
        .insert({ ...schemas.deals.parse(input), organization_id: org })
        .select()
        .single();
      if (error) databaseError(error);
      return data;
    }
    case "business_processes": {
      const { data, error } = await db
        .from("business_processes")
        .insert({
          ...schemas.business_processes.parse(input),
          organization_id: org,
        })
        .select()
        .single();
      if (error) databaseError(error);
      return data;
    }
    case "company_tools": {
      const { data, error } = await db
        .from("company_tools")
        .insert({ ...schemas.company_tools.parse(input), organization_id: org })
        .select()
        .single();
      if (error) databaseError(error);
      return data;
    }
    case "pain_points": {
      const { data, error } = await db
        .from("pain_points")
        .insert({ ...schemas.pain_points.parse(input), organization_id: org })
        .select()
        .single();
      if (error) databaseError(error);
      return data;
    }
    case "proposals": {
      const { data, error } = await db
        .from("proposals")
        .insert({ ...schemas.proposals.parse(input), organization_id: org })
        .select()
        .single();
      if (error) databaseError(error);
      return data;
    }
  }
}
export async function updateRecord(
  db: DbClient,
  org: string,
  resource: Resource,
  id: string,
  input: unknown,
) {
  uuid.parse(id);
  parseRecord(resource, input, true);
  switch (resource) {
    case "companies": {
      const { data, error } = await db
        .from("companies")
        .update(schemas.companies.partial().parse(input))
        .eq("organization_id", org)
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) databaseError(error);
      if (!data) throw new AppError(404, "not_found", "データが見つかりません");
      return data;
    }
    case "contacts": {
      const { data, error } = await db
        .from("contacts")
        .update(schemas.contacts.partial().parse(input))
        .eq("organization_id", org)
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) databaseError(error);
      if (!data) throw new AppError(404, "not_found", "データが見つかりません");
      return data;
    }
    case "tasks": {
      const { data, error } = await db
        .from("tasks")
        .update(schemas.tasks.partial().parse(input))
        .eq("organization_id", org)
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) databaseError(error);
      if (!data) throw new AppError(404, "not_found", "データが見つかりません");
      return data;
    }
    case "deals": {
      const { data, error } = await db
        .from("deals")
        .update(schemas.deals.partial().parse(input))
        .eq("organization_id", org)
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) databaseError(error);
      if (!data) throw new AppError(404, "not_found", "データが見つかりません");
      return data;
    }
    case "business_processes": {
      const { data, error } = await db
        .from("business_processes")
        .update(schemas.business_processes.partial().parse(input))
        .eq("organization_id", org)
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) databaseError(error);
      if (!data) throw new AppError(404, "not_found", "データが見つかりません");
      return data;
    }
    case "company_tools": {
      const { data, error } = await db
        .from("company_tools")
        .update(schemas.company_tools.partial().parse(input))
        .eq("organization_id", org)
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) databaseError(error);
      if (!data) throw new AppError(404, "not_found", "データが見つかりません");
      return data;
    }
    case "pain_points": {
      const { data, error } = await db
        .from("pain_points")
        .update(schemas.pain_points.partial().parse(input))
        .eq("organization_id", org)
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) databaseError(error);
      if (!data) throw new AppError(404, "not_found", "データが見つかりません");
      return data;
    }
    case "proposals": {
      const { data, error } = await db
        .from("proposals")
        .update(schemas.proposals.partial().parse(input))
        .eq("organization_id", org)
        .eq("id", id)
        .select()
        .maybeSingle();
      if (error) databaseError(error);
      if (!data) throw new AppError(404, "not_found", "データが見つかりません");
      return data;
    }
  }
}
export async function deleteRecord(
  db: DbClient,
  org: string,
  resource: Resource,
  id: string,
) {
  const { data, error } = await db
    .from(resource)
    .delete()
    .eq("organization_id", org)
    .eq("id", uuid.parse(id))
    .select("id")
    .maybeSingle();
  if (error) databaseError(error);
  if (!data) throw new AppError(404, "not_found", "データが見つかりません");
}
export async function recordActivity(
  db: DbClient,
  org: string,
  input: unknown,
) {
  const { company_id, ...payload } = activitySchema.parse(input);
  const { data, error } = await db.rpc("record_activity", {
    org,
    company: company_id,
    payload,
  });
  if (error) databaseError(error);
  return data;
}
export async function listActivities(
  db: DbClient,
  org: string,
  options: ListOptions,
) {
  if (!options.company_id)
    throw new AppError(422, "company_required", "企業を指定してください");
  let query = db
    .from("activities")
    .select("*", { count: "exact" })
    .eq("organization_id", org)
    .eq("company_id", options.company_id);
  if (options.type) query = query.eq("type", options.type);
  const from = (options.page - 1) * options.pageSize;
  const { data, error, count } = await query
    .order("occurred_at", { ascending: false })
    .order("id")
    .range(from, from + options.pageSize - 1);
  if (error) databaseError(error);
  const ids = data.filter((a) => a.type === "call").map((a) => a.id);
  const details = ids.length
    ? await db.from("call_details").select("*").in("activity_id", ids)
    : { data: [], error: null };
  if (details.error) databaseError(details.error);
  const callMap = new Map(details.data.map((d) => [d.activity_id, d]));
  return {
    data: data.map((a) => ({ ...a, call_details: callMap.get(a.id) ?? null })),
    count,
    page: options.page,
    pageSize: options.pageSize,
  };
}
