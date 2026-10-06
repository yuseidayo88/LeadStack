import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { CompanyCandidateRow } from "@/lib/database.types";
import type { GbizCompany } from "@/lib/gbiz/client";
vi.mock("server-only", () => ({}));
import {
  authorizeScanStep,
  cancelScanRun,
  commitScanCandidate,
  finishScanRun,
  startScanRun,
} from "@/lib/discovery/scan-jobs";
import { candidateFromGbiz } from "@/lib/discovery/mapping";

const org = randomUUID();
const runId = randomUUID();
const now = "2026-10-06T00:00:00.000Z";
const source: GbizCompany = {
  corporateNumber: "1000000000001",
  name: "試験設備",
  location: "東京都千代田区",
  postalCode: null,
  status: null,
  updatedAt: null,
  industry: ["D"],
  companyUrl: "https://new.example/",
  employeeNumber: 25,
  businessSummary: "設備点検",
  provenance: {
    source: "gBizINFO",
    requestUrl: "https://api.info.gbiz.go.jp/hojin/v2/hojin",
    retrievedAt: now,
    metadata: null,
  },
};
function database(
  data: unknown,
  error: { code: string; message: string } | null = null,
) {
  const signals: AbortSignal[] = [];
  const rpc = vi.fn(() => ({
    abortSignal(signal: AbortSignal) {
      signals.push(signal);
      return Promise.resolve({ data, error });
    },
  }));
  return {
    rpc,
    signals,
    db: { rpc } as unknown as Parameters<typeof cancelScanRun>[0],
  };
}
beforeEach(() => vi.useFakeTimers({ now: Date.parse(now) }));
afterEach(() => vi.useRealTimers());

describe("durable scan RPC adapter", () => {
  test("run identity and server deadline are passed with a request-bound signal", async () => {
    const { db, rpc, signals } = database({
      run_id: runId,
      status: "active",
      started: true,
    });
    const signal = new AbortController().signal;
    const deadline = "2026-10-06T00:00:25.000Z";
    await startScanRun(db, org, runId, now, deadline, signal);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("start_discovery_scan_run", {
      org,
      run_id: runId,
      issued_at: now,
      deadline_at: deadline,
    });
    expect(signals).toEqual([signal]);
  });

  test("an active replay cannot acquire another worker under the same lease", async () => {
    const { db } = database({
      run_id: runId,
      status: "active",
      started: false,
    });
    await expect(
      startScanRun(db, org, runId, now, now, new AbortController().signal),
    ).rejects.toMatchObject({ status: 409, code: "scan_run_replayed" });
  });

  test.each([
    ["cancelled", "cancelled"],
    ["finished", "cancelled"],
    ["missing", "cancelled"],
    ["expired", "time_limit"],
    ["chunk_limit", "chunk_limit"],
  ])(
    "%s permit denial pauses as %s before remote work",
    async (status, reason) => {
      const { db } = database({ run_id: runId, status, allowed: false });
      await expect(
        authorizeScanStep(
          db,
          org,
          runId,
          "detail",
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ reason });
    },
  );

  test("active state without a positive authorization fails closed", async () => {
    const { db } = database({ run_id: runId, status: "active" });
    await expect(
      authorizeScanStep(db, org, runId, "search", new AbortController().signal),
    ).rejects.toMatchObject({ reason: "cancelled" });
  });

  test("website changes send only provider columns; SQL owns enrichment invalidation", async () => {
    const previous = {
      id: randomUUID(),
      website_url: "https://old.example/",
      updated_at: now,
      provenance: {},
    } as CompanyCandidateRow;
    const mapped = candidateFromGbiz(source, previous);
    expect(mapped).toHaveProperty("enrichment_result", null);
    const row = { ...previous, ...mapped } as CompanyCandidateRow;
    const { db, rpc } = database({ status: "active", row, saved: true });
    await expect(
      commitScanCandidate(
        db,
        org,
        runId,
        mapped,
        previous,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ row, saved: true });
    expect(rpc).toHaveBeenCalledWith(
      "commit_discovery_scan_candidate",
      expect.objectContaining({
        org,
        run_id: runId,
        expected_updated_at: now,
        candidate: expect.objectContaining({
          website_url: "https://new.example/",
        }),
      }),
    );
    const args = (
      rpc.mock.calls[0] as unknown as [
        string,
        { candidate: Record<string, unknown> },
      ]
    )[1];
    expect(Object.keys(args.candidate).sort()).toEqual(
      [
        "corporate_number",
        "name",
        "prefecture_code",
        "prefecture",
        "location",
        "industry_codes",
        "industry_labels",
        "website_url",
        "employee_number",
        "source_updated_at",
        "fetched_at",
        "provenance",
      ].sort(),
    );
  });

  test.each(["cancelled", "finished", "expired", "missing", "chunk_limit"])(
    "%s commit refusal has no row and is never counted saved",
    async (status) => {
      const { db } = database({ status, row: null, saved: false });
      await expect(
        commitScanCandidate(
          db,
          org,
          runId,
          candidateFromGbiz(source),
          undefined,
          new AbortController().signal,
        ),
      ).rejects.toHaveProperty("reason");
    },
  );

  test("SQL lease-race rollback requires manual resume, never automatic time-limit continuation", async () => {
    const { db } = database(null, {
      code: "P0409",
      message: "private db detail",
    });
    await expect(
      commitScanCandidate(
        db,
        org,
        runId,
        candidateFromGbiz(source),
        undefined,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "cancelled" });
  });

  test("manual-update CAS returns committed manual fields without counting a save", async () => {
    const row = {
      id: randomUUID(),
      employee_number: 42,
      phone: "03-0000-0000",
      website_url: "https://manual.example/",
    } as CompanyCandidateRow;
    const { db } = database({ status: "active", row, saved: false });
    await expect(
      commitScanCandidate(
        db,
        org,
        runId,
        candidateFromGbiz(source),
        row,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ row, saved: false });
  });

  test.each([cancelScanRun, finishScanRun])(
    "terminal cleanup owns an independent live abort signal",
    async (fn) => {
      const { db, signals } = database({ run_id: runId, status: "cancelled" });
      await fn(db, org, runId);
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);
    },
  );

  test.each(["active", "missing", "chunk_limit"])(
    "cancel never acknowledges nonterminal %s state",
    async (status) => {
      const { db } = database({ run_id: runId, status });
      await expect(cancelScanRun(db, org, runId)).rejects.toMatchObject({
        code: "scan_cancel_unconfirmed",
      });
    },
  );

  test.each([null, {}, { status: "active" }])(
    "malformed RPC state fails closed: %j",
    async (value) => {
      const { db } = database(value);
      await expect(
        authorizeScanStep(
          db,
          org,
          runId,
          "detail",
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "scan_state_unavailable" });
    },
  );
});
