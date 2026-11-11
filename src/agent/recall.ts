/**
 * Recall: turns a MemoryPlan into evidence the answering model can rely on.
 *
 * Deterministic and code-driven (no LLM): date ranges come from dates.ts, rows from SQLite.
 * The output is honest about absence. When nothing exists for a date, the model is told
 * so explicitly (NO_RECORD), along with the nearest activity and any topic matches on other
 * days, so it can say "I have nothing on 3 Nov, but we discussed Postgres on 4 Nov".
 */
import type { MemoryPlan } from "./planner.js";
import { describeInstant, isoDateIn, resolveRef, type ResolvedRange } from "../memory/dates.js";
import type { Claim, MemoryStore, Turn } from "../memory/store.js";

export type RecallResult = {
  /** Text block injected into the model context; empty when memory wasn't needed. */
  context: string;
  /** Compact summary for the UI ("Recalled 2 turns from Tue 3 Nov"). */
  summary: { label: string; found: number }[];
  turns: Turn[];
};

const MAX_ANSWER_CHARS = 2500;

export function recall(plan: MemoryPlan, mem: MemoryStore, now: Date, tz: string, excludeConversation?: string): RecallResult {
  if (!plan.refersToPast && plan.temporalRefs.length === 0) return { context: "", summary: [], turns: [] };

  const sections: string[] = [];
  const summary: RecallResult["summary"] = [];
  const seen = new Map<string, Turn>();
  const keep = (t: Turn) => {
    // The current conversation is already in the model's history, so don't duplicate it.
    if (t.conversationId !== excludeConversation && !seen.has(t.id)) seen.set(t.id, t);
  };

  // 1) Date-anchored lookups: exact, and the reason this design uses a time index.
  for (const { ref, candidates, note } of plan.temporalRefs.map((r) => resolveRef(r, now, tz))) {
    const lines: string[] = [`Phrase "${ref.text}" resolves to: ${candidates.map((c) => c.label).join("  OR  ") || "(unresolvable)"}${note ? `  [${note}]` : ""}`];
    for (const range of candidates) {
      const hits = mem.turnsInRange(range.start, range.end, plan.topics).filter((t) => t.conversationId !== excludeConversation);
      summary.push({ label: range.label, found: hits.length });
      if (hits.length) {
        lines.push(`  ${range.label}: ${hits.length} exchange(s) found (listed below).`);
        hits.forEach(keep);
      } else {
        lines.push(`  ${range.label}: NO_RECORD. No conversations on this date.${nearestNote(mem, range, tz)}`);
      }
    }
    sections.push(lines.join("\n"));
  }

  // 2) Topic lookups across all time, so we can catch the user misremembering the date.
  if (plan.topics.length) {
    const byTopic = mem.searchTurns(plan.topics, 5, now).filter((t) => t.conversationId !== excludeConversation);
    const outside = byTopic.filter((t) => !seen.has(t.id));
    if (plan.temporalRefs.length === 0) {
      summary.push({ label: `topic: ${plan.topics.join(", ")}`, found: byTopic.length });
      byTopic.forEach(keep);
      if (!byTopic.length) sections.push(`Topic search for ${JSON.stringify(plan.topics)}: NO_RECORD in any past conversation.`);
    } else if (outside.length) {
      sections.push(
        `Topic matches on OTHER dates (the user may have the date wrong): ${outside
          .slice(0, 3)
          .map((t) => `${describeInstant(t.createdAt, tz)} — "${clip(t.userText, 80)}"`)
          .join("; ")}`,
      );
      // Only pull these in if the requested dates turned up nothing at all.
      if (seen.size === 0) outside.slice(0, 3).forEach(keep);
    }
  }

  const turns = [...seen.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const claims = mem.claimsForTurns(turns.map((t) => t.id));

  const body = turns.map((t) => renderTurn(t, claims.get(t.id) ?? [], tz)).join("\n\n");
  const context = [
    "<memory>",
    "Retrieved by the system from this user's past conversations with you. This is the complete record for the dates/topics below. If something is not here, you did not discuss it on that date. Never invent past exchanges.",
    sections.join("\n\n"),
    turns.length ? `\n${body}` : "\nNo matching past exchanges were found.",
    plan.wantsRecheck ? "\nThe user wants these earlier answers re-verified against the web *today*. Re-check each claim; report what changed, what didn't, and what you couldn't verify." : "",
    "</memory>",
  ].join("\n");

  return { context, summary, turns };
}

function renderTurn(t: Turn, claims: Claim[], tz: string): string {
  const parts = [
    `<past_exchange when="${describeInstant(t.createdAt, tz)}" date="${isoDateIn(t.createdAt, tz)}">`,
    `User asked: ${t.userText}`,
    `You answered: ${clip(t.assistantText, MAX_ANSWER_CHARS)}`,
  ];
  if (claims.length) {
    parts.push("Time-sensitive claims recorded from that answer (as observed then):");
    for (const c of claims) parts.push(`  - ${c.entity} | ${c.attribute}: ${c.value}${c.sourceUrl ? ` (source: ${c.sourceUrl})` : ""}`);
  }
  parts.push("</past_exchange>");
  return parts.join("\n");
}

function nearestNote(mem: MemoryStore, range: ResolvedRange, tz: string): string {
  const { before, after } = mem.nearestActivity(range.start, range.end);
  const bits: string[] = [];
  if (before) bits.push(`closest earlier: ${describeInstant(before.createdAt, tz)} ("${clip(before.userText, 60)}")`);
  if (after) bits.push(`closest later: ${describeInstant(after.createdAt, tz)} ("${clip(after.userText, 60)}")`);
  return bits.length ? ` Nearby activity: ${bits.join("; ")}.` : " No conversation history exists at all before this one.";
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
