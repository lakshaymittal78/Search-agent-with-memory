export type SearchParams = {
  query: string;
  /** Only results published on/after this date (YYYY-MM-DD). */
  since?: string;
  /** Coarse recency filter when no exact date applies. */
  freshness?: "day" | "week" | "month" | "year";
  count?: number;
};

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  /** Publication / last-updated date if the provider knows it (free-form). */
  published: string | null;
  /** Extra passages from the page itself (provider-supplied or fetched by pages.ts). */
  content?: string;
};

export interface SearchProvider {
  readonly name: string;
  search(p: SearchParams, signal?: AbortSignal): Promise<SearchHit[]>;
}
