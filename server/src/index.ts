// Hono API server: serves the council run as a Server-Sent Events stream.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { getConnection, loadCouncilConfig } from './config';
import { runCouncil, type Emit } from './council';
import { listModels, type ModelInfo } from './llm';
import { AsyncQueue } from './queue';

const app = new Hono();

// The Quasar dev server proxies /api to us, so same-origin in practice; CORS is
// here only to make direct curl/other-origin testing painless.
app.use('/api/*', cors());

app.get('/api/health', (c) => {
  try {
    const conn = getConnection();
    const cfg = loadCouncilConfig();
    return c.json({
      ok: true,
      model: conn.model,
      seats: cfg.council.map((p) => p.name),
      peer_review: cfg.settings.peer_review,
    });
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      503,
    );
  }
});

// Roster + settings for the UI's Config/Settings panels. No secrets — the API
// key is never returned, only the endpoint host.
app.get('/api/config', (c) => {
  let cfg;
  try {
    cfg = loadCouncilConfig();
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
  }
  let endpoint: string | null = null;
  let defaultModel: string | null = null;
  try {
    const conn = getConnection();
    defaultModel = conn.model;
    try { endpoint = new URL(conn.baseUrl).host; } catch { endpoint = conn.baseUrl; }
  } catch {
    /* no key configured — still show the roster */
  }
  return c.json({
    endpoint,
    default_model: defaultModel,
    settings: cfg.settings,
    council: cfg.council.map((p) => ({
      name: p.name,
      tagline: p.tagline ?? null,
      accent: p.accent ?? null,
      model: p.model ?? null,
      temperature: p.temperature ?? null,
    })),
    chairman: {
      name: cfg.chairman.name,
      model: cfg.chairman.model ?? null,
      temperature: cfg.chairman.temperature ?? null,
    },
  });
});

// Available models for the UI's model pickers. Cached for the process lifetime
// (the model catalog rarely changes within a session).
let modelsCache: ModelInfo[] | null = null;
app.get('/api/models', async (c) => {
  if (modelsCache) return c.json({ models: modelsCache });
  try {
    const conn = getConnection();
    modelsCache = await listModels(conn);
    return c.json({ models: modelsCache });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      503,
    );
  }
});

interface RunEvent {
  event: string;
  data: unknown;
}

app.post('/api/council/run', async (c) => {
  let body: {
    question?: string;
    peer_review?: boolean;
    council_model?: string;
    review_model?: string;
    chairman_model?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON: { "question": "..." }' }, 400);
  }
  const question = (body.question ?? '').trim();
  if (!question) return c.json({ error: 'Missing "question".' }, 400);
  const runOpts = {
    peerReview: typeof body.peer_review === 'boolean' ? body.peer_review : undefined,
    councilModel: body.council_model || undefined,
    reviewModel: body.review_model || undefined,
    chairmanModel: body.chairman_model || undefined,
  };

  // Fail fast with a normal HTTP error if config is broken, rather than opening
  // an SSE stream that immediately dies.
  try {
    getConnection();
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      503,
    );
  }

  return streamSSE(c, async (stream) => {
    const queue = new AsyncQueue<RunEvent>();
    const emit: Emit = (event, data) => queue.push({ event, data });

    // Abort the LLM calls if the client disconnects.
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());

    const run = runCouncil(question, emit, ac.signal, runOpts)
      .catch((err) => {
        emit('fatal', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => queue.close());

    for await (const ev of queue) {
      await stream.writeSSE({
        event: ev.event,
        data: JSON.stringify(ev.data),
      });
    }
    await run;
  });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[council] API listening on http://localhost:${info.port}`);
});
