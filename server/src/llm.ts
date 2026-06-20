// Minimal streaming client for an OpenAI-compatible chat-completions endpoint.
import { chatCompletionsUrl, type Connection } from './config';

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
