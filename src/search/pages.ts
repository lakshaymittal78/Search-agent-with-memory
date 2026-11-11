/**
 * Optional page reading for the web_search tool (`read_pages: true`).
 *
 * Search snippets are often too thin for exact facts (a pricing table, a changelog entry).
 * Rather than adding a second "fetch" tool, which the brief rules out, web_search can
 * open its own top results and return the passages most relevant to the query.
 */
const MAX_BYTES = 1_500_000;
const PASSAGE = 450;

function isPublicHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    // Basic SSRF guard: never let search results point us at local/private hosts.
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h.startsWith("[")) return false; // IPv6 literals
    return true;
  } catch {
    return false;
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/td|\/th)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Pick the passages that best match the query, in page order. */
export function relevantPassages(text: string, query: string, budget = 2400): string {
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}$€£]+/u).filter((w) => w.length > 2))];
  const wantsNumbers = /(price|pricing|cost|plan|\$|tier|fee|rate|version|release)/i.test(query);
  const chunks: { i: number; text: string; score: number }[] = [];
  for (let i = 0; i < text.length; i += PASSAGE) {
    const chunk = text.slice(i, i + PASSAGE);
    const lc = chunk.toLowerCase();
    let score = 0;
    for (const t of terms) if (lc.includes(t)) score += 2;
    if (wantsNumbers && /[$€£]\s?\d|\d+(\.\d+)?\s?(\/mo|per month|\/month|usd|gb|users?)/i.test(chunk)) score += 3;
    if (/\b20\d\d\b/.test(chunk)) score += 1; // dated passages are more useful for "what changed"
    chunks.push({ i, text: chunk, score });
  }
  const picked = chunks
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.floor(budget / PASSAGE))
    .sort((a, b) => a.i - b.i);
  return picked.map((c) => c.text.trim()).join(" … ");
}

export async function readPage(url: string, query: string, timeoutMs = 6000): Promise<string | null> {
  if (!isPublicHttpUrl(url)) return null;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; research-assistant/1.0)", Accept: "text/html,text/plain" },
    });
    if (!res.ok || !isPublicHttpUrl(res.url)) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain/.test(type)) return null;
    const raw = (await res.text()).slice(0, MAX_BYTES);
    const text = type.includes("html") ? htmlToText(raw) : raw;
    const passages = relevantPassages(text, query);
    return passages || null;
  } catch {
    return null;
  }
}
