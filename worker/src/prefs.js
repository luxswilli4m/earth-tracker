// SiteStore: a tiny Durable Object that keeps the signed-in layer choices, so they follow you
// between devices. There is one shared store, because everyone signs in with the same password.
import { DurableObject } from 'cloudflare:workers';

const MAX_BYTES = 8_000;

export class SiteStore extends DurableObject {
  async get() {
    return (await this.ctx.storage.get('prefs')) || null;
  }

  async put(prefs) {
    const text = JSON.stringify(prefs);
    if (text.length > MAX_BYTES) throw new Error('prefs too large');
    const record = { prefs, updated: Date.now() };
    await this.ctx.storage.put('prefs', record);
    return record;
  }
}

// Only keep the fields the app knows about, with sensible types, so the store can't be filled with junk.
export function cleanPrefs(p) {
  if (!p || typeof p !== 'object') return null;
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length < 40).slice(0, 20) : undefined);
  const out = {
    satellites: bool(p.satellites),
    orbits: strs(p.orbits),
    owner: typeof p.owner === 'string' && p.owner.length < 20 ? p.owner : undefined,
    payloadOnly: bool(p.payloadOnly),
    ships: bool(p.ships),
    shipGroups: strs(p.shipGroups),
    lanes: bool(p.lanes),
    lanesOpacity: typeof p.lanesOpacity === 'number' && p.lanesOpacity >= 0 && p.lanesOpacity <= 1 ? p.lanesOpacity : undefined,
    labels: bool(p.labels),
    panelCollapsed: bool(p.panelCollapsed),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
