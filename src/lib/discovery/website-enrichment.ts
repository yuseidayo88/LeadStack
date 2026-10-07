import "server-only";

import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

export interface WebsiteEnrichment {
  status: "found" | "not_found" | "blocked" | "failed";
  phone: string | null;
  employeeNumber: number | null;
  sourceUrl: string | null;
  evidence: string | null;
  message: string | null;
  checkedAt: string;
}

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8_000;
const BOT = "LeadStackBot";
const USER_AGENT = `${BOT}/1.0 (user-requested company contact verification)`;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

class EnrichmentError extends Error {
  constructor(
    readonly outcome: "blocked" | "failed",
    message: string,
  ) {
    super(message);
  }
}

function blocked(
  message = "安全にアクセスできる公式サイトURLを確認できませんでした。",
): never {
  throw new EnrichmentError("blocked", message);
}

// Deliberately conservative public-unicast allowlist. Reject special-purpose,
// documentation, multicast, mapped, transition and future address ranges.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || address.includes(".")) return false;
  const [first, second = "0"] = address.toLowerCase().split(":");
  const a = parseInt(first || "0", 16);
  const b = parseInt(second || "0", 16);
  return (
    a >= 0x2000 &&
    a <= 0x3fff &&
    !(a === 0x2001 && (b <= 0x01ff || b === 0x0db8)) &&
    a !== 0x2002 &&
    !(a === 0x3fff && b <= 0x0fff)
  );
}

function safeUrl(input: string, base?: URL): URL {
  let url: URL;
  try {
    if (input.length > 2048 || /[\u0000-\u001f\u007f]/.test(input)) blocked();
    url = new URL(input, base);
  } catch {
    blocked();
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port)) ||
    !host ||
    host.endsWith(".") ||
    /(^|\.)(localhost|local|internal|home|lan)$/i.test(host) ||
    (!isIP(host) && !host.includes(".")) ||
    (isIP(host) && !publicAddress(host))
  )
    blocked();
  // Token-bearing links are not public company pages. Never echo query values.
  for (const key of url.searchParams.keys()) {
    if (
      /token|secret|password|credential|api.?key|signature|authorization/i.test(
        key,
      )
    )
      blocked();
  }
  url.hash = "";
  return url;
}

function aborted(): EnrichmentError {
  return new EnrichmentError(
    "failed",
    "公式サイトの確認がタイムアウトしました。",
  );
}

async function pinnedLookup(
  url: URL,
  signal: AbortSignal,
): Promise<LookupFunction> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  let addresses: { address: string; family: number }[];
  if (family) {
    addresses = [{ address: host, family }];
  } else {
    addresses = await new Promise((resolve, reject) => {
      const onAbort = () => reject(aborted());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else
        lookup(host, { all: true, verbatim: true })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
    });
  }
  if (
    !addresses.length ||
    addresses.length > 256 ||
    addresses.some(
      (item) =>
        item.family !== isIP(item.address) || !publicAddress(item.address),
    )
  )
    blocked();
  const pinned = addresses[0];
  // The native client never performs a second DNS lookup. agent:false prevents
  // pooled connections or proxy agents from changing the validated destination.
  return (_host, options, callback) => {
    if (options.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
}

interface Page {
  url: URL;
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function requestPage(url: URL, signal: AbortSignal): Promise<Page> {
  const resolve = await pinnedLookup(url, signal);
  if (signal.aborted) throw aborted();
  return new Promise((fulfill, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false,
        lookup: resolve,
        signal,
        maxHeaderSize: 16 * 1024,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          "Accept-Encoding": "identity",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const page = { url, status, headers: response.headers, body: "" };
        // Do not read denial or redirect bodies (which may contain reflected data).
        if (status < 200 || status >= 300) {
          response.destroy();
          fulfill(page);
          return;
        }
        if (
          Number(response.headers["content-length"]) > MAX_BYTES ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          response.destroy();
          reject(
            new EnrichmentError(
              "blocked",
              "公式サイトの応答が取得上限または対応形式を超えました。",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy();
            reject(
              new EnrichmentError(
                "blocked",
                "公式サイトの応答が取得上限を超えました。",
              ),
            );
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("aborted", () =>
          reject(
            new EnrichmentError("failed", "公式サイトの応答が中断されました。"),
          ),
        );
        response.on("end", () => {
          const charset =
            /charset\s*=\s*["']?([\w-]+)/i.exec(
              response.headers["content-type"] ?? "",
            )?.[1] ?? "utf-8";
          if (
            !/^(?:utf-?8|shift[_-]?jis|sjis|windows-31j|euc-jp|iso-2022-jp|us-ascii)$/i.test(
              charset,
            )
          ) {
            reject(
              new EnrichmentError(
                "blocked",
                "公式サイトの文字形式に対応していません。",
              ),
            );
            return;
          }
          try {
            page.body = new TextDecoder(charset, { fatal: true }).decode(
              Buffer.concat(chunks),
            );
            fulfill(page);
          } catch {
            reject(
              new EnrichmentError(
                "blocked",
                "公式サイトの文字情報を確認できませんでした。",
              ),
            );
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

interface RobotsRule {
  allow: boolean;
  path: string;
}
interface RobotsPolicy {
  rules: RobotsRule[];
  delayed: boolean;
}

function robotsPolicy(body: string): RobotsPolicy {
  const groups: {
    agents: string[];
    rules: RobotsRule[];
    delayed: boolean;
    started: boolean;
  }[] = [];
  let group: (typeof groups)[number] | undefined;
  if (/<(?:!doctype|html|form|script)\b/i.test(body))
    blocked("robots.txt の公開範囲を確認できませんでした。");
  for (const raw of body.replace(/^\uFEFF/, "").split(/\r?\n|\r/)) {
    const line = raw.split("#", 1)[0].trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!group || group.started) {
        group = { agents: [], rules: [], delayed: false, started: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (
      group &&
      ["allow", "disallow", "crawl-delay", "request-rate"].includes(key)
    ) {
      group.started = true;
      if (key === "crawl-delay" || key === "request-rate") {
        // Avoid ignoring crawl timing or creating a long-running crawler.
        if (key === "request-rate" || !/^0(?:\.0+)?$/.test(value))
          group.delayed = true;
      } else if (value) {
        if (
          value.length > 2048 ||
          (!value.startsWith("/") && !value.startsWith("*"))
        )
          blocked("robots.txt の取得条件を確認できませんでした。");
        group.rules.push({ allow: key === "allow", path: value });
      }
    }
  }
  const specific = groups.filter((item) =>
    item.agents.some(
      (agent) =>
        agent !== "*" && agent !== "" && BOT.toLowerCase().includes(agent),
    ),
  );
  const selected = specific.length
    ? specific
    : groups.filter((item) => item.agents.includes("*"));
  return {
    rules: selected.flatMap((item) => item.rules),
    delayed: selected.some((item) => item.delayed),
  };
}

function encodedPath(value: string): string {
  return value
    .replace(/[^\x21-\x7e]/gu, (character) => encodeURIComponent(character))
    .replace(/%[0-9a-f]{2}/gi, (escape) => {
      const char = String.fromCharCode(parseInt(escape.slice(1), 16));
      return /[a-z0-9_~.-]/i.test(char) ? char : escape.toUpperCase();
    });
}

// Wildcard matching without constructing a potentially exponential regex from
// untrusted robots rules. Rule/path lengths are bounded to 2048 characters.
function pathMatches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const tokens = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  let offset = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (index === 0) {
      if (!path.startsWith(token)) return false;
      offset = token.length;
    } else if (index === tokens.length - 1 && anchored) {
      return path.endsWith(token) && path.length - token.length >= offset;
    } else {
      const next = path.indexOf(token, offset);
      if (next < 0) return false;
      offset = next + token.length;
    }
  }
  return !anchored || offset === path.length;
}

function allowed(url: URL, policy: RobotsPolicy): boolean {
  if (policy.delayed) return false;
  const path = encodedPath(url.pathname + url.search);
  let bestLength = -1;
  let permit = true;
  for (const rule of policy.rules) {
    const pattern = encodedPath(rule.path);
    if (pathMatches(path, pattern)) {
      const length = pattern.replace(/\*/g, "").replace(/\$$/, "").length;
      if (length > bestLength || (length === bestLength && rule.allow)) {
        bestLength = length;
        permit = rule.allow;
      }
    }
  }
  return permit;
}

function unescapeHtml(text: string): string {
  return text.replace(
    /&(#x[\da-f]{1,6}|#\d{1,7}|amp|quot|apos|lt|gt|nbsp);/gi,
    (entity, code: string) => {
      if (code.startsWith("#")) {
        const number =
          code[1].toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return number > 0 &&
          number <= 0x10ffff &&
          !(number >= 0xd800 && number <= 0xdfff)
          ? String.fromCodePoint(number)
          : " ";
      }
      return (
        (
          {
            amp: "&",
            quot: '"',
            apos: "'",
            lt: "<",
            gt: ">",
            nbsp: " ",
          } as Record<string, string>
        )[code.toLowerCase()] ?? entity
      );
    },
  );
}

function visibleHtml(
  html: string,
  inspectInactive?: (element: string, tag: string, content: string) => void,
): string {
  const lower = html.toLowerCase();
  const output: string[] = [];
  let offset = 0;
  while (offset < html.length) {
    const start = html.indexOf("<", offset);
    if (start < 0) {
      output.push(html.slice(offset));
      break;
    }
    output.push(html.slice(offset, start));
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end < 0) break;
      offset = end + 3;
      output.push(" ");
      continue;
    }
    const end = html.indexOf(">", start + 1);
    if (end < 0) break;
    const tag = html.slice(start, end + 1);
    const ignored = /^<(script|style|noscript|template|svg)\b/i.exec(tag);
    if (ignored) {
      const element = ignored[1].toLowerCase();
      const close = lower.indexOf(`</${element}`, end + 1);
      inspectInactive?.(
        element,
        tag,
        html.slice(end + 1, close < 0 ? html.length : close),
      );
      if (close < 0) break;
      const closeEnd = html.indexOf(">", close);
      if (closeEnd < 0) break;
      offset = closeEnd + 1;
      output.push(" ");
    } else {
      output.push(tag.length <= 4096 ? tag : " ");
      offset = end + 1;
    }
  }
  return output.join("");
}

function textContent(html: string): string {
  const output: string[] = [];
  let offset = 0;
  while (offset < html.length) {
    const start = html.indexOf("<", offset);
    if (start < 0) {
      output.push(html.slice(offset));
      break;
    }
    output.push(html.slice(offset, start), " ");
    const end = html.indexOf(">", start + 1);
    if (end < 0) break;
    offset = end + 1;
  }
  return unescapeHtml(output.join(""))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function* anchors(html: string): Generator<{ markup: string; index: number }> {
  const lower = html.toLowerCase();
  let offset = 0;
  let scanned = 0;
  while (offset < html.length && scanned++ < 2000) {
    const start = lower.indexOf("<a", offset);
    if (start < 0) break;
    offset = start + 2;
    if (!/[\s>]/.test(html[offset] ?? "")) continue;
    const tagEnd = html.indexOf(">", offset);
    if (tagEnd < 0) break;
    const close = lower.indexOf("</a", tagEnd + 1);
    if (close < 0) break;
    const end = html.indexOf(">", close + 3);
    if (end < 0) break;
    offset = end + 1;
    if (tagEnd - start <= 4096 && end - start <= 8192)
      yield { markup: html.slice(start, end + 1), index: start };
  }
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return match ? unescapeHtml(match[1] ?? match[2] ?? match[3]) : null;
}

function phoneNumber(raw: string): string | null {
  const normalized = raw.normalize("NFKC").replace(/[‐‑‒–—−ー]/g, "-");
  if (!/^(?:\+81|0)[\d\s()-]+$/.test(normalized)) return null;
  const digits = normalized.replace(/[^\d+]/g, "").replace(/^\+81(?:0)?/, "0");
  if (
    !/^(?:0[1-9]\d{8}|050\d{8}|0800\d{7})$/.test(digits) ||
    /^(?:070|080(?!0)|090)/.test(digits)
  )
    return null;
  return digits;
}

interface Fields {
  phone: string | null;
  employeeNumber: number | null;
  evidence: string | null;
}
function extractFields(html: string): Fields {
  const cleaned = visibleHtml(html);
  const text = textContent(cleaned);
  let phone: string | null = null;
  let employeeNumber: number | null = null;
  const snippets: string[] = [];
  const personal = /携帯|担当者|個人|直通|緊急|採用|FAX|ファクス/i;
  for (const match of text.matchAll(
    /(?:代表電話|電話番号|電話|\bTEL(?:EPHONE)?\b)\s*[：:]?\s*((?:\+81|0)[\d ()\-‐‑‒–—−ー]{8,25})/gi,
  )) {
    if (personal.test(text.slice(Math.max(0, match.index! - 25), match.index)))
      continue;
    phone = phoneNumber(match[1].trim());
    if (phone) break;
  }
  if (!phone) {
    for (const match of anchors(cleaned)) {
      const href = attribute(
        match.markup.slice(0, match.markup.indexOf(">") + 1),
        "href",
      );
      if (!href?.toLowerCase().startsWith("tel:")) continue;
      const nearby = textContent(
        cleaned.slice(
          Math.max(0, match.index - 90),
          match.index + match.markup.length,
        ),
      );
      if (personal.test(nearby)) continue;
      phone = phoneNumber(href.slice(4));
      if (phone) break;
    }
  }
  if (phone) snippets.push(`電話番号: ${phone}`);
  // Approximate counts, ranges, dated years, revenue, recruiting slots and
  // group/consolidated figures are not silently converted to an exact count.
  const employees =
    /(?:従業員数|社員数|従業員)\s*[：:]?\s*((?:\d{1,3}(?:,\d{3})+|\d+))\s*(人|名)(?!\s*(?:以上|以下|未満|程度|前後|規模|~|〜|～|から))/g;
  for (const match of text.matchAll(employees)) {
    const before = text.slice(Math.max(0, match.index! - 16), match.index);
    const after = text.slice(
      match.index! + match[0].length,
      match.index! + match[0].length + 16,
    );
    if (
      /連結|グループ|全体|約|およそ/.test(before) ||
      /^\s*[（(]?\s*(?:連結|グループ)/.test(after)
    )
      continue;
    const count = Number(match[1].replace(/,/g, ""));
    if (Number.isSafeInteger(count) && count >= 0 && count <= 10_000_000) {
      employeeNumber = count;
      // Preserve an explicit count definition, never arbitrary surrounding text
      // that could include a person's name or email address.
      const definition =
        /^\s*[(（]([\d\s年月日時点現在末単体単独正社員従業員パートアルバイト契約派遣非規役出向含む除く・、:：]{1,40})[)）]/.exec(
          after,
        )?.[0] ?? "";
      snippets.push(match[0].trim() + definition);
      break;
    }
  }
  return {
    phone,
    employeeNumber,
    evidence: snippets.length ? snippets.join(" / ").slice(0, 150) : null,
  };
}

function nextCompanyPage(
  html: string,
  current: URL,
  policy: RobotsPolicy,
): URL | null {
  const candidates: { url: URL; score: number }[] = [];
  for (const match of anchors(visibleHtml(html))) {
    const href = attribute(
      match.markup.slice(0, match.markup.indexOf(">") + 1),
      "href",
    );
    if (!href) continue;
    try {
      const url = safeUrl(href, current);
      const label = textContent(match.markup);
      if (
        url.origin !== current.origin ||
        url.href === current.href ||
        !allowed(url, policy)
      )
        continue;
      if (
        /logout|login|sign[-_]?in|delete|unsubscribe|\.pdf$/i.test(url.pathname)
      )
        continue;
      const score =
        /会社概要|企業概要|会社情報|corporate|company|profile|about/i.test(
          label + " " + url.pathname,
        )
          ? 2
          : /お問い合わせ|お問合せ|連絡先|contact/i.test(
                label + " " + url.pathname,
              )
            ? 1
            : 0;
      if (score) candidates.push({ url, score });
    } catch {
      /* Ignore unsupported links; do not expose or follow them. */
    }
    if (candidates.length >= 100) break;
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.url ?? null;
}

function accessGateMarkup(markup: string): boolean {
  for (const match of markup.matchAll(
    /<([a-z][a-z\d:-]{0,63})\b[^>]{0,4096}>/gi,
  )) {
    const tag = match[0];
    const element = match[1].toLowerCase();
    if (
      element === "input" &&
      (attribute(tag, "type")?.toLowerCase() === "password" ||
        attribute(tag, "name")?.toLowerCase() === "password")
    )
      return true;
    // Widgets/response fields are active controls. An article, stylesheet,
    // comment or configuration variable merely mentioning CAPTCHA is not.
    const identifiers = ["id", "class", "name"].flatMap((name) =>
      (attribute(tag, name) ?? "").split(/\s+/),
    );
    if (
      identifiers.some((value) =>
        /^(?:(?:g-)?recaptcha|h-captcha|hcaptcha|cf-turnstile|cf-chl|captcha)(?:[-_:]|$)/i.test(
          value,
        ),
      )
    )
      return true;
    if (
      ["iframe", "img"].includes(element) &&
      /captcha|challenge-platform|challenges\.cloudflare\.com/i.test(
        attribute(tag, "src") ?? "",
      )
    )
      return true;
  }
  // Instructions to solve a challenge remain blocked; a bare product name or
  // description mentioning CAPTCHA is not itself an access requirement.
  return /verify (?:that )?you are human|ロボットではない|(?:complete|solve|enter)\s+(?:the\s+)?captcha|captcha\s+(?:is\s+)?required|画像認証を(?:完了|入力)/i.test(
    textContent(markup),
  );
}

function hasAccessGate(html: string): boolean {
  let gated = false;
  const markup = visibleHtml(html, (element, tag, content) => {
    if (element === "noscript") {
      gated ||= accessGateMarkup(visibleHtml(content));
      return;
    }
    if (element !== "script") return;
    // Still refuse concrete challenge integrations, even if company details
    // appear alongside them. No script execution, token solving or form POST.
    gated ||=
      /captcha|cf-chl-|challenge-platform|challenges\.cloudflare\.com/i.test(
        attribute(tag, "src") ?? "",
      ) ||
      /\b_cf_chl_opt\b|cf-chl-|challenge-platform|\b(?:grecaptcha(?:\.enterprise)?|hcaptcha|turnstile)\s*\.\s*(?:render|execute)\s*\(/i.test(
        content,
      );
  });
  return gated || accessGateMarkup(markup);
}

function checkHtml(page: Page): void {
  if (page.status === 401 || page.status === 403 || page.status === 429)
    blocked(
      "公式サイトが自動取得を制限しています。サイトを直接確認してください。",
    );
  if (page.status < 200 || page.status >= 300)
    throw new EnrichmentError(
      "failed",
      "公式サイトの公開ページを取得できませんでした。",
    );
  if (
    !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
      page.headers["content-type"] ?? "",
    )
  )
    blocked("公式サイトのHTMLページを確認できませんでした。");
  if (hasAccessGate(page.body))
    blocked("認証またはアクセス確認が必要なページのため、取得を停止しました。");
  if (
    /\b(?:noindex|nofollow|none)\b/i.test(
      String(page.headers["x-robots-tag"] ?? ""),
    )
  )
    blocked("公式サイトの自動取得制限に従い、補完を停止しました。");
  for (const tag of page.body.matchAll(/<meta\b[^>]{0,4096}>/gi)) {
    if (
      ["robots", BOT.toLowerCase()].includes(
        attribute(tag[0], "name")?.toLowerCase() ?? "",
      ) &&
      /\b(?:noindex|nofollow|none)\b/i.test(attribute(tag[0], "content") ?? "")
    )
      blocked("公式サイトの自動取得制限に従い、補完を停止しました。");
  }
}

/** Read-only proposals for a known official URL. Call only on explicit user action.
 * At most robots + homepage + one same-origin company page, two redirects total,
 * 1 MiB per response and 8 seconds total. No credentials, cookies or retries.
 * Never combine fields from different pages under one sourceUrl, or treat these
 * unreviewed proposals as verified CRM data. Employee scope remains unknown.
 */
export async function enrichOfficialWebsite(
  input: string,
): Promise<WebsiteEnrichment> {
  const empty: WebsiteEnrichment = {
    status: "not_found",
    phone: null,
    employeeNumber: null,
    sourceUrl: null,
    evidence: null,
    message: null,
    checkedAt: new Date().toISOString(),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let homepage = safeUrl(input);
    let redirects = 0;
    async function fetchPage(
      url: URL,
      canFollow: (target: URL) => boolean,
    ): Promise<Page> {
      let current = url;
      while (true) {
        const page = await requestPage(current, controller.signal);
        if (!redirectStatuses.has(page.status)) return page;
        if (++redirects > 2 || !page.headers.location)
          blocked("公式サイトの転送が取得上限を超えました。");
        const target = safeUrl(page.headers.location, current);
        if (
          target.hostname !== homepage.hostname ||
          (current.protocol === "https:" && target.protocol !== "https:") ||
          !canFollow(target)
        )
          blocked("公式サイトの転送先の公開範囲を確認できませんでした。");
        current = target;
      }
    }
    const robots = await fetchPage(
      new URL("/robots.txt", homepage),
      () => true,
    );
    if (robots.status !== 404 && (robots.status < 200 || robots.status >= 300))
      blocked("robots.txt を確認できないため、自動取得を停止しました。");
    if (
      robots.status !== 404 &&
      robots.headers["content-type"] &&
      !/^text\/plain(?:;|$)/i.test(robots.headers["content-type"])
    )
      blocked("robots.txt の公開範囲を確認できませんでした。");
    const policy =
      robots.status === 404
        ? { rules: [], delayed: false }
        : robotsPolicy(robots.body);
    // The common HTTP -> HTTPS robots redirect is verified before switching the
    // homepage. Other changes of origin require separate robots and are refused.
    if (robots.url.origin !== homepage.origin) {
      if (
        homepage.protocol !== "http:" ||
        robots.url.protocol !== "https:" ||
        robots.url.pathname !== "/robots.txt"
      )
        blocked();
      homepage = safeUrl(homepage.pathname + homepage.search, robots.url);
    }
    if (!allowed(homepage, policy))
      blocked("公式サイトの robots.txt に従い、自動取得を停止しました。");
    const followsPolicy = (target: URL) =>
      target.origin === homepage.origin && allowed(target, policy);
    const page = await fetchPage(homepage, followsPolicy);
    checkHtml(page);
    let fields = extractFields(page.body);
    let source = page.url;
    let partial = false;
    const next = nextCompanyPage(page.body, page.url, policy);
    if ((!fields.phone || fields.employeeNumber === null) && next) {
      try {
        const detail = await fetchPage(next, followsPolicy);
        checkHtml(detail);
        const additional = extractFields(detail.body);
        if (
          (additional.phone && !fields.phone) ||
          (additional.phone && additional.employeeNumber !== null) ||
          (!fields.phone &&
            fields.employeeNumber === null &&
            additional.employeeNumber !== null)
        ) {
          fields = additional;
          source = detail.url;
        }
      } catch (error) {
        if (!fields.evidence) throw error;
        partial = true;
      }
    }
    return {
      ...empty,
      ...fields,
      status: fields.evidence ? "found" : "not_found",
      sourceUrl: fields.evidence ? source.href : null,
      message: fields.evidence
        ? `${partial ? "追加ページは取得できませんでした。" : ""}公式サイトの記載から得た候補です。代表番号・従業員数と集計範囲を確認してから取り込んでください。`
        : "対象ページに確認できる代表電話・従業員数の記載がありませんでした。",
    };
  } catch (error) {
    if (controller.signal.aborted)
      return { ...empty, status: "failed", message: aborted().message };
    return {
      ...empty,
      status: error instanceof EnrichmentError ? error.outcome : "failed",
      message:
        error instanceof EnrichmentError
          ? error.message
          : "公式サイトの情報を取得できませんでした。",
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
