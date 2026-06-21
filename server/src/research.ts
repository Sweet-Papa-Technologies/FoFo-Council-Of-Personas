// Provider-agnostic web research via the Tavily API. This normalizes grounding
// into ONE tool every seat can use — so non-Gemini lineages (which lack native
// search) and the Chairman all ground from the same evidence, closing the gap
// where one grounded advisor is right but an ungrounded synthesis hallucinates.
//
// A ResearchSession is created per council run and caches results by query, so
// N seats asking the same thing trigger ONE search, not N. Failures are soft:
// research never aborts a run — a missing key or a Tavily error just means no
// brief for that query.
import { keychainGet } from './secrets';
import type { GroundingSource } from './llm';

const TAVILY_URL = 'https://api.tavily.com/search';
// Tavily caps `query` at 400 chars. A council question can be a multi-paragraph
// brief, so collapse whitespace and truncate at a word boundary well under the
// limit — the gist is enough to ground a search.
const TAVILY_QUERY_MAX = 380;
function toSearchQuery(q: string): string {
  const flat = q.replace(/\s+/g, ' ').trim();
  if (flat.length <= TAVILY_QUERY_MAX) return flat;
  const cut = flat.slice(0, TAVILY_QUERY_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Resolve the Tavily API key: env first (prod/Secret Manager), then Keychain. */
export function resolveTavilyKey(): string | undefined {
  return (
    process.env.TAVILY_API_KEY ||
    process.env.TAVILY_KEY ||
    keychainGet('TAVILY_API_KEY') || // macOS Keychain (service: council-of-personas)
    undefined
  );
}

export function researchAvailable(): boolean {
  return !!resolveTavilyKey();
}

export interface ResearchBrief {
  text: string; // formatted block to inject into a prompt
  sources: GroundingSource[];
}

interface TavilyResult { title?: string; url?: string; content?: string }

/** One research context per run. Dedupes identical queries across all seats. */
export class ResearchSession {
  private key: string | undefined;
  private cache = new Map<string, Promise<ResearchBrief | null>>();
  private maxResults: number;
  /** Last error from a failed search (invalid key, quota, network) — for surfacing. */
  lastError: string | null = null;

  constructor(opts: { maxResults?: number } = {}) {
    this.key = resolveTavilyKey();
    this.maxResults = opts.maxResults ?? 5;
  }

  get enabled(): boolean {
    return !!this.key;
  }

  /** Search (cached by normalized query). Returns null on any failure (see lastError). */
  brief(query: string, signal?: AbortSignal): Promise<ResearchBrief | null> {
    const norm = query.trim().slice(0, 400).toLowerCase();
    const existing = this.cache.get(norm);
    if (existing) return existing;
    const p = this.fetchBrief(query, signal).catch((err) => {
      this.lastError = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[research] tavily error:', this.lastError);
      return null;
    });
    this.cache.set(norm, p);
    return p;
  }

  private async fetchBrief(query: string, signal?: AbortSignal): Promise<ResearchBrief | null> {
    if (!this.key) return null;
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify({
        api_key: this.key, // accepted in body too, for older Tavily clients
        query: toSearchQuery(query), // Tavily rejects queries over 400 chars
        search_depth: 'advanced',
        max_results: this.maxResults,
        include_answer: true,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Tavily HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const j = (await res.json()) as { answer?: string; results?: TavilyResult[] };
    const results = (j.results ?? []).filter((r) => r.url);
    const sources: GroundingSource[] = results.map((r) => ({
      title: r.title || r.url || 'source',
      uri: r.url as string,
    }));

    const lines: string[] = [];
    lines.push('--- Research brief (live web search; cite/verify before relying on it) ---');
    if (j.answer) lines.push(`Summary: ${j.answer}`);
    results.forEach((r, i) => {
      const snippet = (r.content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      lines.push(`[${i + 1}] ${r.title || r.url}\n${r.url}\n${snippet}`);
    });
    lines.push('--- End research brief ---');
    return { text: lines.join('\n\n'), sources };
  }
}
