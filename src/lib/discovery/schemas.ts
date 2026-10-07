import { z } from "zod";

const prefecture = z.string().regex(/^(0[1-9]|[1-3]\d|4[0-7])$/);
const ids = z
  .array(z.uuid())
  .min(1)
  .max(50)
  .transform((v) => [...new Set(v)]);
const blankOptional = (value: unknown) =>
  value === "" || value === null ? undefined : value;
const employeeBound = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : value),
  z
    .union([z.string().regex(/^\d+$/).transform(Number), z.number()])
    .pipe(z.number().int().min(0).max(2147483647))
    .optional(),
);
const businessKeywords = z
  .string()
  .trim()
  .max(200)
  .default("")
  .transform((value) => [...new Set(value.split(/[,、，\s]+/).filter(Boolean))])
  .pipe(z.array(z.string().min(1).max(40)).max(8));
export const scanCriteria = z
  .strictObject({
    // Optional to keep old signed criteria/checkpoints valid when not enabled.
    refreshDetails: z.boolean().optional(),
    prefecture: z.preprocess(blankOptional, prefecture.optional()),
    name: z.preprocess(
      blankOptional,
      z.string().trim().min(1).max(200).optional(),
    ),
    corporateNumber: z.preprocess(
      blankOptional,
      z
        .string()
        .regex(/^\d{13}$/)
        .optional(),
    ),
    industry: z.preprocess(
      blankOptional,
      z
        .string()
        .regex(/^(?:[A-T]|unknown)$/)
        .optional(),
    ),
    employeeMin: employeeBound,
    employeeMax: employeeBound,
    includeUnknownEmployees: z.boolean().default(true),
    includeUnknownIndustry: z.boolean().default(false),
    businessKeywords: businessKeywords.transform((terms) => terms.join(" ")),
    hasPhone: z.boolean().default(false),
    hasWebsite: z.boolean().default(false),
    hasEmployees: z.boolean().default(false),
  })
  .refine(
    (value) =>
      value.employeeMin === undefined ||
      value.employeeMax === undefined ||
      value.employeeMin <= value.employeeMax,
    {
      message: "従業員数の下限は上限以下にしてください",
      path: ["employeeMax"],
    },
  )
  .refine(
    (value) =>
      Boolean(
        value.prefecture ||
        value.name ||
        value.corporateNumber ||
        value.industry ||
        value.employeeMin !== undefined ||
        value.employeeMax !== undefined ||
        value.businessKeywords,
      ),
    "都道府県・業種・従業員数・事業キーワードのいずれかを指定してください",
  );
export const discoveryQuery = z
  .object({
    search: z.string().trim().max(200).default(""),
    view: z.enum(["full", "summary"]).default("full"),
    prefecture: z.preprocess(blankOptional, prefecture.optional()),
    industry: z.preprocess(
      blankOptional,
      z
        .string()
        .regex(/^(?:[A-T]|unknown)$/)
        .optional(),
    ),
    hasPhone: z.enum(["true", "false"]).optional(),
    hasWebsite: z.enum(["true", "false"]).optional(),
    hasEmployees: z.enum(["true", "false"]).optional(),
    employeeMin: employeeBound,
    employeeMax: employeeBound,
    includeUnknownEmployees: z.enum(["true", "false"]).default("false"),
    includeUnknownIndustry: z.enum(["true", "false"]).default("false"),
    businessKeywords,
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    sort: z
      .enum(["name", "fetched_at", "employee_number"])
      .default("fetched_at"),
    direction: z.enum(["asc", "desc"]).default("desc"),
  })
  .refine(
    (value) =>
      value.employeeMin === undefined ||
      value.employeeMax === undefined ||
      value.employeeMin <= value.employeeMax,
    {
      message: "従業員数の下限は上限以下にしてください",
      path: ["employeeMax"],
    },
  );

const website = z
  .string()
  .trim()
  .max(2000)
  .transform((v) => v || null)
  .nullable()
  .refine((v) => {
    if (v === null) return true;
    try {
      const u = new URL(v);
      return (
        ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      );
    } catch {
      return false;
    }
  }, "httpまたはhttpsの公式サイトURLを入力してください");

export const scanInput = z.strictObject({
  action: z.literal("scan"),
  criteria: scanCriteria,
  resumeToken: z.string().min(1).max(32_768).optional(),
  runId: z.uuid(),
  issuedAt: z.iso.datetime({ offset: true }),
});
export const scanCancelInput = z.strictObject({ runId: z.uuid() });

export const discoveryInput = z.discriminatedUnion("action", [
  scanInput,
  z
    .strictObject({
      action: z.literal("acquire"),
      prefecture: prefecture.optional(),
      name: z.string().trim().min(1).max(200).optional(),
      corporateNumber: z
        .string()
        .regex(/^\d{13}$/)
        .optional(),
      page: z.number().int().min(1).max(10).default(1),
    })
    .refine(
      (v) => !!(v.prefecture || v.name || v.corporateNumber),
      "都道府県または企業名を指定してください",
    ),
  z.strictObject({ action: z.literal("preview"), ids }),
  z.strictObject({
    action: z.literal("remove"),
    ids,
    confirmed: z.literal(true),
  }),
  z.strictObject({
    action: z.literal("import"),
    ids,
    reviewToken: z.string().min(1).max(200),
    confirmedDuplicates: z.boolean(),
    confirmed: z.literal(true),
  }),
  z.strictObject({ action: z.literal("enrich"), id: z.uuid() }),
  z.strictObject({ action: z.literal("research_phone"), id: z.uuid() }),
  z.strictObject({
    action: z.literal("confirm_phone"),
    id: z.uuid(),
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
    confirmed: z.literal(true),
  }),
  z.strictObject({
    action: z.literal("update"),
    id: z.uuid(),
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
    phone: z
      .string()
      .trim()
      .max(100)
      .transform((v) => v || null)
      .nullable(),
    website_url: website,
    employee_number: z.number().int().min(0).max(2147483647).nullable(),
  }),
]);

export type DiscoveryQuery = z.infer<typeof discoveryQuery>;
export type DiscoveryInput = z.infer<typeof discoveryInput>;
