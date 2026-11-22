// Satellite layer: draws every active satellite as a point and keeps it moving.
//
// A web worker runs SGP4 for all satellites a few times a second and returns positions and
// velocities. Between those updates, each frame nudges every point along its velocity, so
// motion stays smooth even when the clock is sped up.
/* global Cesium */
import { json2satrec, sgp4, gstime, eciToEcf, jday } from '../vendor/satellite.esm.js';
import { ownerName } from './owners.js';

const MU = 398600.4418; // km^3/s^2, Earth's gravitational parameter
const RE = 6378.137; // km, Earth's equatorial radius

export const ORBITS = {
  LEO: { label: 'Low Earth orbit', color: '#4fd1ff' },
  MEO: { label: 'Medium Earth orbit', color: '#ffb547' },
  GEO: { label: 'Geostationary', color: '#ff5cc8' },
  HEO: { label: 'Highly elliptical', color: '#8dff6a' },
};

const TYPES = { PAY: 'Payload (satellite)', 'R/B': 'Rocket body', DEB: 'Debris', UNK: 'Unknown' };

function classify(meanMotion, ecc) {
  const period = 1440 / meanMotion; // minutes
  if (ecc > 0.25) return 'HEO';
  if (period < 128) return 'LEO';
  if (meanMotion > 0.98 && meanMotion < 1.02 && ecc < 0.05) return 'GEO';
  return 'MEO';
}

export class SatelliteLayer {
  constructor(viewer, data, { onReady, onFirstPositions } = {}) {
    this.onFirstPositions = onFirstPositions;
    this.viewer = viewer;
    this.generated = data.generated;
    this.source = data.source;
    const f = Object.fromEntries(data.fields.map((k, i) => [k, i]));
    this.f = f;
    this.rows = data.sats;

    this.meta = data.sats.map((r) => {
      const mm = r[f.meanMotion];
      const ecc = r[f.ecc];
      const nRad = (mm * 2 * Math.PI) / 86400;
      const a = Math.cbrt(MU / (nRad * nRad));
      return {
        name: r[f.name],
        norad: r[f.norad],
        intl: r[f.intl],
        owner: r[f.owner],
        launch: r[f.launch],
        type: r[f.type],
        epoch: r[f.epoch],
        inc: r[f.inc],
        ecc,
        period: 1440 / mm,
        a,
        apogee: a * (1 + ecc) - RE,
        perigee: a * (1 - ecc) - RE,
        orbit: classify(mm, ecc),
        search: `${r[f.name]} ${r[f.norad]} ${r[f.intl]}`.toLowerCase(),
      };
    });

    this.colors = Object.fromEntries(
      Object.entries(ORBITS).map(([k, v]) => [k, Cesium.Color.fromCssColorString(v.color)]),
    );
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    const scale = new Cesium.NearFarScalar(1.5e6, 2.0, 4.0e7, 0.8);
    this.meta.forEach((m, i) => {
      this.points.add({
        position: Cesium.Cartesian3.ZERO,
        pixelSize: 3,
        color: this.colors[m.orbit],
        scaleByDistance: scale,
        show: false,
        id: { layer: 'satellite', index: i },
      });
    });

    this.visible = new Uint8Array(this.meta.length).fill(1);
    this.valid = new Uint8Array(this.meta.length);
    this.pos = null;
    this.vel = null;
    this.baseTime = 0;
    this.busy = false;
    this.lastRequestWall = 0;
    this.lastRequestSim = 0;
    this.selected = -1;
    this.enabled = true;

    this.pathCollection = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.path = null;
    this.pathSim = 0;
    this.selRec = null;

    this.worker = new Worker(new URL('./sat-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onWorker(e.data, onReady);
    this.worker.postMessage({ type: 'init', rows: this.rows, fields: data.fields });

    this.scratch = new Cesium.Cartesian3();
    viewer.clock.onTick.addEventListener((clock) => this.tick(clock));
  }

  onWorker(msg, onReady) {
    if (msg.type === 'ready') {
      this.ready = true;
      this.request(this.simMs());
      onReady?.();
    } else if (msg.type === 'positions') {
      this.pos = msg.pos;
      this.vel = msg.vel;
      this.baseTime = msg.timeMs;
      this.busy = false;
      for (let i = 0; i < this.meta.length; i++) this.valid[i] = Number.isFinite(msg.pos[i * 3]) ? 1 : 0;
      this.applyVisibility();
      if (this.onFirstPositions) {
        const fn = this.onFirstPositions;
        this.onFirstPositions = null;
        fn();
      }
    }
  }

  simMs() {
    return Cesium.JulianDate.toDate(this.viewer.clock.currentTime).getTime();
  }

  request(simMs) {
    if (!this.ready || this.busy) return;
    this.busy = true;
    this.lastRequestWall = performance.now();
    this.lastRequestSim = simMs;
    this.worker.postMessage({ type: 'step', timeMs: simMs });
  }

  tick() {
    if (!this.enabled) return;
    const sim = this.simMs();
    const wall = performance.now();
    // Fresh SGP4 positions roughly 4x a second, or right away after a big jump on the timeline.
    if (wall - this.lastRequestWall > 250 || Math.abs(sim - this.lastRequestSim) > 60_000) this.request(sim);
    if (!this.pos) return;

    const dt = (sim - this.baseTime) / 1000;
    const { pos, vel, points, scratch } = this;
    const len = points.length;
    for (let i = 0; i < len; i++) {
      if (!this.visible[i] || !this.valid[i]) continue;
      const o = i * 3;
      scratch.x = pos[o] + vel[o] * dt;
      scratch.y = pos[o + 1] + vel[o + 1] * dt;
      scratch.z = pos[o + 2] + vel[o + 2] * dt;
      points.get(i).position = scratch;
    }

    if (this.selected >= 0 && Math.abs(sim - this.pathSim) > 20_000) this.drawPath();
  }

  setEnabled(on) {
    this.enabled = on;
    this.points.show = on;
    this.pathCollection.show = on;
  }

  // filter: { orbits: Set of orbit keys, owner: code or '', types: Set of type codes or null }
  setFilter(filter) {
    this.filter = filter;
    this.meta.forEach((m, i) => {
      const ok =
        filter.orbits.has(m.orbit) &&
        (!filter.owner || m.owner === filter.owner) &&
        (!filter.payloadsOnly || !m.type || m.type === 'PAY');
      this.visible[i] = ok ? 1 : 0;
    });
    this.applyVisibility();
  }

  applyVisibility() {
    for (let i = 0; i < this.points.length; i++) {
      this.points.get(i).show = Boolean(this.visible[i] && this.valid[i]) || i === this.selected;
    }
  }

  visibleCount() {
    let n = 0;
    for (let i = 0; i < this.visible.length; i++) n += this.visible[i] && this.valid[i] ? 1 : 0;
    return n;
  }

  owners() {
    const counts = new Map();
    for (const m of this.meta) counts.set(m.owner, (counts.get(m.owner) || 0) + 1);
    return [...counts.entries()]
      .filter(([code]) => code)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, name: ownerName(code), count }));
  }

  search(query, limit = 25) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out = [];
    for (let i = 0; i < this.meta.length && out.length < limit; i++) {
      if (this.meta[i].search.includes(q)) out.push(i);
    }
    return out;
  }

  select(i) {
    if (this.selected >= 0) {
      const p = this.points.get(this.selected);
      p.pixelSize = 3;
      p.color = this.colors[this.meta[this.selected].orbit];
      p.outlineWidth = 0;
    }
    this.selected = i;
    this.pathCollection.removeAll();
    this.path = null;
    this.selRec = null;
    if (i < 0) {
      this.applyVisibility();
      return;
    }
    const p = this.points.get(i);
    p.pixelSize = 10;
    p.color = Cesium.Color.WHITE;
    p.outlineColor = this.colors[this.meta[i].orbit];
    p.outlineWidth = 3;
    p.show = true;
    const r = this.rows[i];
    const f = this.f;
    try {
      this.selRec = json2satrec({
        OBJECT_NAME: r[f.name], NORAD_CAT_ID: r[f.norad], OBJECT_ID: r[f.intl], EPOCH: r[f.epoch],
        MEAN_MOTION: r[f.meanMotion], ECCENTRICITY: r[f.ecc], INCLINATION: r[f.inc],
        RA_OF_ASC_NODE: r[f.raan], ARG_OF_PERICENTER: r[f.argp], MEAN_ANOMALY: r[f.meanAnomaly],
        BSTAR: r[f.bstar], MEAN_MOTION_DOT: r[f.mmDot], MEAN_MOTION_DDOT: r[f.mmDdot],
      });
    } catch {
      this.selRec = null;
    }
    this.drawPath();
  }

  // The path the satellite will trace over the ground-fixed globe during its next orbit.
  drawPath() {
    this.pathCollection.removeAll();
    const i = this.selected;
    if (i < 0 || !this.selRec) return;
    const m = this.meta[i];
    const start = this.simMs();
    this.pathSim = start;
    const steps = 240;
    const span = Math.min(m.period, 1440) * 60_000; // one orbit, capped at a day for GEO
    const positions = [];
    for (let k = 0; k <= steps; k++) {
      const d = new Date(start + (span * k) / steps);
      const jd = jday(d);
      let r;
      try {
        r = sgp4(this.selRec, (jd - this.selRec.jdsatepoch) * 1440);
      } catch {
        r = null;
      }
      if (!r || !r.position) continue;
      const p = eciToEcf(r.position, gstime(jd));
      positions.push(new Cesium.Cartesian3(p.x * 1000, p.y * 1000, p.z * 1000));
    }
    if (positions.length > 1) {
      this.pathCollection.add({
        positions,
        width: 1.5,
        material: Cesium.Material.fromType('Color', {
          color: this.colors[m.orbit].withAlpha(0.8),
        }),
      });
    }
  }

  // Live details for the info card.
  details(i) {
    const m = this.meta[i];
    let altitude = null, lat = null, lon = null, speed = null;
    const p = this.points.get(i).position;
    if (this.valid[i] && p && !Cesium.Cartesian3.equals(p, Cesium.Cartesian3.ZERO)) {
      const c = Cesium.Cartographic.fromCartesian(p);
      if (c) {
        altitude = c.height / 1000;
        lat = Cesium.Math.toDegrees(c.latitude);
        lon = Cesium.Math.toDegrees(c.longitude);
        const r = Cesium.Cartesian3.magnitude(p) / 1000;
        speed = Math.sqrt(MU * (2 / r - 1 / m.a)); // vis-viva, km/s relative to the stars
      }
    }
    const epochMs = new Date(m.epoch.endsWith('Z') ? m.epoch : `${m.epoch}Z`).getTime();
    return {
      ...m,
      ownerName: ownerName(m.owner),
      typeName: TYPES[m.type] || m.type || 'Not listed',
      orbitName: ORBITS[m.orbit].label,
      altitude, lat, lon, speed,
      epochAgeHours: (this.simMs() - epochMs) / 3_600_000,
      valid: Boolean(this.valid[i]),
    };
  }

  position(i) {
    return this.points.get(i).position;
  }
}
