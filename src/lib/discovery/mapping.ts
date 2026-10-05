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
  } as const;
  const present = {
    name: company.name !== null,
    location: company.location !== null,
    industry: company.industry !== null,
    website_url: company.companyUrl !== null,
    employee_number:
      company.employeeNumber !== null && company.employeeNumber <= 2147483647,
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
    provenance: {
      ...oldProvenance,
      gbiz: company.provenance as unknown as Json,
      rawIndustry: company.industry ?? oldProvenance.rawIndustry ?? null,
      fieldSources,
    } as Json,
  };
}

export function discoverySearch(term: string) {
  const contains = (v: string) => {
    const pattern = `%${v.replace(/[\\%_]/g, "\\$&")}%`;
    return `"${pattern.replace(/[\\"]/g, "\\$&")}"`;
  };
  const normalized = term.normalize("NFKC");
  return [
    `name.ilike.${contains(term)}`,
    `corporate_number.ilike.${contains(normalized)}`,
  ].join(",");
}
