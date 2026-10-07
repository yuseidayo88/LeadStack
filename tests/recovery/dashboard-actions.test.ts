import { describe, expect, it } from "vitest";
import {
  dashboardActions,
  dashboardDeadline,
} from "../../src/lib/crm/dashboard-actions";

const task = (
  id: string,
  due_at: string | null,
  status = "todo",
  updated_at = "2026-10-07T00:00:00Z",
) => ({ id, due_at, status, updated_at });
describe("dashboard action list", () => {
  it("honors the database's microsecond version when updates share a millisecond", () => {
    const before = task("a", null, "todo", "2026-10-07T00:00:00.123001+00:00");
    const after = task(
      "a",
      null,
      "completed",
      "2026-10-07T00:00:00.123999+00:00",
    );
    expect(dashboardActions([before], [after])).toEqual([]);
    expect(dashboardActions([after], [before])).toEqual([]);
  });
  it("shows an overlapping callback only once and keeps every distinct action", () => {
    const overdue = task("a", "2026-10-06T00:00:00Z");
    const today = task("b", "2026-10-07T00:00:00Z");
    const upcoming = task("c", "2026-10-08T00:00:00Z");
    const undated = task("d", null);
    expect(
      dashboardActions(
        [today],
        [overdue],
        [today, undated, upcoming, overdue],
      ).map((t) => t.id),
    ).toEqual(["a", "b", "c", "d"]);
  });
  it("prefers the newest returned version before deciding whether it is actionable", () => {
    const before = task("a", "2026-10-06T00:00:00Z");
    const completed = task(
      "a",
      before.due_at,
      "completed",
      "2026-10-07T01:00:00Z",
    );
    expect(dashboardActions([before], [completed])).toEqual([]);
    expect(dashboardActions([completed], [before])).toEqual([]);
    expect(dashboardActions([task("c", null, "cancelled")])).toEqual([]);
  });
  it("sorts a changed due date using the newer version and breaks equal-date ties consistently", () => {
    const old = task("b", "2026-10-06T00:00:00Z");
    const newer = task(
      "b",
      "2026-10-08T00:00:00Z",
      "todo",
      "2026-10-07T01:00:00Z",
    );
    const sameDay = task("a", newer.due_at);
    expect(dashboardActions([old, sameDay], [newer]).map((t) => t.id)).toEqual([
      "a",
      "b",
    ]);
    expect(dashboardActions([newer], [sameDay, old]).map((t) => t.id)).toEqual([
      "a",
      "b",
    ]);
  });
  it("does not discard distinct actions beyond one group's thirty-row limit", () => {
    const groups = Array.from({ length: 3 }, (_, group) =>
      Array.from({ length: 30 }, (_, n) => task(`${group}-${n}`, null)),
    );
    expect(dashboardActions(...groups)).toHaveLength(90);
  });
  it.each([
    ["2026-10-06T14:59:59.999Z", "overdue"],
    ["2026-10-06T15:00:00Z", "today"],
    ["2026-10-07T14:59:59.999Z", "today"],
    ["2026-10-07T15:00:00Z", "upcoming"],
    [null, "unscheduled"],
    ["invalid", "unscheduled"],
  ])("classifies %s against the API's Tokyo day", (due, expected) => {
    expect(dashboardDeadline(due, "2026-10-07")).toBe(expected);
  });
});
