/**
 * One user turn, end to end:
 *
 *   plan memory (regex gate → small model)  →  recall (SQL, no LLM)
 *     →  answer loop (main model ⇄ web_search, parallel calls, bounded rounds, streamed)
 *     →  persist turn  →  extract claims in the background
 */
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { anthropic } from "../llm.js";
import { config } from "../config.js";
import { clock } from "../clock.js";
import { store, type Source } from "../memory/store.js";
import { extractAndStoreClaims } from "../memory/claims.js";
import { isoDateIn, resolveRef } from "../memory/dates.js";
import { planMemory } from "./planner.js";
import { recall } from "./recall.js";
import { SYSTEM_PROMPT, turnContext } from "./prompt.js";
import { formatHits, runWebSearch, WebSearchInput, webSearchTool } from "../search/index.js";

export type AgentEvent =
  | { type: "start"; conversationId: string; turnId: string }
  | { type: "memory"; items: { label: string; found: number }[] }
  | { type: "search_start"; id: string; query: string; since?: string }
  | { type: "search_end"; id: string; count: number; sources: Source[]; error?: string }
  | { type: "text"; delta: string }
  | { type: "done"; conversationId: string; turnId: string; sources: Source[] }
  | { type: "error"; message: string };

export type TurnInput = {
  conversationId?: string;
  message: string;
  timezone: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
};

export type TurnResult = { conversationId: string; turnId: string; answer: string; claims: Promise<number> };

export async function runTurn({ conversationId, message, timezone: tz, emit, signal }: TurnInput): Promise<TurnResult> {
  const now = clock.now();
  const mem = store();
  const convId = mem.ensureConversation(conversationId, message, now);
  const turnId = randomUUID();
  emit({ type: "start", conversationId: convId, turnId });

  // ── 1. Memory ────────────────────────────────────────────────────────────
  const history = mem.conversationTurns(convId, config.historyTurns);
  const recent = history.slice(-2).map((t) => `User: ${t.userText}`).join("\n");
  const plan = await planMemory(message, recent, now, tz);
  const recalled = recall(plan, mem, now, tz, convId);
  if (recalled.summary.length) emit({ type: "memory", items: recalled.summary });

  // Resolved dates are useful to the model even with no memory hit, e.g. as `since` for searches.
  const resolvedDates = plan.temporalRefs.map((r) => {
    const { candidates } = resolveRef(r, now, tz);
    return `"${r.text}" = ${candidates.map((c) => `${c.label} (${isoDateIn(c.start, tz)})`).join(" or ") || "unresolved"}`;
  });

  // ── 2. Context ───────────────────────────────────────────────────────────
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const t of history) {
    messages.push({ role: "user", content: t.userText }, { role: "assistant", content: t.assistantText || "(no answer)" });
  }
  messages.push({ role: "user", content: message });
  messages.push({ role: "system", content: turnContext(now, tz, recalled.context, resolvedDates) });

  // ── 3. Answer loop ───────────────────────────────────────────────────────
  const sources = new Map<string, Source>();
  const answerParts: string[] = [];
  let round = 0;
  let jsonRetries = 0;

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const finalRound = round >= config.maxToolRounds;
      const stream = anthropic.beta.messages.stream(
        {
          model: config.mainModel,
          max_tokens: 16000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [webSearchTool],
          // Out of rounds: answer with what we have instead of searching forever.
          tool_choice: finalRound ? { type: "none" } : { type: "auto" },
          messages,
          output_config: { effort: config.mainEffort },
          cache_control: { type: "ephemeral" },
          // On a safety decline, the API re-runs the request on a fallback model in the same call.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );

      let roundText = "";
      stream.on("text", (delta) => {
        if (!roundText && answerParts.length) emit({ type: "text", delta: "\n\n" });
        roundText += delta;
        emit({ type: "text", delta });
      });

      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // Only an unparseable streamed tool input is retried here; API errors propagate.
        if (err instanceof Anthropic.APIError || (err as Error).name === "AbortError" || jsonRetries++ >= 2) throw err;
        continue;
      }
      if (roundText) answerParts.push(roundText);

      if (msg.stop_reason === "refusal") {
        if (!roundText) {
          const t = "I can't help with that request.";
          emit({ type: "text", delta: t });
          answerParts.push(t);
        }
        break;
      }
      if (msg.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: msg.content });
        continue;
      }

      const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) break;
      if (msg.stop_reason === "max_tokens") throw new Error("The response was cut off while preparing a search. Please try again.");

      messages.push({ role: "assistant", content: msg.content });
      round++;

      // Run every search the model asked for in parallel.
      const results = await Promise.all(
        toolUses.map(async (tu): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const parsed = WebSearchInput.safeParse(tu.input);
          if (tu.name !== "web_search" || !parsed.success) {
            return { type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Invalid tool call: ${parsed.success ? `unknown tool ${tu.name}` : parsed.error.message}` };
          }
          const input = parsed.data;
          emit({ type: "search_start", id: tu.id, query: input.query, since: input.since });
          try {
            const hits = await runWebSearch(input);
            mem.logSearch(turnId, input.query, input, hits.length, now);
            const found = hits.map((h) => ({ title: h.title, url: h.url, published: h.published }));
            for (const s of found) if (!sources.has(s.url)) sources.set(s.url, s);
            emit({ type: "search_end", id: tu.id, count: hits.length, sources: found.slice(0, 5) });
            return { type: "tool_result", tool_use_id: tu.id, content: formatHits(input, hits) };
          } catch (err) {
            const reason = (err as Error).message;
            emit({ type: "search_end", id: tu.id, count: 0, sources: [], error: reason });
            return { type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Search failed: ${reason}. Tell the user if this prevents a reliable answer.` };
          }
        }),
      );
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    const msg =
      err instanceof Anthropic.AuthenticationError ? "The Anthropic API key is missing or invalid."
      : err instanceof Anthropic.RateLimitError ? "The model is rate-limited right now. Please retry in a moment."
      : err instanceof Anthropic.APIError ? `Model API error (${err.status}): ${err.message}`
      : (err as Error).name === "AbortError" ? "Stopped."
      : (err as Error).message;
    emit({ type: "error", message: msg });
    if (!answerParts.length) throw err;
  }

  // ── 4. Persist ───────────────────────────────────────────────────────────
  const answer = answerParts.join("\n\n").trim();
  // Keep the sources the answer actually cited; fall back to everything we saw.
  const cited = [...sources.values()].filter((s) => answer.includes(s.url));
  const keptSources = cited.length ? cited : [...sources.values()].slice(0, 8);
  mem.saveTurn({ id: turnId, conversationId: convId, userText: message, assistantText: answer, createdAt: now, sources: keptSources });
  emit({ type: "done", conversationId: convId, turnId, sources: keptSources });

  // ── 5. Claim ledger (background) ────────────────────────────────────────
  const claims = sources.size > 0 ? extractAndStoreClaims(mem, turnId, now, message, answer) : Promise.resolve(0);
  return { conversationId: convId, turnId, answer, claims };
}
