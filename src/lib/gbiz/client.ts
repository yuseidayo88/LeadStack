import "server-only";

// Contract: https://api.info.gbiz.go.jp/hojin/v3/api-docs/v2
const API_URL = "https://api.info.gbiz.go.jp/hojin/v2/hojin";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CORPORATE_NUMBER = /^\d{13}$/;

const errorMessages = {
  not_configured: "GビズインフォのAPIトークンが設定されていません。",
  invalid_parameters: "Gビズインフォの検索条件を確認してください。",
  unauthorized: "GビズインフォのAPI認証に失敗しました。",
  rate_limited:
    "Gビズインフォの利用上限に達しました。時間をおいて再実行してください。",
  upstream_error: "Gビズインフォから情報を取得できませんでした。",
  invalid_response: "Gビズインフォの応答を確認できませんでした。",
  response_too_large: "Gビズインフォの応答が取得上限を超えました。",
  timeout: "Gビズインフォへの接続がタイムアウトしました。",
  network_error: "Gビズインフォに接続できませんでした。",
  redirect_refused: "Gビズインフォからの転送を拒否しました。",
} as const;

export class GbizError extends Error {
  readonly code: keyof typeof errorMessages;
  readonly status?: number;

  constructor(code: keyof typeof errorMessages, status?: number) {
    super(errorMessages[code]);
    this.name = "GbizError";
    this.code = code;
    this.status = status;
  }
}

const metadataFields = [
  "corporate_number",
  "name",
  "location",
  "postal_code",
  "status",
  "update_date",
  "industry",
  "company_url",
  "employee_number",
] as const;
type FieldMetadata = Partial<Record<(typeof metadataFields)[number], string>>;

export interface GbizCompany {
  corporateNumber: string;
  name: string | null;
  location: string | null;
  postalCode: string | null;
  status: string | null;
  updatedAt: string | null;
  industry: string[] | null;
  companyUrl: string | null;
  employeeNumber: number | null;
  // The API has no phone field. A missing employee count is never converted to 0.
  provenance: {
    source: "gBizINFO";
    requestUrl: string;
    retrievedAt: string;
    metadata: {
      source: FieldMetadata;
      lastAcquisitionDate: FieldMetadata;
      lastUpdateDate: FieldMetadata;
      dataQuality: FieldMetadata;
      importFrequency: FieldMetadata;
    } | null;
  };
}

export interface GbizSearchParams {
  prefecture?: string;
  name?: string;
  corporateNumber?: string;
  page?: number;
  limit?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadata(value: unknown): FieldMetadata {
  const fields = record(value);
  const result: FieldMetadata = {};
  for (const key of metadataFields) {
    const entry = text(fields?.[key]);
    if (entry !== null) result[key] = entry;
  }
  return result;
}

function companyUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function normalizeCompany(
  value: unknown,
  requestUrl: string,
  retrievedAt: string,
): GbizCompany {
  const data = record(value);
  const corporateNumber = text(data?.corporate_number);
  if (!data || !corporateNumber || !CORPORATE_NUMBER.test(corporateNumber))
    throw new GbizError("invalid_response");
  const meta = record(data["meta-data"]);
  const industry = Array.isArray(data.industry)
    ? data.industry.map(text).filter((item): item is string => item !== null)
    : [];
  return {
    corporateNumber,
    name: text(data.name),
    location: text(data.location),
    postalCode: text(data.postal_code),
    status: text(data.status),
    updatedAt: text(data.update_date),
    industry: industry.length ? industry : null,
    companyUrl: companyUrl(data.company_url),
    employeeNumber:
      typeof data.employee_number === "number" &&
      Number.isSafeInteger(data.employee_number) &&
      data.employee_number >= 0
        ? data.employee_number
        : null,
    provenance: {
      source: "gBizINFO",
      requestUrl,
      retrievedAt,
      metadata: meta
        ? {
            source: metadata(meta.source),
            lastAcquisitionDate: metadata(meta.last_acquisition_date),
            lastUpdateDate: metadata(meta.last_update_date),
            dataQuality: metadata(meta.data_quality),
            importFrequency: metadata(meta.import_frequency),
          }
        : null,
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new GbizError("response_too_large");
  }
  if (!response.body) throw new GbizError("invalid_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GbizError("response_too_large");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof GbizError) throw error;
    if (error instanceof SyntaxError) throw new GbizError("invalid_response");
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function request(
  url: URL,
  maxRecords: number,
  allowNotFound = false,
): Promise<GbizCompany[]> {
  const token = process.env.GBIZ_API_TOKEN?.trim();
  if (!token) throw new GbizError("not_configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-hojinInfo-api-token": token },
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    )
      throw new GbizError("redirect_refused", response.status);
    if (response.status === 404 && allowNotFound) return [];
    if (!response.ok) {
      const code =
        response.status === 401 || response.status === 403
          ? "unauthorized"
          : response.status === 429
            ? "rate_limited"
            : "upstream_error";
      throw new GbizError(code, response.status);
    }
    const data = record(await readJson(response));
    if (!data || (data.errors != null && !Array.isArray(data.errors)))
      throw new GbizError("invalid_response");
    if (Array.isArray(data.errors) && data.errors.length)
      throw new GbizError("upstream_error", response.status);
    const companies = data["hojin-infos"];
    if (!Array.isArray(companies) || companies.length > maxRecords)
      throw new GbizError("invalid_response");
    const retrievedAt = new Date().toISOString();
    return companies.map((company) =>
      normalizeCompany(company, url.toString(), retrievedAt),
    );
  } catch (error) {
    if (controller.signal.aborted) throw new GbizError("timeout");
    if (error instanceof GbizError) throw error;
    // Do not forward fetch exceptions, headers, upstream messages or response bodies.
    throw new GbizError("network_error");
  } finally {
    clearTimeout(timer);
    // Release unread bodies after HTTP failures/redirects without exposing errors.
    await response?.body?.cancel().catch(() => {});
  }
}

export async function searchGbizCompanies(params: GbizSearchParams): Promise<{
  companies: GbizCompany[];
  page: number;
  limit: number;
}> {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const name = text(params.name);
  const corporateNumber = text(params.corporateNumber);
  const prefecture = text(params.prefecture);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 10 ||
    !Number.isInteger(limit) ||
    limit < 20 ||
    limit > 50 ||
    (params.name !== undefined && (!name || name.length > 200)) ||
    (params.corporateNumber !== undefined &&
      (!corporateNumber || !CORPORATE_NUMBER.test(corporateNumber))) ||
    (params.prefecture !== undefined &&
      (!prefecture || !/^(0[1-9]|[1-3]\d|4[0-7])$/.test(prefecture))) ||
    (!name && !corporateNumber && !prefecture)
  )
    throw new GbizError("invalid_parameters");
  const url = new URL(API_URL);
  if (name) url.searchParams.set("name", name);
  if (corporateNumber)
    url.searchParams.set("corporate_number", corporateNumber);
  if (prefecture) url.searchParams.set("prefecture", prefecture);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("metadata_flg", "true");
  // No industry parameter or reliable total-count field exists in this API.
  return { companies: await request(url, limit), page, limit };
}

export async function getGbizCompany(
  corporateNumber: string,
): Promise<GbizCompany | null> {
  if (
    typeof corporateNumber !== "string" ||
    !CORPORATE_NUMBER.test(corporateNumber)
  )
    throw new GbizError("invalid_parameters");
  const url = new URL(`${API_URL}/${corporateNumber}`);
  url.searchParams.set("metadata_flg", "true");
  const companies = await request(url, 1, true);
  const company = companies[0] ?? null;
  if (company && company.corporateNumber !== corporateNumber)
    throw new GbizError("invalid_response");
  return company;
}
