// Web worker: turns orbital elements into positions with SGP4, off the main thread.
// Positions and velocities come back in Earth-fixed coordinates (metres, metres/second),
// which is the frame Cesium draws the globe in.
import { json2satrec, sgp4, gstime, eciToEcf, jday } from '../vendor/satellite.esm.js';

let satrecs = [];

function toOmm(row, f) {
  return {
    OBJECT_NAME: row[f.name], NORAD_CAT_ID: row[f.norad], OBJECT_ID: row[f.intl], EPOCH: row[f.epoch],
    MEAN_MOTION: row[f.meanMotion], ECCENTRICITY: row[f.ecc], INCLINATION: row[f.inc],
    RA_OF_ASC_NODE: row[f.raan], ARG_OF_PERICENTER: row[f.argp], MEAN_ANOMALY: row[f.meanAnomaly],
    BSTAR: row[f.bstar], MEAN_MOTION_DOT: row[f.mmDot], MEAN_MOTION_DDOT: row[f.mmDdot],
  };
}

// Earth's rotation, needed to turn inertial velocity into Earth-fixed velocity.
const OMEGA_EARTH = 7.2921150e-5; // rad/s

function step(timeMs) {
  const n = satrecs.length;
  const pos = new Float64Array(n * 3);
  const vel = new Float32Array(n * 3);
  const d = new Date(timeMs);
  const jd = jday(d);
  const gmst = gstime(jd);
  const cosG = Math.cos(gmst), sinG = Math.sin(gmst);
  for (let i = 0; i < n; i++) {
    const rec = satrecs[i];
    const o = i * 3;
    let r = null;
    if (rec) {
      try {
        r = sgp4(rec, (jd - rec.jdsatepoch) * 1440);
      } catch {
        r = null;
      }
    }
    if (!r || !r.position || rec.error) {
      pos[o] = pos[o + 1] = pos[o + 2] = NaN;
      continue;
    }
    const p = eciToEcf(r.position, gmst); // km
    pos[o] = p.x * 1000; pos[o + 1] = p.y * 1000; pos[o + 2] = p.z * 1000;
    // Velocity: rotate inertial velocity into the Earth frame, then remove Earth's spin (ω × r).
    const v = r.velocity; // km/s, inertial
    const vx = v.x * cosG + v.y * sinG;
    const vy = -v.x * sinG + v.y * cosG;
    vel[o] = (vx + OMEGA_EARTH * p.y) * 1000;
    vel[o + 1] = (vy - OMEGA_EARTH * p.x) * 1000;
    vel[o + 2] = v.z * 1000;
  }
  return { pos, vel };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    const f = Object.fromEntries(msg.fields.map((k, i) => [k, i]));
    satrecs = msg.rows.map((row) => {
      try {
        return json2satrec(toOmm(row, f));
      } catch {
        return null;
      }
    });
    self.postMessage({ type: 'ready', count: satrecs.length });
  } else if (msg.type === 'step') {
    const { pos, vel } = step(msg.timeMs);
    self.postMessage({ type: 'positions', timeMs: msg.timeMs, pos, vel }, [pos.buffer, vel.buffer]);
  }
};
