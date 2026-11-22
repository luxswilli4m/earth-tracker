#!/usr/bin/env node
// Makes synthetic satellite data for offline development, shaped like CelesTrak's GP JSON.
// These are NOT real satellites; the real site always builds from live CelesTrak data.
//   node tools/make-sample.mjs > tools/sample-gp.json
//   node scripts/fetch-satellites.mjs --sample tools/sample-gp.json

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rand() * a.length)];
const epoch = new Date().toISOString().replace('Z', '');

const gp = [];
const satcat = {};
let id = 90000;

function add(name, owner, meanMotion, inc, ecc = 0.0001 + rand() * 0.001, type = 'PAY') {
  const n = id++;
  gp.push({
    OBJECT_NAME: name, OBJECT_ID: `2024-${String(n % 999).padStart(3, '0')}A`, EPOCH: epoch,
    MEAN_MOTION: meanMotion, ECCENTRICITY: ecc, INCLINATION: inc, RA_OF_ASC_NODE: rand() * 360,
    ARG_OF_PERICENTER: rand() * 360, MEAN_ANOMALY: rand() * 360, NORAD_CAT_ID: n,
    BSTAR: 0.0001, MEAN_MOTION_DOT: 0.00001, MEAN_MOTION_DDOT: 0,
  });
  satcat[n] = { owner, launch: '2024-01-01', type, ops: '+' };
}

add('SAMPLE ISS', 'ISS', 15.5, 51.64, 0.0005);
for (let i = 0; i < 7000; i++) add(`SAMPLE STARLINK-${i}`, 'US', 15.06, pick([53, 53.2, 43, 70, 97.6]));
for (let i = 0; i < 1500; i++) add(`SAMPLE LEO-${i}`, pick(['PRC', 'CIS', 'ESA', 'JPN', 'IND', 'UK', 'FR']), 13.5 + rand() * 2.5, 40 + rand() * 60);
for (let i = 0; i < 600; i++) add(`SAMPLE ONEWEB-${i}`, 'UK', 13.2, 87.9);
for (let i = 0; i < 120; i++) add(`SAMPLE GNSS-${i}`, pick(['US', 'CIS', 'ESA', 'PRC']), 2.0, 55 + rand() * 10);
for (let i = 0; i < 500; i++) add(`SAMPLE GEO-${i}`, pick(['US', 'SES', 'EUTE', 'ITSO', 'JPN', 'PRC', 'AUS']), 1.0027, rand() * 2);
for (let i = 0; i < 40; i++) add(`SAMPLE MOLNIYA-${i}`, 'CIS', 2.006, 63.4, 0.7);

process.stdout.write(JSON.stringify({ gp, satcat }));
