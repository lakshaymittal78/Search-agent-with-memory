import { clock } from "../clock.js";
import type { SearchHit, SearchParams, SearchProvider } from "./types.js";

// https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

type BraveResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
  extra_snippets?: string[];
};

export class BraveSearch implements SearchProvider {
  readonly name = "brave";
  constructor(private apiKey: string) {}

  async search(p: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
    const url = new URL(ENDPOINT);
    url.searchParams.set("q", p.query);
    url.searchParams.set("count", String(p.count ?? 8));
    url.searchParams.set("extra_snippets", "true");
    url.searchParams.set("text_decorations", "false");
    if (p.since) {
      const today = clock.now().toISOString().slice(0, 10);
      url.searchParams.set("freshness", `${p.since}to${today}`);
    } else if (p.freshness) {
      url.searchParams.set("freshness", FRESHNESS[p.freshness]);
    }

    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey },
      signal,
    });
    if (!res.ok) throw new Error(`Brave search HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { web?: { results?: BraveResult[] } };

    return (data.web?.results ?? [])
      .filter((r) => r.url && r.title)
      .map((r) => ({
        title: r.title!,
        url: r.url!,
        snippet: r.description ?? "",
        published: r.page_age ?? r.age ?? null,
        content: r.extra_snippets?.length ? r.extra_snippets.join(" … ") : undefined,
      }));
  }
}
