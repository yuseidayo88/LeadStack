import type { GbizCompany } from "@/lib/gbiz/client";
import type { CompanyCandidateRow, Json } from "@/lib/database.types";
import { prefectures } from "@/lib/crm/display";
import { normalizeIndustries } from "./industries";

export function object(value: Json | undefined): {
  [key: string]: Json | undefined;
} {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

const MAX_PROVENANCE_BYTES = 16_000;

// JSONB's text representation uses a space after every comma and colon.
// Count UTF-8 bytes, including numeric exponents expanded by PostgreSQL.
export function candidateProvenanceBytes(value: Json): number {
  if (Array.isArray(value))
    return (
      2 +
      value.reduce<number>(
        (sum, item) => sum + candidateProvenanceBytes(item),
        0,
      ) +
      Math.max(0, value.length - 1) * 2
    );
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(
      ([, item]) => item !== undefined,
    );
    return (
      2 +
      entries.reduce(
        (sum, [key, item]) =>
          sum +
          Buffer.byteLength(JSON.stringify(key)) +
          2 +
          candidateProvenanceBytes(item!),
        0,
      ) +
      Math.max(0, entries.length - 1) * 2
    );
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const [coefficient, exponent] = String(value).split("e");
    if (exponent !== undefined) {
      const unsigned = coefficient.replace("-", "");
      const digits = unsigned.replace(".", "").length;
      const point =
        (unsigned.includes(".") ? unsigned.indexOf(".") : unsigned.length) +
        Number(exponent);
      return (
        (value < 0 ? 1 : 0) +
        (point <= 0 ? 2 - point + digits : point >= digits ? point : digits + 1)
      );
    }
  }
  return Buffer.byteLength(JSON.stringify(value));
}

export class CandidateProvenanceTooLargeError extends Error {
  constructor() {
    super("Candidate provenance exceeds the storage limit");
  }
}

// Only the newly supplied summary may be shortened. Retained evidence from a
// previous acquisition must not be silently altered to fit newer metadata.
export function boundedCandidateProvenance(
  value: { [key: string]: Json | undefined },
  summary: string | null,
  sourceWasTruncated: boolean,
) {
  const fit = (provenance: typeof value): Json | null => {
    if (!summary)
      return candidateProvenanceBytes(provenance) <= MAX_PROVENANCE_BYTES
        ? provenance
        : null;
    const originalCharacters = Array.from(summary);
    const characters = originalCharacters.slice(0, 10_000);
    const full = {
      ...provenance,
      businessSummary: characters.join(""),
      businessSummaryTruncated:
        sourceWasTruncated || originalCharacters.length > characters.length,
    };
    if (candidateProvenanceBytes(full) <= MAX_PROVENANCE_BYTES) return full;
    const shortened = {
      ...provenance,
      businessSummary: "",
      businessSummaryTruncated: true,
    };
    if (candidateProvenanceBytes(shortened) >= MAX_PROVENANCE_BYTES)
      return null;
    let low = 0,
      high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      shortened.businessSummary = characters.slice(0, middle).join("");
      if (candidateProvenanceBytes(shortened) <= MAX_PROVENANCE_BYTES)
        low = middle;
      else high = middle - 1;
    }
    if (low === 0) return null;
    shortened.businessSummary = characters.slice(0, low).join("");
    return shortened;
  };
  const fitted = fit(value);
  if (fitted) return fitted;
  // The raw metadata is redundant with fieldSources. Omit only this newly
  // fetched duplicate; keep current per-field evidence with its actual value.
  const compact = fit({
    ...value,
    gbiz: { ...object(value.gbiz), metadata: null },
    gbizMetadataOmitted: true,
  });
  if (compact) return compact;
  // A pathological non-summary payload is skipped by the batch caller, leaving
  // any prior record and its matching sources intact.
  throw new CandidateProvenanceTooLargeError();
}

export function candidateFromGbiz(
  company: GbizCompany,
  previous?: CompanyCandidateRow,
) {
  const oldProvenance = object(previous?.provenance);
  const overrides = Array.isArray(oldProvenance.manualOverrides)
    ? oldProvenance.manualOverrides
    : [];
  const region = prefectures.findIndex((p) => company.location?.startsWith(p));
  const industry = normalizeIndustries(company.industry);
  const website = overrides.includes("website_url")
    ? (previous?.website_url ?? null)
    : (company.companyUrl ?? previous?.website_url ?? null);
  const fieldSources = { ...object(oldProvenance.fieldSources) };
  const providerFields = {
    name: "name",
    location: "location",
    industry: "industry",
    website_url: "company_url",
    employee_number: "employee_number",
    business_summary: "business_summary",
  } as const;
  const present = {
    name: company.name !== null,
    location: company.location !== null,
    industry: company.industry !== null,
    website_url: company.companyUrl !== null,
    employee_number:
      company.employeeNumber !== null && company.employeeNumber <= 2147483647,
    business_summary: Boolean(company.businessSummary?.trim()),
  };
  for (const field of Object.keys(
    providerFields,
  ) as (keyof typeof providerFields)[]) {
    if (present[field] && !overrides.includes(field)) {
      const key = providerFields[field];
      fieldSources[field] = {
        source: company.provenance.metadata?.source[key] ?? "Gビズインフォ",
        retrievedAt: company.provenance.retrievedAt,
        sourceUpdatedAt:
          company.provenance.metadata?.lastUpdateDate[key] ?? company.updatedAt,
        sourceUrl: `https://info.gbiz.go.jp/hojin/ichiran?hojinBango=${company.corporateNumber}`,
      };
    }
  }
  // A failed/missing upstream detail must not erase a previously known attribute.
  return {
    corporate_number: company.corporateNumber,
    name: company.name || previous?.name || "名称未確認",
    location: company.location ?? previous?.location ?? null,
    prefecture:
      region < 0 ? (previous?.prefecture ?? null) : prefectures[region],
    prefecture_code:
      region < 0
        ? (previous?.prefecture_code ?? null)
        : String(region + 1).padStart(2, "0"),
    industry_codes: company.industry
      ? industry.codes
      : (previous?.industry_codes ?? []),
    industry_labels: company.industry
      ? industry.labels
      : (previous?.industry_labels ?? []),
    website_url: website,
    ...(previous && previous.website_url !== website
      ? {
          enrichment_result: null,
          enrichment_status: null,
          enrichment_checked_at: null,
          enrichment_error: null,
        }
      : {}),
    employee_number: overrides.includes("employee_number")
      ? (previous?.employee_number ?? null)
      : company.employeeNumber !== null && company.employeeNumber <= 2147483647
        ? company.employeeNumber
        : (previous?.employee_number ?? null),
    source_updated_at: company.updatedAt ?? previous?.source_updated_at ?? null,
    fetched_at: company.provenance.retrievedAt,
    provenance: boundedCandidateProvenance(
      {
        ...oldProvenance,
        gbiz: company.provenance as unknown as Json,
        rawIndustry: company.industry ?? oldProvenance.rawIndustry ?? null,
        fieldSources,
      },
      company.businessSummary?.trim() || null,
      company.businessSummaryTruncated === true,
    ),
  };
}

function contains(column: string, value: string) {
  // PostgREST rewrites every '*' in LIKE patterns to '%', even an escaped
  // asterisk. Use a literal, unanchored regex for that case only; users never
  // supply regex syntax. Quote separately for the PostgREST filter grammar.
  const usesAsterisk = value.includes("*");
  const pattern = usesAsterisk
    ? value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : `%${value.replace(/[\\%_]/g, "\\$&")}%`;
  return `${column}.${usesAsterisk ? "imatch" : "ilike"}."${pattern.replace(/[\\"]/g, "\\$&")}"`;
}

export function discoveryBusinessSearch(terms: string[]) {
  return terms
    .flatMap((term) => [
      contains("name", term),
      contains("provenance->>businessSummary", term),
    ])
    .join(",");
}

export function discoverySearch(term: string) {
  const normalized = term.normalize("NFKC");
  return [
    contains("name", term),
    contains("corporate_number", normalized),
  ].join(",");
}
