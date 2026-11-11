import type { SearchHit, SearchParams, SearchProvider } from "./types.js";

// https://docs.tavily.com/documentation/api-reference/endpoint/search
const ENDPOINT = "https://api.tavily.com/search";
const TIME_RANGE = { day: "day", week: "week", month: "month", year: "year" } as const;

type TavilyResult = { title?: string; url?: string; content?: string; published_date?: string };

export class TavilySearch implements SearchProvider {
  readonly name = "tavily";
  constructor(private apiKey: string) {}

  async search(p: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
    const body: Record<string, unknown> = {
      query: p.query,
      max_results: p.count ?? 8,
      search_depth: "basic",
      include_answer: false,
    };
    if (p.since) body.start_date = p.since;
    else if (p.freshness) body.time_range = TIME_RANGE[p.freshness];

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`Tavily search HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { results?: TavilyResult[] };

    return (data.results ?? [])
      .filter((r) => r.url && r.title)
      .map((r) => ({
        title: r.title!,
        url: r.url!,
        snippet: (r.content ?? "").slice(0, 600),
        published: r.published_date ?? null,
      }));
  }
}
