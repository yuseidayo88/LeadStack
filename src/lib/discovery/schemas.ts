import { z } from "zod";

const prefecture = z.string().regex(/^(0[1-9]|[1-3]\d|4[0-7])$/);
const ids = z
  .array(z.uuid())
  .min(1)
  .max(50)
  .transform((v) => [...new Set(v)]);
const blankOptional = (value: unknown) =>
  value === "" || value === null ? undefined : value;
export const discoveryQuery = z.object({
  search: z.string().trim().max(200).default(""),
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
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  sort: z.enum(["name", "fetched_at", "employee_number"]).default("fetched_at"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});

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

export const discoveryInput = z.discriminatedUnion("action", [
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
