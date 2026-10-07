import { expect, test, vi } from "vitest";
import { runPhoneResearch } from "@/lib/discovery/phone-research";
import type { PhoneResearchResponse } from "@/lib/discovery/contracts";

const result = { outcome: "checked" } as PhoneResearchResponse;
const callbacks = () => ({
  shouldStop: () => false,
  onStart: vi.fn(),
  onResult: vi.fn(),
});

test("one request at a time; stopping waits for its saved result and never starts another", async () => {
  let stop = false;
  let complete!: (response: PhoneResearchResponse) => void;
  const request = vi.fn(
    () =>
      new Promise<PhoneResearchResponse>((resolve) => {
        complete = resolve;
      }),
  );
  const events = callbacks();
  const run = runPhoneResearch({
    ids: ["a", "b"],
    request,
    ...events,
    shouldStop: () => stop,
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(events.onStart).toHaveBeenCalledWith("a");
  stop = true;
  complete(result);
  expect(await run).toBe("stopped");
  expect(events.onResult).toHaveBeenCalledWith({ id: "a", result });
  expect(request).toHaveBeenCalledTimes(1);
});

test("deduplicates IDs and completes once; rejects more than 10 before requests", async () => {
  const request = vi.fn().mockResolvedValue(result);
  expect(
    await runPhoneResearch({ ids: ["a", "a", "b"], request, ...callbacks() }),
  ).toBe("complete");
  expect(request.mock.calls).toEqual([["a"], ["b"]]);
  request.mockClear();
  await expect(
    runPhoneResearch({
      ids: Array.from({ length: 11 }, (_, n) => String(n)),
      request,
      ...callbacks(),
    }),
  ).rejects.toThrow("10社");
  expect(request).not.toHaveBeenCalled();
});

test.each([401, 403, 429, 500, undefined])(
  "%s stops without retrying or discarding earlier results",
  async (status) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(Object.assign(new Error("失敗"), { status }));
    const events = callbacks();
    expect(
      await runPhoneResearch({ ids: ["a", "b", "c"], request, ...events }),
    ).toBe("error");
    expect(request).toHaveBeenCalledTimes(2);
    expect(events.onResult).toHaveBeenNthCalledWith(1, { id: "a", result });
    expect(events.onResult).toHaveBeenNthCalledWith(2, {
      id: "b",
      error: "失敗",
    });
  },
);

test.each([404, 409, 422])(
  "per-candidate %s allows remaining companies to be checked",
  async (status) => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("要確認"), { status }))
      .mockResolvedValueOnce(result);
    expect(
      await runPhoneResearch({ ids: ["a", "b"], request, ...callbacks() }),
    ).toBe("complete");
    expect(request).toHaveBeenCalledTimes(2);
  },
);

test("unmounted/stopped queues do not start network access", async () => {
  const request = vi.fn();
  expect(
    await runPhoneResearch({
      ids: ["a"],
      request,
      ...callbacks(),
      shouldStop: () => true,
    }),
  ).toBe("stopped");
  expect(request).not.toHaveBeenCalled();
});
