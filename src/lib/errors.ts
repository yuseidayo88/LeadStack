import { ZodError } from "zod";
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function databaseError(error: {
  code?: string;
  message: string;
}): never {
  switch (error.code) {
    case "42501":
      throw new AppError(403, "forbidden", "この操作を行う権限がありません");
    case "23505":
      throw new AppError(409, "duplicate", "同じ情報が既に登録されています");
    case "23503":
      throw new AppError(
        422,
        "invalid_reference",
        "関連する企業・担当者・組織メンバーを確認してください",
      );
    case "23514":
    case "23502":
    case "22023":
    case "22P02":
      throw new AppError(
        422,
        "invalid_data",
        "入力内容または組織の権限設定を確認してください",
      );
    default:
      throw new AppError(
        500,
        "database_error",
        "保存・取得に失敗しました。時間を置いて再試行してください",
      );
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof ZodError)
    return Response.json(
      {
        error: {
          code: "validation",
          message: "入力内容を確認してください",
          fields: error.flatten().fieldErrors,
        },
      },
      { status: 422 },
    );
  if (error instanceof AppError)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  if (error instanceof SyntaxError)
    return Response.json(
      {
        error: {
          code: "invalid_json",
          message: "JSON の形式を確認してください",
        },
      },
      { status: 400 },
    );
  // Never return database internals, tokens, request bodies or stack traces.
  console.error(
    "LeadStack request failed:",
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    {
      error: {
        code: "internal",
        message: "処理に失敗しました。再試行してください",
      },
    },
    { status: 500 },
  );
}
