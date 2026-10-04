import { z } from "zod";
export const uuid = z.uuid();
const text = z.string().trim().max(10000).nullable().optional();
const shortText = z.string().trim().max(200).nullable().optional();
const name = z.string().trim().min(1, "入力してください").max(200);
const title = z.string().trim().min(1, "入力してください").max(300);
const ref = uuid.nullable().optional();
const time = z.iso.datetime({ offset: true }).nullable().optional();
const count = z.number().int().min(0).max(2147483647).nullable().optional();
const url = z
  .url()
  .refine(
    (v) => ["http:", "https:"].includes(new URL(v).protocol),
    "HTTP(S) URL を指定してください",
  )
  .nullable()
  .optional();
export const roles = ["owner", "admin", "sales", "viewer"] as const;
export const companyStatuses = [
  "new",
  "active",
  "nurturing",
  "not_target",
  "closed",
] as const;
export const dealStages = [
  "discovery",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;
export const taskTypes = [
  "callback",
  "follow_up",
  "meeting",
  "proposal",
  "other",
] as const;
export const taskStatuses = ["todo", "completed", "cancelled"] as const;
export const activityTypes = [
  "call",
  "meeting",
  "email",
  "memo",
  "status_change",
] as const;
export const callResults = [
  "no_answer",
  "gatekeeper",
  "connected",
  "callback",
  "appointment",
  "rejected",
  "other",
] as const;
export const proposalTypes = ["build", "automate", "keep"] as const;
export const processTypes = [
  "project_management",
  "estimate",
  "daily_report",
  "billing",
  "customer_management",
  "scheduling",
  "inventory",
  "reporting",
  "document_management",
  "inquiry_management",
  "communication",
  "other",
] as const;
export const painTypes = [
  "duplicate_entry",
  "manual_work",
  "fragmented_information",
  "paperwork",
  "slow_reporting",
  "human_error",
  "repetitive_work",
  "communication_delay",
  "approval_delay",
  "data_search",
  "person_dependency",
  "other",
] as const;
const companyLink = { company_id: uuid, contact_id: ref };
export const schemas = {
  companies: z.strictObject({
    name,
    corporate_number: z
      .string()
      .regex(/^\d{13}$/)
      .nullable()
      .optional(),
    industry: shortText,
    industry_subcategory: shortText,
    prefecture: shortText,
    city: shortText,
    address: text,
    website_url: url,
    phone: shortText,
    contact_url: url,
    employee_min: count,
    employee_max: count,
    capital: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    business_description: text,
    company_status: z.enum(companyStatuses).optional(),
    assigned_user_id: ref,
    source: shortText,
  }),
  contacts: z.strictObject({
    company_id: uuid,
    name,
    department: shortText,
    position: shortText,
    phone: shortText,
    email: z.email().max(254).nullable().optional(),
    is_decision_maker: z.boolean().optional(),
    notes: text,
  }),
  tasks: z.strictObject({
    ...companyLink,
    assigned_user_id: uuid,
    type: z.enum(taskTypes),
    title,
    description: text,
    due_at: time,
    status: z.enum(taskStatuses).optional(),
  }),
  deals: z.strictObject({
    ...companyLink,
    owner_user_id: uuid,
    name: title,
    stage: z.enum(dealStages).optional(),
    initial_price: count,
    monthly_price: count,
    expected_close_date: z.iso.date().nullable().optional(),
    lost_reason: text,
    notes: text,
  }),
  business_processes: z.strictObject({
    company_id: uuid,
    process_type: z.enum(processTypes),
    current_method: shortText,
    description: text,
    pain_level: z.number().int().min(1).max(5).nullable().optional(),
    notes: text,
  }),
  company_tools: z.strictObject({
    company_id: uuid,
    tool_name: name,
    category: shortText,
    usage_description: text,
    keep_or_replace: z
      .enum(["unknown", "keep", "replace", "integrate"])
      .optional(),
  }),
  pain_points: z.strictObject({
    company_id: uuid,
    type: z.enum(painTypes),
    description: text,
    severity: z.number().int().min(1).max(5).nullable().optional(),
  }),
  proposals: z.strictObject({
    company_id: uuid,
    type: z.enum(proposalTypes),
    title,
    description: text,
    reason: text,
    expected_benefit: text,
    automation_config: z
      .strictObject({
        trigger: z.string().trim().min(1).max(1000),
        steps: z.array(z.string().trim().min(1).max(1000)).max(30),
        tools: z.array(name).max(20),
      })
      .nullable()
      .optional(),
    status: z.enum(["draft", "proposed", "accepted", "rejected"]).optional(),
    generated_by: z.enum(["rule", "human"]).optional(),
  }),
} as const;
export type Resource = keyof typeof schemas;
export const resourceSchema = z.enum(
  Object.keys(schemas) as [Resource, ...Resource[]],
);
export const activitySchema = z
  .strictObject({
    company_id: uuid,
    contact_id: ref,
    type: z.enum(activityTypes),
    title: title.nullable().optional(),
    content: text,
    occurred_at: time,
    phone_number: shortText,
    result: z.enum(callResults).nullable().optional(),
    started_at: time,
    ended_at: time,
    duration_seconds: count,
    callback: z
      .strictObject({
        title,
        due_at: z.iso.datetime({ offset: true }),
        assigned_user_id: uuid.optional(),
      })
      .nullable()
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.type !== "call" &&
      (v.result != null ||
        v.phone_number != null ||
        v.started_at != null ||
        v.ended_at != null ||
        v.duration_seconds != null ||
        v.callback != null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "架電情報は電話活動にのみ登録できます",
        path: ["type"],
      });
    }
    if (
      v.started_at &&
      v.ended_at &&
      new Date(v.ended_at) < new Date(v.started_at)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "終了日時は開始日時以降にしてください",
        path: ["ended_at"],
      });
    }
  });
export const listSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
  company_id: uuid.optional(),
  industry: z.string().max(200).optional(),
  prefecture: z.string().max(200).optional(),
  assigned_user_id: uuid.optional(),
  company_status: z.enum(companyStatuses).optional(),
  stage: z.enum(dealStages).optional(),
  type: z.string().max(100).optional(),
  status: z.string().max(100).optional(),
  due_before: z.iso.datetime({ offset: true }).optional(),
  due_after: z.iso.datetime({ offset: true }).optional(),
  sort: z
    .enum([
      "name",
      "created_at",
      "updated_at",
      "due_at",
      "occurred_at",
      "expected_close_date",
      "last_contact_at",
    ])
    .default("created_at"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});
export type ListOptions = z.infer<typeof listSchema>;
export function parseRecord(resource: Resource, input: unknown, patch = false) {
  const data = patch
    ? schemas[resource].partial().parse(input)
    : schemas[resource].parse(input);
  if (patch && Object.keys(data).length === 0)
    throw new z.ZodError([
      { code: "custom", path: [], message: "変更内容がありません" },
    ]);
  if (
    "employee_min" in data &&
    "employee_max" in data &&
    data.employee_min != null &&
    data.employee_max != null &&
    data.employee_min > data.employee_max
  ) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["employee_max"],
        message: "人数の上限は下限以上にしてください",
      },
    ]);
  }
  return data;
}
