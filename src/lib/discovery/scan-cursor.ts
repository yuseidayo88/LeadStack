import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import type { ScanCriteria } from "./contracts";

const cursorSchema = z.strictObject({
  version: z.literal(1),
  organization: z.uuid(),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  expires: z.number().int().positive(),
  page: z.number().int().min(1).max(11),
  offset: z.number().int().min(0).max(20),
  numbers: z.array(z.string().regex(/^\d{13}$/)).max(20),
  lastPage: z.boolean(),
  scanned: z.number().int().min(0).max(200),
  saved: z.number().int().min(0).max(200),
  detailsFailed: z.number().int().min(0).max(1000),
  unknownEmployees: z.number().int().min(0).max(200),
  unknownIndustry: z.number().int().min(0).max(200),
  matchedIds: z.array(z.uuid()).max(200),
  seen: z.array(z.string().regex(/^\d{13}$/)).max(200),
  target: z.number().int().min(20).max(200),
  completedTarget: z.boolean(),
});

export type ScanCursor = z.infer<typeof cursorSchema>;

function secret() {
  const token = process.env.GBIZ_API_TOKEN?.trim();
  if (!token)
    throw new AppError(
      503,
      "gbiz_not_configured",
      "企業情報の取得設定がまだ完了していません。",
    );
  return createHmac("sha256", token)
    .update("LeadStack:company-discovery:scan-cursor:v1")
    .digest();
}

function scope(criteria: ScanCriteria) {
  // Inputs have already passed the canonical Zod object, including defaults.
  return createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
}

export function signScanCursor(cursor: ScanCursor) {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const signature = createHmac("sha256", secret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function openScanCursor(
  organization: string,
  criteria: ScanCriteria,
  token?: string,
  now = Date.now(),
): ScanCursor {
  if (!token) {
    secret();
    return {
      version: 1,
      organization,
      scope: scope(criteria),
      expires: now + 2 * 60 * 60 * 1000,
      page: 1,
      offset: 0,
      numbers: [],
      lastPage: false,
      scanned: 0,
      saved: 0,
      detailsFailed: 0,
      unknownEmployees: 0,
      unknownIndustry: 0,
      matchedIds: [],
      seen: [],
      target: 20,
      completedTarget: false,
    };
  }
  let cursor: ScanCursor;
  try {
    if (token.length > 32768) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 2 || !parts.every((part) => /^[\w-]+$/.test(part)))
      throw new Error();
    const supplied = Buffer.from(parts[1], "base64url");
    const expected = createHmac("sha256", secret()).update(parts[0]).digest();
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new Error();
    cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
    );
    if (
      cursor.organization !== organization ||
      cursor.scope !== scope(criteria) ||
      cursor.offset > cursor.numbers.length ||
      cursor.matchedIds.length > cursor.scanned ||
      cursor.saved > cursor.scanned ||
      cursor.target % 20 !== 0 ||
      new Set(cursor.matchedIds).size !== cursor.matchedIds.length
    )
      throw new Error();
  } catch {
    throw new AppError(
      409,
      "scan_scope_changed",
      "検索条件または再開情報が変わりました。新しい検索を開始してください。",
    );
  }
  if (cursor.expires <= now)
    throw new AppError(
      410,
      "scan_expired",
      "検索の再開期限を過ぎました。新しい検索を開始してください。",
    );
  if (cursor.completedTarget) {
    if (cursor.matchedIds.length < cursor.target)
      throw new AppError(
        409,
        "scan_scope_changed",
        "検索の再開情報を確認できません。新しい検索を開始してください。",
      );
    cursor.target = Math.min(200, cursor.matchedIds.length + 20);
    cursor.completedTarget = false;
  }
  return cursor;
}
