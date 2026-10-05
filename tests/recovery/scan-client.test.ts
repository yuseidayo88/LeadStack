import { describe, expect, test, vi } from "vitest";
import type { ScanEvent } from "@/lib/discovery/contracts";
import {
  hasScanCriteria,
  parseScanCheckpoint,
  parseScanEvent,
  readScanEvents,
  scanCriteriaFromFilters,
} from "@/lib/discovery/scan-client";
import { defaultDiscoveryFilters } from "@/lib/discovery/targeting";

const candidateId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-10-05T01:00:00.000Z";
const base = "/api/organizations/11111111-1111-4111-8111-111111111111";

function event(overrides: Partial<ScanEvent> = {}): ScanEvent {
  return {
    type: "progress",
    scanned: 1,
    matched: 1,
    target: 20,
    saved: 1,
    detailsFailed: 0,
    unknownEmployees: 0,
    unknownIndustry: 0,
    matchedIds: [candidateId],
    resumeToken: "signed-cursor",
    nextAllowedAt: timestamp,
    ...overrides,
  };
}

function responseFromChunks(chunks: Uint8Array[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } },
  );
}

function responseFromText(text: string) {
  return responseFromChunks([new TextEncoder().encode(text)]);
}

describe("scan criteria from visible filters", () => {
  test("preserves zero and unknown toggles without adding absent bounds", () => {
    expect(
      scanCriteriaFromFilters({
        ...defaultDiscoveryFilters,
        employeeMin: "0",
        hasWebsite: true,
        includeUnknownIndustry: true,
      }),
    ).toEqual({
      employeeMin: 0,
      includeUnknownEmployees: true,
      includeUnknownIndustry: true,
      hasPhone: false,
      hasWebsite: true,
      hasEmployees: false,
    });
  });

  test("normalizes full-width corporate numbers instead of treating them as names", () => {
    const criteria = scanCriteriaFromFilters({
      ...defaultDiscoveryFilters,
      search: "　４００００１２０９０００１　",
    });
    expect(criteria.corporateNumber).toBe("4000012090001");
    expect(criteria).not.toHaveProperty("name");
  });

  test("retains the user-selected business conditions independently of upstream name search", () => {
    const criteria = scanCriteriaFromFilters({
      ...defaultDiscoveryFilters,
      search: "　ＡＢＣ設備　",
      prefecture: "13",
      industry: "D",
      employeeMin: "10",
      employeeMax: "50",
      businessKeywords: "  設備 点検  ",
      includeUnknownEmployees: false,
      hasEmployees: true,
    });
    expect(criteria).toEqual({
      name: "ABC設備",
      prefecture: "13",
      industry: "D",
      employeeMin: 10,
      employeeMax: 50,
      businessKeywords: "設備 点検",
      includeUnknownEmployees: false,
      includeUnknownIndustry: false,
      hasPhone: false,
      hasWebsite: false,
      hasEmployees: true,
    });
  });

  test("display sorting and preset labels do not change the scan criteria scope", () => {
    const filters = {
      ...defaultDiscoveryFilters,
      prefecture: "13",
      businessKeywords: "設備 点検",
    };
    const first = scanCriteriaFromFilters(filters);
    const reordered = scanCriteriaFromFilters({
      ...filters,
      sort: "name",
      direction: "asc",
      presetId: "equipment",
    });
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first));
    expect(
      JSON.stringify(
        scanCriteriaFromFilters({ ...filters, employeeMax: "50" }),
      ),
    ).not.toBe(JSON.stringify(first));
  });

  test("presence-only toggles do not trigger an unrestricted nationwide scan", () => {
    expect(
      hasScanCriteria(scanCriteriaFromFilters(defaultDiscoveryFilters)),
    ).toBe(false);
    expect(
      hasScanCriteria({
        hasPhone: true,
        hasWebsite: true,
        hasEmployees: true,
        includeUnknownEmployees: true,
        includeUnknownIndustry: true,
      }),
    ).toBe(false);
    expect(hasScanCriteria({ employeeMin: 0 })).toBe(true);
    expect(hasScanCriteria({ industry: "unknown" })).toBe(true);
  });
});

describe("scan event validation", () => {
  test.each(["progress", "complete", "paused", "error"] as const)(
    "accepts a valid %s event",
    (type) => {
      const value = event({ type });
      expect(parseScanEvent(value)).toEqual(value);
    },
  );

  test.each([
    null,
    [],
    {},
    { type: "unexpected" },
    { scanned: -1 },
    { matched: 201 },
    { saved: "1" },
    { detailsFailed: 0.5 },
    { unknownEmployees: NaN },
    { unknownIndustry: Infinity },
    { target: 201 },
    { matchedIds: ["not-an-id"] },
    { matchedIds: Array.from({ length: 201 }, () => candidateId) },
    { resumeToken: 123 },
    { resumeToken: "x".repeat(32769) },
    { nextAllowedAt: "invalid-date" },
    { message: "x".repeat(2001) },
    { message: {} },
    { reason: "unexpected" },
  ])("rejects malformed event values %#", (invalid) => {
    const value =
      invalid && !Array.isArray(invalid) ? { ...event(), ...invalid } : invalid;
    // An empty object must be rejected on its own rather than made valid by the fixture.
    expect(
      parseScanEvent(
        invalid && Object.keys(invalid).length === 0 ? invalid : value,
      ),
    ).toBeNull();
  });
});

describe("NDJSON scan stream", () => {
  test("decodes split UTF-8 Japanese messages and a final line without a newline", async () => {
    const progress = event({ message: "東京都の設備会社を確認中" });
    const complete = event({
      type: "complete",
      reason: "exhausted",
      resumeToken: null,
    });
    const wire = `\n${JSON.stringify(progress)}\r\n\n${JSON.stringify(complete)}`;
    const bytes = new TextEncoder().encode(wire);
    // Single-byte fragments guarantee that every Japanese character crosses a read boundary.
    const response = responseFromChunks(
      Array.from(bytes, (byte) => Uint8Array.of(byte)),
    );
    const onEvent = vi.fn();
    await expect(readScanEvents(response, onEvent)).resolves.toEqual(complete);
    expect(onEvent.mock.calls.map(([value]) => value)).toEqual([
      progress,
      complete,
    ]);
    expect(response.body?.locked).toBe(false);
  });

  test("preserves each progress update when one network read contains several lines", async () => {
    const events = [
      event(),
      event({ scanned: 2, saved: 2 }),
      event({ type: "paused", scanned: 2, saved: 2, reason: "time_limit" }),
    ];
    const onEvent = vi.fn();
    await expect(
      readScanEvents(
        responseFromText(
          events.map((item) => JSON.stringify(item)).join("\n") + "\n",
        ),
        onEvent,
      ),
    ).resolves.toEqual(events[2]);
    expect(onEvent.mock.calls.map(([value]) => value)).toEqual(events);
  });

  test("returns a structured terminal upstream error for the UI to show and resume", async () => {
    const failure = event({
      type: "error",
      reason: "upstream_error",
      message: "時間をおいて再開してください。",
    });
    const onEvent = vi.fn();
    await expect(
      readScanEvents(responseFromText(JSON.stringify(failure)), onEvent),
    ).resolves.toEqual(failure);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(failure);
  });

  test("rejects an aborted stream while retaining previously delivered progress and releasing its lock", async () => {
    const progress = event();
    const abort = new DOMException("Aborted", "AbortError");
    let first = true;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(progress) + "\n"),
            );
          } else {
            controller.error(abort);
          }
        },
      }),
    );
    const onEvent = vi.fn();
    await expect(readScanEvents(response, onEvent)).rejects.toBe(abort);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(progress);
    expect(response.body?.locked).toBe(false);
  });

  test.each(["{bad json}\n", '{"type":"complete"}\n', '{"type":"complete"'])(
    "rejects malformed or incomplete lines after a valid checkpoint: %s",
    async (tail) => {
      const progress = event();
      const response = responseFromText(JSON.stringify(progress) + "\n" + tail);
      const onEvent = vi.fn();
      await expect(readScanEvents(response, onEvent)).rejects.toThrow(
        "検索の応答を読み取れませんでした。",
      );
      expect(onEvent).toHaveBeenCalledExactlyOnceWith(progress);
      expect(response.body?.locked).toBe(false);
    },
  );

  test.each(["", "\n \r\n", JSON.stringify(event()) + "\n"])(
    "does not report success when EOF arrives without a terminal event %#",
    async (wire) => {
      await expect(
        readScanEvents(responseFromText(wire), vi.fn()),
      ).rejects.toThrow("保存済みの位置から再開できます");
    },
  );

  test.each(["", "\n"])(
    "bounds both an unfinished line and a terminated line %#",
    async (suffix) => {
      const response = responseFromText("x".repeat(64001) + suffix);
      const onEvent = vi.fn();
      await expect(readScanEvents(response, onEvent)).rejects.toThrow(
        "検索の応答が大きすぎるため停止しました。",
      );
      expect(onEvent).not.toHaveBeenCalled();
      expect(response.body?.locked).toBe(false);
    },
  );

  test("surfaces a structured HTTP error without treating it as a streamed event", async () => {
    const onEvent = vi.fn();
    const response = Response.json(
      { error: { message: "検索条件が変わりました。" } },
      { status: 409 },
    );
    await expect(readScanEvents(response, onEvent)).rejects.toThrow(
      "検索条件が変わりました。",
    );
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("handles an upstream HTML error without leaking its body into the UI", async () => {
    const response = new Response("<html>internal proxy details</html>", {
      status: 502,
    });
    await expect(readScanEvents(response, vi.fn())).rejects.toThrow(
      "企業検索を開始できませんでした。時間をおいて再試行してください。",
    );
  });

  test("rejects a successful HTTP response with no readable body", async () => {
    await expect(readScanEvents(new Response(null), vi.fn())).rejects.toThrow(
      "検索の応答を読み取れませんでした。",
    );
  });

  test("cancels an unfinished network response after rejecting a malformed event", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{bad json}\n"));
          // Keep the underlying stream open to model a live server still sending events.
        },
        cancel,
      }),
    );
    await expect(readScanEvents(response, vi.fn())).rejects.toThrow(
      "検索の応答を読み取れませんでした。",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
});

describe("persisted scan checkpoints", () => {
  const now = Date.parse(timestamp);
  const checkpoint = {
    version: 1,
    base,
    scope: JSON.stringify({ prefecture: "13", employeeMax: 50 }),
    event: event({ type: "paused", reason: "time_limit" }),
    savedAt: now - 60_000,
  };

  test("restores a current checkpoint with its exact criteria and opaque resume token", () => {
    expect(parseScanCheckpoint(JSON.stringify(checkpoint), base, now)).toEqual(
      checkpoint,
    );
  });

  test("rejects a checkpoint copied from another organization even when its criteria match", () => {
    const otherBase = "/api/organizations/22222222-2222-4222-8222-222222222222";
    expect(
      parseScanCheckpoint(JSON.stringify(checkpoint), otherBase, now),
    ).toBeNull();
  });

  test.each([undefined, 0, 2, "1", null])(
    "rejects missing, old, or unsupported envelope version %j",
    (version) => {
      expect(
        parseScanCheckpoint(
          JSON.stringify({ ...checkpoint, version }),
          base,
          now,
        ),
      ).toBeNull();
    },
  );

  test("rejects expired and implausibly future-dated checkpoints", () => {
    for (const savedAt of [now - 2 * 60 * 60 * 1000 - 1, now + 60_001]) {
      expect(
        parseScanCheckpoint(
          JSON.stringify({ ...checkpoint, savedAt }),
          base,
          now,
        ),
      ).toBeNull();
    }
    expect(
      parseScanCheckpoint(
        JSON.stringify({
          ...checkpoint,
          savedAt: now - 2 * 60 * 60 * 1000 + 1,
        }),
        base,
        now,
      ),
    ).not.toBeNull();
  });

  test.each([null, "", "null", "{}", "[]", "not json", "x".repeat(50_001)])(
    "ignores unusable stored data %#",
    (value) => {
      expect(parseScanCheckpoint(value, base, now)).toBeNull();
    },
  );

  test.each([
    { scope: "x".repeat(2501) },
    { scope: {} },
    { savedAt: "2026-10-05" },
    { savedAt: null },
    { event: { type: "paused" } },
    { event: null },
    { base: undefined },
  ])("rejects unsafe persisted fields %#", (override) => {
    expect(
      parseScanCheckpoint(
        JSON.stringify({ ...checkpoint, ...override }),
        base,
        now,
      ),
    ).toBeNull();
  });
});
