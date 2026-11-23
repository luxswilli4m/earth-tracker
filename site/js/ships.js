// Live ships layer (signed-in only). The browser never talks to aisstream.io directly: it opens
// a WebSocket to our Worker, tells it what part of the globe is in view, and receives the ships
// there every couple of seconds.
/* global Cesium */
import { CONFIG } from './config.js';
import { getToken, isSignedIn, gatedFetch } from './auth.js';
import { SHIP_GROUPS, shipGroup, flagFromMmsi, typeName, navStatus } from './ais-codes.js';

const STALE_MS = 30 * 60_000;
// Matches the relay's limit (MAX_VIEW_DEG = 45): only stream when zoomed in this close.
const MAX_VIEW_DEG = 40;

function icon(color, moving) {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.lineWidth = 1.5;
  g.beginPath();
  if (moving) {
    // arrow pointing "up" (north); rotated per ship by its heading
    g.moveTo(12, 2); g.lineTo(19, 21); g.lineTo(12, 16); g.lineTo(5, 21); g.closePath();
  } else {
    g.arc(12, 12, 5.5, 0, Math.PI * 2);
  }
  g.fill();
  g.stroke();
  return c;
}

export class ShipLayer {
  constructor(viewer, { onStatus, onChange } = {}) {
    this.viewer = viewer;
    this.onStatus = onStatus || (() => {});
    this.onChange = onChange || (() => {});
    this.collection = viewer.scene.primitives.add(new Cesium.BillboardCollection({ scene: viewer.scene }));
    this.ships = new Map(); // mmsi -> { p: packed array, info, bb }
    this.groupsOn = new Set(Object.keys(SHIP_GROUPS));
    this.icons = {};
    for (const [k, g] of Object.entries(SHIP_GROUPS)) this.icons[k] = { move: icon(g.color, true), still: icon(g.color, false) };
    this.enabled = false;
    this.ws = null;
    this.failures = 0;
    this.selected = null;
    this.scale = new Cesium.NearFarScalar(1.5e5, 1.1, 1.2e7, 0.35);
    viewer.camera.moveEnd.addEventListener(() => this.sendView());
    setInterval(() => this.prune(), 60_000);
  }

  setEnabled(on) {
    this.enabled = on;
    this.collection.show = on;
    if (on) this.connect();
    else this.disconnect();
  }

  setGroups(set) {
    this.groupsOn = set;
    for (const s of this.ships.values()) s.bb.show = this.groupsOn.has(s.group);
    this.onChange();
  }

  status(state, detail = '') {
    this.state = state;
    this.onStatus(state, detail);
  }

  connect() {
    if (!this.enabled || this.ws) return;
    if (!isSignedIn()) return this.status('signin');
    if (!CONFIG.workerUrl) return this.status('error', 'Worker URL not set');
    this.status('connecting');
    // Send the current view up front so the relay subscribes to the right area immediately.
    const v = this.currentView();
    const qs = v ? `?view=${[v.west, v.south, v.east, v.north].map((x) => x.toFixed(3)).join(',')}` : '';
    const url = `${CONFIG.workerUrl.replace(/^http/, 'ws')}/api/ships${qs}`;
    const ws = new WebSocket(url, ['earth-tracker', `auth.${getToken()}`]);
    this.ws = ws;
    ws.onopen = () => {
      this.failures = 0;
      this.sendView();
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      this.ws = null;
      if (!this.enabled) return;
      this.failures++;
      // Several quick failures in a row usually mean the session expired: check, and stop if so.
      if (this.failures >= 3) {
        gatedFetch('/api/me').then((r) => {
          if (r.status === 401) this.status('signin');
          else this.retry();
        }).catch(() => this.retry());
      } else this.retry();
    };
  }

  retry() {
    if (!isSignedIn()) return this.status('signin');
    const wait = Math.min(30_000, 2_000 * 2 ** Math.min(this.failures, 4));
    this.status('reconnecting', `retrying in ${Math.round(wait / 1000)} s`);
    setTimeout(() => this.connect(), wait);
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close(1000, 'layer off');
    this.collection.removeAll();
    this.ships.clear();
    this.selected = null;
    this.status('off');
    this.onChange();
  }

  // What's on screen, padded generously so ships just off the edge are already loaded when you
  // pan. Returns null when zoomed out too far to stream (the relay would ignore it anyway).
  currentView() {
    const r = this.viewer.camera.computeViewRectangle(this.viewer.scene.globe.ellipsoid);
    if (!r) return null;
    const d = Cesium.Math.toDegrees;
    let west = d(r.west), east = d(r.east);
    let south = d(r.south), north = d(r.north);
    const width = east >= west ? east - west : 360 - west + east;
    const height = north - south;
    if (width > MAX_VIEW_DEG || height > MAX_VIEW_DEG) return null;
    // Pad up to 50% each side, but never past the limit.
    const padX = Math.min(width * 0.5, (MAX_VIEW_DEG - width) / 2);
    const padY = Math.min(height * 0.5, (MAX_VIEW_DEG - height) / 2);
    west -= padX; east += padX;
    south = Math.max(-85, south - padY); north = Math.min(85, north + padY);
    if (west < -180) west += 360;
    if (east > 180) east -= 360;
    return { west, south, east, north };
  }

  sendView() {
    if (!this.enabled) return;
    clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => {
      const view = this.currentView();
      this.zoomedOut = !view;
      if (this.zoomedOut) this.status('zoom');
      else if (this.state === 'zoom') this.status(this.lastUpstream === 'live' ? 'live' : 'connecting');
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'view', view }));
    }, 150);
  }

  onMessage(m) {
    if (m.status) {
      const s = m.status;
      this.lastUpstream = s.upstream;
      // Show what the relay knows, so problems are visible without opening any logs.
      const detail = [`${(s.tracked || 0).toLocaleString()} ships tracked by the relay`];
      if (s.error) detail.push(`feed says: ${s.error}`);
      const st = s.stats;
      if (st && !s.tracked) {
        detail.push(`${st.messages} messages received, ${st.parsed} usable, ${st.connects} connection${st.connects === 1 ? '' : 's'}`);
        if (s.compression === false) detail.push('compression not negotiated');
        if (st.lastError) detail.push(`last problem: ${st.lastError}`);
        if (st.lastClose) detail.push(`last disconnect: ${st.lastClose}`);
        if (st.lastType) detail.push(`last message type: ${st.lastType}`);
        if (st.sample) detail.push(`unused message: ${st.sample.slice(0, 160)}`);
        detail.push(`relay version: ${s.build || 'older than 2026-11-23c'}`);
      }
      this.lastStatus = s; // full details for the browser console: earthTracker.ships.lastStatus
      if (this.zoomedOut) this.status('zoom');
      else if (s.upstream === 'error') this.status('error', [s.error || 'ship feed unavailable', ...detail.slice(1)].join('; '));
      else if (s.upstream === 'live') this.status('live', detail.join('; '));
      else this.status('connecting');
    }
    if (m.type !== 'ships') return;
    for (const [mmsi, info] of Object.entries(m.info || {})) {
      const s = this.ships.get(Number(mmsi));
      if (s) { s.info = { ...s.info, ...info }; this.restyle(s); }
      else this.pendingInfo = { ...(this.pendingInfo || {}), [mmsi]: info };
    }
    for (const p of m.ships) this.upsert(p);
    this.onChange();
  }

  upsert(p) {
    const mmsi = p[0];
    let s = this.ships.get(mmsi);
    const position = Cesium.Cartesian3.fromDegrees(p[2], p[1], 0);
    if (!s) {
      const info = (this.pendingInfo && this.pendingInfo[mmsi]) || {};
      if (this.pendingInfo) delete this.pendingInfo[mmsi];
      s = { p, info, bb: this.collection.add({ position, id: { layer: 'ship', mmsi }, scaleByDistance: this.scale, alignedAxis: Cesium.Cartesian3.UNIT_Z }) };
      this.ships.set(mmsi, s);
    } else {
      s.p = p;
      s.bb.position = position;
    }
    this.restyle(s);
  }

  restyle(s) {
    const [, , , sog, cog, hdg] = s.p;
    s.group = shipGroup(s.info.type);
    const moving = sog !== null && sog >= 0.5;
    const dir = hdg !== null ? hdg : cog;
    const picked = this.selected === s.p[0];
    s.bb.image = this.icons[s.group][moving && dir !== null ? 'move' : 'still'];
    s.bb.rotation = moving && dir !== null ? -Cesium.Math.toRadians(dir) : 0;
    s.bb.width = s.bb.height = picked ? 30 : 16;
    s.bb.show = this.groupsOn.has(s.group) || picked;
  }

  prune() {
    const cutoff = Date.now() / 1000 - STALE_MS / 1000;
    for (const [mmsi, s] of this.ships) {
      if (s.p[7] < cutoff && mmsi !== this.selected) {
        this.collection.remove(s.bb);
        this.ships.delete(mmsi);
      }
    }
    this.onChange();
  }

  counts() {
    let shown = 0;
    for (const s of this.ships.values()) if (s.bb.show) shown++;
    return { shown, total: this.ships.size };
  }

  select(mmsi) {
    const prev = this.selected;
    this.selected = mmsi;
    if (prev !== null && this.ships.has(prev)) this.restyle(this.ships.get(prev));
    if (mmsi !== null && this.ships.has(mmsi)) this.restyle(this.ships.get(mmsi));
  }

  details(mmsi) {
    const s = this.ships.get(mmsi);
    if (!s) return null;
    const [, lat, lon, sog, cog, hdg, nav, ts] = s.p;
    const i = s.info;
    return {
      mmsi, lat, lon, sog, cog, hdg,
      name: i.name || `MMSI ${mmsi}`,
      group: s.group,
      groupLabel: SHIP_GROUPS[s.group].label,
      color: SHIP_GROUPS[s.group].color,
      type: typeName(i.type),
      flag: flagFromMmsi(mmsi),
      nav: navStatus(nav),
      dest: i.dest || '',
      eta: i.eta || '',
      imo: i.imo || null,
      call: i.call || '',
      size: i.len ? `${i.len} × ${i.beam || '?'} m` : '',
      draught: i.draught || null,
      ageSec: Math.max(0, Date.now() / 1000 - ts),
    };
  }

  position(mmsi) {
    return this.ships.get(mmsi)?.bb.position;
  }
}
