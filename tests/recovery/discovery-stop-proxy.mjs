// LOCAL ONLY: preserve the upstream scan even when the browser disconnects.
// This reproduces platforms that do not propagate request cancellation.
import assert from "node:assert/strict";
import http from "node:http";
import { pathToFileURL } from "node:url";

export function createDisconnectProxy({
  port = 3012,
  upstreamPort = 3011,
} = {}) {
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  assert.ok(
    Number.isInteger(upstreamPort) &&
      upstreamPort > 1024 &&
      upstreamPort < 65536,
  );
  assert.notEqual(port, upstreamPort);
  const scans = [];
  let truncateNextScan = false;
  let delayNextCancel = false;
  let failNextCancel = false;
  let holdNextEof = false;
  const server = http.createServer((request, response) => {
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        request.socket.remoteAddress,
      )
    ) {
      response.writeHead(403).end();
      return;
    }
    const path = new URL(request.url || "/", `http://localhost:${port}`)
      .pathname;
    if (path === "/__test_proxy/state") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ mode: "ignore-scan-disconnect", scans }));
      return;
    }
    if (path === "/__test_proxy/truncate" && request.method === "POST") {
      truncateNextScan = true;
      response.writeHead(204).end();
      return;
    }
    if (path === "/__test_proxy/cancel-delay" && request.method === "POST") {
      delayNextCancel = true;
      response.writeHead(204).end();
      return;
    }
    if (path === "/__test_proxy/cancel-fail" && request.method === "POST") {
      failNextCancel = true;
      response.writeHead(204).end();
      return;
    }
    if (path === "/__test_proxy/hold-eof" && request.method === "POST") {
      holdNextEof = true;
      response.writeHead(204).end();
      return;
    }
    const isScan =
      request.method === "POST" && /\/company-discovery\/scan$/.test(path);
    const isCancel =
      request.method === "POST" &&
      /\/company-discovery\/scan\/cancel$/.test(path);
    if (isCancel && failNextCancel) {
      failNextCancel = false;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "local_cancel_failure",
            message: "Synthetic cancellation failure",
          },
        }),
      );
      request.resume();
      return;
    }
    const delayCancel = isCancel && delayNextCancel;
    if (isCancel) delayNextCancel = false;
    const holdEof = isScan && holdNextEof;
    if (isScan) holdNextEof = false;
    const responseParts = [];
    const record = isScan
      ? {
          id: scans.length + 1,
          path,
          startedAt: Date.now(),
          clientClosedAt: null,
          endedAt: null,
          status: null,
          bytes: 0,
          upstreamAborted: false,
        }
      : null;
    const truncate = isScan && truncateNextScan;
    if (isScan) truncateNextScan = false;
    let pending = "";
    let truncated = false;
    if (record) scans.push(record);
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: `localhost:${port}` },
      },
      (incoming) => {
        if (record) record.status = incoming.statusCode;
        if (!response.destroyed)
          response.writeHead(incoming.statusCode || 502, incoming.headers);
        incoming.on("data", (chunk) => {
          if (record) record.bytes += chunk.length;
          if (delayCancel) {
            responseParts.push(chunk);
            return;
          }
          // Always consume upstream data, including after downstream close.
          if (!response.destroyed && !response.writableEnded)
            response.write(chunk);
          if (truncate && !truncated) {
            pending += chunk.toString();
            let index;
            while ((index = pending.indexOf("\n")) !== -1) {
              const line = pending.slice(0, index);
              pending = pending.slice(index + 1);
              let event;
              try {
                event = JSON.parse(line);
              } catch {
                continue;
              }
              if (event.saved >= 1 && event.type === "progress") {
                truncated = true;
                response.end();
                break;
              }
            }
          }
        });
        incoming.on("end", () => {
          if (record) record.endedAt = Date.now();
          if (delayCancel || holdEof) {
            setTimeout(() => {
              if (!response.destroyed && !response.writableEnded)
                response.end(
                  delayCancel ? Buffer.concat(responseParts) : undefined,
                );
            }, 2500);
          } else if (!response.destroyed) response.end();
        });
        incoming.on("aborted", () => {
          if (record) {
            record.upstreamAborted = true;
            record.endedAt = Date.now();
          }
          if (!response.destroyed) response.destroy();
        });
        incoming.on("error", () => {
          if (record) record.endedAt ||= Date.now();
          if (!response.destroyed) response.destroy();
        });
      },
    );
    upstream.on("error", () => {
      if (record) record.endedAt ||= Date.now();
      if (!response.destroyed) response.writeHead(502).end();
    });
    response.on("close", () => {
      if (record && !record.endedAt) record.clientClosedAt = Date.now();
      // Deliberately do NOT upstream.destroy() for scans.
      if (!isScan && !response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
  });
  return {
    server,
    scans,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const proxy = createDisconnectProxy();
  await proxy.listen();
  console.log(
    "Local disconnect-draining proxy listening on 127.0.0.1:3012 -> 127.0.0.1:3011",
  );
  for (const event of ["SIGINT", "SIGTERM"])
    process.once(event, async () => {
      await proxy.close();
      process.exit(0);
    });
}
