// Remembers layer choices. Always saved on this device (localStorage), and when signed in also
// saved to the Worker, so a new device or browser picks up the same setup.
import { isSignedIn, gatedFetch } from './auth.js';

const KEY = 'earth-tracker.prefs';
let saveTimer = null;
let collectFn = () => ({});

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

function writeLocal(record) {
  try {
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable: choices just won't persist on this device */
  }
}

// main.js tells us how to read the current choices off the page.
export function setCollector(fn) {
  collectFn = fn;
}

export function loadLocal() {
  return readLocal();
}

// Call after any change. Saves locally at once and to the Worker a moment later.
export function savePrefs() {
  const record = { prefs: collectFn(), updated: Date.now() };
  writeLocal(record);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!isSignedIn()) return;
    gatedFetch('/api/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: record.prefs }),
    }).catch(() => { /* offline: the local copy still has it */ });
  }, 1500);
}

// When signed in, fetch the synced copy; returns it only if it's newer than this device's.
export async function loadSynced() {
  if (!isSignedIn()) return null;
  try {
    const res = await gatedFetch('/api/prefs');
    if (!res.ok) return null;
    const remote = await res.json();
    const local = readLocal();
    if (remote && remote.prefs && (!local || remote.updated > local.updated)) {
      writeLocal(remote);
      return remote.prefs;
    }
  } catch {
    /* offline or Worker not updated yet */
  }
  return null;
}
