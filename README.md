# Search Agent

A chat agent with one tool, **web search**, and a date-indexed memory of past conversations. It can answer "What did I ask you on 3 November? Is it still correct?" by recalling the exact exchange and re-checking each claim against today's web.

See [DESIGN.md](DESIGN.md) for the architecture and the reasoning behind it.

## Run it

Requires Node 22.13+ (it uses the built-in `node:sqlite`).

```bash
cp .env.example .env     # add ANTHROPIC_API_KEY and BRAVE_API_KEY (or TAVILY_API_KEY)
npm install
npm run dev              # → http://localhost:3000
```

Optional: run `npm run seed` to create demo history (Postgres hosting last Tuesday, a CRM shortlist on Monday) by running the real agent with its clock moved back. Then try:

- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
- "What did I ask you on 3 November? Is your answer still correct today?"

## Search providers

| Provider | Free allowance | Key |
|---|---|---|
| [Brave Search API](https://brave.com/search/api/) | $5 credit per month (~1,000 queries), card required | `BRAVE_API_KEY` |
| [Tavily](https://tavily.com/) | 1,000 credits per month, no card | `TAVILY_API_KEY` |

Set either one. If both are set, Brave is used unless `SEARCH_PROVIDER=tavily`.

## Layout

```
src/
  server.ts           Hono routes, SSE streaming
  agent/loop.ts       one turn: plan → recall → tool loop → persist → claims
  agent/planner.ts    regex gate + small-model memory planner (structured output)
  agent/recall.ts     date/topic lookups → evidence block (incl. NO_RECORD)
  agent/prompt.ts     static system prompt + per-turn context
  memory/dates.ts     temporal resolver (pure, timezone/DST-safe, tested)
  memory/store.ts     SQLite: turns (time index + FTS5), claims, searches
  memory/claims.ts    post-turn claim extraction
  search/             provider-agnostic web_search: Brave, Tavily, page reading
public/index.html     chat UI (no build step)
scripts/seed.ts       demo history via the real agent
test/                 date resolver + recall tests (no API keys needed)
```

`npm test` runs the unit tests and `npm run typecheck` runs the type checker.
