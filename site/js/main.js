/* global Cesium */
import { SatelliteLayer, ORBITS } from './satellites.js';
import { ShipLayer } from './ships.js';
import { SHIP_GROUPS } from './ais-codes.js';
import { authConfigured, isSignedIn, onAuthChange, signIn, signOut } from './auth.js';

const $ = (id) => document.getElementById(id);

// ---------- Globe ----------
// No Cesium ion account needed: imagery is the Natural Earth II texture bundled with Cesium.
const viewer = new Cesium.Viewer('globe', {
  baseLayer: Cesium.ImageryLayer.fromProviderAsync(
    Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')),
  ),
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  animation: true,
  timeline: true,
});
viewer.scene.globe.enableLighting = true; // day/night shading that follows the clock
viewer.scene.globe.showGroundAtmosphere = true;
viewer.scene.screenSpaceCameraController.minimumZoomDistance = 50_000;
viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(134, -20, 26_000_000) });

const clock = viewer.clock;
function goLive() {
  const now = Cesium.JulianDate.now();
  clock.startTime = Cesium.JulianDate.addHours(now, -12, new Cesium.JulianDate());
  clock.stopTime = Cesium.JulianDate.addHours(now, 12, new Cesium.JulianDate());
  clock.currentTime = now;
  clock.multiplier = 1;
  clock.clockRange = Cesium.ClockRange.UNBOUNDED;
  clock.shouldAnimate = true;
  viewer.timeline.zoomTo(clock.startTime, clock.stopTime);
}
goLive();
$('now-btn').addEventListener('click', goLive);

// "Live" chip lights up only when the clock is at real time and normal speed.
setInterval(() => {
  const drift = Math.abs(Cesium.JulianDate.secondsDifference(clock.currentTime, Cesium.JulianDate.now()));
  $('now-btn').classList.toggle('on', drift < 5 && clock.multiplier === 1 && clock.shouldAnimate);
}, 500);

// ---------- Satellites ----------
let sats = null;
const orbitsOn = new Set(Object.keys(ORBITS));

async function loadSatellites() {
  const res = await fetch('data/satellites.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`satellite data missing (HTTP ${res.status})`);
  const data = await res.json();
  $('loading-text').textContent = `Calculating ${data.count.toLocaleString()} orbits…`;
  sats = new SatelliteLayer(viewer, data, {
    onReady: () => applyFilter(),
    onFirstPositions: () => {
      $('loading').classList.add('done');
      applyFilter();
    },
  });

  const updated = new Date(data.generated);
  $('sat-source').textContent =
    `${data.source}. Orbit data updated ${updated.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`;

  const ownerSel = $('owner-filter');
  for (const o of sats.owners()) {
    const opt = document.createElement('option');
    opt.value = o.code;
    opt.textContent = `${o.name} (${o.count.toLocaleString()})`;
    ownerSel.append(opt);
  }
}

function applyFilter() {
  if (!sats) return;
  sats.setFilter({
    orbits: orbitsOn,
    owner: $('owner-filter').value,
    payloadsOnly: $('payload-only').checked,
  });
  $('sat-count').textContent = sats.visibleCount().toLocaleString();
}

// Orbit filter chips, coloured to match the points on the globe
for (const [key, o] of Object.entries(ORBITS)) {
  const b = document.createElement('button');
  b.className = 'orbit-chip';
  b.innerHTML = `<span class="dot" style="background:${o.color}"></span>${key}`;
  b.title = o.label;
  b.addEventListener('click', () => {
    if (orbitsOn.has(key)) orbitsOn.delete(key);
    else orbitsOn.add(key);
    b.classList.toggle('off', !orbitsOn.has(key));
    applyFilter();
  });
  $('orbit-chips').append(b);
}
$('owner-filter').addEventListener('change', applyFilter);
$('payload-only').addEventListener('change', applyFilter);
$('sat-toggle').addEventListener('change', (e) => {
  sats?.setEnabled(e.target.checked);
  if (!e.target.checked && selection?.layer === 'satellite') select(null);
});
$('panel-toggle').addEventListener('click', () => {
  const p = $('layers-panel');
  p.classList.toggle('collapsed');
  $('panel-toggle').textContent = p.classList.contains('collapsed') ? '+' : '–';
});

// ---------- Search ----------
const results = $('search-results');
let activeResult = -1;
$('sat-search').addEventListener('input', (e) => {
  const hits = sats ? sats.search(e.target.value) : [];
  results.innerHTML = '';
  activeResult = -1;
  for (const i of hits) {
    const m = sats.meta[i];
    const li = document.createElement('li');
    li.innerHTML = `<span></span><small></small>`;
    li.firstChild.textContent = m.name;
    li.lastChild.textContent = `#${m.norad} · ${m.orbit}`;
    li.addEventListener('click', () => pick(i));
    results.append(li);
  }
  results.hidden = hits.length === 0;
});
$('sat-search').addEventListener('keydown', (e) => {
  const items = [...results.children];
  if (!items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((li, k) => li.classList.toggle('active', k === activeResult));
  } else if (e.key === 'Enter') {
    items[Math.max(activeResult, 0)].click();
  } else if (e.key === 'Escape') {
    results.hidden = true;
  }
});
function pick(i) {
  results.hidden = true;
  $('sat-search').value = sats.meta[i].name;
  selectSat(i);
  flyTo(i);
}
function flyTo(i) {
  const p = sats.position(i);
  if (!p || Cesium.Cartesian3.equals(p, Cesium.Cartesian3.ZERO)) return;
  const c = Cesium.Cartographic.fromCartesian(p);
  const range = Math.max(c.height * 2.5, 7_000_000);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height + range),
    duration: 1.6,
  });
}

// ---------- Selection + info card ----------
// One selection at a time, from any layer: { layer: 'satellite', id: index } or { layer: 'ship', id: mmsi }.
let selection = null;
const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
const latLon = (lat, lon) => (lat === null || lat === undefined ? '—' : `${fmt(Math.abs(lat), 2)}°${lat >= 0 ? 'N' : 'S'}, ${fmt(Math.abs(lon), 2)}°${lon >= 0 ? 'E' : 'W'}`);

function select(layer, id) {
  if (selection && selection.layer === layer && selection.id === id) return;
  if (selection?.layer === 'satellite') sats?.select(-1);
  if (selection?.layer === 'ship') ships?.select(null);
  selection = layer ? { layer, id } : null;
  if (layer === 'satellite') sats?.select(id);
  if (layer === 'ship') ships?.select(id);
  $('info-card').hidden = !selection;
  renderCard();
}
// Older call sites select satellites by index; -1 clears.
const selectSat = (i) => (i < 0 ? select(null) : select('satellite', i));

function fillCard(kicker, color, name, rows, note) {
  $('info-kicker').textContent = kicker;
  $('info-kicker').style.color = color;
  $('info-name').textContent = name;
  const dl = $('info-list');
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.append(dt, dd);
  }
  $('info-note').textContent = note;
}

function renderCard() {
  if (!selection) return;
  if (selection.layer === 'satellite' && sats) return renderSatCard(selection.id);
  if (selection.layer === 'ship' && ships) return renderShipCard(selection.id);
}

function renderSatCard(i) {
  const d = sats.details(i);
  const periodText = d.period < 120 ? `${fmt(d.period, 1)} min` : `${fmt(d.period / 60, 2)} h`;
  const age = Math.abs(d.epochAgeHours);
  const ageText = age < 48 ? `${fmt(age)} hours` : `${fmt(age / 24)} days`;
  fillCard(d.orbitName, ORBITS[d.orbit].color, d.name, [
    ['Owner', d.ownerName],
    ['Type', d.typeName],
    ['Launched', d.launch || '—'],
    ['NORAD ID', String(d.norad)],
    ['Int’l designator', d.intl || '—'],
    ['Altitude', d.altitude === null ? '—' : `${fmt(d.altitude)} km`],
    ['Speed', d.speed === null ? '—' : `${fmt(d.speed, 2)} km/s`],
    ['Over', d.lat === null ? '—' : latLon(d.lat, d.lon)],
    ['Orbit period', periodText],
    ['Inclination', `${fmt(d.inc, 1)}°`],
    ['Perigee / apogee', `${fmt(d.perigee)} / ${fmt(d.apogee)} km`],
  ], d.valid
    ? `Position calculated from orbit data ${ageText} ${d.epochAgeHours >= 0 ? 'old' : 'ahead'}. The line shows its path over the next orbit.`
    : 'No valid position at this time: the orbit data may be stale, or the object may have re-entered.');
}

function renderShipCard(mmsi) {
  const d = ships.details(mmsi);
  if (!d) return select(null);
  const age = d.ageSec < 90 ? `${fmt(d.ageSec)} seconds` : `${fmt(d.ageSec / 60)} minutes`;
  fillCard(d.groupLabel, d.color, d.name, [
    ['Flag', d.flag],
    ['Type', d.type],
    ['Status', d.nav],
    ['Speed', d.sog === null ? '—' : `${fmt(d.sog, 1)} kn (${fmt(d.sog * 1.852, 1)} km/h)`],
    ['Course', d.cog === null ? '—' : `${fmt(d.cog)}°`],
    ['Heading', d.hdg === null ? '—' : `${fmt(d.hdg)}°`],
    ['Destination', d.dest || '—'],
    ['ETA', d.eta || '—'],
    ['Position', latLon(d.lat, d.lon)],
    ['Size', d.size || '—'],
    ['Draught', d.draught ? `${fmt(d.draught, 1)} m` : '—'],
    ['IMO', d.imo ? String(d.imo) : '—'],
    ['MMSI', String(d.mmsi)],
    ['Call sign', d.call || '—'],
  ], `Last AIS report ${age} ago. Destination and ETA are typed in by the crew, so they can be out of date. Flag is worked out from the MMSI.`);
}
setInterval(renderCard, 1000);
$('info-close').addEventListener('click', () => select(null));

const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((e) => {
  const hit = viewer.scene.pick(e.position);
  const id = hit && hit.id;
  if (id && id.layer === 'satellite') select('satellite', id.index);
  else if (id && id.layer === 'ship') select('ship', id.mmsi);
  else select(null);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
handler.setInputAction((e) => {
  const hit = viewer.scene.pick(e.endPosition);
  viewer.canvas.style.cursor = hit && hit.id && hit.id.layer ? 'pointer' : '';
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

// ---------- Shipping lanes (public, static tiles) ----------
let lanesLayer = null;
$('lanes-toggle').addEventListener('change', (e) => {
  if (e.target.checked && !lanesLayer) {
    lanesLayer = viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
      url: 'tiles/lanes/{z}/{x}/{y}.png',
      tilingScheme: new Cesium.GeographicTilingScheme(),
      maximumLevel: 5,
      credit: 'Ship density: World Bank / IMF (CC BY 4.0)',
    }));
    lanesLayer.alpha = Number($('lanes-opacity').value);
  }
  if (lanesLayer) lanesLayer.show = e.target.checked;
});
$('lanes-opacity').addEventListener('input', (e) => {
  if (lanesLayer) lanesLayer.alpha = Number(e.target.value);
});

// ---------- Live ships (signed-in only) ----------
const shipStatusText = {
  off: 'Turn on to see live ships in the area you’re viewing.',
  signin: 'Sign in to see live ships.',
  connecting: 'Connecting to the ship feed…',
  reconnecting: 'Connection lost, reconnecting…',
  live: 'Live',
  error: 'Ship feed unavailable',
};
const ships = new ShipLayer(viewer, {
  onStatus: (state, detail) => {
    const el = $('ship-status');
    el.className = `status-line ${state === 'live' ? 'live' : state === 'error' ? 'error' : ''}`;
    el.textContent = shipStatusText[state] + (detail ? ` (${detail})` : '');
    renderShipCount();
  },
  onChange: renderShipCount,
});
function renderShipCount() {
  const { shown } = ships.counts();
  $('ship-count').textContent = ships.enabled && ships.state === 'live' ? `${shown.toLocaleString()} on map` : '';
}
const shipGroupsOn = new Set(Object.keys(SHIP_GROUPS));
for (const [key, g] of Object.entries(SHIP_GROUPS)) {
  const b = document.createElement('button');
  b.className = 'orbit-chip';
  b.innerHTML = `<span class="dot" style="background:${g.color}"></span>`;
  b.append(g.label);
  b.addEventListener('click', () => {
    if (shipGroupsOn.has(key)) shipGroupsOn.delete(key);
    else shipGroupsOn.add(key);
    b.classList.toggle('off', !shipGroupsOn.has(key));
    ships.setGroups(new Set(shipGroupsOn));
  });
  $('ship-chips').append(b);
}
$('ship-toggle').addEventListener('change', (e) => {
  if (e.target.checked && !isSignedIn()) {
    e.target.checked = false;
    ships.status('signin');
    if (authConfigured()) $('auth-btn').click();
    return;
  }
  if (!e.target.checked && selection?.layer === 'ship') select(null);
  ships.setEnabled(e.target.checked);
});
onAuthChange((signedIn) => {
  if (!signedIn && ships.enabled) {
    $('ship-toggle').checked = false;
    ships.setEnabled(false);
    ships.status('signin');
  }
  if (signedIn && !ships.enabled) ships.status('off');
});
ships.status(isSignedIn() ? 'off' : 'signin');

// ---------- Sign-in ----------
const authBtn = $('auth-btn');
function renderAuth() {
  if (!authConfigured()) {
    authBtn.textContent = 'Sign-in not set up';
    authBtn.disabled = true;
    authBtn.title = 'Deploy the Worker and add its URL to site/js/config.js';
  } else {
    authBtn.disabled = false;
    authBtn.textContent = isSignedIn() ? 'Signed in · Sign out' : 'Sign in';
    authBtn.title = '';
  }
}
renderAuth();
onAuthChange(renderAuth);
authBtn.addEventListener('click', () => {
  if (isSignedIn()) signOut();
  else {
    $('auth-error').hidden = true;
    $('auth-password').value = '';
    $('auth-dialog').showModal();
  }
});
$('auth-cancel').addEventListener('click', () => $('auth-dialog').close());
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-submit').disabled = true;
  try {
    await signIn($('auth-password').value);
    $('auth-dialog').close();
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  } finally {
    $('auth-submit').disabled = false;
  }
});

// ---------- Start ----------
loadSatellites().catch((err) => {
  console.error(err);
  $('loading-text').textContent = `Couldn’t load satellites: ${err.message}`;
  document.querySelector('.spinner').style.display = 'none';
});

window.earthTracker = { viewer, ships, get sats() { return sats; } }; // handy for debugging in the console
