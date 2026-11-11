import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";
import { recall } from "../src/agent/recall.js";
import { mightReferToPast, type MemoryPlan } from "../src/agent/planner.js";
import type { TemporalRef } from "../src/memory/dates.js";

const NOW = new Date("2026-11-11T14:00:00Z"); // Wed
const TZ = "Europe/London";

function seeded(): MemoryStore {
  const mem = new MemoryStore(":memory:");
  const c1 = mem.ensureConversation(undefined, "postgres", new Date("2026-11-03T10:00:00Z"));
  const t1 = mem.saveTurn({
    conversationId: c1,
    userText: "What are the best managed Postgres hosting options for a small startup?",
    assistantText: "Neon, Supabase and Render are good options. Neon Launch is $19/month.",
    createdAt: new Date("2026-11-03T10:05:00Z"),
    sources: [],
  });
  mem.saveClaims(t1, new Date("2026-11-03T10:05:00Z"), [{ entity: "Neon", attribute: "Launch plan price", value: "$19/month", sourceUrl: "https://neon.tech/pricing" }]);

  const c2 = mem.ensureConversation(undefined, "crm", new Date("2026-11-09T09:00:00Z"));
  mem.saveTurn({
    conversationId: c2,
    userText: "Shortlist 5 CRM tools for a 20-person sales team",
    assistantText: "HubSpot, Pipedrive, Salesforce, Attio, Close.",
    createdAt: new Date("2026-11-09T09:01:00Z"),
    sources: [],
  });
  return mem;
}

const weekday = (text: string, weekday: TemporalRef["weekday"], qualifier: TemporalRef["qualifier"]): TemporalRef => ({
  text, kind: "weekday", weekday, qualifier, month: null, day: null, year: null, amount: null, unit: null, name: null,
});
const date = (text: string, month: number, day: number): TemporalRef => ({
  text, kind: "calendar_date", weekday: null, qualifier: null, month, day, year: null, amount: null, unit: null, name: null,
});

describe("gate", () => {
  it("skips the planner for ordinary questions", () => {
    expect(mightReferToPast("What's the latest version of Node.js?")).toBe(false);
    expect(mightReferToPast("Explain how TCP slow start works")).toBe(false);
  });
  it("fires on back-references", () => {
    expect(mightReferToPast("What did I ask you on 3 November?")).toBe(true);
    expect(mightReferToPast("Last Tuesday I asked you about Postgres hosting")).toBe(true);
    expect(mightReferToPast("On Monday we shortlisted 5 CRM tools")).toBe(true);
  });
});

describe("recall", () => {
  it("finds the exchange for an exact date, with its claim ledger", () => {
    const plan: MemoryPlan = { refersToPast: true, topics: [], temporalRefs: [date("3 November", 11, 3)], wantsRecheck: true };
    const r = recall(plan, seeded(), NOW, TZ);
    expect(r.turns).toHaveLength(1);
    expect(r.context).toContain("Postgres hosting");
    expect(r.context).toContain("Neon | Launch plan price: $19/month");
    expect(r.context).toContain("re-verified");
  });

  it("'last Tuesday' searches both candidate Tuesdays and finds the 3rd", () => {
    const plan: MemoryPlan = { refersToPast: true, topics: ["Postgres hosting"], temporalRefs: [weekday("last Tuesday", "tuesday", "last")], wantsRecheck: true };
    const r = recall(plan, seeded(), NOW, TZ);
    expect(r.summary).toEqual([
      { label: "Tue 3 Nov 2026", found: 1 },
      { label: "Tue 10 Nov 2026", found: 0 },
    ]);
    expect(r.turns[0].userText).toMatch(/Postgres/);
  });

  it("is explicit about absence and points at nearby activity", () => {
    const plan: MemoryPlan = { refersToPast: true, topics: [], temporalRefs: [date("5 November", 11, 5)], wantsRecheck: false };
    const r = recall(plan, seeded(), NOW, TZ);
    expect(r.turns).toHaveLength(0);
    expect(r.context).toContain("NO_RECORD");
    expect(r.context).toContain("closest earlier: Tue 3 Nov 2026");
  });

  it("surfaces topic matches on other dates when the user misremembers", () => {
    const plan: MemoryPlan = { refersToPast: true, topics: ["CRM"], temporalRefs: [weekday("on Tuesday", "tuesday", "none")], wantsRecheck: true };
    const r = recall(plan, seeded(), NOW, TZ);
    expect(r.context).toContain("NO_RECORD");
    expect(r.context).toContain("OTHER dates");
    expect(r.turns[0].userText).toMatch(/CRM/);
  });

  it("topic-only recall searches all history", () => {
    const plan: MemoryPlan = { refersToPast: true, topics: ["CRM tools"], temporalRefs: [], wantsRecheck: false };
    const r = recall(plan, seeded(), NOW, TZ);
    expect(r.turns.map((t) => t.userText)).toEqual(["Shortlist 5 CRM tools for a 20-person sales team"]);
  });
});
