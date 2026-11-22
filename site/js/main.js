/* global Cesium */
import { SatelliteLayer, ORBITS } from './satellites.js';
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
  if (!e.target.checked) select(-1);
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
  select(i);
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
let selected = -1;
const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));

function select(i) {
  if (i === selected) return;
  selected = i;
  sats?.select(i);
  $('info-card').hidden = i < 0;
  renderCard();
}

function renderCard() {
  if (selected < 0 || !sats) return;
  const d = sats.details(selected);
  $('info-kicker').textContent = d.orbitName;
  $('info-kicker').style.color = ORBITS[d.orbit].color;
  $('info-name').textContent = d.name;
  const periodText = d.period < 120 ? `${fmt(d.period, 1)} min` : `${fmt(d.period / 60, 2)} h`;
  const rows = [
    ['Owner', d.ownerName],
    ['Type', d.typeName],
    ['Launched', d.launch || '—'],
    ['NORAD ID', String(d.norad)],
    ['Int’l designator', d.intl || '—'],
    ['Altitude', d.altitude === null ? '—' : `${fmt(d.altitude)} km`],
    ['Speed', d.speed === null ? '—' : `${fmt(d.speed, 2)} km/s`],
    ['Over', d.lat === null ? '—' : `${fmt(Math.abs(d.lat), 1)}°${d.lat >= 0 ? 'N' : 'S'}, ${fmt(Math.abs(d.lon), 1)}°${d.lon >= 0 ? 'E' : 'W'}`],
    ['Orbit period', periodText],
    ['Inclination', `${fmt(d.inc, 1)}°`],
    ['Perigee / apogee', `${fmt(d.perigee)} / ${fmt(d.apogee)} km`],
  ];
  const dl = $('info-list');
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const age = Math.abs(d.epochAgeHours);
  const ageText = age < 48 ? `${fmt(age)} hours` : `${fmt(age / 24)} days`;
  $('info-note').textContent = d.valid
    ? `Position calculated from orbit data ${ageText} ${d.epochAgeHours >= 0 ? 'old' : 'ahead'}. The line shows its path over the next orbit.`
    : 'No valid position at this time: the orbit data may be stale, or the object may have re-entered.';
}
setInterval(renderCard, 1000);
$('info-close').addEventListener('click', () => select(-1));

const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((e) => {
  const hit = viewer.scene.pick(e.position);
  if (hit && hit.id && hit.id.layer === 'satellite') select(hit.id.index);
  else select(-1);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
handler.setInputAction((e) => {
  const hit = viewer.scene.pick(e.endPosition);
  viewer.canvas.style.cursor = hit && hit.id && hit.id.layer ? 'pointer' : '';
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

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

window.earthTracker = { viewer, get sats() { return sats; } }; // handy for debugging in the console
