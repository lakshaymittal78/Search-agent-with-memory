import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { assertConfig, config } from "./config.js";
import { runTurn } from "./agent/loop.js";
import { store } from "./memory/store.js";
import { isValidTimeZone } from "./memory/dates.js";

assertConfig();

const app = new Hono();

const ChatBody = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(8000),
  timezone: z.string().optional(),
});

app.post("/api/chat", async (c) => {
  const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
  const { conversationId, message } = parsed.data;
  const tz = parsed.data.timezone && isValidTimeZone(parsed.data.timezone) ? parsed.data.timezone : "UTC";

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    const started = Date.now();
    // Serialize writes so events arrive in order, and drain them before the stream closes.
    let writes: Promise<unknown> = Promise.resolve();
    try {
      await runTurn({
        conversationId,
        message,
        timezone: tz,
        signal: abort.signal,
        emit: (e) => {
          writes = writes.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => {});
        },
      });
    } catch (err) {
      console.error("[chat] turn failed:", (err as Error).message);
    } finally {
      await writes;
      console.log(`[chat] turn finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  });
});

app.get("/api/conversations", (c) => c.json(store().listConversations()));

app.get("/api/conversations/:id", (c) => {
  const turns = store().conversationTurns(c.req.param("id"), 200);
  return c.json(turns);
});

app.get("/api/health", (c) => c.json({ ok: true, search: config.searchProvider, model: config.mainModel }));

app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`\n  Agent ready → http://localhost:${info.port}`);
  console.log(`  model: ${config.mainModel} (effort ${config.mainEffort}) · planner: ${config.fastModel} · search: ${config.searchProvider}\n`);
});
