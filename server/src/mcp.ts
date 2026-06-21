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

// Run the council and collect its streamed events into a final result.
async function convene(
  question: string,
  opts: { peerReview?: boolean; search?: boolean },
): Promise<{ markdown: string; json: unknown }> {
  const members = new Map<number, Member>();
  let chairman = '';
  let chairmanError: string | null = null;
  let tally: { name: string; label: string; points: number; appearances: number }[] = [];
  let chairmanSources: { title: string; uri: string }[] = [];
  let fatal: string | null = null;

  const emit: Emit = (event, data) => {
    const d = data as Record<string, any>;
    switch (event) {
      case 'roster':
        for (const m of d.members as Record<string, any>[]) {
          members.set(m.id, { id: m.id, name: m.name, label: m.label, answer: '', error: null, sources: [] });
        }
        break;
      case 'member_done': { const m = members.get(d.id); if (m) m.answer = d.content; break; }
      case 'member_error': { const m = members.get(d.id); if (m) m.error = d.error; break; }
      case 'member_sources': { const m = members.get(d.id); if (m) m.sources = d.sources || []; break; }
      case 'ranking_tally': tally = d.tally; break;
      case 'chairman_sources': chairmanSources = d.sources || []; break;
      case 'chairman_done': chairman = d.content; break;
      case 'chairman_error': chairmanError = d.error; break;
      case 'fatal': fatal = d.error; break;
    }
  };

  const runOpts: { peerReview?: boolean; searchAll?: boolean } = {};
  if (typeof opts.peerReview === 'boolean') runOpts.peerReview = opts.peerReview;
  if (typeof opts.search === 'boolean') runOpts.searchAll = opts.search;
  await runCouncil(question, emit, new AbortController().signal, runOpts);
  if (fatal) throw new Error(fatal);

  const list = [...members.values()];
  const json = {
    question,
    chairman: { content: chairman, error: chairmanError, sources: chairmanSources },
    members: list.map((m) => ({
      name: m.name, label: m.label, status: m.error ? 'error' : 'ok',
      answer: m.answer, error: m.error, sources: m.sources,
    })),
    rankings: tally.map((t, i) => ({ rank: i + 1, name: t.name, points: t.points, appearances: t.appearances })),
  };

  const L: string[] = [];
  L.push(`# Council of Personas — "${question}"`, '');
  L.push("## ⚖️ Chairman's Synthesis", '');
  L.push(chairmanError ? `⚠️ ${chairmanError}` : (chairman || '_(none)_'), '');
  if (tally.length) {
    L.push('### Peer ranking', '', '| # | Advisor | Points |', '|--:|---|--:|');
    tally.forEach((t, i) => L.push(`| ${i + 1} | ${t.name} | ${t.points} |`));
    L.push('');
  }
  L.push('## The Council', '');
  for (const m of list) {
    L.push(`### ${m.name}`, '', m.error ? `⚠️ ${m.error}` : (m.answer || '_(none)_'));
    if (m.sources.length) L.push('', `🔎 ${m.sources.map((s) => `[${s.title}](${s.uri})`).join(' · ')}`);
    L.push('');
  }
  return { markdown: L.join('\n'), json };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'council-of-personas', version: '0.1.0' });

  server.registerTool(
    'convene_council',
    {
      title: 'Convene the Council of Personas',
      description:
        'Ask a council of adversarial advisors (Red Team/Skeptic, Visionary, Operator/Pragmatist, ' +
        'Domain Expert) — all Gemini, each with a different system prompt — to answer a question in ' +
        'parallel, peer-review and rank each other, then have a Chairman synthesize a recommendation. ' +
        'A genuine multi-model second opinion. Use for decisions, design/architecture reviews, strategy, ' +
        'or any question that benefits from clashing viewpoints. Takes ~20–60s.',
      inputSchema: {
        question: z.string().describe('The question to put to the council.'),
        peer_review: z.boolean().optional().describe('Run the peer-review/ranking stage (default: council.yaml setting).'),
        web_search: z.boolean().optional().describe('Ground every advisor with live Google Search (default off).'),
      },
    },
    async ({ question, peer_review, web_search }) => {
      try {
        const opts: { peerReview?: boolean; search?: boolean } = {};
        if (typeof peer_review === 'boolean') opts.peerReview = peer_review;
        if (typeof web_search === 'boolean') opts.search = web_search;
        const { markdown } = await convene(question, opts);
        return { content: [{ type: 'text', text: markdown }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Council failed: ${err instanceof Error ? err.message : String(err)}` }],
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
