// Checks whether your aisstream.io key works, straight from your own computer (not via Cloudflare).
// It connects, asks for ships around South East Queensland for up to 20 seconds, prints what
// comes back, then disconnects. The key is read from the AIS_KEY environment variable so it never
// appears on screen or in your PowerShell history; see worker/README.md for the exact commands.
import WebSocket from 'ws';

const key = process.env.AIS_KEY;
if (!key) {
  console.error('AIS_KEY is not set. See worker/README.md ("Testing your aisstream key").');
  process.exit(1);
}

const ws = new WebSocket('wss://stream.aisstream.io/v0/stream', { perMessageDeflate: true });
let count = 0;
const types = {};
const started = Date.now();

const finish = (why) => {
  console.log(`\nResult: ${why}`);
  console.log(`Messages received: ${count}`, types);
  try { ws.close(); } catch { /* already closed */ }
  setTimeout(() => process.exit(0), 300);
};

ws.on('open', () => {
  console.log('Connected to aisstream. Compression:', ws.extensions || 'none', '- sending subscription…');
  ws.send(JSON.stringify({
    APIKey: key,
    BoundingBoxes: [[[-28.5, 152.5], [-26, 154]]],
    FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
  }));
});
ws.on('message', (data) => {
  count++;
  let m;
  try { m = JSON.parse(String(data)); } catch { m = { raw: String(data).slice(0, 200) }; }
  if (m.error) return finish(`aisstream reported an error: ${m.error}`);
  const t = m.MessageType || Object.keys(m).join(',');
  types[t] = (types[t] || 0) + 1;
  if (count <= 3) console.log(`#${count}`, t, m.MetaData ? `${m.MetaData.ShipName || ''} (MMSI ${m.MetaData.MMSI})` : JSON.stringify(m).slice(0, 200));
  if (count >= 25) finish('OK: your key works and ships are streaming.');
});
ws.on('close', (code, reason) => finish(`aisstream closed the connection after ${((Date.now() - started) / 1000).toFixed(1)} s (code ${code}${reason.length ? `: ${reason}` : ''})`));
ws.on('error', (err) => finish(`connection error: ${err.message}`));
setTimeout(() => finish(count ? 'OK: connected and received some ships (a quiet area).' : 'No messages within 20 seconds.'), 20_000);
