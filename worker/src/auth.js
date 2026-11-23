// Session tokens and origin checks shared by every endpoint.

export const SESSION_DAYS = 30;
const enc = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function makeToken(env) {
  const now = Date.now();
  const payload = { iat: now, exp: now + SESSION_DAYS * 86_400_000 };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.TOKEN_SECRET), enc.encode(body));
  return { token: `${body}.${b64url(sig)}`, expires: payload.exp };
}

export async function verifyToken(env, token) {
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
export async function passwordMatches(env, given) {
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

export function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Normal requests: Authorization: Bearer <token>.
// WebSockets (browsers can't set headers on them): subprotocols "earth-tracker, auth.<token>".
export function tokenFrom(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim());
  const p = protocols.find((s) => s.startsWith('auth.'));
  return p ? p.slice(5) : '';
}

// Use this to wrap every endpoint that costs quota or calls a keyed API.
export async function requireAuth(request, env) {
  return verifyToken(env, tokenFrom(request));
}
