// ShipRelay: one Durable Object that holds the single connection to aisstream.io and shares it
// between every signed-in viewer.
//
// Why it's shaped like this:
// - aisstream doesn't allow browser connections and caps an account at 3 connections, so the
//   key and the connection both live here, and viewers connect to us instead.
// - An open outbound connection keeps this object running, which counts against the free plan's
//   daily allowance. So it only connects while at least one viewer is watching, and hangs up
//   IDLE_MS after the last one leaves.
// - aisstream only sends ships inside the boxes we subscribe to, so we subscribe to the union of
//   what viewers can currently see, and each viewer only receives ships in their own view.
import { DurableObject } from 'cloudflare:workers';
import { viewToBoxes, inBoxes, mergeBoxes, parseAis, packPos } from './ships-core.js';

const AIS_URL = 'https://stream.aisstream.io/v0/stream';
const MESSAGE_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
const IDLE_MS = 2 * 60_000; // hang up this long after the last viewer leaves
const POS_TTL = 30 * 60_000; // forget ships not heard from in 30 minutes
const INFO_TTL = 6 * 60 * 60_000; // keep names and destinations for 6 hours
const FLUSH_MS = 2_000; // send updates to viewers every 2 seconds
const RESUB_MIN_MS = 1_500; // aisstream allows at most one subscription change per second
const MAX_PER_BATCH = 4_000;
// Until anyone has sent their view, subscribe to a small box (aisstream requires at least one).
const PLACEHOLDER_BOX = [[[-28, 152.5], [-27, 153.5]]];

export class ShipRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pos = new Map(); // mmsi -> { lat, lon, sog, cog, hdg, nav, ts }
    this.info = new Map(); // mmsi -> { name, type, ..., ts }
    this.viewers = new Map(); // WebSocket -> { boxes, lastSent, infoSent: Set }
    this.upstream = null;
    this.upstreamState = 'idle'; // idle | connecting | live | error
    this.upstreamError = '';
    this.compression = null;
    this.subKey = '';
    this.lastSubAt = 0;
    this.subTimer = null;
    this.flushTimer = null;
    this.retryMs = 2_000;
    // Diagnostics shown under "Live ships", so problems are visible without opening any logs.
    this.stats = { connects: 0, messages: 0, parsed: 0, lastType: '', lastClose: '', lastError: '', sample: '' };
  }

  // ---------- viewers ----------

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.viewers.set(server, { boxes: [], lastSent: 0, infoSent: new Set() });
    server.addEventListener('message', (e) => this.onViewerMessage(server, e.data));
    const drop = () => this.dropViewer(server);
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);
    await this.ctx.storage.deleteAlarm();
    this.ensureUpstream();
    this.ensureFlushing();
    this.sendStatus(server);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'earth-tracker' } });
  }

  onViewerMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    const v = this.viewers.get(ws);
    if (!v) return;
    if (msg.type === 'view') {
      v.boxes = viewToBoxes(msg.view);
      v.lastSent = 0; // send everything already known in the new view
      this.scheduleResubscribe();
      this.flushTo(ws, v, Date.now());
    }
  }

  dropViewer(ws) {
    if (!this.viewers.delete(ws)) return;
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    if (this.viewers.size === 0) {
      this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    } else {
      this.scheduleResubscribe();
    }
  }

  // Runs IDLE_MS after the last viewer left: hang up and forget everything.
  async alarm() {
    if (this.viewers.size > 0) return;
    this.closeUpstream('idle');
    this.pos.clear();
    this.info.clear();
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  ensureFlushing() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_MS);
  }

  flushAll() {
    const now = Date.now();
    this.prune(now);
    for (const [ws, v] of this.viewers) this.flushTo(ws, v, now);
  }

  flushTo(ws, v, now) {
    if (!v.boxes.length) return;
    const ships = [];
    const info = {};
    for (const [mmsi, p] of this.pos) {
      if (p.ts <= v.lastSent || !inBoxes(p.lat, p.lon, v.boxes)) continue;
      ships.push(packPos(mmsi, p));
      if (!v.infoSent.has(mmsi) && this.info.has(mmsi)) {
        const { ts, ...rest } = this.info.get(mmsi);
        info[mmsi] = rest;
        v.infoSent.add(mmsi);
      }
      if (ships.length >= MAX_PER_BATCH) break;
    }
    v.lastSent = now;
    this.send(ws, { type: 'ships', ships, info, status: this.status() });
  }

  // Static details that arrive after a ship was first sent.
  noteInfoChanged(mmsi) {
    for (const v of this.viewers.values()) v.infoSent.delete(mmsi);
  }

  prune(now) {
    for (const [mmsi, p] of this.pos) if (now - p.ts > POS_TTL) this.pos.delete(mmsi);
    for (const [mmsi, i] of this.info) if (now - i.ts > INFO_TTL) this.info.delete(mmsi);
  }

  status() {
    return {
      upstream: this.upstreamState,
      error: this.upstreamError,
      tracked: this.pos.size,
      compression: this.compression,
      stats: this.stats,
    };
  }

  sendStatus(ws) {
    this.send(ws, { type: 'status', status: this.status() });
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      this.dropViewer(ws);
    }
  }

  // ---------- upstream (aisstream.io) ----------

  boxes() {
    const lists = [...this.viewers.values()].map((v) => v.boxes).filter((b) => b.length);
    return lists.length ? mergeBoxes(lists) : PLACEHOLDER_BOX;
  }

  subscription() {
    return { APIKey: this.env.AISSTREAM_KEY, BoundingBoxes: this.boxes(), FilterMessageTypes: MESSAGE_TYPES };
  }

  async ensureUpstream() {
    if (this.upstream || this.upstreamState === 'connecting' || this.viewers.size === 0) return;
    if (!this.env.AISSTREAM_KEY) {
      this.upstreamState = 'error';
      this.upstreamError = 'AISSTREAM_KEY secret is not set on the Worker';
      return;
    }
    this.upstreamState = 'connecting';
    this.stats.connects++;
    try {
      // AIS_URL can be overridden for local testing; the key never leaves this object.
      const url = (this.env.AIS_URL || AIS_URL).replace(/^ws/, 'http');
      const res = await fetch(url, { headers: { Upgrade: 'websocket' } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`aisstream refused the connection (HTTP ${res.status})`);
      ws.accept();
      this.upstream = ws;
      // aisstream closes the connection if the subscription doesn't arrive within 3 seconds.
      const sub = this.subscription();
      ws.send(JSON.stringify(sub));
      this.subKey = JSON.stringify(sub.BoundingBoxes);
      this.lastSubAt = Date.now();
      ws.addEventListener('message', (e) => this.onAis(e.data));
      ws.addEventListener('close', (e) => {
        this.stats.lastClose = `${new Date().toISOString().slice(11, 19)} UTC, code ${e.code}${e.reason ? `: ${e.reason}` : ''}`;
        this.onUpstreamClosed(`aisstream closed the connection (code ${e.code}${e.reason ? `: ${e.reason}` : ''})`);
      });
      ws.addEventListener('error', () => this.onUpstreamClosed('connection error'));
      this.upstreamState = 'live';
      this.retryMs = 2_000;
    } catch (err) {
      this.onUpstreamClosed(err.message);
    }
    for (const ws of this.viewers.keys()) this.sendStatus(ws);
  }

  onUpstreamClosed(reason) {
    this.upstream = null;
    if (this.upstreamState === 'idle') return; // we hung up on purpose
    this.upstreamState = 'error';
    this.upstreamError = reason;
    this.stats.lastError = reason;
    for (const ws of this.viewers.keys()) this.sendStatus(ws);
    // 'error' and 'close' often fire together: only schedule one retry.
    if (this.viewers.size > 0 && !this.retryTimer) {
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 60_000);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.upstreamState = 'retrying';
        this.ensureUpstream();
      }, wait);
    }
  }

  closeUpstream(state) {
    this.upstreamState = state;
    const ws = this.upstream;
    this.upstream = null;
    if (ws) try { ws.close(1000, 'no viewers'); } catch { /* already closed */ }
  }

  scheduleResubscribe() {
    if (this.subTimer) return;
    const wait = Math.max(0, RESUB_MIN_MS - (Date.now() - this.lastSubAt));
    this.subTimer = setTimeout(() => {
      this.subTimer = null;
      this.resubscribe();
    }, wait);
  }

  resubscribe() {
    if (!this.upstream) return this.ensureUpstream();
    const sub = this.subscription();
    const key = JSON.stringify(sub.BoundingBoxes);
    if (key === this.subKey) return;
    try {
      this.upstream.send(JSON.stringify(sub)); // replaces the previous subscription
      this.subKey = key;
      this.lastSubAt = Date.now();
    } catch (err) {
      this.onUpstreamClosed(err.message);
    }
  }

  onAis(data) {
    let msg;
    const raw = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.stats.messages++;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.stats.lastError = `unreadable message: ${raw.slice(0, 120)}`;
      return;
    }
    if (msg.error || msg.Error) {
      this.upstreamError = String(msg.error || msg.Error);
      this.stats.lastError = `aisstream says: ${this.upstreamError}`;
      return;
    }
    this.stats.lastType = msg.MessageType || Object.keys(msg).join(',').slice(0, 60);
    if (msg.MessageType === 'SubscriptionConfirmation' || msg.Message?.SubscriptionConfirmation) {
      const c = msg.Message?.SubscriptionConfirmation || msg;
      if (typeof c.CompressionEnabled === 'boolean') this.compression = c.CompressionEnabled;
      return;
    }
    const r = parseAis(msg);
    if (!r) {
      // Keep one example of a message we couldn't use, trimmed, to spot format changes.
      if (!this.stats.sample) this.stats.sample = raw.slice(0, 300);
      return;
    }
    this.stats.parsed++;
    this.upstreamError = '';
    if (r.pos) this.pos.set(r.mmsi, r.pos);
    if (r.info) {
      const prev = this.info.get(r.mmsi) || {};
      const merged = { ...prev, ...Object.fromEntries(Object.entries(r.info).filter(([, v]) => v !== null && v !== '')) };
      const changed = JSON.stringify({ ...prev, ts: 0 }) !== JSON.stringify({ ...merged, ts: 0 });
      merged.ts = Date.now();
      this.info.set(r.mmsi, merged);
      if (changed) this.noteInfoChanged(r.mmsi);
    }
  }
}
