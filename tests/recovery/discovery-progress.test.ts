import { describe, expect, test } from "vitest";
import type { ScanEvent } from "@/lib/discovery/contracts";
import { scanProgressState } from "@/lib/discovery/progress";

const complete: ScanEvent = {
  type: "complete",
  scanned: 8,
  matched: 3,
  target: 20,
  saved: 8,
  detailsFailed: 0,
  unknownEmployees: 0,
  unknownIndustry: 0,
  matchedIds: [],
  resumeToken: null,
  nextAllowedAt: "2026-10-07T00:00:00Z",
  reason: "exhausted",
};
const idle = {
  event: null,
  running: false,
  finishing: false,
  requestPending: false,
  cancellation: "idle" as const,
  waitingUntil: null,
  resultsUpdating: false,
  resultsError: false,
  error: "",
};

describe("discovery progress reflects acknowledged work", () => {
  test("the 200-position cap is not reported as an exhaustive search", () => {
    const result = scanProgressState({
      ...idle,
      event: { ...complete, scanned: 200, matched: 0, reason: "scan_limit" },
    });
    expect(result.label).toContain("確認上限");
    expect(result.label).toContain("この範囲で条件一致0社");
    expect(result.label).toContain("全件確認済みではありません");
  });
  test("target completion reports the split without promising 20 verified matches", () => {
    const result = scanProgressState({
      ...idle,
      event: { ...complete, reason: "target", matched: 5, needsReview: 15 },
    });
    expect(result.label).toContain("条件一致5社・情報不足15社");
  });
  test("reports activity before response headers or the first event arrive", () => {
    const state = scanProgressState({
      ...idle,
      running: true,
      requestPending: true,
    });
    expect(state.indeterminate).toBe(true);
    expect(state.label).toContain("検索中");
  });

  test.each(["running", "finishing", "resultsUpdating"] as const)(
    "a complete event does not announce completion while %s",
    (pending) => {
      const state = scanProgressState({
        ...idle,
        event: complete,
        [pending]: true,
      });
      expect(state.indeterminate).toBe(true);
      expect(state.label).not.toContain("完了");
    },
  );

  test("an exhausted search can complete below the target without inventing work", () => {
    const state = scanProgressState({ ...idle, event: complete });
    expect(state.label).toBe(
      "取得範囲の確認が終了しました（条件一致3社・情報不足0社）",
    );
    expect(state.indeterminate).toBe(false);
  });

  test("zero matches are final only after the list has settled", () => {
    const event = { ...complete, matched: 0 };
    expect(
      scanProgressState({ ...idle, event, finishing: true }).label,
    ).not.toContain("0社");
    expect(scanProgressState({ ...idle, event }).label).toContain(
      "条件一致0社",
    );
  });

  test.each(["pending", "failed"] as const)(
    "cancellation %s takes precedence over stale success or failure",
    (cancellation) => {
      const state = scanProgressState({
        ...idle,
        event: complete,
        running: true,
        requestPending: true,
        error: "upstream failure",
        cancellation,
      });
      expect(state.label).toContain("停止");
      expect(state.label).not.toContain("完了");
      expect(state.indeterminate).toBe(cancellation === "pending");
    },
  );

  test("a final list failure cannot announce success from an earlier terminal event", () => {
    expect(
      scanProgressState({ ...idle, event: complete, resultsError: true }).label,
    ).toBe("結果の一覧を更新できませんでした");
  });

  test("resuming after an upstream error first shows the new request", () => {
    const event: ScanEvent = {
      ...complete,
      type: "error",
      reason: "upstream_error",
    };
    const state = scanProgressState({
      ...idle,
      event,
      running: true,
      requestPending: true,
    });
    expect(state.label).toContain("検索中");
    expect(state.indeterminate).toBe(true);
    expect(scanProgressState({ ...idle, event }).label).toContain("中断");
  });

  test("a known cooldown is distinguished from an active network request", () => {
    const state = scanProgressState({
      ...idle,
      running: true,
      requestPending: true,
      waitingUntil: complete.nextAllowedAt,
    });
    expect(state.label).toContain("待機中");
    expect(state.indeterminate).toBe(false);
  });
});
