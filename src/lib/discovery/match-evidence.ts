import type { Candidate, ScanCriteria } from "./contracts";

type Fields = Pick<Candidate, "industry_codes" | "employee_number">;
type Criteria = Pick<ScanCriteria, "industry" | "employeeMin" | "employeeMax">;

export function missingMatchFields(row: Fields, criteria: Criteria) {
  const missing: ("employees" | "industry")[] = [];
  if (
    (criteria.employeeMin !== undefined ||
      criteria.employeeMax !== undefined) &&
    row.employee_number === null
  )
    missing.push("employees");
  if (
    criteria.industry &&
    criteria.industry !== "unknown" &&
    !row.industry_codes.length
  )
    missing.push("industry");
  return missing;
}

// A literal code/word match is evidence of the filter, never an inferred
// business classification, buying intent or verified need for automation.
export function discoveryMatchEvidence(
  row: Fields & Pick<Candidate, "name" | "business_summary">,
  criteria: Criteria & { businessKeywords: string[] },
): NonNullable<Candidate["match_evidence"]> {
  const text = `${row.name} ${row.business_summary ?? ""}`.toLocaleLowerCase(
    "ja",
  );
  return {
    industryCode:
      criteria.industry && row.industry_codes.includes(criteria.industry)
        ? criteria.industry
        : null,
    keywords: criteria.businessKeywords.filter((term) =>
      text.includes(term.toLocaleLowerCase("ja")),
    ),
    missing: missingMatchFields(row, criteria),
  };
}
