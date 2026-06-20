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
  signal?: AbortSignal;
}

/**
 * Stream a chat completion, invoking `onDelta` for each token chunk.
 * Resolves with the full concatenated text. Throws on HTTP / network errors
 * (callers are expected to catch per-seat so one failure can't sink the run).
 */
export async function streamChat(
  conn: Connection,
  req: ChatRequest,
  onDelta: (delta: string) => void,
): Promise<string> {
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

  // Parse the SSE stream: lines of `data: {json}` separated by blank lines.
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
      if (payload === '[DONE]') return full;
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
  return full;
}
