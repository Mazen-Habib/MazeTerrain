/** Are buildings representable at all, at each model scale? */
import { fetchOsm } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import { projectENU, resolveScale } from '../src/geometry/coords';
import { testConfig } from '../tests/helpers';

const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev)' } })) as unknown as typeof fetch;

const LAT = 33.7, LON = 73.06;
const NOZZLE = 0.4, LAYER = 0.2;

for (const extent_km of [1, 2, 4, 9.2]) {
  const half = extent_km / 2;
  const bbox = {
    west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
    east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
    south: LAT - half / 110.574, north: LAT + half / 110.574,
  };
  const f = normalise(await fetchOsm(bbox, ['buildings'], { fetchImpl: withAgent }));
  const scale = resolveScale(testConfig({ bbox, modelWidth_mm: 100 }), 500, 560);

  const rows = f.polygons.map((p) => {
    const ring = p.rings[0].map(([lon, lat]) => projectENU(lon, lat, scale.origin));
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for (const [x,y] of ring){ minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y); }
    return {
      w_mm: Math.min(maxX-minX, maxY-minY) * scale.scale,
      h_mm: (p.height_m ?? 6) * scale.scale,
      h_m: p.height_m ?? 6,
    };
  }).filter(r => Number.isFinite(r.w_mm) && r.w_mm > 0);

  rows.sort((a,b)=>a.w_mm-b.w_mm);
  const med = rows[Math.floor(rows.length/2)];
  const printableW = rows.filter(r=>r.w_mm >= NOZZLE).length;
  const visibleH = rows.filter(r=>r.h_mm >= LAYER*3).length;

  console.log(
    `\n${extent_km} km  scale ${scale.scale.toFixed(4)} mm/m  ${rows.length} buildings`);
  console.log(
    `  median footprint ${med.w_mm.toFixed(3)} mm (${(med.w_mm/scale.scale).toFixed(0)} m), ` +
    `median height ${med.h_mm.toFixed(3)} mm (${med.h_m} m)`);
  console.log(
    `  footprint >= ${NOZZLE} mm nozzle : ${printableW} of ${rows.length} (${(printableW/rows.length*100).toFixed(0)}%)`);
  console.log(
    `  height >= 3 layers (${(LAYER*3).toFixed(1)} mm): ${visibleH} of ${rows.length} (${(visibleH/rows.length*100).toFixed(0)}%)`);
}
