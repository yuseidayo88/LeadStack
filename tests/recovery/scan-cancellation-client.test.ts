import { describe, expect, test, vi } from "vitest";
import type { ScanEvent } from "@/lib/discovery/contracts";
import {
  activeScanStorageKey,
  clearActiveScanRun,
  parseActiveScanRun,
  readScanEvents,
  requestScanCancellation,
  shouldContinueScan,
  type ActiveScanRun,
} from "@/lib/discovery/scan-client";

const base = "/api/organizations/11111111-1111-4111-8111-111111111111";
const run: ActiveScanRun = {
  version: 1,
  base,
  runId: "11111111-1111-4111-8111-111111111112",
  tabId: "11111111-1111-4111-8111-111111111113",
  actorId: "11111111-1111-4111-8111-111111111114",
  issuedAt: "2026-10-06T12:00:00.000Z",
};
const event: ScanEvent = {
  type: "paused",
  reason: "chunk_limit",
  scanned: 5,
  saved: 5,
  matched: 1,
  target: 20,
  detailsFailed: 0,
  unknownEmployees: 1,
  unknownIndustry: 0,
  matchedIds: [],
  resumeToken: "signed-checkpoint",
  nextAllowedAt: run.issuedAt,
};

function store(value: ActiveScanRun | null) {
  const values = new Map<string, string>();
  if (value)
    values.set(activeScanStorageKey(value.base), JSON.stringify(value));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

describe("active scan recovery marker", () => {
  test("retains only the run identity and owner needed to recover an abandoned request", () => {
    expect(parseActiveScanRun(JSON.stringify(run), base)).toEqual(run);
    expect(activeScanStorageKey(base)).toBe(
      `leadstack.discovery.active.v1.${base}`,
    );
  });

  test.each([
    { version: 2 },
    { version: undefined },
    { runId: "not-a-run" },
    { runId: undefined },
    { tabId: "wrong" },
    { actorId: "wrong" },
    { actorId: undefined },
    { issuedAt: "wrong" },
    { issuedAt: null },
    { base: "/api/organizations/another-org" },
  ])("rejects corrupt or cross-organization markers %#", (override) => {
    expect(
      parseActiveScanRun(JSON.stringify({ ...run, ...override }), base),
    ).toBeNull();
  });

  test.each([null, "", "{broken", "null", "[]", "{}", "x".repeat(2001)])(
    "ignores unusable stored content %#",
    (value) => expect(parseActiveScanRun(value, base)).toBeNull(),
  );

  test("does not infer server cancellation from an old local timestamp", () => {
    const old = { ...run, issuedAt: "2020-01-01T00:00:00.000Z" };
    expect(parseActiveScanRun(JSON.stringify(old), base)).toEqual(old);
  });

  test("clears the exact completed run's marker", () => {
    const storage = store(run);
    clearActiveScanRun(storage, run);
    expect(storage.getItem(activeScanStorageKey(base))).toBeNull();
  });

  test("late cancellation and response EOF cannot erase another tab's new run", () => {
    const newer = {
      ...run,
      runId: "22222222-2222-4222-8222-222222222222",
      tabId: "22222222-2222-4222-8222-222222222223",
    };
    const storage = store(newer);
    clearActiveScanRun(storage, run);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(
      parseActiveScanRun(storage.getItem(activeScanStorageKey(base)), base),
    ).toEqual(newer);
  });

  test("missing marker is safe after an earlier lifecycle cancellation acknowledged", () => {
    const storage = store(null);
    clearActiveScanRun(storage, run);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});

describe("independent durable cancellation request", () => {
  test.each(["cancelled", "finished", "expired"])(
    "accepts a matching durable %s receipt",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ data: { runId: run.runId, status } }),
        );
      await expect(
        requestScanCancellation(run, fetcher),
      ).resolves.toBeUndefined();
      expect(fetcher).toHaveBeenCalledOnce();
      const [url, options] = fetcher.mock.calls[0];
      expect(url).toBe(`${base}/company-discovery/scan/cancel`);
      expect(options).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.runId }),
      });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.signal?.aborted).toBe(false);
    },
  );

  test.each([
    { data: { runId: run.runId, status: "running" } },
    { data: { runId: run.runId, status: "accepted" } },
    {
      data: {
        runId: "22222222-2222-4222-8222-222222222222",
        status: "cancelled",
      },
    },
    { data: { status: "cancelled" } },
    { data: null },
    { ok: true },
    null,
  ])(
    "does not acknowledge ambiguous or another run's receipt %#",
    async (result) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(result));
      await expect(requestScanCancellation(run, fetcher)).rejects.toThrow(
        "停止を確認できません",
      );
    },
  );

  test.each([401, 403, 409, 500, 503])(
    "does not acknowledge HTTP %s",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { data: { runId: run.runId, status: "cancelled" } },
            { status },
          ),
        );
      await expect(requestScanCancellation(run, fetcher)).rejects.toThrow(
        "停止を確認できません",
      );
    },
  );

  test("connection failure remains unconfirmed and can be retried with the same run ID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Network disconnected"))
      .mockResolvedValueOnce(
        Response.json({ data: { runId: run.runId, status: "cancelled" } }),
      );
    await expect(requestScanCancellation(run, fetcher)).rejects.toThrow(
      "Network disconnected",
    );
    await expect(
      requestScanCancellation(run, fetcher),
    ).resolves.toBeUndefined();
    expect(
      fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([{ runId: run.runId }, { runId: run.runId }]);
  });

  test("waits for acknowledgment instead of considering request dispatch a stop", async () => {
    let acknowledge!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          acknowledge = resolve;
        }),
    );
    let acknowledged = false;
    const pending = requestScanCancellation(run, fetcher).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    acknowledge(
      Response.json({ data: { runId: run.runId, status: "cancelled" } }),
    );
    await pending;
    expect(acknowledged).toBe(true);
  });
});

describe("bounded chunk continuation and response completion", () => {
  test.each(["chunk_limit", "time_limit"] as const)(
    "continues %s only with a saved cursor",
    (reason) => {
      expect(shouldContinueScan({ ...event, reason })).toBe(true);
      expect(shouldContinueScan({ ...event, reason, resumeToken: null })).toBe(
        false,
      );
      expect(shouldContinueScan({ ...event, reason, type: "error" })).toBe(
        false,
      );
    },
  );

  test.each([
    "cancelled",
    "target",
    "scan_limit",
    "exhausted",
    "upstream_error",
  ] as const)("does not automatically restart after %s", (reason) =>
    expect(shouldContinueScan({ ...event, reason })).toBe(false),
  );

  test("terminal event alone does not finish until EOF, so lifecycle stop can still cancel", async () => {
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          wire = controller;
        },
      }),
    );
    let finished = false;
    const onEvent = vi.fn();
    const pending = readScanEvents(response, onEvent).then((value) => {
      finished = true;
      return value;
    });
    wire.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(event));
    expect(finished).toBe(false);
    wire.close();
    await expect(pending).resolves.toEqual(event);
    expect(finished).toBe(true);
  });

  test("rejects progress emitted after terminal instead of allowing stale result changes", async () => {
    const later = { ...event, type: "progress", scanned: 6, saved: 6 };
    const response = new Response(
      `${JSON.stringify(event)}\n${JSON.stringify(later)}\n`,
    );
    const onEvent = vi.fn();
    await expect(readScanEvents(response, onEvent)).rejects.toThrow("終了後");
    expect(onEvent).toHaveBeenCalledOnce();
  });

  test("terminal followed by stream failure stays unfinished for the hook to cancel", async () => {
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          wire = controller;
        },
      }),
    );
    const onEvent = vi.fn();
    const pending = readScanEvents(response, onEvent);
    wire.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    const rejected = expect(pending).rejects.toThrow("socket closed");
    wire.error(new Error("socket closed"));
    await rejected;
  });
});
