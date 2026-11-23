// A fake aisstream.io for local testing: synthetic ships (not real) that follow the real
// protocol closely enough to exercise the Worker's relay end to end.
//   cd tools/mock && npm install && node mock-aisstream.mjs
// Then run the Worker with AIS_URL=ws://127.0.0.1:9001 in worker/.dev.vars.
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 9001);
const HUBS = [
  { name: 'Brisbane', lat: -27.3, lon: 153.3, n: 120 },
  { name: 'Singapore', lat: 1.2, lon: 103.9, n: 300 },
  { name: 'Rotterdam', lat: 51.95, lon: 3.9, n: 200 },
];
const TYPES = [70, 70, 70, 71, 80, 80, 60, 30, 52, 36];
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

const ships = [];
let mmsi = 503000000;
for (const h of HUBS) {
  for (let i = 0; i < h.n; i++) {
    const moving = rand() > 0.3;
    ships.push({
      mmsi: mmsi++, name: `SAMPLE ${h.name.toUpperCase()} ${i}`,
      lat: h.lat + (rand() - 0.5) * 3, lon: h.lon + (rand() - 0.5) * 4,
      sog: moving ? 5 + rand() * 15 : 0, cog: rand() * 360, type: TYPES[Math.floor(rand() * TYPES.length)],
    });
  }
}

function inBoxes(s, boxes) {
  return boxes.some(([[a, b], [c, d]]) => s.lat >= Math.min(a, c) && s.lat <= Math.max(a, c) && s.lon >= Math.min(b, d) && s.lon <= Math.max(b, d));
}

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: true });
wss.on('connection', (ws, req) => {
  console.log('client asked for extensions:', req.headers['sec-websocket-extensions'] || 'none');
  if (process.env.REQUIRE_COMPRESSION && !/permessage-deflate/.test(req.headers['sec-websocket-extensions'] || '')) {
    console.log('rejecting uncompressed client (like aisstream now does)');
    return ws.terminate();
  }
  let sub = null;
  const deadline = setTimeout(() => { console.log('no subscription within 3 s, closing'); ws.close(); }, 3000);
  ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (!m.APIKey) return ws.close(4001, 'missing APIKey');
    clearTimeout(deadline);
    sub = m;
    console.log('subscription:', JSON.stringify(m.BoundingBoxes), 'types:', (m.FilterMessageTypes || []).length);
  });
  let tick = 0;
  const timer = setInterval(() => {
    if (!sub) return;
    tick++;
    for (const s of ships) {
      const step = (s.sog / 3600) * 1 / 60; // degrees per second, roughly
      s.lat += Math.cos((s.cog * Math.PI) / 180) * step;
      s.lon += Math.sin((s.cog * Math.PI) / 180) * step;
      if (!inBoxes(s, sub.BoundingBoxes) || rand() > 0.15) continue;
      ws.send(JSON.stringify({
        MessageType: 'PositionReport',
        MetaData: { MMSI: s.mmsi, ShipName: s.name, latitude: s.lat, longitude: s.lon, time_utc: new Date().toISOString() },
        Message: { PositionReport: { UserID: s.mmsi, Latitude: s.lat, Longitude: s.lon, Sog: s.sog, Cog: s.cog, TrueHeading: Math.round(s.cog), NavigationalStatus: s.sog ? 0 : 5, Valid: true } },
      }));
      if (tick % 20 === 1) {
        ws.send(JSON.stringify({
          MessageType: 'ShipStaticData',
          MetaData: { MMSI: s.mmsi, ShipName: s.name },
          Message: { ShipStaticData: { Name: s.name, Type: s.type, Destination: 'SAMPLE PORT', ImoNumber: 9000000 + (s.mmsi % 100000), CallSign: 'TEST', Dimension: { A: 150, B: 40, C: 15, D: 15 }, Eta: { Month: 12, Day: 1, Hour: 8, Minute: 0 }, MaximumStaticDraught: 10.5 } },
        }));
      }
    }
  }, 1000);
  ws.on('close', () => { clearInterval(timer); console.log('upstream client disconnected'); });
});
console.log(`mock aisstream listening on ws://127.0.0.1:${PORT} with ${ships.length} sample ships`);
