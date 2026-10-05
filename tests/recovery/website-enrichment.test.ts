import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { enrichOfficialWebsite } from "@/lib/discovery/website-enrichment";

type Reply = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  chunks?: Buffer[];
  pending?: boolean;
  error?: Error;
};
let replies: Reply[];
const origin = "https://company.example.com";
const robots = (body = "User-agent: *\nAllow: /", status = 200) => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body,
});
const html = (body: string, headers: Record<string, string> = {}) => ({
  body,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
});
const phoneHtml = "<h1>会社概要</h1><p>電話番号: 03-1234-5678</p>";

beforeEach(() => {
  replies = [];
  mocks.lookup.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
  mocks.request.mockImplementation(
    (
      _url: URL,
      options: RequestOptions,
      callback: (value: IncomingMessage) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & { end: () => void };
      request.end = () => {
        const reply = replies.shift();
        if (!reply) throw new Error("Unexpected request in test");
        options.signal?.addEventListener(
          "abort",
          () => request.emit("error", new Error("AbortError")),
          { once: true },
        );
        if (reply.pending) return;
        queueMicrotask(() => {
          if (reply.error) {
            request.emit("error", reply.error);
            return;
          }
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
            destroy: () => void;
          };
          response.statusCode = reply.status ?? 200;
          response.headers = reply.headers ?? {};
          let destroyed = false;
          response.destroy = () => {
            destroyed = true;
          };
          callback(response as unknown as IncomingMessage);
          if (!destroyed) {
            for (const chunk of reply.chunks ?? [
              Buffer.from(reply.body ?? ""),
            ]) {
              if (destroyed) break;
              response.emit("data", chunk);
            }
            if (!destroyed) response.emit("end");
          }
        });
      };
      return request;
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  mocks.lookup.mockReset();
  mocks.request.mockReset();
});

test("returns reviewable same-page proposals and a bounded evidence snippet without collecting names/email", async () => {
  replies.push(
    robots(),
    html(
      `${phoneHtml}<table><tr><th>代表者</th><td>個人の氏名</td></tr><tr><th>従業員数</th><td>1,234名</td></tr></table><p>hidden@example.com</p>`,
    ),
  );
  const result = await enrichOfficialWebsite(origin);
  expect(result).toMatchObject({
    status: "found",
    phone: "0312345678",
    employeeNumber: 1234,
    sourceUrl: `${origin}/`,
    evidence: "電話番号: 0312345678 / 従業員数 1,234名",
  });
  expect(result.message).toContain("集計範囲");
  expect(result.evidence!.length).toBeLessThanOrEqual(150);
  expect(JSON.stringify(result)).not.toContain("個人の氏名");
  expect(JSON.stringify(result)).not.toContain("hidden@example.com");
  expect(Date.parse(result.checkedAt)).not.toBeNaN();
  const options = mocks.request.mock.calls[0][1] as RequestOptions;
  expect(options).toMatchObject({
    agent: false,
    method: "GET",
    maxHeaderSize: 16384,
    headers: {
      "User-Agent": expect.stringContaining("LeadStackBot"),
      "Accept-Encoding": "identity",
    },
  });
  expect(options.headers).not.toHaveProperty("Authorization");
  expect(options.headers).not.toHaveProperty("Cookie");
});

test.each([
  "http://localhost/",
  "http://app.local/",
  "http://metadata.google.internal/",
  "http://intranet/",
  "file:///etc/passwd",
  "ftp://company.example.com",
  "https://user:secret@company.example.com",
  "https://company.example.com:8443/",
  "https://company.example.com/?api_token=secret",
  "https://company.example.com/?signature=secret",
  "http://127.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://0.0.0.0/",
  "http://10.0.0.1/",
  "http://100.64.0.1/",
  "http://169.254.169.254/",
  "http://172.16.0.1/",
  "http://192.168.1.1/",
  "http://192.0.0.1/",
  "http://192.0.2.1/",
  "http://192.88.99.1/",
  "http://198.18.0.1/",
  "http://198.51.100.1/",
  "http://203.0.113.1/",
  "http://224.0.0.1/",
  "http://255.255.255.255/",
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[fc00::1]/",
  "http://[fe80::1]/",
  "http://[ff00::1]/",
  "http://[64:ff9b::7f00:1]/",
  "http://[2001::1]/",
  "http://[2001:db8::1]/",
  "http://[2002:7f00:1::]/",
  "http://[3fff::1]/",
])("rejects unsafe URL before DNS or any request: %s", async (url) => {
  expect(await enrichOfficialWebsite(url)).toMatchObject({
    status: "blocked",
    phone: null,
    employeeNumber: null,
    sourceUrl: null,
  });
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});

test.each([
  "127.0.0.1",
  "169.254.169.254",
  "::1",
  "::ffff:127.0.0.1",
  "2001:db8::1",
  "fc00::1",
])(
  "rejects all DNS answers if any address is nonpublic: %s",
  async (address) => {
    mocks.lookup.mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
    expect(mocks.request).not.toHaveBeenCalled();
  },
);

test("pins each connection to the inspected DNS address; it cannot re-resolve to an internal address", async () => {
  replies.push(robots(), html(phoneHtml));
  await enrichOfficialWebsite(origin);
  expect(mocks.lookup).toHaveBeenCalledTimes(2);
  expect(mocks.lookup).toHaveBeenCalledWith("company.example.com", {
    all: true,
    verbatim: true,
  });
  const options = mocks.request.mock.calls[0][1] as RequestOptions;
  const one = vi.fn();
  const all = vi.fn();
  options.lookup!("company.example.com", { all: false }, one);
  options.lookup!("company.example.com", { all: true }, all);
  expect(one).toHaveBeenCalledWith(null, "93.184.215.14", 4);
  expect(all).toHaveBeenCalledWith(null, [
    { address: "93.184.215.14", family: 4 },
  ]);
  expect(mocks.lookup).toHaveBeenCalledTimes(2);
});

test("revalidates DNS before the homepage after robots; DNS rebinding is blocked", async () => {
  replies.push(robots());
  mocks.lookup
    .mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }])
    .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
  expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

test("accepts public IPv6 while preserving IPv6 pinning", async () => {
  mocks.lookup.mockResolvedValue([
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  replies.push(robots(), html(phoneHtml));
  expect((await enrichOfficialWebsite(origin)).status).toBe("found");
  const callback = vi.fn();
  (mocks.request.mock.calls[0][1] as RequestOptions).lookup!(
    "company.example.com",
    {},
    callback,
  );
  expect(callback).toHaveBeenCalledWith(null, "2606:4700:4700::1111", 6);
});

test.each([401, 403, 429, 500, 503])(
  "robots HTTP %s stops without retries or fetching the homepage",
  async (status) => {
    replies.push(robots("", status));
    expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  },
);

test("only robots 404 is treated as no published policy", async () => {
  replies.push(robots("", 404), html(phoneHtml));
  expect((await enrichOfficialWebsite(origin)).status).toBe("found");
});

test.each([
  "User-agent: *\nDisallow: /",
  "User-agent: *\nAllow: /\nUser-agent: LeadStackBot\nDisallow: /",
  "User-agent: LeadStackBot\nAllow: /public\nUser-agent: leadstackbot\nDisallow: /*$",
  "User-agent: *\nCrawl-delay: 5\nAllow: /",
  "User-agent: *\nRequest-rate: 1/60\nAllow: /",
])(
  "honors wildcard, matching bot groups and timing restrictions: %s",
  async (body) => {
    replies.push(robots(body));
    expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  },
);

test("specific bot groups override wildcard and combine duplicate groups", async () => {
  replies.push(
    robots(
      "User-agent: *\nDisallow: /\nUser-agent: LeadStackBot\nDisallow: /private\nUser-agent: leadstackbot\nAllow: /about$",
    ),
    html(phoneHtml),
  );
  expect((await enrichOfficialWebsite(`${origin}/about`)).status).toBe("found");
});

test.each([
  [
    "/private/company",
    "User-agent: *\nDisallow: /private/*\nAllow: /private/company$",
  ],
  ["/about", "User-agent: *\nDisallow: /about\nAllow: /about"],
  ["/other", "User-agent: *\nDisallow: /about$"],
])(
  "supports robots longest-match, allow tie and end anchor: %s",
  async (path, policy) => {
    replies.push(robots(policy), html(phoneHtml));
    expect((await enrichOfficialWebsite(origin + path)).status).toBe("found");
  },
);

test.each(["/company/%61bout", "/company/会社", "/company/a?secret=1"])(
  "robots compares encoded paths and query strings: %s",
  async (path) => {
    replies.push(robots("User-agent: *\nDisallow: /company/*"));
    expect((await enrichOfficialWebsite(origin + path)).status).toBe("blocked");
    expect(mocks.request).toHaveBeenCalledTimes(
      path.includes("secret=") ? 0 : 1,
    );
  },
);

test("fetches at most one company page; ignores external and robots-disallowed links", async () => {
  replies.push(
    robots("User-agent: *\nDisallow: /private"),
    html(
      '<a href="https://other.example.com/about">会社概要</a><a href="/private/company">会社情報</a><a href="/about">会社概要</a><a href="/contact">連絡先</a>',
    ),
    html(`${phoneHtml}<p>従業員数: 42名</p><a href="/more">会社情報</a>`),
  );
  const result = await enrichOfficialWebsite(origin);
  expect(result).toMatchObject({
    status: "found",
    phone: "0312345678",
    employeeNumber: 42,
    sourceUrl: `${origin}/about`,
  });
  expect(mocks.request.mock.calls.map(([url]) => String(url))).toEqual([
    `${origin}/robots.txt`,
    `${origin}/`,
    `${origin}/about`,
  ]);
});

test("does not combine employee count and phone from different source pages", async () => {
  replies.push(
    robots(),
    html('<p>従業員数: 42名</p><a href="/contact">お問い合わせ</a>'),
    html(phoneHtml),
  );
  expect(await enrichOfficialWebsite(origin)).toMatchObject({
    phone: "0312345678",
    employeeNumber: null,
    sourceUrl: `${origin}/contact`,
  });
});

test("keeps an already retrieved proposal when the optional company page is unavailable", async () => {
  replies.push(robots(), html(phoneHtml + '<a href="/about">会社概要</a>'), {
    status: 503,
  });
  expect(await enrichOfficialWebsite(origin)).toMatchObject({
    status: "found",
    phone: "0312345678",
    sourceUrl: `${origin}/`,
    message: expect.stringContaining("追加ページは取得できませんでした"),
  });
  expect(mocks.request).toHaveBeenCalledTimes(3);
});

test.each([
  "https://evil.example.com/about",
  "http://company.example.com/about",
  "http://127.0.0.1/",
  "https://user:secret@company.example.com/",
])("rejects external, downgrade or unsafe redirect: %s", async (location) => {
  replies.push(robots(), { status: 302, headers: { location } });
  expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

test("validates robots before following a homepage redirect", async () => {
  replies.push(robots("User-agent: *\nDisallow: /private"), {
    status: 302,
    headers: { location: "/private/company" },
  });
  expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

test("supports same-host HTTP to HTTPS upgrade when HTTPS robots is fetched first", async () => {
  replies.push(
    { status: 301, headers: { location: `${origin}/robots.txt` } },
    robots(),
    html(phoneHtml),
  );
  expect(
    (await enrichOfficialWebsite("http://company.example.com/")).status,
  ).toBe("found");
  expect(mocks.request.mock.calls.map(([url]) => String(url))).toEqual([
    "http://company.example.com/robots.txt",
    `${origin}/robots.txt`,
    `${origin}/`,
  ]);
});

test("stops after two redirects in total", async () => {
  replies.push(
    robots(),
    { status: 302, headers: { location: "/a" } },
    { status: 302, headers: { location: "/b" } },
    { status: 302, headers: { location: "/c" } },
  );
  expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
  expect(mocks.request).toHaveBeenCalledTimes(4);
});

test.each([401, 403, 429])(
  "does not retry or extract text from blocked HTML response %s",
  async (status) => {
    replies.push(robots(), { ...html(phoneHtml), status });
    expect(await enrichOfficialWebsite(origin)).toMatchObject({
      status: "blocked",
      phone: null,
    });
    expect(mocks.request).toHaveBeenCalledTimes(2);
  },
);

test.each([
  '<form><input name="password"></form>',
  '<div class="g-recaptcha">Check</div>',
  '<meta name="robots" content="noindex, nofollow">',
])(
  "does not bypass authentication, challenge or robots meta: %s",
  async (body) => {
    replies.push(robots(), html(body + phoneHtml));
    expect(await enrichOfficialWebsite(origin)).toMatchObject({
      status: "blocked",
      phone: null,
    });
  },
);

test("respects X-Robots-Tag and rejects HTML disguised as robots text", async () => {
  replies.push(robots(), html(phoneHtml, { "x-robots-tag": "noindex" }));
  expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
  replies.push(robots("<html>Login</html>"));
  expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
});

test.each([
  "<p>FAX: 03-1234-5678</p>",
  "<p>携帯電話: 090-1234-5678</p>",
  "<p>担当者 電話: 03-1234-5678</p>",
  '<p>担当者 <a href="tel:0312345678">電話する</a></p>',
  '<script>const x="電話番号: 03-1234-5678"</script>',
  "<p>法人番号 1234567890123 / 売上高 1234万円 / 募集人数 10名</p>",
  "<p>電話: 03-1234-56789</p>",
])(
  "does not extract personal, FAX, executable or unrelated data: %s",
  async (body) => {
    replies.push(robots(), html(body));
    expect(await enrichOfficialWebsite(origin)).toMatchObject({
      status: "not_found",
      phone: null,
      employeeNumber: null,
      evidence: null,
    });
  },
);

test.each([
  ['<a href="tel:0120-123-456">電話する</a>', "0120123456"],
  ["<p>TEL: ０３−１２３４−５６７８</p>", "0312345678"],
  ['<a href="tel:+81-3-1234-5678">Call</a>', "0312345678"],
  ["<p>電話: 0800-123-4567</p>", "08001234567"],
])("extracts explicit business phone variants: %s", async (body, phone) => {
  replies.push(robots(), html(body));
  expect(await enrichOfficialWebsite(origin)).toMatchObject({
    status: "found",
    phone,
  });
});

test.each([
  "従業員数: 約100名",
  "従業員数: 10〜20名",
  "従業員数: 100名以上",
  "連結 従業員数: 100名",
  "従業員数: 100名（連結）",
  "従業員数: 非公開",
  "採用予定人数: 20名",
])("keeps uncertain/non-company employee counts unknown: %s", async (body) => {
  replies.push(robots(), html(body));
  expect((await enrichOfficialWebsite(origin)).employeeNumber).toBeNull();
});

test("preserves an explicitly published zero employee count", async () => {
  replies.push(robots(), html("従業員数: 0名"));
  expect(await enrichOfficialWebsite(origin)).toMatchObject({
    status: "found",
    employeeNumber: 0,
  });
});

test("preserves a nearby explicit employee definition without collecting unrelated personal text", async () => {
  replies.push(
    robots(),
    html("従業員数: 42名（パート含む） 代表者 個人の氏名"),
  );
  expect(await enrichOfficialWebsite(origin)).toMatchObject({
    employeeNumber: 42,
    evidence: "従業員数: 42名(パート含む)",
  });
});

test("malformed or unterminated HTML cannot expose script text or cause unbounded tag scans", async () => {
  replies.push(
    robots(),
    html("<script>" + "<script>".repeat(10_000) + phoneHtml),
  );
  expect(await enrichOfficialWebsite(origin)).toMatchObject({
    status: "not_found",
    phone: null,
  });
  replies.push(robots(), html("<".repeat(80_000) + phoneHtml));
  expect((await enrichOfficialWebsite(origin)).status).toBe("found");
});

test.each<Record<string, string>>([
  { "content-length": String(1024 * 1024 + 1) },
  { "content-encoding": "gzip" },
  { "content-type": "application/json" },
])("blocks unbounded or unsupported response format: %j", async (headers) => {
  replies.push(robots(), html(phoneHtml, headers));
  expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
});

test("enforces byte limit while streaming even without Content-Length", async () => {
  replies.push(robots(), {
    ...html(""),
    chunks: [Buffer.alloc(600_000), Buffer.alloc(600_000)],
  });
  expect((await enrichOfficialWebsite(origin)).status).toBe("blocked");
});

test("total deadline aborts a stalled HTTP request", async () => {
  vi.useFakeTimers();
  replies.push({ pending: true });
  const result = enrichOfficialWebsite(origin);
  await vi.advanceTimersByTimeAsync(8001);
  expect(await result).toMatchObject({
    status: "failed",
    message: expect.stringContaining("タイムアウト"),
  });
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

test("total deadline also bounds DNS resolution", async () => {
  vi.useFakeTimers();
  mocks.lookup.mockReturnValue(new Promise(() => {}));
  const result = enrichOfficialWebsite(origin);
  await vi.advanceTimersByTimeAsync(8001);
  expect(await result).toMatchObject({
    status: "failed",
    message: expect.stringContaining("タイムアウト"),
  });
  expect(mocks.request).not.toHaveBeenCalled();
});

test("network errors never leak exception messages, secrets, URL or stack", async () => {
  mocks.lookup.mockRejectedValue(
    new Error("secret-token and internal-host:5432"),
  );
  const result = await enrichOfficialWebsite(origin);
  expect(result.status).toBe("failed");
  expect(JSON.stringify(result)).not.toMatch(
    /secret-token|internal-host|stack|company\.example/,
  );
});
