import { describe, expect, it } from "vitest";
import { civilIn, resolveRef, startOfCivil, type TemporalRef } from "../src/memory/dates.js";

const base: Omit<TemporalRef, "kind" | "text"> = {
  weekday: null, qualifier: null, month: null, day: null, year: null, amount: null, unit: null, name: null,
};
const ref = (r: Partial<TemporalRef> & Pick<TemporalRef, "kind">): TemporalRef => ({ ...base, text: "x", ...r });

// Wednesday 11 November 2026, early afternoon in London.
const NOW = new Date("2026-11-11T14:00:00Z");
const labels = (tz: string, r: TemporalRef, now = NOW) => resolveRef(r, now, tz).candidates.map((c) => c.label);

describe("weekday references", () => {
  it("bare weekday = most recent past occurrence", () => {
    expect(labels("Europe/London", ref({ kind: "weekday", weekday: "monday", qualifier: "none" }))).toEqual(["Mon 9 Nov 2026"]);
  });

  it("bare weekday equal to today = today, then a week ago", () => {
    expect(labels("Europe/London", ref({ kind: "weekday", weekday: "wednesday", qualifier: "none" }))).toEqual([
      "Wed 11 Nov 2026",
      "Wed 4 Nov 2026",
    ]);
  });

  it("'last Tuesday' when Tuesday already passed this week is ambiguous → both, previous week first", () => {
    const r = resolveRef(ref({ kind: "weekday", weekday: "tuesday", qualifier: "last" }), NOW, "Europe/London");
    expect(r.candidates.map((c) => c.label)).toEqual(["Tue 3 Nov 2026", "Tue 10 Nov 2026"]);
    expect(r.note).toMatch(/ambiguous/);
  });

  it("'last Friday' when Friday hasn't come yet this week → unambiguous previous week", () => {
    expect(labels("Europe/London", ref({ kind: "weekday", weekday: "friday", qualifier: "last" }))).toEqual(["Fri 6 Nov 2026"]);
  });

  it("uses the user's timezone to decide what 'today' is", () => {
    // 02:00 UTC on Wed 11 Nov is still Tue 10 Nov 18:00 in Los Angeles.
    const early = new Date("2026-11-11T02:00:00Z");
    expect(civilIn(early, "America/Los_Angeles")).toEqual({ y: 2026, m: 11, d: 10 });
    expect(labels("America/Los_Angeles", ref({ kind: "weekday", weekday: "monday", qualifier: "none" }), early)).toEqual(["Mon 9 Nov 2026"]);
    expect(labels("Asia/Tokyo", ref({ kind: "named", name: "today" }), early)).toEqual(["Wed 11 Nov 2026"]);
  });
});

describe("calendar dates", () => {
  it("'3 November' resolves to local midnight-to-midnight", () => {
    const [c] = resolveRef(ref({ kind: "calendar_date", month: 11, day: 3 }), NOW, "America/Los_Angeles").candidates;
    expect(c.label).toBe("Tue 3 Nov 2026");
    expect(c.start.toISOString()).toBe("2026-11-03T08:00:00.000Z"); // PST, after DST ended on 1 Nov
    expect(c.end.toISOString()).toBe("2026-11-04T08:00:00.000Z");
  });

  it("a future day-month without a year means last year", () => {
    expect(labels("UTC", ref({ kind: "calendar_date", month: 12, day: 5 }))).toEqual(["Fri 5 Dec 2025"]);
  });

  it("rejects impossible dates instead of rolling over", () => {
    const r = resolveRef(ref({ kind: "calendar_date", month: 2, day: 30 }), NOW, "UTC");
    expect(r.candidates).toEqual([]);
    expect(r.note).toMatch(/invalid/);
  });
});

describe("relative and named periods", () => {
  it("'two weeks ago' = that ISO week", () => {
    expect(labels("UTC", ref({ kind: "relative", amount: 2, unit: "week" }))).toEqual(["week of Mon 26 Oct 2026"]);
  });

  it("'3 days ago' tries the exact day first, then neighbours", () => {
    expect(labels("UTC", ref({ kind: "relative", amount: 3, unit: "day" }))).toEqual(["Sun 8 Nov 2026", "Sat 7 Nov 2026", "Mon 9 Nov 2026"]);
  });

  it("last month / last week", () => {
    expect(labels("UTC", ref({ kind: "named", name: "last_month" }))).toEqual(["Oct 2026"]);
    const [w] = resolveRef(ref({ kind: "named", name: "last_week" }), NOW, "UTC").candidates;
    expect(w.start.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });
});

describe("DST edges", () => {
  it("day after spring-forward starts at the new offset", () => {
    expect(startOfCivil({ y: 2026, m: 3, d: 29 }, "Europe/London").toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(startOfCivil({ y: 2026, m: 3, d: 30 }, "Europe/London").toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });
});
