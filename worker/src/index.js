// Earth Tracker API (Cloudflare Worker).
//
// Stage 1 only handles sign-in. Later stages add the live ship and aircraft relays and the
// markets endpoints, each wrapped in requireAuth() so they can't eat into free-plan quotas
// for anyone who isn't signed in.
//
// Secrets (set with `npx wrangler secret put NAME`, never committed):
//   SITE_PASSWORD  the shared password
//   TOKEN_SECRET   long random string used to sign session tokens
// Vars (wrangler.toml):
//   ALLOWED_ORIGINS  comma-separated list of sites allowed to call this API

const SESSION_DAYS = 30;
const enc = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function makeToken(env) {
  const now = Date.now();
  const payload = { iat: now, exp: now + SESSION_DAYS * 86_400_000 };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.TOKEN_SECRET), enc.encode(body));
  return { token: `${body}.${b64url(sig)}`, expires: payload.exp };
}

async function verifyToken(env, token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.TOKEN_SECRET), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

// Constant-time password check: compare HMACs of both values rather than the strings themselves.
async function passwordMatches(env, given) {
  const key = await hmacKey(env.TOKEN_SECRET);
  const [a, b] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(String(given))),
    crypto.subtle.sign('HMAC', key, enc.encode(env.SITE_PASSWORD)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request, env) },
  });
}

// Use this to wrap every endpoint that costs quota or calls a keyed API.
export async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return verifyToken(env, token);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    if (!env.SITE_PASSWORD || !env.TOKEN_SECRET) {
      return json(request, env, { error: 'Worker secrets not set (SITE_PASSWORD, TOKEN_SECRET)' }, 500);
    }

    if (url.pathname === '/api/session' && request.method === 'POST') {
      // Optional brute-force protection, enabled by the LOGIN_LIMITER binding in wrangler.toml.
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

    if (url.pathname === '/api/health') return json(request, env, { ok: true });

    return json(request, env, { error: 'Not found' }, 404);
  },
};
