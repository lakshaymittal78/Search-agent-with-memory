# Design

## The problem, restated

The sample questions share one shape: *"At time T we discussed X. What's true now?"* Answering them takes two things beyond a good web-search agent:

1. Exact recall. "Last Tuesday" and "3 November" have to resolve to the right conversation, and when nothing exists the agent has to say so.
2. Per-fact re-verification. "Has pricing changed?" means checking the specific claims made earlier against today's web.

The architecture is built around those two.

## How a turn works

```
message ─► regex gate ─(back-reference?)─► planner (Haiku, structured output)
                │ no                          topics + temporal phrases, classified not resolved
                ▼                               │
           (skip, 0ms)                          ▼
                                       date resolver (pure code, user's timezone)
                                       "last Tuesday" → [Tue 3 Nov, Tue 10 Nov] (ambiguous → both)
                                                │
                                                ▼
                                       recall (SQLite: time index + FTS5, no LLM)
                                       past exchanges + claim ledger, or explicit NO_RECORD
                                                │
          ┌─────────────────────────────────────┘
          ▼
   answer loop (Opus, one tool: web_search) ── parallel calls, ≤4 rounds, streamed over SSE
          │
          ▼
   persist turn ─► claim extraction in background (Haiku): {entity, attribute, value, source}
```

- Recall runs in code before the model is called. The brief allows one tool, and a "should I check memory?" tool call would cost an extra model round trip. The model gets the evidence in a mid-conversation system message, so the static system prompt stays cached.
- The LLM classifies date phrases and code does the arithmetic, because models get weekday maths wrong. The planner labels "last Tuesday" as `{weekday: tuesday, qualifier: last}`, and `dates.ts` resolves it in the user's timezone (sent by the browser), handling DST, with unit tests. An ambiguous phrase produces several candidate dates; recall searches all of them and uses whichever has a conversation.
- When a date has no conversations, recall emits `NO_RECORD` along with the nearest activity and any topic matches on other days. The agent can then say "Nothing on 5 Nov, but we discussed Postgres on 3 Nov" instead of inventing a conversation.
- After each answer that used the web, the small model extracts the perishable facts (prices, versions, launches) as rows in a claim ledger. "Is your answer still correct?" then becomes a checklist: each claim is re-searched and reported as then → now, with a status and a source.
- The search tool is my own: `web_search(query, since?, freshness?, read_pages?)` over Brave or Tavily. Owning it gives date filters ("since Monday" → `since: 2026-11-09`), parallel calls (five CRMs means five searches in one round), timeouts, retry, a 10-minute cache and a log of every query. Snippets rarely include a pricing table, so `read_pages` opens the top results and extracts the relevant passages. That gets exact figures without adding a second tool.
- Most messages fail the regex gate and skip the memory step entirely. The prompt tells the model when to search, so small talk gets no searches. Tokens stream as soon as they exist, and the UI shows each search as it runs.

## Choices and rejections

| Considered | Decision | Why |
|---|---|---|
| Memory as a second tool | Rejected | Breaks the one-tool rule and adds a model round trip on every recall question. |
| Vector DB / embeddings | Rejected | These questions are keyed by date first and topic second. A time index plus FTS5 is exact, easy to explain, and needs no extra infrastructure. Embeddings would help fuzzy topic recall at scale (see below). |
| Stuff all history into context | Rejected | Slow, expensive, and worse than an index at "what did I say on the 3rd". |
| Provider's built-in web search | Rejected | Less control over date filters, logging and page reading, and it ties the design to one model vendor. |
| LangChain / agent frameworks | Rejected | The loop is about 150 lines and is the part being judged. A framework would hide it. |
| Planner / researcher / writer multi-agent | Rejected | Adds latency with no accuracy gain on these questions. Parallel tool calls already cover the fan-out. |
| `node:sqlite` vs `better-sqlite3` | `node:sqlite` | No native compile step, so `npm install && npm run dev` works on any OS. |
| One big model for everything | Split | Opus writes the answers, where the user is waiting and quality matters. Haiku plans and extracts, where speed and cost matter more. |

## Known limits

- There is no auth, so each install has one user and one memory.
- The seed script produces "past" turns with the real agent and a moved clock, but those turns search today's web. They test recall and recheck; they can't show what the web looked like on that date.
- Page reading converts HTML to text with regexes, so JavaScript-rendered pricing pages can come back empty. The model is told to say when it couldn't verify something.

## With another week

1. An eval harness: about 50 scripted multi-session conversations under a fake clock, graded by an LLM judge on recall accuracy, refusal to hallucinate, citation validity and latency. Every prompt change would be tested against it.
2. Claim diffing in code: re-search each claim, extract the current value with structured output, and decide changed or unchanged deterministically before the model writes prose.
3. Hybrid recall: embeddings alongside FTS for paraphrased topics ("the database thing").
4. Better page reading: a readability-style extractor with a headless-browser fallback for JavaScript pages, and pages cached by URL and ETag.
5. Proactive freshness: a nightly job re-checks stored claims and flags drift, so "has anything changed?" can be answered without waiting on searches.
6. Multiple users: auth, per-user memory, and a way to forget a conversation.
