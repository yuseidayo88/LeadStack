import type { Json } from "@/lib/database.types";

export type EnrichmentProposal = {
  status: "found" | "not_found" | "blocked" | "failed";
  phone: string | null;
  employeeNumber: number | null;
  sourceUrl: string | null;
  evidence: string | null;
  message: string | null;
  checkedAt: string;
};

export type Candidate = {
  list_summary?: true;
  matched_business_keywords?: string[];
  id: string;
  organization_id: string;
  corporate_number: string;
  name: string;
  prefecture_code: string | null;
  prefecture: string | null;
  location: string | null;
  industry_codes: string[];
  industry_labels: string[];
  phone: string | null;
  website_url: string | null;
  employee_number: number | null;
  business_summary?: string | null;
  business_summary_truncated?: boolean;
  source_updated_at: string | null;
  fetched_at: string;
  updated_at: string;
  created_at: string;
  provenance: Json;
  company_id: string | null;
  crm_company_name?: string | null;
  crm_company_phone?: string | null;
  enrichment_status: "pending" | "complete" | "unavailable" | "failed" | null;
  enrichment_error: string | null;
  enrichment_checked_at: string | null;
  enrichment_result: EnrichmentProposal | null;
};

export type DiscoveryListResponse = {
  data: Candidate[];
  count: number;
  page: number;
  pageSize: number;
  configured: boolean;
  totalCached: number;
  lastFetchedAt: string | null;
  industryOptions: { value: string; label: string }[];
};

export type AcquireResponse = {
  fetched: number;
  detailsFailed: number;
  page: number;
  nextPage: number | null;
  message: string;
};

export type PhoneResearchResponse = {
  candidate: Candidate;
  outcome:
    "checked" | "cached" | "existing_phone" | "missing_website" | "pending";
};

export type ScanCriteria = {
  prefecture?: string;
  name?: string;
  corporateNumber?: string;
  industry?: string;
  employeeMin?: number;
  employeeMax?: number;
  includeUnknownEmployees?: boolean;
  includeUnknownIndustry?: boolean;
  businessKeywords?: string;
  hasPhone?: boolean;
  hasWebsite?: boolean;
  hasEmployees?: boolean;
};

export type ScanEvent = {
  type: "progress" | "complete" | "paused" | "error";
  scanned: number;
  matched: number;
  target: number;
  saved: number;
  detailsFailed: number;
  unknownEmployees: number;
  unknownIndustry: number;
  matchedIds: string[];
  resumeToken: string | null;
  nextAllowedAt: string;
  reason?:
    | "target"
    | "scan_limit"
    | "exhausted"
    | "time_limit"
    | "chunk_limit"
    | "upstream_error"
    | "cancelled";
  message?: string;
};

export type ImportPreview = {
  review_token: string;
  items: {
    candidate_id: string;
    name: string;
    company_id: string | null;
    duplicates: { id: string; name: string; reason: string }[];
    selected_duplicates: {
      candidate_id: string;
      name: string;
      reason: string;
    }[];
  }[];
};

export type ImportResult = {
  items: { candidate_id: string; company_id: string; created: boolean }[];
  created_count: number;
  existing_count: number;
};
