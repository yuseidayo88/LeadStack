import { GbizError, getGbizCompany } from "../src/lib/gbiz/client.ts";

// METI's published corporate number: one read, no CRM/database writes.
const CORPORATE_NUMBER = "4000012090001";

try {
  const company = await getGbizCompany(CORPORATE_NUMBER);
  if (!company) {
    console.log(JSON.stringify({ ok: false, code: "company_not_found" }));
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify({
        ok: true,
        corporateNumber: company.corporateNumber,
        hasName: Boolean(company.name),
        hasLocation: Boolean(company.location),
        hasWebsite: Boolean(company.companyUrl),
        hasEmployeeNumber: company.employeeNumber !== null,
        industryCount: company.industry?.length ?? 0,
      }),
    );
  }
} catch (error) {
  // Do not log upstream bodies, thrown fetch messages, headers, or environment.
  console.log(
    JSON.stringify({
      ok: false,
      code: error instanceof GbizError ? error.code : "unexpected_error",
      ...(error instanceof GbizError && error.status
        ? { status: error.status }
        : {}),
    }),
  );
  process.exitCode = 1;
}
