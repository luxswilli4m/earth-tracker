#!/usr/bin/env python3
"""Makes a small synthetic ship-density GeoTIFF for testing build-lanes.py offline (not real data).
  python3 tools/make-sample-lanes.py /tmp/sample-lanes.tif
  python3 scripts/build-lanes.py --input /tmp/sample-lanes.tif
"""
import sys
import numpy as np
import rasterio
from rasterio.transform import from_bounds

out = sys.argv[1]
w, h = 7200, 3400  # 0.05 degree cells over -180..180, -85..85 like the real file's extent
rng = np.random.default_rng(1)
data = np.zeros((h, w), dtype=np.int32)

def lane(lon1, lat1, lon2, lat2, strength):
    n = 4000
    lons = np.linspace(lon1, lon2, n)
    lats = np.linspace(lat1, lat2, n) + np.sin(np.linspace(0, 6, n)) * 1.5
    xs = ((lons + 180) / 360 * w).astype(int).clip(0, w - 1)
    ys = ((85 - lats) / 170 * h).astype(int).clip(0, h - 1)
    for dx in range(-2, 3):
        for dy in range(-2, 3):
            data[(ys + dy).clip(0, h - 1), (xs + dx).clip(0, w - 1)] += strength // (1 + abs(dx) + abs(dy))

lane(103.8, 1.3, 32.5, 30.0, 50000)    # Singapore -> Suez
lane(121.5, 31.2, -122.4, 37.8, 8000)  # Shanghai -> SF (wraps oddly; fine for a test)
lane(153.2, -27.4, 103.8, 1.3, 12000)  # Brisbane -> Singapore
lane(-5.6, 36.0, -74.0, 40.7, 20000)   # Gibraltar -> New York
data += (rng.random((h, w)) < 0.002).astype(np.int32) * 30

with rasterio.open(out, 'w', driver='GTiff', width=w, height=h, count=1, dtype='int32',
                   crs='EPSG:4326', transform=from_bounds(-180, -85, 180, 85, w, h), compress='deflate') as d:
    d.write(data, 1)
print('wrote', out)
