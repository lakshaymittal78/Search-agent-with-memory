/**
 * Memory planner. Decides whether this message refers to earlier conversations and,
 * if so, *what* and *when*: topic keywords plus temporal phrases in a structured form
 * that dates.ts can resolve exactly.
 *
 * Two stages, so ordinary questions pay nothing:
 *   1. A regex gate (free, ~0ms). Most messages have no back-reference and skip stage 2.
 *   2. A small, fast model with structured output (~0.5s) for the ones that do.
 */
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic } from "../llm.js";
import { config } from "../config.js";
import { describeNow, WEEKDAYS, type TemporalRef } from "../memory/dates.js";

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const DAY = "(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?";
const GATE = new RegExp(
  [
    String.raw`\b(?:i|we)\s+(?:asked|said|told|mentioned|shortlisted|discussed|talked|looked|compared|chose|picked|decided|shared|gave)\b`,
    String.raw`\byou\s+(?:said|told|recommended|suggested|answered|mentioned|found|gave|listed)\b`,
    String.raw`\b(?:last|this|on|since)\s+${DAY}\b`,
    String.raw`\b${DAY}\b`,
    String.raw`\b(?:yesterday|earlier|previously|last\s+time|last\s+week|last\s+month|ago|remember|recall|our\s+(?:chat|conversation)|still\s+(?:correct|true|accurate|valid))\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\b`,
    String.raw`\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?\b`,
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
  ].join("|"),
  "i",
);

export function mightReferToPast(message: string): boolean {
  return GATE.test(message);
}

const TemporalRefSchema = z.object({
  text: z.string().describe("The exact phrase from the message, e.g. 'last Tuesday'"),
  kind: z.enum(["weekday", "calendar_date", "relative", "named"]),
  weekday: z.enum(WEEKDAYS).nullable().describe("For kind=weekday"),
  qualifier: z.enum(["last", "this", "none"]).nullable().describe("For kind=weekday: 'last Tuesday'→last, 'this Tuesday'→this, 'on Tuesday'→none"),
  month: z.number().int().nullable().describe("For kind=calendar_date: 1-12"),
  day: z.number().int().nullable().describe("For kind=calendar_date: day of month"),
  year: z.number().int().nullable().describe("For kind=calendar_date, only if the user stated a year"),
  amount: z.number().int().nullable().describe("For kind=relative: '3 days ago'→3"),
  unit: z.enum(["day", "week", "month"]).nullable().describe("For kind=relative"),
  name: z.enum(["today", "yesterday", "this_week", "last_week", "this_month", "last_month"]).nullable().describe("For kind=named"),
});

const PlanSchema = z.object({
  refers_to_past_conversation: z
    .boolean()
    .describe("True if the user refers to something said, asked, decided or shared in an EARLIER conversation with this assistant"),
  topics: z.array(z.string()).describe("Short keyword phrases naming what was discussed, e.g. ['Postgres hosting'], ['CRM', 'sales team']. Empty if none."),
  temporal_refs: z.array(TemporalRefSchema).describe("Every phrase that pins WHEN the earlier conversation happened. Empty if none."),
  wants_recheck: z.boolean().describe("True if the user wants the earlier answer re-verified or wants to know what changed since"),
});

export type MemoryPlan = {
  refersToPast: boolean;
  topics: string[];
  temporalRefs: TemporalRef[];
  wantsRecheck: boolean;
};

const EMPTY: MemoryPlan = { refersToPast: false, topics: [], temporalRefs: [], wantsRecheck: false };

const SYSTEM = `You extract memory-lookup parameters from a chat message sent to an AI assistant that remembers past conversations with this user.
Only fill temporal_refs with phrases about WHEN an earlier conversation or event in it happened ("on Monday", "last Tuesday", "3 November", "two weeks ago", "yesterday").
Do not resolve dates yourself; classify the phrase. "Monday" with no qualifier → kind=weekday, qualifier=none. "Nov 3rd" → kind=calendar_date, month=11, day=3, year=null.
Topics should be the nouns that would appear in that earlier conversation, not words like "pricing changes" alone — include the product category too.`;

export async function planMemory(message: string, recentContext: string, now: Date, tz: string): Promise<MemoryPlan> {
  if (!mightReferToPast(message)) return EMPTY;
  try {
    const res = await anthropic.messages.parse({
      model: config.fastModel,
      max_tokens: 2000,
      output_config: { effort: "low", format: zodOutputFormat(PlanSchema) },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Now: ${describeNow(now, tz)}\n\nRecent messages in this chat (may be empty):\n${recentContext || "(none)"}\n\nMessage to analyse:\n${message}`,
        },
      ],
    });
    const p = res.parsed_output;
    if (!p) return EMPTY;
    return {
      refersToPast: p.refers_to_past_conversation,
      topics: p.topics,
      temporalRefs: p.temporal_refs,
      wantsRecheck: p.wants_recheck,
    };
  } catch (err) {
    // Memory is an enhancement: if planning fails, answer without it rather than fail the turn.
    console.warn("[planner] failed, continuing without memory:", (err as Error).message);
    return EMPTY;
  }
}
