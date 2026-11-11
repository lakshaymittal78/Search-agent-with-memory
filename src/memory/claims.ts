/**
 * Claim ledger: after a turn that used the web, pull out the perishable facts the
 * answer asserted (price, plan limit, version, launch, status) as structured rows.
 *
 * Runs off the critical path, after the answer has streamed, on the small model.
 * Later, "is that still true?" re-checks these rows one by one instead of making the
 * model re-read and re-interpret its own old prose.
 */
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic } from "../llm.js";
import { config } from "../config.js";
import type { MemoryStore } from "./store.js";

const ClaimsSchema = z.object({
  claims: z
    .array(
      z.object({
        entity: z.string().describe("Product, company, person or thing, e.g. 'Neon'"),
        attribute: z.string().describe("What about it, e.g. 'Launch plan price'"),
        value: z.string().describe("The asserted value, verbatim-ish, e.g. '$19/month, 10 GB storage'"),
        source_url: z.string().nullable().describe("URL the answer cited for this, if any"),
      }),
    )
    .describe("Time-sensitive factual claims only. Skip opinions, advice and timeless facts. Max 25."),
});

export async function extractAndStoreClaims(mem: MemoryStore, turnId: string, observedAt: Date, question: string, answer: string): Promise<number> {
  try {
    const res = await anthropic.messages.parse({
      model: config.fastModel,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(ClaimsSchema) },
      system:
        "Extract the time-sensitive factual claims an assistant's answer makes: facts that could become wrong later (prices, plan limits, features shipped, versions, dates, who holds a role, availability). One claim per fact. Keep values short and exact.",
      messages: [{ role: "user", content: `Question:\n${question}\n\nAnswer:\n${answer}` }],
    });
    const claims = (res.parsed_output?.claims ?? []).slice(0, 25);
    mem.saveClaims(
      turnId,
      observedAt,
      claims.map((c) => ({ entity: c.entity, attribute: c.attribute, value: c.value, sourceUrl: c.source_url })),
    );
    return claims.length;
  } catch (err) {
    console.warn("[claims] extraction failed:", (err as Error).message);
    return 0;
  }
}
