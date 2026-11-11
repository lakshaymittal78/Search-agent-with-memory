/**
 * Seeds demo history by running the REAL agent with the clock moved into the past.
 * The stored answers, sources and claim ledgers are genuine agent output, not
 * hand-written fixtures, so the "what changed since?" flows can be tried immediately.
 *
 *   npm run seed            # skips scenarios whose date already has history
 *
 * Note: searches run against today's web, so "past" answers reflect current data.
 * The point is to exercise recall and the recheck path, not to time-travel the web.
 */
import { assertConfig } from "../src/config.js";
import { clock } from "../src/clock.js";
import { runTurn } from "../src/agent/loop.js";
import { store } from "../src/memory/store.js";

assertConfig();
const tz = process.env.SEED_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

// Dates relative to "today" so the sample questions ("on Monday", "last Tuesday", "3 November") keep working.
function daysAgoAt(weekday: number, weeksBack: number, hour: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour));
  const back = ((d.getUTCDay() - weekday + 7) % 7 || 7) + 7 * weeksBack;
  d.setUTCDate(d.getUTCDate() - back);
  return d;
}

const scenarios = [
  {
    at: daysAgoAt(2, 0, 10), // most recent Tuesday before today
    turns: [
      "What are the best managed Postgres hosting options for a small SaaS startup, and what do they cost? Compare Neon, Supabase, AWS RDS, Render and Crunchy Bridge.",
    ],
  },
  {
    at: daysAgoAt(2, 1, 15), // the Tuesday before that (covers both readings of "last Tuesday")
    turns: ["Which Postgres hosting provider has the cheapest plan with point-in-time recovery?"],
  },
  {
    at: daysAgoAt(1, 0, 9), // most recent Monday
    turns: [
      "We're a 20-person sales team. Shortlist 5 CRM tools for us with per-seat pricing.",
      "Great, let's go with HubSpot, Pipedrive, Salesforce Sales Cloud, Attio and Close as our shortlist.",
    ],
  },
];

const mem = store();
for (const s of scenarios) {
  const dayStart = new Date(Date.UTC(s.at.getUTCFullYear(), s.at.getUTCMonth(), s.at.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  if (mem.turnsInRange(dayStart, dayEnd).length) {
    console.log(`skip ${s.at.toISOString().slice(0, 10)}: already has history`);
    continue;
  }
  let conversationId: string | undefined;
  let minute = 0;
  for (const message of s.turns) {
    clock.set(new Date(s.at.getTime() + minute++ * 3 * 60_000));
    console.log(`\n[${clock.now().toISOString()}] > ${message}`);
    const res = await runTurn({
      conversationId,
      message,
      timezone: tz,
      emit: (e) => {
        if (e.type === "search_start") console.log(`   search: ${e.query}`);
        if (e.type === "error") console.log(`   error: ${e.message}`);
      },
    });
    conversationId = res.conversationId;
    const n = await res.claims;
    console.log(`   answered (${res.answer.length} chars), ${n} claims recorded`);
  }
}
clock.set(null);
console.log("\nSeed complete. Run `npm run dev` and try: \"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?\"");
