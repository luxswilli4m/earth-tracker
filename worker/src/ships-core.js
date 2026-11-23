// Pure helpers for the ship relay: bounding boxes and AIS message parsing.
// Kept free of Cloudflare-only APIs so they can be tested with plain Node (worker/test.mjs).

// A view from the browser: { west, south, east, north } in degrees. "west > east" means the
// view crosses the 180° line, which AIS bounding boxes can't express, so it becomes two boxes.
// aisstream wants each box as [[lat, lon], [lat, lon]].
// Views wider or taller than this are ignored: zoomed out that far, the stream is a flood of
// messages too small to see, and it's what makes the free-plan relay drop and restart.
export const MAX_VIEW_DEG = 45;

export function viewToBoxes(v) {
  if (!v || ![v.west, v.south, v.east, v.north].every(Number.isFinite)) return [];
  const width = v.east >= v.west ? v.east - v.west : 360 - v.west + v.east;
  if (width > MAX_VIEW_DEG || Math.abs(v.north - v.south) > MAX_VIEW_DEG) return [];
  const s = Math.max(-90, Math.min(v.south, v.north));
  const n = Math.min(90, Math.max(v.south, v.north));
  const w = Math.max(-180, Math.min(180, v.west));
  const e = Math.max(-180, Math.min(180, v.east));
  if (w <= e) return [[[s, w], [n, e]]];
  return [[[s, w], [n, 180]], [[s, -180], [n, e]]];
}

export function inBoxes(lat, lon, boxes) {
  for (const [[s, w], [n, e]] of boxes) {
    if (lat >= s && lat <= n && lon >= w && lon <= e) return true;
  }
  return false;
}

// Combine every viewer's boxes into one subscription. Many small boxes are fine; if there are
// lots of viewers, fall back to one box around everything to stay well within aisstream's limits.
export function mergeBoxes(list, max = 12) {
  const all = list.flat();
  if (all.length <= max) return all;
  let s = 90, w = 180, n = -90, e = -180;
  for (const [[bs, bw], [bn, be]] of all) {
    s = Math.min(s, bs); w = Math.min(w, bw); n = Math.max(n, bn); e = Math.max(e, be);
  }
  return [[[s, w], [n, e]]];
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === 'string' ? v.replace(/@+$/, '').trim() : '');

function etaString(eta) {
  if (!eta || !eta.Month || !eta.Day) return '';
  const pad = (x) => String(x).padStart(2, '0');
  const time = eta.Hour < 24 && eta.Minute < 60 ? ` ${pad(eta.Hour)}:${pad(eta.Minute)} UTC` : '';
  return `${pad(eta.Day)}/${pad(eta.Month)}${time}`;
}

// Turns one aisstream message into { mmsi, pos?, info? }, or null if it's unusable.
// pos  = latest position: { lat, lon, sog, cog, hdg, nav, ts }
// info = static details:  { name, type, dest, imo, call, len, beam, eta, draught }
export function parseAis(msg, now = Date.now()) {
  if (!msg || typeof msg !== 'object') return null;
  const meta = msg.MetaData || {};
  const body = msg.Message || {};
  const type = msg.MessageType;
  const mmsi = Number(meta.MMSI ?? meta.mmsi ?? body[type]?.UserID);
  if (!Number.isInteger(mmsi) || mmsi <= 0) return null;
  const out = { mmsi };
  const metaName = text(meta.ShipName ?? meta.shipName);

  if (type === 'PositionReport' || type === 'StandardClassBPositionReport' || type === 'ExtendedClassBPositionReport') {
    const p = body[type] || {};
    const lat = num(p.Latitude), lon = num(p.Longitude);
    if (p.Valid === false || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const sog = num(p.Sog), cog = num(p.Cog), hdg = num(p.TrueHeading);
    out.pos = {
      lat, lon,
      sog: sog !== null && sog < 102.2 ? sog : null, // 102.3 = not available
      cog: cog !== null && cog < 360 ? cog : null, // 360 = not available
      hdg: hdg !== null && hdg < 360 ? hdg : null, // 511 = not available
      nav: num(p.NavigationalStatus),
      ts: now,
    };
    if (metaName) out.info = { name: metaName };
    return out;
  }

  if (type === 'ShipStaticData') {
    const p = body[type] || {};
    const dim = p.Dimension || {};
    const len = (num(dim.A) || 0) + (num(dim.B) || 0);
    const beam = (num(dim.C) || 0) + (num(dim.D) || 0);
    out.info = {
      name: text(p.Name) || metaName,
      type: num(p.Type),
      dest: text(p.Destination),
      imo: num(p.ImoNumber) || null,
      call: text(p.CallSign),
      len: len || null,
      beam: beam || null,
      eta: etaString(p.Eta),
      draught: num(p.MaximumStaticDraught) || null,
    };
    return out;
  }

  if (type === 'StaticDataReport') {
    const p = body[type] || {};
    const info = {};
    if (p.ReportA && p.ReportA.Valid !== false && p.ReportA.Name) info.name = text(p.ReportA.Name);
    if (p.ReportB && p.ReportB.Valid !== false) {
      const b = p.ReportB;
      if (num(b.ShipType)) info.type = b.ShipType;
      if (b.CallSign) info.call = text(b.CallSign);
      const d = b.Dimension || {};
      const len = (num(d.A) || 0) + (num(d.B) || 0);
      const beam = (num(d.C) || 0) + (num(d.D) || 0);
      if (len) info.len = len;
      if (beam) info.beam = beam;
    }
    if (!Object.keys(info).length && metaName) info.name = metaName;
    if (!Object.keys(info).length) return null;
    out.info = info;
    return out;
  }

  return null;
}

// Wire format to the browser, kept compact: one array per ship.
export function packPos(mmsi, p) {
  const r = (x, d) => (x === null ? null : Math.round(x * d) / d);
  return [mmsi, r(p.lat, 1e5), r(p.lon, 1e5), r(p.sog, 10), r(p.cog, 10), p.hdg, p.nav, Math.round(p.ts / 1000)];
}
