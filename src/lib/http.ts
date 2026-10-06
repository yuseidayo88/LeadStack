import { AppError, errorResponse } from "@/lib/errors";
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const allowed = new URL(process.env.NEXT_PUBLIC_SITE_URL || request.url)
    .origin;
  if (origin && origin !== allowed)
    throw new AppError(403, "origin", "送信元を確認できません");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError(403, "origin", "送信元を確認できません");
}
export async function readJson(request: Request, maxBytes = 128 * 1024) {
  sameOrigin(request);
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new AppError(415, "content_type", "JSON 形式で送信してください");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "empty_body", "入力内容がありません");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError(413, "too_large", "入力内容が大きすぎます");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}
export async function handle(action: () => Promise<Response>) {
  try {
    const response = await action();
    const noTransform = response.headers
      .get("Cache-Control")
      ?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-transform");
    // Streaming routes may prohibit intermediary buffering/transformation while
    // retaining the same private, non-cacheable policy as other API responses.
    response.headers.set(
      "Cache-Control",
      `private, no-store${noTransform ? ", no-transform" : ""}`,
    );
    return response;
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
