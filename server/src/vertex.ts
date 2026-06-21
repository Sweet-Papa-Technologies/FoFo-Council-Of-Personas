// Direct Vertex AI provider — lets council seats run on NON-Gemini lineages
// (Claude via Anthropic-on-Vertex, DeepSeek/Llama/etc via Vertex MaaS) so the
// council is a genuine multi-MODEL panel, not one substrate in four costumes.
//
// A seat opts into Vertex purely via its `model:` string in council.yaml:
//   vertex:anthropic:claude-sonnet-4-6              -> Anthropic Messages API
//   vertex:openai:deepseek-ai/deepseek-v3.2-maas    -> Vertex MaaS (OpenAI-compat)
//   vertex:openai:meta/llama-4-maverick-...-maas
//
// Auth is ADC: the Cloud Run runtime SA (roles/aiplatform.user) in prod, or
// `gcloud auth application-default` locally. No keys to manage.
import { GoogleAuth } from 'google-auth-library';
import type { ChatRequest, ChatResult } from './llm';

const VERTEX_PROJECT =
  process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'fofoapps-934be';
// Claude 4.6 + the MaaS models live on the `global` endpoint.
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'global';
const ANTHROPIC_VERSION = 'vertex-2023-10-16';

function host(loc: string): string {
  return loc === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${loc}-aiplatform.googleapis.com`;
}

const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
async function accessToken(): Promise<string> {
  const t = await auth.getAccessToken();
  if (!t) throw new Error('Vertex: could not obtain an access token (ADC not configured?)');
  return t;
}

export type VertexKind = 'anthropic' | 'openai';

/** Parse a `vertex:<kind>:<modelId>` string, or null if it isn't a Vertex model. */
export function parseVertexModel(model: string): { kind: VertexKind; id: string } | null {
  const m = /^vertex:(anthropic|openai):(.+)$/.exec(model.trim());
  if (!m) return null;
  return { kind: m[1] as VertexKind, id: m[2] };
}

const baseHeaders = (tok: string) => ({
  Authorization: `Bearer ${tok}`,
  'Content-Type': 'application/json',
  // The runtime SA's project IS the quota project in prod; for local user ADC
  // this header supplies the quota project explicitly.
  'x-goog-user-project': VERTEX_PROJECT,
});

async function sseLoop(
  body: ReadableStream<Uint8Array>,
  onLine: (json: any) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
      if (!payload || payload === '[DONE]') continue;
      try { onLine(JSON.parse(payload)); } catch { /* keep-alive / partial */ }
    }
  }
}

/** Claude via Anthropic-on-Vertex (:streamRawPredict, Messages API). */
async function streamAnthropic(
  modelId: string,
  req: ChatRequest,
  onDelta: (d: string) => void,
): Promise<ChatResult> {
  const tok = await accessToken();
  const url = `${host(VERTEX_LOCATION)}/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/anthropic/models/${encodeURIComponent(modelId)}:streamRawPredict`;

  // Text + any image attachments as Anthropic content blocks.
  const content: unknown[] = [{ type: 'text', text: req.user }];
  for (const a of req.attachments ?? []) {
    if (a.mime.startsWith('image/')) {
      content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } });
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: baseHeaders(tok),
    body: JSON.stringify({
      anthropic_version: ANTHROPIC_VERSION,
      system: req.system,
      messages: [{ role: 'user', content }],
      max_tokens: 8192,
      temperature: req.temperature,
      stream: true,
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Vertex/Anthropic HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }

  let full = '';
  await sseLoop(res.body, (json) => {
    if (json?.type === 'content_block_delta' && json?.delta?.type === 'text_delta') {
      const t = json.delta.text as string;
      if (t) { full += t; onDelta(t); }
    }
  });
  return { text: full, sources: [], queries: [] };
}

/** DeepSeek / Llama / etc via Vertex MaaS (OpenAI-compatible openapi endpoint). */
async function streamVertexOpenAI(
  modelId: string,
  req: ChatRequest,
  onDelta: (d: string) => void,
): Promise<ChatResult> {
  const tok = await accessToken();
  const url = `${host(VERTEX_LOCATION)}/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/endpoints/openapi/chat/completions`;

  const images = (req.attachments ?? []).filter((a) => a.mime.startsWith('image/'));
  const userContent: unknown = images.length
    ? [
        { type: 'text', text: req.user },
        ...images.map((a) => ({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } })),
      ]
    : req.user;

  const res = await fetch(url, {
    method: 'POST',
    headers: baseHeaders(tok),
    body: JSON.stringify({
      model: modelId,
      temperature: req.temperature,
      stream: true,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: userContent },
      ],
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Vertex/MaaS HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }

  let full = '';
  await sseLoop(res.body, (json) => {
    const delta: string | undefined = json?.choices?.[0]?.delta?.content;
    if (delta) { full += delta; onDelta(delta); }
  });
  return { text: full, sources: [], queries: [] };
}

/** Dispatch a Vertex model call by kind. */
export function streamVertex(
  kind: VertexKind,
  modelId: string,
  req: ChatRequest,
  onDelta: (d: string) => void,
): Promise<ChatResult> {
  return kind === 'anthropic'
    ? streamAnthropic(modelId, req, onDelta)
    : streamVertexOpenAI(modelId, req, onDelta);
}
