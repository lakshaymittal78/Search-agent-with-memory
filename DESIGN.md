# Design

## Problem and approach

The main problem this agent solves is connecting past conversations with current information. The sample questions generally follow this pattern: *We discussed something at a particular time. What did we establish, and is it still true today?*
<img width="1668" height="2776" alt="mermaid-diagram (1)" src="https://github.com/user-attachments/assets/8c46f18b-b658-447e-8dd6-d592df04a247" />

This requires two capabilities:

1. **Reliable recall:** Find the correct past conversation using dates and topics, without making up information when no record exists.
2. **Freshness verification:** Revisit specific claims from previous answers and check whether they are still accurate.

I designed the system around these two requirements.

## How the system works

A user message first passes through a lightweight regex check. If it doesn't look like a question requiring historical context, the memory pipeline is skipped.

For relevant questions, a Haiku-based planner identifies topics and temporal expressions. It classifies phrases such as "last Tuesday" but does not calculate dates itself.

A date resolver written in TypeScript handles the actual date calculations using the user's timezone. This keeps date arithmetic deterministic and makes it easier to test edge cases such as daylight saving time and ambiguous weekday references.

The recall layer uses SQLite with a time index and FTS5 for keyword-based retrieval. It returns relevant past conversations and previously extracted claims. If nothing exists for the requested date, it explicitly returns `NO_RECORD` rather than allowing the model to assume something happened.

The retrieved information is then provided to the Opus model, which handles the answer and can use one custom `web_search` tool. Multiple searches can run in parallel, with a maximum of four rounds. Responses are streamed to the frontend through SSE.

After a web-assisted answer, Haiku extracts important claims such as prices, versions and product announcements. These are stored in a claim ledger containing the entity, attribute, value and source. Future verification questions can use these records as a checklist and compare previous information against current search results.

## Important design decisions

- **Recall happens before the model call.** I chose code-based retrieval instead of making memory a second tool. This avoids an additional model round trip and keeps the implementation within the one-tool constraint.
- **Date interpretation is split between the model and code.** The model understands natural language expressions, while TypeScript performs date calculations. This avoids relying on an LLM for weekday arithmetic.
- **SQLite instead of a vector database.** The primary retrieval requirement is finding conversations associated with specific dates, followed by topic matching. A time index and FTS5 are sufficient for this use case without introducing additional infrastructure. Embeddings could improve retrieval for heavily paraphrased queries in the future.
- **A claim ledger instead of storing entire answers as memory.** Individual facts are easier to verify than a complete previous response. Each claim can be searched independently.
- **A custom web search implementation.** I wanted control over date filtering, parallel searches, retries, timeouts, caching and page extraction. The implementation supports Brave or Tavily and can read pages when search snippets don't contain enough detail.
- **No agent framework.** The answer loop is relatively small, so implementing it directly makes the control flow, tool calls and error handling easier to understand.
- **Separate models for different tasks.** Opus handles final responses, where answer quality matters most. Haiku handles planning and claim extraction, where speed and cost are more important.
- **`node:sqlite` instead of `better-sqlite3`.** This avoids an additional native compilation dependency and simplifies installation.

## Limitations

There is currently no authentication or multi-user support. Each installation has a single memory store.

The seed script creates historical conversations using a shifted clock, but web searches still use current information. Therefore, it tests historical recall and freshness verification, not historical web accuracy.

The page reader extracts text from HTML using regex-based processing. Pages that render pricing information through JavaScript may not return usable content. The agent should communicate when it cannot verify a claim rather than presenting an unsupported answer.

## What I would improve with another week

1. **Evaluation:** Build an evaluation suite with approximately 50 multi-session conversations under a fake clock. Test date resolution, recall accuracy, hallucination avoidance, citations and latency.
2. **Deterministic claim verification:** Extract current claim values using structured output and compare them in code before generating the final response.
3. **Hybrid retrieval:** Combine FTS5 with embeddings to improve recall when users describe previous discussions using different wording.
4. **Improved page extraction:** Introduce a readability-based extractor and a headless-browser fallback for JavaScript-rendered pages.
5. **Proactive freshness checks:** Periodically recheck stored claims and flag information that may have changed.
6. **Multi-user support:** Add authentication, isolated user memories and conversation deletion capabilities.
