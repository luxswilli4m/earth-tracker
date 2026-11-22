// Sign-in for the gated parts of the app (live feeds and the markets panel, in later stages).
// The map itself is public. The Worker is what actually enforces access: this file only
// stores the session token the Worker hands out and attaches it to gated requests.
import { CONFIG } from './config.js';

const KEY = 'earth-tracker.session';
const listeners = new Set();

function read() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.token && s.expires > Date.now()) return s;
  } catch {
    /* storage unavailable or corrupt: treat as signed out */
  }
  return null;
}

function write(s) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore: the session just won't survive a reload */
  }
  listeners.forEach((fn) => fn(isSignedIn()));
}

let session = read();

export const authConfigured = () => Boolean(CONFIG.workerUrl);
export const isSignedIn = () => Boolean(session && session.expires > Date.now());
export const onAuthChange = (fn) => listeners.add(fn);

export async function signIn(password) {
  const res = await fetch(`${CONFIG.workerUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.status === 401) throw new Error('Wrong password');
  if (res.status === 429) throw new Error('Too many attempts, try again in a few minutes');
  if (!res.ok) throw new Error(`Sign-in failed (HTTP ${res.status})`);
  const { token, expires } = await res.json();
  session = { token, expires };
  write(session);
}

export function signOut() {
  session = null;
  write(null);
}

// For later stages: fetch a gated Worker endpoint with the session attached.
export async function gatedFetch(path, init = {}) {
  if (!isSignedIn()) throw new Error('Sign in required');
  const res = await fetch(`${CONFIG.workerUrl}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${session.token}` },
  });
  if (res.status === 401) signOut();
  return res;
}
