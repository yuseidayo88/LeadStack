import { AppError } from "@/lib/errors";
import { matchesCreatedRecord } from "@/lib/crm/create-retry";
import { requireOrganization } from "@/lib/auth";
import { handle, readJson } from "@/lib/http";
import {
  resourceSchema,
  listSchema,
  parseRecord,
  uuid,
} from "@/lib/crm/schemas";
import { listRecords, createRecord, getRecord } from "@/lib/crm/repository";
type Context = { params: Promise<{ org: string; resource: string }> };
export async function GET(request: Request, context: Context) {
  return handle(async () => {
    const { org, resource } = await context.params;
    const table = resourceSchema.parse(resource);
    const { db } = await requireOrganization(org);
    return Response.json(
      await listRecords(
        db,
        org,
        table,
        listSchema.parse(Object.fromEntries(new URL(request.url).searchParams)),
      ),
    );
  });
}
export async function POST(request: Request, context: Context) {
  return handle(async () => {
    const { org, resource } = await context.params;
    const input = await readJson(request);
    const table = resourceSchema.parse(resource);
    const { db } = await requireOrganization(org, true);
    const key = request.headers.get("Idempotency-Key");
    const creationId = key ? uuid.parse(key) : undefined;
    const parsed = parseRecord(table, input);
    try {
      return Response.json(
        { data: await createRecord(db, org, table, parsed, creationId) },
        { status: 201 },
      );
    } catch (error) {
      if (
        !creationId ||
        !(error instanceof AppError) ||
        error.code !== "duplicate"
      )
        throw error;
      const existing = await getRecord(db, org, table, creationId).catch(
        () => null,
      );
      if (!existing || !matchesCreatedRecord(parsed, existing))
        throw new AppError(
          409,
          "request_conflict",
          "同じ操作は保存済みか、内容が変更されています。一覧を更新して確認してください",
        );
      return Response.json({ data: existing });
    }
  });
}
