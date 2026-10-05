import { ExternalLink } from "lucide-react";
import { phoneHref } from "@/lib/crm/search";

export function UnknownValue() {
  return <span className="text-xs text-muted-foreground">未確認</span>;
}

export function safeWebsite(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export function WebsiteLink({ value }: { value: string | null | undefined }) {
  const url = safeWebsite(value);
  if (!url) return <UnknownValue />;
  return (
    <a
      href={url.href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-52 items-center gap-1 text-primary hover:underline"
      aria-label={`Webサイトを別タブで開く：${url.hostname}`}
      title={url.href}
    >
      <span className="truncate">{url.hostname.replace(/^www\./, "")}</span>
      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
    </a>
  );
}

export function PhoneLink({ value }: { value: string | null | undefined }) {
  const href = phoneHref(value);
  if (!value) return <UnknownValue />;
  return href ? (
    <a
      className="whitespace-nowrap font-mono hover:text-primary hover:underline"
      href={href}
    >
      {value}
    </a>
  ) : (
    <span>{value}</span>
  );
}

export function employeeLabel(value: number | null | undefined) {
  return value == null ? "未確認" : `${value.toLocaleString("ja-JP")} 名`;
}

export function fetchedLabel(value: string | null | undefined) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "未取得";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
