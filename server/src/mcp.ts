// MCP server exposing the Council of Personas as a tool, so any MCP client
// (Claude Code, Claude Desktop, or a hosted claude.ai connector) can convene
// the council and get the synthesis back. Runs over stdio by default; pass
// `--http` (or set MCP_HTTP=1) to serve Streamable HTTP for remote hosting.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { runCouncil, type Emit } from './council';
import { handleOAuth, validateAccessToken } from './oauth';

interface Member {
  id: number;
  name: string;
  label: string;
  answer: string;
  error: string | null;
  sources: { title: string; uri: string }[];
}

interface Source { title: string; uri: string }
interface TallyRow { name: string; label: string; points: number; appearances: number }

// Structured result of one council run — the basis for every output format.
interface CouncilResult {
  question: string;
  chairman: { content: string; error: string | null; sources: Source[] };
  devils_advocate: { content: string; error: string | null } | null;
  members: {
    name: string; label: string; status: 'ok' | 'error';
    answer: string; error: string | null; grounded: boolean; sources: Source[];
  }[];
  rankings: { rank: number; name: string; points: number; appearances: number }[];
}

// Optional progress reporter: (progress, total|undefined, message).
type ProgressFn = (progress: number, total: number | undefined, message: string) => void;

// Run the council and collect its streamed events into a structured result.
async function convene(
  question: string,
  opts: { peerReview?: boolean; search?: boolean; research?: boolean },
  hooks: { signal?: AbortSignal; onProgress?: ProgressFn } = {},
): Promise<CouncilResult> {
  const members = new Map<number, Member>();
  let chairman = '';
  let chairmanError: string | null = null;
  let dissent = '';
  let dissentError: string | null = null;
  let tally: TallyRow[] = [];
  let chairmanSources: Source[] = [];
  let fatal: string | null = null;

  // Progress accounting: advisors + devil's advocate + chairman.
  const report = hooks.onProgress;
  let total: number | undefined;
  let seatCount = 0;
  let doneSeats = 0;

  const emit: Emit = (event, data) => {
    const d = data as Record<string, any>;
    switch (event) {
      case 'roster':
        for (const m of d.members as Record<string, any>[]) {
          members.set(m.id, { id: m.id, name: m.name, label: m.label, answer: '', error: null, sources: [] });
        }
        seatCount = members.size;
        total = seatCount + 2; // + devil's advocate + chairman
        report?.(0, total, `Dispatching ${seatCount} advisors…`);
        break;
      case 'stage':
        if (d.stage === 'research') report?.(0, total, 'Researching (live web)…');
        else if (d.stage === 'review') report?.(doneSeats, total, 'Peer review running…');
        else if (d.stage === 'chairman' && total) report?.(total - 1, total, 'Chairman synthesizing…');
        break;
      case 'member_done': {
        const m = members.get(d.id); if (m) m.answer = d.content;
        doneSeats++; report?.(doneSeats, total, `Advisor ${doneSeats}/${seatCount} returned`);
        break;
      }
      case 'member_error': { const m = members.get(d.id); if (m) m.error = d.error; break; }
      case 'member_sources': { const m = members.get(d.id); if (m) m.sources = d.sources || []; break; }
      case 'ranking_tally': tally = d.tally; break;
      case 'devils_advocate_done':
        dissent = d.content;
        if (total) report?.(total - 1, total, "Devil's Advocate challenged the consensus");
        break;
      case 'devils_advocate_error': dissentError = d.error; break;
      case 'chairman_sources': chairmanSources = d.sources || []; break;
      case 'chairman_done':
        chairman = d.content;
        if (total) report?.(total, total, 'Done');
        break;
      case 'chairman_error': chairmanError = d.error; break;
      case 'fatal': fatal = d.error; break;
    }
  };

  const runOpts: { peerReview?: boolean; searchAll?: boolean; research?: boolean } = {};
  if (typeof opts.peerReview === 'boolean') runOpts.peerReview = opts.peerReview;
  if (typeof opts.search === 'boolean') runOpts.searchAll = opts.search;
  if (typeof opts.research === 'boolean') runOpts.research = opts.research;
  await runCouncil(question, emit, hooks.signal ?? new AbortController().signal, runOpts);
  if (fatal) throw new Error(fatal);

  const list = [...members.values()];
  return {
    question,
    chairman: { content: chairman, error: chairmanError, sources: chairmanSources },
    devils_advocate: dissent || dissentError ? { content: dissent || '', error: dissentError } : null,
    members: list.map((m) => ({
      name: m.name, label: m.label, status: (m.error ? 'error' : 'ok') as 'ok' | 'error',
      answer: m.answer, error: m.error, grounded: m.sources.length > 0, sources: m.sources,
    })),
    rankings: tally.map((t, i) => ({ rank: i + 1, name: t.name, points: t.points, appearances: t.appearances })),
  };
}

const srcLine = (s: Source[]) => s.map((x) => `[${x.title}](${x.uri})`).join(' · ');

// ---- Output formatters -------------------------------------------------------

function renderMarkdown(r: CouncilResult, summaryOnly: boolean): string {
  const L: string[] = [];
  L.push(`# Council of Personas — "${r.question}"`, '');
  L.push("## ⚖️ Chairman's Synthesis", '');
  L.push(r.chairman.error ? `⚠️ ${r.chairman.error}` : (r.chairman.content || '_(none)_'), '');
  if (r.chairman.sources.length) L.push(`🔎 ${srcLine(r.chairman.sources)}`, '');
  if (r.rankings.length) {
    L.push('### Peer ranking', '', '| # | Advisor | Points |', '|--:|---|--:|');
    r.rankings.forEach((t) => L.push(`| ${t.rank} | ${t.name} | ${t.points} |`));
    L.push('');
  }
  if (summaryOnly) return L.join('\n');
  if (r.devils_advocate) {
    L.push("## ⚔️ Devil's Advocate", '');
    L.push(r.devils_advocate.error ? `⚠️ ${r.devils_advocate.error}` : (r.devils_advocate.content || '_(none)_'), '');
  }
  L.push('## The Council', '');
  for (const m of r.members) {
    L.push(`### ${m.name}`, '', m.error ? `⚠️ ${m.error}` : (m.answer || '_(none)_'));
    if (m.sources.length) L.push('', `🔎 ${srcLine(m.sources)}`);
    L.push('');
  }
  return L.join('\n');
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Minimal, safe markdown → HTML: escapes first, then headings, bold, links, lists,
// and paragraph breaks. No raw HTML passthrough, so nothing the model emits can
// inject markup.
function mdToHtml(md: string): string {
  const lines = esc(md).split('\n');
  const out: string[] = [];
  let inList = false;
  const inline = (t: string) =>
    t
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      if (inList) { out.push('</ul>'); inList = false; }
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
    } else if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (!line) {
      if (inList) { out.push('</ul>'); inList = false; }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

// Self-contained, theme-neutral HTML (transparent bg, scoped inline CSS, no JS,
// no external requests) — renders inside artifact/visualizer surfaces.
function renderHtml(r: CouncilResult, summaryOnly: boolean): string {
  const P = 'cop'; // scope prefix
  const chair = r.chairman.error
    ? `<p class="${P}-err">⚠️ ${esc(r.chairman.error)}</p>`
    : mdToHtml(r.chairman.content || '_(none)_');
  const chairSrc = r.chairman.sources.length
    ? `<p class="${P}-src">🔎 ${r.chairman.sources.map((s) => `<a href="${esc(s.uri)}">${esc(s.title)}</a>`).join(' · ')}</p>`
    : '';
  const ranking = r.rankings.length
    ? `<table class="${P}-tbl"><thead><tr><th>#</th><th>Advisor</th><th>Points</th></tr></thead><tbody>` +
      r.rankings.map((t) => `<tr><td>${t.rank}</td><td>${esc(t.name)}</td><td>${t.points}</td></tr>`).join('') +
      '</tbody></table>'
    : '';
  const da = r.devils_advocate
    ? `<details class="${P}-card ${P}-da"><summary>⚔️ Devil's Advocate</summary>${
        r.devils_advocate.error ? `<p class="${P}-err">⚠️ ${esc(r.devils_advocate.error)}</p>` : mdToHtml(r.devils_advocate.content)
      }</details>`
    : '';
  const advisors = summaryOnly
    ? ''
    : r.members
        .map((m) => {
          const body = m.error ? `<p class="${P}-err">⚠️ ${esc(m.error)}</p>` : mdToHtml(m.answer || '_(none)_');
          const foot = `<p class="${P}-meta">${m.grounded ? '🔎 grounded' : 'ungrounded'}${
            m.sources.length ? ' · ' + m.sources.map((s) => `<a href="${esc(s.uri)}">${esc(s.title)}</a>`).join(' · ') : ''
          }</p>`;
          return `<details class="${P}-card"><summary>${esc(m.name)} <span class="${P}-tag">${m.status}</span></summary>${body}${foot}</details>`;
        })
        .join('\n');
  const css = `
.${P}{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:inherit;max-width:820px;margin:0 auto}
.${P} h1,.${P} h2,.${P} h3,.${P} h4{line-height:1.25;margin:1.1em 0 .4em}
.${P} h1{font-size:1.4rem}.${P} h2{font-size:1.15rem}.${P} h3,.${P} h4{font-size:1rem}
.${P} a{color:#4ea1ff}
.${P}-hero{border:1px solid rgba(127,127,127,.3);border-radius:12px;padding:16px 20px;background:rgba(127,127,127,.06)}
.${P}-card{border:1px solid rgba(127,127,127,.25);border-radius:10px;padding:6px 14px;margin:10px 0;background:rgba(127,127,127,.04)}
.${P}-card>summary{cursor:pointer;font-weight:600;padding:6px 0}
.${P}-da{border-color:rgba(78,161,255,.45)}
.${P}-tag{font-weight:400;font-size:.75rem;opacity:.6}
.${P}-tbl{border-collapse:collapse;margin:.6em 0;font-size:.9rem}
.${P}-tbl th,.${P}-tbl td{border:1px solid rgba(127,127,127,.3);padding:4px 12px;text-align:left}
.${P}-src,.${P}-meta{font-size:.8rem;opacity:.7;margin-top:.6em}
.${P}-err{color:#ff6b6b}
`;
  return (
    `<style>${css}</style>` +
    `<div class="${P}">` +
    `<h1>Council of Personas</h1>` +
    `<p class="${P}-meta">${esc(r.question)}</p>` +
    `<section class="${P}-hero"><h2>⚖️ Chairman's Synthesis</h2>${chair}${chairSrc}${ranking ? '<h3>Peer ranking</h3>' + ranking : ''}</section>` +
    da +
    (advisors ? `<h2>The Council</h2>${advisors}` : '') +
    `</div>`
  );
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'council-of-personas', version: '0.1.0' });

  server.registerTool(
    'convene_council',
    {
      title: 'Convene the Council of Personas',
      description:
        'Ask a council of adversarial advisors (Red Team/Skeptic, Visionary, Operator/Pragmatist, ' +
        'Domain Expert), each with a different system prompt, to answer a question in parallel. They ' +
        'peer-review and rank each other; a standing Devil’s Advocate then attacks wherever they ' +
        'converge (anti-framing guard); finally a Chairman synthesizes a recommendation with a ' +
        'confidence/cruxes calibration. A genuine multi-perspective second opinion. Use for decisions, ' +
        'design/architecture reviews, strategy, or any question that benefits from clashing viewpoints. ' +
        'Takes ~20–60s.',
      inputSchema: {
        question: z.string().min(1).describe('The question to put to the council.'),
        peer_review: z.boolean().optional().describe('Run the peer-review/ranking stage (default: council.yaml setting).'),
        web_search: z.boolean().optional().describe('Ground advisors with native model search (Gemini Google Search) (default off).'),
        research: z.boolean().optional().describe('Inject one shared live web-research brief (Tavily) into EVERY advisor, the Devil’s Advocate, and the Chairman — provider-agnostic grounding so the whole council reasons from the same evidence. Default off.'),
        summary_only: z.boolean().optional().describe('Return only the Chairman synthesis + peer ranking, omitting the full advisor essays. Good for decisions where the synthesis is the deliverable. Default false.'),
        output_format: z.enum(['markdown', 'json', 'html']).optional().describe('markdown (default) | json (structured per-seat objects for the agent to render itself) | html (self-contained, collapsible, no scripts).'),
      },
    },
    async ({ question, peer_review, web_search, research, summary_only, output_format }, extra) => {
      const fmt = output_format ?? 'markdown';
      const summary = summary_only ?? false;

      // F2: forward per-stage progress to clients that asked for it (degrade
      // gracefully — a client that sent no progressToken just gets nothing).
      const progressToken = extra?._meta?.progressToken;
      const onProgress: ProgressFn | undefined =
        progressToken === undefined
          ? undefined
          : (progress, totalSteps, message) => {
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress,
                    message,
                    ...(typeof totalSteps === 'number' ? { total: totalSteps } : {}),
                  },
                })
                .catch(() => {}); // never let progress break the run
            };

      try {
        const q = (question ?? '').trim();
        if (!q) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Error: `question` is required and must be non-empty.' }],
          };
        }
        const opts: { peerReview?: boolean; search?: boolean; research?: boolean } = {};
        if (typeof peer_review === 'boolean') opts.peerReview = peer_review;
        if (typeof web_search === 'boolean') opts.search = web_search;
        if (typeof research === 'boolean') opts.research = research;

        const hooks: { signal?: AbortSignal; onProgress?: ProgressFn } = {};
        if (extra?.signal) hooks.signal = extra.signal;
        if (onProgress) hooks.onProgress = onProgress;
        const result = await convene(q, opts, hooks);

        // Partial-failure visibility: if every seat AND the chairman failed, treat
        // the run as an error so the agent doesn't act on an empty result.
        const liveSeats = result.members.filter((m) => m.status === 'ok').length;
        const chairOk = !result.chairman.error && !!result.chairman.content;
        if (liveSeats === 0 && !chairOk) {
          const reasons = result.members.map((m) => `${m.name}: ${m.error ?? 'no response'}`).join('; ');
          return {
            isError: true,
            content: [{ type: 'text', text: `Council produced no usable output. Seat errors — ${reasons || 'unknown'}. Chairman: ${result.chairman.error ?? 'no output'}.` }],
          };
        }

        if (fmt === 'json') {
          const json = summary
            ? { question: result.question, chairman: result.chairman, devils_advocate: result.devils_advocate, rankings: result.rankings }
            : result;
          return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
        }
        const text = fmt === 'html' ? renderHtml(result, summary) : renderMarkdown(result, summary);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        // Surface a structured, actionable error back to the calling agent.
        const msg = err instanceof Error ? err.message : String(err);
        const hint = /no api key/i.test(msg)
          ? ' (the server is missing its LLM API key — check Secret Manager / env)'
          : /HTTP 4\d\d/.test(msg)
            ? ' (upstream rejected the request — check model name, key, or quota)'
            : /HTTP 5\d\d|fetch failed|ECONN|ETIMEDOUT/i.test(msg)
              ? ' (upstream/network error — likely transient, retry may help)'
              : '';
        return {
          isError: true,
          content: [{ type: 'text', text: `Council failed: ${msg}${hint}` }],
        };
      }
    },
  );

  return server;
}

async function main() {
  const http = process.argv.includes('--http') || process.env.MCP_HTTP === '1';

  if (!http) {
    await buildServer().connect(new StdioServerTransport());
    return;
  }

  // Streamable HTTP for remote hosting (one transport per session id).
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const port = Number(process.env.PORT ?? 8788);

  const oauthSecret = process.env.OAUTH_HMAC_SECRET;
  const oauthPass = process.env.OAUTH_PASSPHRASE;
  const oauthEnabled = !!(oauthSecret && oauthPass);
  const staticToken = process.env.MCP_BEARER_TOKEN;

  const httpServer = createServer(async (req, res) => {
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || `localhost:${port}`;
    const proto = (req.headers['x-forwarded-proto'] as string) || (host.startsWith('localhost') ? 'http' : 'https');
    const base = `${proto}://${host}`;
    const ctx = { base, secret: oauthSecret ?? '', passphrase: oauthPass ?? '' };

    // OAuth + discovery endpoints (for claude.ai web's custom-connector flow).
    if (oauthEnabled && (await handleOAuth(req, res, ctx))) return;

    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end('Not found');
      return;
    }

    // Auth gate: a static bearer (Claude Code) OR an OAuth access token (web).
    if (oauthEnabled || staticToken) {
      const auth = (req.headers['authorization'] as string) || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const okStatic = !!staticToken && bearer.length > 0 && bearer === staticToken;
      const okOauth = oauthEnabled && bearer.length > 0 && validateAccessToken(bearer, ctx);
      if (!okStatic && !okOauth) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, transport!); },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      await buildServer().connect(transport);
    }

    // Read + parse the body for POSTs (GET/DELETE carry none).
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : undefined;
    }
    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(port, () => {
    // eslint-disable-next-line no-console
    console.error(`[council-mcp] Streamable HTTP on http://localhost:${port}/mcp`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('council-mcp fatal:', err);
  process.exit(1);
});
