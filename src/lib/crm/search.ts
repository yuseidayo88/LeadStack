// Keep SQL LIKE escaping separate from PostgREST's quoted filter-value grammar.
function contains(value: string) {
  const pattern = `%${value.replace(/[\\%_]/g, "\\$&")}%`;
  return `"${pattern.replace(/[\\"]/g, "\\$&")}"`;
}
export function directorySearch(
  resource: "companies" | "contacts",
  term: string,
) {
  const filters = [`name.ilike.${contains(term)}`];
  if (resource === "contacts") filters.push(`email.ilike.${contains(term)}`);
  // Only numeric-looking queries participate in phone/registration lookup.
  // Do not turn a company name such as "第2営業所" into a broad search for "2".
  const normalized = term.normalize("NFKC");
  if (/^[+\d\s()\-‐‑‒–—―ー−]+$/.test(normalized)) {
    const digits = normalized.replace(/\D/g, "");
    if (digits) {
      filters.push(`search_phone.ilike.${contains(digits)}`);
      if (resource === "companies")
        filters.push(`corporate_number.ilike.${contains(digits)}`);
    }
  }
  return filters.join(",");
}
export function phoneHref(phone: string | null | undefined) {
  const number = (phone || "").normalize("NFKC").replace(/[^+\d]/g, "");
  return /\d/.test(number) ? `tel:${number}` : undefined;
}
