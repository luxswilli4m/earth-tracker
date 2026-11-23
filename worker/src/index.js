// Earth Tracker API (Cloudflare Worker).
//
//   POST /api/session   shared password -> 30-day session token
//   GET  /api/me        is this token still valid?
//   GET  /api/health    is the Worker up?
//   WS   /api/ships     live ships, signed-in only (relayed by the ShipRelay Durable Object)
//   GET/PUT /api/prefs  saved layer choices, signed-in only (SiteStore Durable Object)
//
// Everything that costs quota or uses an API key goes through requireAuth().
//
// Secrets (set with `npx.cmd wrangler@4 secret put NAME`, never committed):
//   SITE_PASSWORD   the shared password
//   TOKEN_SECRET    long random string used to sign session tokens
//   AISSTREAM_KEY   aisstream.io API key (stage 2)
// Vars (wrangler.toml):
//   ALLOWED_ORIGINS comma-separated list of sites allowed to call this API
import { makeToken, passwordMatches, requireAuth, allowedOrigins } from './auth.js';

import { cleanPrefs } from './prefs.js';

export { ShipRelay } from './ships.js';
export { SiteStore } from './prefs.js';

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowedOrigins(env).includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    if (url.pathname === '/api/health') return json(request, env, { ok: true });

    if (!env.SITE_PASSWORD || !env.TOKEN_SECRET) {
      return json(request, env, { error: 'Worker secrets not set (SITE_PASSWORD, TOKEN_SECRET)' }, 500);
    }

    if (url.pathname === '/api/session' && request.method === 'POST') {
      // Brute-force protection: 10 attempts per minute per IP (LOGIN_LIMITER in wrangler.toml).
      if (env.LOGIN_LIMITER) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const { success } = await env.LOGIN_LIMITER.limit({ key: ip });
        if (!success) return json(request, env, { error: 'Too many attempts' }, 429);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json(request, env, { error: 'Expected JSON body' }, 400);
      }
      if (!(await passwordMatches(env, body.password || ''))) {
        return json(request, env, { error: 'Wrong password' }, 401);
      }
      return json(request, env, await makeToken(env));
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      const session = await requireAuth(request, env);
      if (!session) return json(request, env, { signedIn: false }, 401);
      return json(request, env, { signedIn: true, expires: session.exp });
    }

    if (url.pathname === '/api/prefs') {
      if (!(await requireAuth(request, env))) return json(request, env, { error: 'Sign in required' }, 401);
      const store = env.STORE.get(env.STORE.idFromName('site'));
      if (request.method === 'GET') return json(request, env, (await store.get()) || { prefs: null, updated: 0 });
      if (request.method === 'PUT') {
        let body;
        try {
          body = await request.json();
        } catch {
          return json(request, env, { error: 'Expected JSON body' }, 400);
        }
        const prefs = cleanPrefs(body.prefs);
        if (!prefs) return json(request, env, { error: 'Expected { prefs: {...} }' }, 400);
        return json(request, env, await store.put(prefs));
      }
      return json(request, env, { error: 'Method not allowed' }, 405);
    }

    if (url.pathname === '/api/ships') {
      if (request.headers.get('Upgrade') !== 'websocket') return json(request, env, { error: 'Expected WebSocket' }, 426);
      // CORS doesn't cover WebSockets, so check the page's origin by hand.
      if (!allowedOrigins(env).includes(request.headers.get('Origin') || '')) {
        return new Response('Origin not allowed', { status: 403 });
      }
      if (!(await requireAuth(request, env))) return new Response('Sign in required', { status: 401 });
      const relay = env.SHIPS.get(env.SHIPS.idFromName('global'));
      return relay.fetch(request);
    }

    return json(request, env, { error: 'Not found' }, 404);
  },
};
