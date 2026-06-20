// Minimal streaming client for an OpenAI-compatible chat-completions endpoint.
import { chatCompletionsUrl, type Connection } from './config';

export interface ModelInfo {
  id: string;
}

function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/models$/.test(trimmed)) return trimmed;
  if (/\/(v\d+\w*|openai)$/.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

/**
 * List chat-capable models from the provider. For the Gemini endpoint this uses
 * the native models API and filters to text generation models; for any other
 * OpenAI-compatible endpoint it uses GET /models. Errors propagate to the caller.
 */
export async function listModels(conn: Connection): Promise<ModelInfo[]> {
  let host = '';
  try { host = new URL(conn.baseUrl).host; } catch { /* keep empty */ }

  if (host.includes('generativelanguage.googleapis.com')) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models` +
      `?pageSize=1000&key=${encodeURIComponent(conn.apiKey)}`;
    const res = await fetch(url);
    const j = (await res.json()) as any;
    if (!res.ok) throw new Error(`models HTTP ${res.status}`);
    // Keep text chat models; drop image/audio/tts/embedding/etc.
    const exclude = /(image|tts|audio|embedding|aqa|live|computer-use|vision|learnlm|gemma|nano-banana|robotics)/i;
    const ids: string[] = (j.models || [])
      .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m: any) => String(m.name || '').replace(/^models\//, ''))
      .filter((id: string) => /^gemini-/.test(id) && !exclude.test(id));
    return uniqSorted(ids).map((id) => ({ id }));
  }

  const res = await fetch(modelsUrl(conn.baseUrl), {
    headers: { Authorization: `Bearer ${conn.apiKey}` },
  });
  const j = (await res.json()) as any;
  if (!res.ok) throw new Error(`models HTTP ${res.status}`);
  const ids: string[] = (j.data || j.models || [])
    .map((m: any) => m.id ?? m.name)
    .filter(Boolean);
  return uniqSorted(ids).map((id) => ({ id }));
}

// Unique, with newer-looking names first (reverse-alpha puts gemini-3.x and the
// *-latest aliases above gemini-2.x).
function uniqSorted(ids: string[]): string[] {
  return [...new Set(ids)].sort().reverse();
}

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  temperature: number;
  search?: boolean; // enable live Google Search grounding (Gemini native)
  signal?: AbortSignal;
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface ChatResult {
  text: string;
  sources: GroundingSource[];
  queries: string[];
}

function isGeminiHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host.includes('generativelanguage.googleapis.com');
  } catch {
    return false;
  }
}

/**
 * Stream a chat completion, invoking `onDelta` for each token chunk. Resolves
 * with the full text plus any web sources used for grounding. When `req.search`
 * is set and the endpoint is Gemini, this routes through Gemini's native
 * grounded streaming API; otherwise it uses the OpenAI-compatible endpoint.
 * Throws on HTTP / network errors (callers catch per-seat).
 */
export async function streamChat(
  conn: Connection,
  req: ChatRequest,
  onDelta: (delta: string) => void,
): Promise<ChatResult> {
  if (req.search && isGeminiHost(conn.baseUrl)) {
    return streamGeminiGrounded(conn, req, onDelta);
  }
  return streamOpenAI(conn, req, onDelta);
}

async function streamOpenAI(
  conn: Connection,
  req: ChatRequest,
  onDelta: (delta: string) => void,
): Promise<ChatResult> {
  const url = chatCompletionsUrl(conn.baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${conn.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      temperature: req.temperature,
      stream: true,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `LLM HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return { text: full, sources: [], queries: [] };
      try {
        const json = JSON.parse(payload);
        const delta: string | undefined = json?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        // ignore keep-alives / partial frames
      }
    }
  }
  return { text: full, sources: [], queries: [] };
}

/** Gemini native grounded streaming via :streamGenerateContent + googleSearch. */
async function streamGeminiGrounded(
  conn: Connection,
  req: ChatRequest,
  onDelta: (delta: string) => void,
): Promise<ChatResult> {
  // baseUrl is …/v1beta/openai — the native API is at …/v1beta/models/<model>:…
  const root = conn.baseUrl.replace(/\/openai\/?$/, '').replace(/\/+$/, '');
  const url = `${root}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': conn.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: req.temperature },
    }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `LLM HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  const sourcesByUri = new Map<string, GroundingSource>();
  const queries = new Set<string>();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      try {
        const json = JSON.parse(payload);
        const cand = json?.candidates?.[0];
        const parts = cand?.content?.parts ?? [];
        for (const p of parts) {
          if (typeof p?.text === 'string' && p.text) {
            full += p.text;
            onDelta(p.text);
          }
        }
        const gm = cand?.groundingMetadata;
        if (gm) {
          for (const q of gm.webSearchQueries ?? []) queries.add(q);
          for (const ch of gm.groundingChunks ?? []) {
            const w = ch?.web;
            if (w?.uri) {
              sourcesByUri.set(w.uri, { title: w.title || w.uri, uri: w.uri });
            }
          }
        }
      } catch {
        // ignore partial frames
      }
    }
  }
  return { text: full, sources: [...sourcesByUri.values()], queries: [...queries] };
}
