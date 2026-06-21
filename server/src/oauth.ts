// Minimal, stateless OAuth 2.1 Authorization Server + Resource Server helpers,
// just enough for claude.ai's custom-connector flow:
//   - RFC 9728 Protected Resource Metadata  (/.well-known/oauth-protected-resource)
//   - RFC 8414 Authorization Server Metadata (/.well-known/oauth-authorization-server)
//   - RFC 7591 Dynamic Client Registration  (/register)
//   - /authorize (PKCE S256, gated by a single passphrase — single-user consent)
//   - /token (authorization_code + refresh_token)
// All artifacts (auth codes, access/refresh tokens) are signed JWTs (HS256), so
// nothing needs to be stored — works on serverless that scales to zero.
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface OAuthCtx {
  base: string; // external base URL, e.g. https://council-mcp-….run.app
  secret: string; // HMAC signing key
  passphrase: string; // the one secret that authorizes consent
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj)));
}
function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function sign(payload: Record<string, unknown>, secret: string, expSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson({ ...payload, iat: now, exp: now + expSec });
  const data = `${header}.${body}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}
function verify(token: string, secret: string): Record<string, any> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  if (!eq(s, expected)) return null;
  try {
    const body = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (body.exp && Math.floor(Date.now() / 1000) > body.exp) return null;
    return body;
  } catch {
    return null;
  }
}

/** Validate a Resource-Server access token (Bearer) issued by /token. */
export function validateAccessToken(token: string, ctx: OAuthCtx): boolean {
  const claims = verify(token, ctx.secret);
  return !!claims && claims.t === 'access';
}

function pkceOk(verifier: string, challenge: string): boolean {
  const h = b64url(createHash('sha256').update(verifier).digest());
  return eq(h, challenge);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  const ctype = (req.headers['content-type'] || '').toLowerCase();
  if (ctype.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function approvePage(params: URLSearchParams, error?: string): string {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) ?? '')}">`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Council of Personas — Authorize</title>
<style>body{background:#0b1326;color:#dae2fd;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#171f33;border:1px solid #454651;border-radius:12px;padding:28px;max-width:380px;width:90%}
h1{font-size:18px;margin:0 0 6px}p{color:#c6c5d3;font-size:14px;line-height:1.5}
input[type=password]{width:100%;box-sizing:border-box;background:#0b1326;border:1px solid #454651;color:#dae2fd;border-radius:8px;padding:11px;font-size:14px;margin:10px 0}
button{width:100%;background:#bcc3ff;color:#192679;border:none;border-radius:8px;padding:12px;font-weight:600;cursor:pointer;font-size:14px}
.err{color:#ffb4ab;font-size:13px}</style></head>
<body><form class="card" method="POST" action="/authorize">
<h1>⚖️ Council of Personas</h1>
<p>A client (e.g. Claude) is requesting access to convene your council. Enter the passphrase to authorize.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<input type="password" name="passphrase" placeholder="Authorization passphrase" autofocus required>
${hidden}
<button type="submit">Authorize</button>
</form></body></html>`;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Handle an OAuth / discovery request. Returns true if it served the request.
 * Anything else (e.g. /mcp) returns false so the caller can handle it.
 */
export async function handleOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthCtx,
): Promise<boolean> {
  const url = new URL(req.url || '/', ctx.base);
  const path = url.pathname;
  const method = req.method || 'GET';

  // ---- Discovery ----
  if (path.startsWith('/.well-known/oauth-protected-resource')) {
    sendJson(res, 200, {
      resource: `${ctx.base}/mcp`,
      authorization_servers: [ctx.base],
      scopes_supported: ['council'],
      bearer_methods_supported: ['header'],
    });
    return true;
  }
  if (
    path.startsWith('/.well-known/oauth-authorization-server') ||
    path === '/.well-known/openid-configuration'
  ) {
    sendJson(res, 200, {
      issuer: ctx.base,
      authorization_endpoint: `${ctx.base}/authorize`,
      token_endpoint: `${ctx.base}/token`,
      registration_endpoint: `${ctx.base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['council'],
    });
    return true;
  }

  // ---- Dynamic Client Registration (stateless: we don't persist clients) ----
  if (path === '/register' && method === 'POST') {
    const meta = await readBody(req);
    sendJson(res, 201, {
      client_id: `cop-${b64url(randomBytes(12))}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: (meta as any).redirect_uris ?? [],
      ...(typeof (meta as any).client_name === 'string' ? { client_name: (meta as any).client_name } : {}),
    });
    return true;
  }

  // ---- Authorization endpoint ----
  if (path === '/authorize') {
    if (method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(approvePage(url.searchParams));
      return true;
    }
    if (method === 'POST') {
      const form = await readBody(req);
      const params = new URLSearchParams(form as Record<string, string>);
      const redirectUri = params.get('redirect_uri') || '';
      const challenge = params.get('code_challenge') || '';
      const state = params.get('state') || '';
      if (!eq(params.get('passphrase') || '', ctx.passphrase)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(approvePage(params, 'Incorrect passphrase.'));
        return true;
      }
      if (!redirectUri || !challenge) {
        sendJson(res, 400, { error: 'invalid_request', error_description: 'missing redirect_uri or code_challenge' });
        return true;
      }
      const code = sign(
        { t: 'code', redirect_uri: redirectUri, cc: challenge, resource: params.get('resource') || '' },
        ctx.secret,
        300,
      );
      const sep = redirectUri.includes('?') ? '&' : '?';
      const loc = `${redirectUri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
      res.writeHead(302, { Location: loc });
      res.end();
      return true;
    }
  }

  // ---- Token endpoint ----
  if (path === '/token' && method === 'POST') {
    const body = await readBody(req);
    const grant = body.grant_type;

    if (grant === 'authorization_code') {
      const claims = verify(body.code || '', ctx.secret);
      if (!claims || claims.t !== 'code') {
        sendJson(res, 400, { error: 'invalid_grant' });
        return true;
      }
      if (body.redirect_uri && !eq(body.redirect_uri, claims.redirect_uri)) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return true;
      }
      if (!body.code_verifier || !pkceOk(body.code_verifier, claims.cc)) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return true;
      }
      sendJson(res, 200, issueTokens(ctx, claims.resource));
      return true;
    }

    if (grant === 'refresh_token') {
      const claims = verify(body.refresh_token || '', ctx.secret);
      if (!claims || claims.t !== 'refresh') {
        sendJson(res, 400, { error: 'invalid_grant' });
        return true;
      }
      sendJson(res, 200, issueTokens(ctx, claims.resource));
      return true;
    }

    sendJson(res, 400, { error: 'unsupported_grant_type' });
    return true;
  }

  return false;
}

function issueTokens(ctx: OAuthCtx, resource: string | undefined) {
  const aud = resource || `${ctx.base}/mcp`;
  return {
    access_token: sign({ t: 'access', sub: 'owner', aud, scope: 'council' }, ctx.secret, 3600),
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: sign({ t: 'refresh', sub: 'owner', resource: aud }, ctx.secret, 60 * 60 * 24 * 30),
    scope: 'council',
  };
}
