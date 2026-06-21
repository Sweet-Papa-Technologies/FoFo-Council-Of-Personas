// Provider-agnostic web research via the Tavily API. This normalizes grounding
// into ONE tool every seat can use — so non-Gemini lineages (which lack native
// search) and the Chairman all ground from the same evidence, closing the gap
// where one grounded advisor is right but an ungrounded synthesis hallucinates.
//
// A ResearchSession is created per council run and caches results by query, so
// N seats asking the same thing trigger ONE search, not N. Failures are soft:
// research never aborts a run — a missing key or a Tavily error just means no
// brief for that query.
import { execFileSync } from 'node:child_process';
import { keychainGet } from './secrets';
import type { GroundingSource } from './llm';

const TAVILY_URL = 'https://api.tavily.com/search';

// macOS Keychain lookup for an arbitrary service+account (the Tavily key is
// stored under its own service, not the app's shared one).
function keychainGetSvc(service: string, account: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const v = out.replace(/\n$/, '');
    return v.length ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the Tavily API key: env first (prod/Secret Manager), then Keychain. */
export function resolveTavilyKey(): string | undefined {
  return (
    process.env.TAVILY_API_KEY ||
    process.env.TAVILY_KEY ||
    keychainGetSvc('tavily-spt-dev', 'tavily-spt-dev') ||
    keychainGet('TAVILY_API_KEY') || // app-service Keychain fallback
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

  constructor(opts: { maxResults?: number } = {}) {
    this.key = resolveTavilyKey();
    this.maxResults = opts.maxResults ?? 5;
  }

  get enabled(): boolean {
    return !!this.key;
  }

  /** Search (cached by normalized query). Returns null on any failure. */
  brief(query: string, signal?: AbortSignal): Promise<ResearchBrief | null> {
    const norm = query.trim().slice(0, 400).toLowerCase();
    const existing = this.cache.get(norm);
    if (existing) return existing;
    const p = this.fetchBrief(query, signal).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[research] tavily error:', err instanceof Error ? err.message : String(err));
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
        query,
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
