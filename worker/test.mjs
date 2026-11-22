// Quick local check of the Worker's sign-in logic, run with: node worker/test.mjs
import assert from 'node:assert/strict';
import worker from './src/index.js';

const env = { SITE_PASSWORD: 'correct horse', TOKEN_SECRET: 'x'.repeat(48), ALLOWED_ORIGINS: 'https://luxswilli4m.github.io' };
const origin = { Origin: 'https://luxswilli4m.github.io' };
const call = (path, init = {}) => worker.fetch(new Request(`https://w.example${path}`, init), env);

let r = await call('/api/session', { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
assert.equal(r.status, 401);

r = await call('/api/session', { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) });
assert.equal(r.status, 200);
assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://luxswilli4m.github.io');
const { token, expires } = await r.json();
assert.ok(token && expires > Date.now());

r = await call('/api/me', { headers: { Authorization: `Bearer ${token}` } });
assert.equal(r.status, 200);

r = await call('/api/me', { headers: { Authorization: `Bearer ${token.slice(0, -2)}xx` } });
assert.equal(r.status, 401, 'tampered token must fail');

r = await call('/api/me');
assert.equal(r.status, 401, 'no token must fail');

r = await call('/api/health', { headers: { Origin: 'https://evil.example' } });
assert.equal(r.headers.get('Access-Control-Allow-Origin'), null, 'unknown origins get no CORS header');

console.log('worker tests passed');
