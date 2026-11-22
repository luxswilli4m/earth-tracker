#!/usr/bin/env node
// Builds site/data/satellites.json from CelesTrak.
//
// Runs once a day in GitHub Actions (see .github/workflows/deploy.yml), so every
// visitor reads one static file and CelesTrak only sees one request per day.
// Please keep it that way: https://celestrak.org/usage-policy.php
//
// Usage:
//   node scripts/fetch-satellites.mjs                 # live CelesTrak data
//   node scripts/fetch-satellites.mjs --sample FILE   # offline: build from a saved GP JSON file

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'site/data/satellites.json');

const GP_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';
// Ownership, launch date and object type live in the satellite catalogue (SATCAT), not in GP data.
const SATCAT_URLS = [
  'https://celestrak.org/pub/satcat.csv',
  'https://celestrak.org/satcat/records.php?GROUP=active&FORMAT=CSV',
];
const UA = 'earth-tracker (github.com/luxswilli4m/earth-tracker; daily build)';

// Order of values in each satellite row of the output file. The front end reads FIELDS, so
// adding a column here only needs a matching read in site/js/satellites.js.
const FIELDS = [
  'name', 'norad', 'intl', 'epoch', 'meanMotion', 'ecc', 'inc', 'raan', 'argp', 'meanAnomaly',
  'bstar', 'mmDot', 'mmDdot', 'owner', 'launch', 'type', 'ops',
];

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return as === 'json' ? res.json() : res.text();
}

// Small CSV parser that handles quoted fields with commas (SATCAT names can contain them).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function loadSatcat() {
  for (const url of SATCAT_URLS) {
    try {
      const rows = parseCsv(await get(url));
      const head = rows.shift();
      const col = (n) => head.indexOf(n);
      const iId = col('NORAD_CAT_ID');
      if (iId < 0) throw new Error('unexpected SATCAT header');
      const map = new Map();
      for (const r of rows) {
        if (r.length < head.length) continue;
        map.set(Number(r[iId]), {
          owner: r[col('OWNER')] || '',
          launch: r[col('LAUNCH_DATE')] || '',
          type: r[col('OBJECT_TYPE')] || '',
          ops: r[col('OPS_STATUS_CODE')] || '',
        });
      }
      console.log(`SATCAT: ${map.size} records from ${url}`);
      return map;
    } catch (err) {
      console.warn(`SATCAT source failed (${err.message}), trying next`);
    }
  }
  // Ownership is a nice-to-have; positions still work without it.
  console.warn('SATCAT unavailable: building without owner data');
  return new Map();
}

const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));

async function main() {
  const sampleIdx = process.argv.indexOf('--sample');
  let gp, satcat;
  if (sampleIdx > -1) {
    const sample = JSON.parse(await readFile(resolve(process.argv[sampleIdx + 1]), 'utf8'));
    gp = sample.gp;
    satcat = new Map(Object.entries(sample.satcat || {}).map(([k, v]) => [Number(k), v]));
    console.log(`Sample mode: ${gp.length} objects`);
  } else {
    gp = await get(GP_URL, 'json');
    if (!Array.isArray(gp) || gp.length < 1000) {
      throw new Error(`GP data looks wrong (${Array.isArray(gp) ? gp.length : typeof gp} records)`);
    }
    console.log(`GP: ${gp.length} active objects`);
    satcat = await loadSatcat();
  }

  const rows = gp.map((o) => {
    const s = satcat.get(Number(o.NORAD_CAT_ID)) || {};
    return [
      (o.OBJECT_NAME || '').trim(), Number(o.NORAD_CAT_ID), o.OBJECT_ID || '', o.EPOCH,
      num(o.MEAN_MOTION), num(o.ECCENTRICITY), num(o.INCLINATION), num(o.RA_OF_ASC_NODE),
      num(o.ARG_OF_PERICENTER), num(o.MEAN_ANOMALY), num(o.BSTAR), num(o.MEAN_MOTION_DOT),
      num(o.MEAN_MOTION_DDOT), s.owner || '', s.launch || '', s.type || '', s.ops || '',
    ];
  });

  const out = {
    generated: new Date().toISOString(),
    source: sampleIdx > -1 ? 'SAMPLE DATA (not real satellites)' : 'CelesTrak GP (active) + SATCAT',
    fields: FIELDS,
    count: rows.length,
    sats: rows,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Wrote ${rows.length} satellites to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
