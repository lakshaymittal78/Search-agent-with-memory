import "dotenv/config";

type SearchProvider = "brave" | "tavily";

function pickSearchProvider(): SearchProvider | null {
  const explicit = process.env.SEARCH_PROVIDER?.trim().toLowerCase();
  if (explicit === "brave" || explicit === "tavily") return explicit;
  if (process.env.BRAVE_API_KEY) return "brave";
  if (process.env.TAVILY_API_KEY) return "tavily";
  return null;
}

const effort = process.env.MAIN_EFFORT?.trim().toLowerCase();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "./data/agent.db",
  mainModel: process.env.MAIN_MODEL ?? "claude-opus-5-5",
  fastModel: process.env.FAST_MODEL ?? "claude-haiku-5-5",
  mainEffort: (effort === "low" || effort === "high" ? effort : "medium") as "low" | "medium" | "high",
  searchProvider: pickSearchProvider(),
  braveKey: process.env.BRAVE_API_KEY ?? "",
  tavilyKey: process.env.TAVILY_API_KEY ?? "",
  /** Max model↔tool round trips per user turn before we force a final answer. */
  maxToolRounds: 4,
  /** Prior turns of the current conversation replayed verbatim to the model. */
  historyTurns: 12,
};

export function assertConfig(): void {
  if (!config.searchProvider) {
    throw new Error(
      "No web search key found. Set BRAVE_API_KEY or TAVILY_API_KEY in .env (see .env.example).",
    );
  }
  if (config.searchProvider === "brave" && !config.braveKey) throw new Error("SEARCH_PROVIDER=brave but BRAVE_API_KEY is empty.");
  if (config.searchProvider === "tavily" && !config.tavilyKey) throw new Error("SEARCH_PROVIDER=tavily but TAVILY_API_KEY is empty.");
}
