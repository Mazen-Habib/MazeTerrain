/** Which buildings become needles once scaled to a small model? */
import { fetchOsm } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import { projectENU, resolveScale } from '../src/geometry/coords';
import { testConfig } from '../tests/helpers';

const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev)' } })) as unknown as typeof fetch;

const extent_km = Number(process.argv[2] ?? 2);
const LAT = 33.7, LON = 73.06, half = extent_km / 2;
const bbox = {
  west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - half / 110.574, north: LAT + half / 110.574,
};

const f = normalise(await fetchOsm(bbox, ['buildings'], { fetchImpl: withAgent }));
// Flat ground, which is the case that makes towers stand out: little relief to
// clamp the exaggeration, so the vertical scale stays high.
const scale = resolveScale(testConfig({ bbox, modelWidth_mm: 100 }), 500, 520);
console.log(`\n${extent_km} km, ${f.polygons.length} buildings, ${scale.scale.toFixed(4)} mm/m xy, ${scale.zScale.toFixed(4)} mm/m z`);
console.log(`terrain relief in print: ${(20 * scale.zScale).toFixed(2)} mm\n`);

const rows = f.polygons.map((p) => {
  const ring = p.rings[0].map(([lon, lat]) => projectENU(lon, lat, scale.origin));
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const [x,y] of ring){ minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y); }
  const w_mm = Math.min(maxX-minX, maxY-minY) * scale.scale;
  const h_mm = (p.height_m ?? 6) * scale.zScale;
  return { subtype: p.subtype, h_m: p.height_m ?? 6, w_mm, h_mm, aspect: w_mm > 0 ? h_mm / w_mm : Infinity };
}).filter(r => Number.isFinite(r.w_mm));

rows.sort((a,b)=>b.aspect-a.aspect);
console.log('worst height-to-width, i.e. the needles:');
for (const r of rows.slice(0,10)) {
  console.log(`  ${r.subtype.padEnd(12)} ${r.h_m.toFixed(0).padStart(4)} m tall, footprint ${r.w_mm.toFixed(2)} mm -> ${r.h_mm.toFixed(2)} mm tall, aspect ${r.aspect.toFixed(1)}:1`);
}
const needles = rows.filter(r=>r.aspect>4);
const subNozzle = rows.filter(r=>r.w_mm < 0.4);
console.log(`\naspect over 4:1  : ${needles.length} of ${rows.length}`);
console.log(`footprint < 0.4mm: ${subNozzle.length} (cannot print at all)`);
console.log(`tallest printed  : ${Math.max(...rows.map(r=>r.h_mm)).toFixed(2)} mm`);
