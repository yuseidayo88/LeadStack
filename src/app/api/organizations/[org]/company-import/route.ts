import { z } from "zod";
import { requireOrganization } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import { AppError, databaseError } from "@/lib/errors";
import { previewCsv } from "@/lib/crm/company-csv";
import type { Json } from "@/lib/database.types";
const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("preview"), csv: z.string().max(600000) }),
  z.strictObject({
    action: z.literal("confirm"),
    id: z.uuid(),
    rows: z.array(z.number().int().min(2).max(501)).min(1).max(500),
    confirmed: z.literal(true),
  }),
]);
export async function POST(
  request: Request,
  context: { params: Promise<{ org: string }> },
) {
  return handle(async () => {
    const { org } = await context.params;
    const { db } = await requireOrganization(org, true);
    const input = inputSchema.parse(await readJson(request, 2 * 1024 * 1024));
    if (input.action === "preview") {
      let rows;
      try {
        rows = previewCsv(input.csv);
      } catch (e) {
        throw new AppError(
          422,
          "csv_invalid",
          e instanceof Error ? e.message : "CSVを確認してください",
        );
      }
      const { data, error } = await db.rpc("preview_company_import", {
        org,
        rows: rows as unknown as Json,
      });
      if (error) databaseError(error);
      return Response.json(data);
    }
    const { data, error } = await db.rpc("confirm_company_import", {
      org,
      preview_id: input.id,
      selected_rows: [...new Set(input.rows)],
    });
    if (error) {
      if (error.code === "40001")
        throw new AppError(
          409,
          "preview_changed",
          "重複候補が変更されました。CSVをもう一度プレビューしてください",
        );
      if (error.code === "P0002")
        throw new AppError(
          410,
          "preview_expired",
          "プレビューの有効期限が切れました。再度プレビューしてください",
        );
      databaseError(error);
    }
    return Response.json({ ids: data });
  });
}
