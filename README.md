# Earth Tracker

**🌍 Open the app: https://luxswilli4m.github.io/earth-tracker/**

A live 3D globe of what's moving around the planet and how the world trades. It's built in stages:

1. **Globe, sign-in and satellites** ← done
2. Ships and shipping lanes
3. Aircraft
4. Earthquakes, wildfires, ports and chokepoints, plus movement trails
5. Trade flows, tariffs, agreements and policy events, as a learning tool
6. Markets panel (sign-in only)

The map is public. Signing in only unlocks the features that use API quotas (the live feeds and the markets panel), and the Worker enforces that.

## How it works

- **Front end** (`site/`): a static site on GitHub Pages using [CesiumJS](https://cesium.com/platform/cesiumjs/) for the globe. It needs no Cesium ion account: the base imagery is the Natural Earth II texture that comes with Cesium.
- **Satellites**: every day, GitHub Actions downloads the active-satellite orbit data from [CelesTrak](https://celestrak.org) (one request a day, per their usage policy), along with owner details from the satellite catalogue, and publishes it with the site. The data is never committed, so the repo stays small. Your browser then calculates every satellite's position from its orbit using SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)), in a background thread, so the dots move live with no live feed. Drag the timeline to see the sky at any other time.
- **Worker** (`worker/`): a Cloudflare Worker that handles sign-in, and later the live relays and market data. Setup steps are in [`worker/README.md`](worker/README.md).

## First-time setup

1. **Turn on Pages.** In this repo, go to **Settings → Pages**, and under **Build and deployment → Source** choose **GitHub Actions**.
2. **Run the first deploy.** Go to **Actions → Build and deploy → Run workflow**. After a minute or two the site is live at `https://luxswilli4m.github.io/earth-tracker/`. From then on it rebuilds on every push and refreshes the satellite data daily.
3. **(Optional for now) Sign-in.** Follow [`worker/README.md`](worker/README.md), then set `workerUrl` in `site/js/config.js`. Nothing in stage 1 needs sign-in, so this can wait until stage 2.

## Working on it locally

```sh
node tools/make-sample.mjs > tools/sample-gp.json         # synthetic test satellites (not real)
node scripts/fetch-satellites.mjs --sample tools/sample-gp.json
# or, for real data (please don't run this repeatedly; CelesTrak asks for gentle use):
node scripts/fetch-satellites.mjs
npx serve site -l 8080                                  # then open http://localhost:8080
```

`site/vendor/satellite.esm.js` is a prebuilt, trimmed copy of satellite.js. To rebuild it: `cd tools/vendor && npm install && npm run build`.

## Data sources and credits

- Orbit data and the satellite catalogue: [CelesTrak](https://celestrak.org), from US Space Force tracking data
- Globe: [CesiumJS](https://cesium.com) (Apache 2.0), with Natural Earth II imagery
- Orbit maths: [satellite.js](https://github.com/shashwatak/satellite-js) (MIT)

Positions are calculated from published orbit data and are typically accurate to within a few kilometres. Satellites that have manoeuvred since their last data update will be off until the next daily refresh.
