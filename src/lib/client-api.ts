"use client";
import useSWR from "swr";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string[]> = {},
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (response.status === 204) return undefined as T;
  let result;
  try {
    result = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "invalid_response",
      "応答を取得できませんでした。再試行してください。",
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      result.error?.code || "request_failed",
      result.error?.message || "処理に失敗しました",
      result.error?.fields,
    );
  return result as T;
}
export function useApi<T>(path: string | null) {
  return useSWR<T, ApiError>(path, (url: string) => api<T>(url), {
    keepPreviousData: false,
    shouldRetryOnError: (err) => err.status >= 500,
    errorRetryCount: 2,
  });
}
export type Paginated<T> = {
  data: T[];
  count: number;
  page: number;
  pageSize: number;
};
export function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "処理に失敗しました。もう一度お試しください。";
}
