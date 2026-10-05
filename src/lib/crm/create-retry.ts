// A replay may only acknowledge the original values; it must never overwrite later edits.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === "object")
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  if (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
    return new Date(value).toISOString();
  return JSON.stringify(value) ?? "undefined";
}
export function matchesCreatedRecord(input: object, record: object) {
  return Object.entries(input).every(
    ([key, value]) =>
      canonical(value) === canonical((record as Record<string, unknown>)[key]),
  );
}
