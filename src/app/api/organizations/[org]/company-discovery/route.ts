import { requireOrganization } from "@/lib/auth";
import { AppError, databaseError } from "@/lib/errors";
import { handle, readJson } from "@/lib/http";
import { discoveryInput, discoveryQuery } from "@/lib/discovery/schemas";
import {
  acquireCandidates,
  enrichCandidate,
  researchCandidatePhone,
  confirmCandidatePhone,
  listCandidates,
  updateCandidate,
} from "@/lib/discovery/service";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ org: string }> };

export async function GET(request: Request, context: Context) {
  return handle(async () => {
    const started = performance.now();
    const { org } = await context.params;
    const { db } = await requireOrganization(org);
    const authorized = performance.now();
    const input = discoveryQuery.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const result = await listCandidates(db, org, input);
    const finished = performance.now();
    return Response.json(result, {
      headers: {
        "Server-Timing": `auth;dur=${(authorized - started).toFixed(1)}, list;dur=${(finished - authorized).toFixed(1)}, total;dur=${(finished - started).toFixed(1)}`,
      },
    });
  });
}

export async function POST(request: Request, context: Context) {
  return handle(async () => {
    const input = discoveryInput.parse(await readJson(request));
    const { org } = await context.params;
    const { db, user } = await requireOrganization(org, true);
    if (input.action === "scan")
      throw new AppError(
        409,
        "scan_endpoint_changed",
        "企業検索画面を再読み込みしてから検索してください。",
      );
    if (input.action === "acquire")
      return Response.json(await acquireCandidates(db, org, input));
    if (input.action === "enrich")
      return Response.json(await enrichCandidate(db, org, input.id));
    if (input.action === "research_phone")
      return Response.json(await researchCandidatePhone(db, org, input.id));
    if (input.action === "confirm_phone")
      return Response.json(
        await confirmCandidatePhone(db, org, user.id, input),
      );
    if (input.action === "update")
      return Response.json(await updateCandidate(db, org, user.id, input));
    if (input.action === "remove") {
      const removed = await db
        .from("company_candidates")
        .delete()
        .eq("organization_id", org)
        .in("id", input.ids)
        .select("id");
      if (removed.error) databaseError(removed.error);
      return Response.json({ removed: removed.data?.length ?? 0 });
    }
    const result =
      input.action === "preview"
        ? await db.rpc("preview_company_candidates", {
            org,
            candidate_ids: input.ids,
          })
        : await db.rpc("import_company_candidates", {
            org,
            candidate_ids: input.ids,
            confirmed_duplicates: input.confirmedDuplicates,
            review_token: input.reviewToken,
          });
    if (result.error) {
      if (result.error.code === "40001")
        throw new AppError(
          409,
          "preview_changed",
          "候補または重複状況が変わりました。取込内容を再確認してください。",
        );
      if (result.error.code === "P0002")
        throw new AppError(
          404,
          "candidate_not_found",
          "選択した候補が見つかりません。一覧を更新してください。",
        );
      databaseError(result.error);
    }
    return Response.json(result.data);
  });
}
