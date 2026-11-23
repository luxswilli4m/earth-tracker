// Quick local checks, run with: node test.mjs (from the worker folder)
// Covers sign-in tokens and the ship relay's pure logic. The Durable Object itself is tested
// end to end with `wrangler dev` and a fake aisstream server (see tools/mock-aisstream.mjs).
import assert from 'node:assert/strict';
import { makeToken, verifyToken, passwordMatches, tokenFrom } from './src/auth.js';
import { viewToBoxes, inBoxes, mergeBoxes, parseAis, packPos } from './src/ships-core.js';

const env = { SITE_PASSWORD: 'correct horse', TOKEN_SECRET: 'x'.repeat(48) };

// ---- auth ----
assert.equal(await passwordMatches(env, 'nope'), false);
assert.equal(await passwordMatches(env, 'correct horse'), true);
const { token, expires } = await makeToken(env);
assert.ok(expires > Date.now());
assert.ok(await verifyToken(env, token));
assert.equal(await verifyToken(env, `${token.slice(0, -2)}xx`), null, 'tampered token must fail');
assert.equal(await verifyToken({ TOKEN_SECRET: 'y'.repeat(48) }, token), null, 'other secret must fail');
assert.equal(tokenFrom(new Request('https://x', { headers: { Authorization: `Bearer ${token}` } })), token);
assert.equal(tokenFrom(new Request('https://x', { headers: { 'Sec-WebSocket-Protocol': `earth-tracker, auth.${token}` } })), token);

// ---- bounding boxes ----
assert.deepEqual(viewToBoxes({ west: 150, south: -30, east: 155, north: -25 }), [[[-30, 150], [-25, 155]]]);
assert.deepEqual(viewToBoxes({ west: 170, south: -10, east: -170, north: 10 }), [[[-10, 170], [10, 180]], [[-10, -180], [10, -170]]], 'crossing 180° splits');
assert.deepEqual(viewToBoxes({ west: 'x' }), []);
const boxes = viewToBoxes({ west: 170, south: -10, east: -170, north: 10 });
assert.ok(inBoxes(0, 175, boxes) && inBoxes(0, -175, boxes) && !inBoxes(0, 0, boxes));
assert.deepEqual(viewToBoxes({ west: 100, south: -40, east: 160, north: -10 }), [], 'views wider than 45° are ignored');
const many = Array.from({ length: 20 }, (_, i) => [[[i, i], [i + 1, i + 1]]]);
assert.deepEqual(mergeBoxes(many), [[[0, 0], [20, 20]]], 'too many boxes collapse into one');

// ---- AIS parsing ----
const pr = parseAis({
  MessageType: 'PositionReport',
  MetaData: { MMSI: 503123456, ShipName: 'SPIRIT OF BRISBANE@@@' },
  Message: { PositionReport: { UserID: 503123456, Latitude: -27.4, Longitude: 153.1, Sog: 12.3, Cog: 45, TrueHeading: 511, NavigationalStatus: 0, Valid: true } },
}, 1000);
assert.deepEqual(pr.pos, { lat: -27.4, lon: 153.1, sog: 12.3, cog: 45, hdg: null, nav: 0, ts: 1000 }, 'heading 511 = not available');
assert.equal(pr.info.name, 'SPIRIT OF BRISBANE', 'AIS padding stripped');
assert.equal(parseAis({ MessageType: 'PositionReport', MetaData: { MMSI: 1 }, Message: { PositionReport: { Latitude: 91, Longitude: 181 } } }), null, '91/181 = no position');
const sd = parseAis({
  MessageType: 'ShipStaticData',
  MetaData: { MMSI: 477000001 },
  Message: { ShipStaticData: { Name: 'EVER TEST', Type: 70, Destination: 'AUBNE', ImoNumber: 9000001, CallSign: 'VRXX', Dimension: { A: 300, B: 66, C: 25, D: 26 }, Eta: { Month: 11, Day: 25, Hour: 6, Minute: 30 }, MaximumStaticDraught: 14.2 } },
});
assert.deepEqual(sd.info, { name: 'EVER TEST', type: 70, dest: 'AUBNE', imo: 9000001, call: 'VRXX', len: 366, beam: 51, eta: '25/11 06:30 UTC', draught: 14.2 });
assert.equal(parseAis({ MessageType: 'Unknown', MetaData: { MMSI: 5 } }), null);
assert.deepEqual(packPos(5, { lat: 1.234567, lon: 2, sog: 3.21, cog: null, hdg: 90, nav: 0, ts: 5500 }), [5, 1.23457, 2, 3.2, null, 90, 0, 6]);

console.log('worker tests passed');

