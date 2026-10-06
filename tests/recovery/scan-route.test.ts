import { beforeEach, afterEach, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ requireOrganization: vi.fn() }));
vi.mock("@/lib/discovery/scan", () => ({ startCompanyScan: vi.fn() }));
vi.mock("@/lib/discovery/service", () => ({
  listCandidates: vi.fn(),
  acquireCandidates: vi.fn(),
  enrichCandidate: vi.fn(),
  updateCandidate: vi.fn(),
}));

import { requireOrganization } from "@/lib/auth";
import { startCompanyScan } from "@/lib/discovery/scan";
import { listCandidates } from "@/lib/discovery/service";
import { AppError } from "@/lib/errors";
import {
  GET,
  POST as SHARED_POST,
} from "@/app/api/organizations/[org]/company-discovery/route";
import { POST } from "@/app/api/organizations/[org]/company-discovery/scan/route";
import { POST as CANCEL_POST } from "@/app/api/organizations/[org]/company-discovery/scan/cancel/route";
import { cancelScanRun } from "@/lib/discovery/scan-jobs";
vi.mock("@/lib/discovery/scan-jobs", () => ({ cancelScanRun: vi.fn() }));

const org = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ org }) };
const db = {} as Parameters<typeof startCompanyScan>[0];
function request(body: unknown, origin = "https://leadstack.example") {
  return new Request(
    `https://leadstack.example/api/organizations/${org}/company-discovery`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        runId: org,
        issuedAt: "2026-10-06T01:00:00.000Z",
        ...(body as object),
      }),
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://leadstack.example");
  vi.mocked(requireOrganization).mockResolvedValue({
    db,
    org,
    role: "owner",
    user: { id: org } as Awaited<
      ReturnType<typeof requireOrganization>
    >["user"],
  });
  vi.mocked(startCompanyScan).mockResolvedValue(
    new Response('{"type":"progress"}\n', {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "private, no-store, no-transform",
      },
    }),
  );
});
afterEach(() => vi.unstubAllEnvs());

test("a name-free scan is organization-authorized and forwards the request cancellation signal", async () => {
  const input = request({
    action: "scan",
    criteria: { prefecture: "13", employeeMin: 10, employeeMax: 50 },
  });
  const response = await POST(input, context);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("cache-control")).toContain("no-transform");
  expect(requireOrganization).toHaveBeenCalledExactlyOnceWith(org, true);
  expect(startCompanyScan).toHaveBeenCalledExactlyOnceWith(
    db,
    org,
    expect.objectContaining({
      action: "scan",
      criteria: expect.objectContaining({
        prefecture: "13",
        employeeMin: 10,
        employeeMax: 50,
        includeUnknownEmployees: true,
      }),
    }),
    input.signal,
  );
});

test.each([401, 403])(
  "authorization failure %s never starts a scan",
  async (status) => {
    vi.mocked(requireOrganization).mockRejectedValue(
      new AppError(status, "forbidden", "権限を確認してください"),
    );
    const response = await POST(
      request({ action: "scan", criteria: { industry: "D" } }),
      context,
    );
    expect(response.status).toBe(status);
    expect(startCompanyScan).not.toHaveBeenCalled();
  },
);

test("cross-origin scan submission is rejected before organization or provider access", async () => {
  const response = await POST(
    request(
      { action: "scan", criteria: { industry: "D" } },
      "https://foreign.example",
    ),
    context,
  );
  expect(response.status).toBe(403);
  expect(requireOrganization).not.toHaveBeenCalled();
  expect(startCompanyScan).not.toHaveBeenCalled();
});

test.each([
  { action: "scan", criteria: {} },
  { action: "scan", criteria: { employeeMin: 51, employeeMax: 10 } },
  { action: "scan", criteria: { prefecture: "13", organization_id: org } },
  {
    action: "scan",
    criteria: { prefecture: "13" },
    resumeToken: "x".repeat(32769),
  },
])("invalid scan input returns422 before any work", async (input) => {
  const response = await POST(request(input), context);
  expect(response.status).toBe(422);
  expect(startCompanyScan).not.toHaveBeenCalled();
});

test("quota failure remains a JSON429 response before streaming begins", async () => {
  vi.mocked(startCompanyScan).mockRejectedValue(
    new AppError(
      429,
      "discovery_rate_limited",
      "30秒ほど置いて再試行してください。",
    ),
  );
  const response = await POST(
    request({ action: "scan", criteria: { industry: "D" } }),
    context,
  );
  expect(response.status).toBe(429);
  expect(response.headers.get("content-type")).toContain("application/json");
});

test("list timing headers expose durations only and forward the lightweight projection", async () => {
  vi.mocked(listCandidates).mockResolvedValue({
    data: [],
    count: 0,
    page: 1,
    pageSize: 20,
    configured: true,
    totalCached: 0,
    lastFetchedAt: null,
    industryOptions: [],
  });
  const response = await GET(
    new Request(
      `https://leadstack.example/api/organizations/${org}/company-discovery?view=summary`,
    ),
    context,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("server-timing")).toMatch(
    /^auth;dur=\d+\.\d, list;dur=\d+\.\d, total;dur=\d+\.\d$/,
  );
  expect(listCandidates).toHaveBeenCalledWith(
    db,
    org,
    expect.objectContaining({ view: "summary" }),
  );
});

test("legacy scan entry cannot bypass durable dedicated endpoint", async () => {
  const response = await SHARED_POST(
    request({ action: "scan", criteria: { prefecture: "13" } }),
    context,
  );
  expect(response.status).toBe(409);
  expect(startCompanyScan).not.toHaveBeenCalled();
});

test.each(["acquire", "enrich", "remove"])(
  "dedicated scan rejects unrelated %s actions",
  async (action) => {
    const response = await POST(
      request({ action, criteria: { prefecture: "13" } }),
      context,
    );
    expect(response.status).toBe(422);
    expect(startCompanyScan).not.toHaveBeenCalled();
  },
);

test.each([
  { runId: "bad" },
  { runId: undefined },
  { issuedAt: "bad" },
  { issuedAt: undefined },
])("run identity is mandatory and validated: %j", async (extra) => {
  const response = await POST(
    request({ action: "scan", criteria: { prefecture: "13" }, ...extra }),
    context,
  );
  expect(response.status).toBe(422);
  expect(startCompanyScan).not.toHaveBeenCalled();
});

function cancelRequest(origin = "https://leadstack.example") {
  return new Request(
    `https://leadstack.example/api/organizations/${org}/company-discovery/scan/cancel`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ runId: org }),
    },
  );
}

test.each(["cancelled", "finished", "expired"] as const)(
  "cancel ACK returns durable terminal %s only after authenticated RPC",
  async (status) => {
    vi.mocked(cancelScanRun).mockResolvedValue({ run_id: org, status });
    const response = await CANCEL_POST(cancelRequest(), context);
    expect(requireOrganization).toHaveBeenCalledExactlyOnceWith(org, true);
    expect(cancelScanRun).toHaveBeenCalledExactlyOnceWith(db, org, org);
    expect(await response.json()).toEqual({ data: { runId: org, status } });
  },
);

test("cancel endpoint checks CSRF before writing a tombstone", async () => {
  const response = await CANCEL_POST(
    cancelRequest("https://foreign.example"),
    context,
  );
  expect(response.status).toBe(403);
  expect(requireOrganization).not.toHaveBeenCalled();
  expect(cancelScanRun).not.toHaveBeenCalled();
});

test.each([401, 403])(
  "cancel endpoint refuses unauthorized actor %s",
  async (status) => {
    vi.mocked(requireOrganization).mockRejectedValue(
      new AppError(status, "forbidden", "権限を確認してください"),
    );
    const response = await CANCEL_POST(cancelRequest(), context);
    expect(response.status).toBe(status);
    expect(cancelScanRun).not.toHaveBeenCalled();
  },
);

test("failed cancel RPC never returns an acknowledgement", async () => {
  vi.mocked(cancelScanRun).mockRejectedValue(
    new AppError(500, "database_error", "保存に失敗しました"),
  );
  const response = await CANCEL_POST(cancelRequest(), context);
  expect(response.status).toBe(500);
  expect(await response.json()).not.toHaveProperty("data");
});
