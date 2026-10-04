export function safeNext(value: string | null) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  )
    return "/dashboard";
  const parsed = new URL(value, "https://leadstack.invalid");
  return parsed.origin === "https://leadstack.invalid"
    ? parsed.pathname + parsed.search
    : "/dashboard";
}
