#!/usr/bin/env python3
"""Builds the shipping-lanes map tiles from the World Bank / IMF Global Shipping Traffic Density data.

Source: https://datacatalog.worldbank.org/search/dataset/0037580 (CC BY 4.0).
The raster counts AIS ship positions per ~500 m cell, Jan 2015 - Feb 2021.

Output: site/tiles/lanes/{z}/{x}/{y}.png in a geographic (lat/lon) tiling scheme, which is what
Cesium's GeographicTilingScheme expects: level z has 2^(z+1) x 2^z tiles, y counted from the north.
Runs in GitHub Actions; the result is cached there, so the 510 MB download happens once, not per build.

Usage:
  python3 scripts/build-lanes.py                # download the real data
  python3 scripts/build-lanes.py --input FILE   # use a local GeoTIFF or zip (for testing)
"""
import argparse
import json
import os
import sys
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timezone

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from PIL import Image

URL = 'https://datacatalogfiles.worldbank.org/ddh-published/0037580/5/DR0045406/shipdensity_global.zip'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'site', 'tiles', 'lanes')
MAX_LEVEL = 5  # 16384 x 8192 px at the top level, about 2.4 km per pixel
TILE = 256

# Colour ramp on the 0..1 log-density scale: transparent sea -> deep blue -> cyan -> white.
STOPS = np.array([0.0, 0.08, 0.3, 0.6, 0.85, 1.0])
RGBA = np.array([
    [8, 30, 48, 0],
    [8, 40, 70, 60],
    [18, 110, 170, 150],
    [40, 190, 235, 210],
    [150, 235, 255, 240],
    [255, 255, 255, 255],
], dtype=np.float32)


def log(msg):
    print(msg, flush=True)


def download(dest):
    log(f'Downloading {URL}')
    req = urllib.request.Request(URL, headers={'User-Agent': 'earth-tracker (github.com/luxswilli4m/earth-tracker)'})
    with urllib.request.urlopen(req) as r, open(dest, 'wb') as f:
        total = int(r.headers.get('Content-Length') or 0)
        done = 0
        while True:
            chunk = r.read(1 << 22)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                sys.stdout.write(f'\r  {done / 1e6:.0f} / {total / 1e6:.0f} MB')
        print()


def raster_path(path):
    """GDAL can read a GeoTIFF straight out of a zip, so nothing gets unpacked to disk."""
    if path.lower().endswith('.zip'):
        with zipfile.ZipFile(path) as z:
            tifs = [n for n in z.namelist() if n.lower().endswith(('.tif', '.tiff'))]
        if not tifs:
            sys.exit('No GeoTIFF found inside the zip')
        log(f'Using {tifs[0]} from the zip')
        return f'zip://{path}!{tifs[0]}'
    return path


def load_global(path):
    w, h = 2 ** (MAX_LEVEL + 1) * TILE, 2 ** MAX_LEVEL * TILE
    log(f'Resampling to a {w} x {h} global grid (this takes a few minutes on the real data)')
    with rasterio.open(path) as src:
        log(f'  source: {src.width} x {src.height}, {src.dtypes[0]}, CRS {src.crs}, bounds {tuple(round(b, 2) for b in src.bounds)}')
        with WarpedVRT(src, crs='EPSG:4326', width=w, height=h,
                       transform=rasterio.transform.from_bounds(-180, -90, 180, 90, w, h),
                       resampling=Resampling.average, src_nodata=src.nodata, nodata=0,
                       warp_mem_limit=2048) as vrt:
            data = vrt.read(1, out_dtype='float32')
    data[~np.isfinite(data)] = 0
    data[data < 0] = 0
    return data


def to_unit(data):
    """Log scale, so the busiest straits don't drown out quieter lanes."""
    v = np.log1p(data)
    nz = v[v > 0]
    top = np.percentile(nz, 99.7) if nz.size else 1.0
    log(f'  {nz.size:,} cells with traffic; colour scale tops out at {np.expm1(top):,.0f} positions per cell')
    return np.clip(v / top, 0, 1).astype(np.float32)


def colourise(t):
    out = np.empty(t.shape + (4,), dtype=np.uint8)
    for c in range(4):
        out[..., c] = np.interp(t, STOPS, RGBA[:, c]).astype(np.uint8)
    out[t <= 0] = 0
    return out


def downsample_max(t):
    h, w = t.shape
    return t.reshape(h // 2, 2, w // 2, 2).max(axis=(1, 3))


def write_tiles(t):
    level_arr = t
    total = 0
    for z in range(MAX_LEVEL, -1, -1):
        rgba = colourise(level_arr)
        nx, ny = 2 ** (z + 1), 2 ** z
        for x in range(nx):
            d = os.path.join(OUT, str(z), str(x))
            os.makedirs(d, exist_ok=True)
            for y in range(ny):
                tile = rgba[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE]
                Image.fromarray(tile, 'RGBA').save(os.path.join(d, f'{y}.png'), optimize=True)
                total += 1
        log(f'  level {z}: {nx * ny} tiles')
        if z > 0:
            level_arr = downsample_max(level_arr)
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', help='local GeoTIFF or zip instead of downloading')
    args = ap.parse_args()

    if args.input:
        src = args.input
    else:
        tmp = tempfile.mkdtemp()
        src = os.path.join(tmp, 'shipdensity_global.zip')
        download(src)

    data = load_global(raster_path(src))
    t = to_unit(data)
    n = write_tiles(t)
    meta = {
        'built': datetime.now(timezone.utc).isoformat(),
        'source': 'World Bank / IMF Global Shipping Traffic Density (AIS positions Jan 2015 - Feb 2021), CC BY 4.0',
        'sourceUrl': 'https://datacatalog.worldbank.org/search/dataset/0037580',
        'maxLevel': MAX_LEVEL,
        'tiles': n,
        'sample': bool(args.input),
    }
    with open(os.path.join(OUT, 'meta.json'), 'w') as f:
        json.dump(meta, f, indent=2)
    size = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(OUT) for fn in fns)
    log(f'Wrote {n} tiles ({size / 1e6:.1f} MB) to {OUT}')


if __name__ == '__main__':
    main()
