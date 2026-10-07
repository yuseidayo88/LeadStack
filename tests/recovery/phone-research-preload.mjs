// Opt-in fixture for an isolated local Next process only. Public DNS/HTTP and
// fetch are blocked; synthetic HTML exercises the actual server extractor.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";

if (process.env.LEADSTACK_LOCAL_PHONE_MOCK === "1") {
  assert.equal(process.env.GBIZ_API_TOKEN, "");
  assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, "http://127.0.0.1:55321");
  const local = (host) =>
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  const fixture = (host) => host.endsWith(".phone-fixture.test");
  const originalLookup = dns.lookup;
  dns.lookup = async (host, options) => {
    if (fixture(host)) return [{ address: "93.184.215.14", family: 4 }];
    if (local(host)) return originalLookup(host, options);
    throw new Error("Local phone fixture blocked external DNS");
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.ok(
      local(url.hostname),
      "Local phone fixture blocked external fetch",
    );
    return originalFetch(input, options);
  };
  for (const transport of [http, https]) {
    const originalRequest = transport.request;
    transport.request = (input, options, callback) => {
      const url =
        input instanceof URL
          ? input
          : typeof input === "string"
            ? new URL(input)
            : null;
      const hostname = url?.hostname ?? input.hostname ?? input.host;
      if (local(hostname)) return originalRequest(input, options, callback);
      assert.ok(
        url && fixture(hostname),
        "Local phone fixture blocked external HTTP",
      );
      const request = new EventEmitter();
      request.end = () => {
        // Record attempts before a response or abort so concurrency assertions
        // also detect requests whose delayed body never completes.
        appendFileSync(
          "/workspace/handoff/e2e-private/phone-requests.jsonl",
          JSON.stringify({
            host: hostname,
            path: url.pathname,
            at: Date.now(),
          }) + "\n",
        );
        let finished = false;
        const aborted = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          request.emit("error", new Error("Aborted"));
        };
        const timer = setTimeout(
          () => {
            if (finished) return;
            finished = true;
            options.signal?.removeEventListener("abort", aborted);
            const robots = url.pathname === "/robots.txt";
            const response = new EventEmitter();
            response.statusCode = 200;
            response.headers = {
              "content-type": robots
                ? "text/plain"
                : "text/html; charset=utf-8",
            };
            let destroyed = false;
            response.destroy = () => {
              destroyed = true;
            };
            callback(response);
            let body;
            if (robots)
              body = hostname.startsWith("blocked.")
                ? "User-agent: *\nDisallow: /"
                : "User-agent: *\nAllow: /";
            else if (hostname.startsWith("empty."))
              body = "<h1>電話調査検証企業</h1><p>従業員数: 12名</p>";
            else if (hostname.startsWith("detail.") && url.pathname === "/")
              body = '<h1>電話調査検証企業</h1><a href="/company">会社概要</a>';
            else
              body =
                "<h1>電話調査検証企業</h1><p>東京都検証市1番地</p><p>代表電話: 03-1234-5678</p><p>従業員数: 12名</p>";
            if (!destroyed) response.emit("data", Buffer.from(body));
            if (!destroyed) response.emit("end");
          },
          url.pathname === "/robots.txt"
            ? 40
            : hostname.startsWith("slow4.")
              ? 4000
              : hostname.startsWith("slow.")
                ? 2000
                : 40,
        );
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (options.signal?.aborted) aborted();
      };
      return request;
    };
  }
  syncBuiltinESMExports();
}
