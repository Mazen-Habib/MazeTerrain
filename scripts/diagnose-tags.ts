/** Do any OSM tags produce absurd geometry heights or widths? */
import { fetchOsm } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import { parseLength, buildingHeight_m } from '../src/data/osm/tags';

const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev)' } })) as unknown as typeof fetch;

const extent_km = Number(process.argv[2] ?? 9);
const LAT = 33.7, LON = 73.06, half = extent_km / 2;
const bbox = {
  west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - half / 110.574, north: LAT + half / 110.574,
};

const f = normalise(await fetchOsm(bbox, ['buildings','water','roads','trails'], { fetchImpl: withAgent }));
console.log(`\n${extent_km} km: ${f.polygons.length} polygons, ${f.lines.length} lines`);

const heights = f.polygons.filter(p=>p.height_m!==undefined).map(p=>p.height_m!);
heights.sort((a,b)=>a-b);
if (heights.length) {
  const q=(t:number)=>heights[Math.floor(heights.length*t)];
  console.log(`building heights: n=${heights.length} p50 ${q(0.5)} p99 ${q(0.99)} max ${heights[heights.length-1]}`);
  const silly = f.polygons.filter(p=>(p.height_m ?? 0) > 200);
  console.log(`over 200 m: ${silly.length}${silly.length ? ' -> ' + silly.slice(0,5).map(p=>p.height_m).join(', ') : ''}`);
  const negative = f.polygons.filter(p=>(p.height_m ?? 0) <= 0);
  console.log(`zero or negative: ${negative.length}`);
}

const minH = f.polygons.filter(p=>p.minHeight_m!==undefined).map(p=>p.minHeight_m!);
if (minH.length) {
  minH.sort((a,b)=>a-b);
  console.log(`min_height: n=${minH.length} max ${minH[minH.length-1]}`);
  console.log(`min_height >= height: ${f.polygons.filter(p=>(p.minHeight_m??0)>=(p.height_m??Infinity)).length}`);
}

const widths = f.lines.map(l=>l.width_m);
widths.sort((a,b)=>a-b);
console.log(`line widths: min ${widths[0]} max ${widths[widths.length-1]}`);
console.log(`non-finite widths: ${f.lines.filter(l=>!Number.isFinite(l.width_m)||l.width_m<=0).length}`);

// parseLength on the shapes OSM actually contains.
console.log('\nparseLength:');
for (const v of ['12','12 m','12m','40 ft','3.5','~8','12,5','tall','', '1e9','-5','Infinity','12 metres']) {
  console.log(`  ${JSON.stringify(v).padEnd(12)} -> ${parseLength(v)}`);
}
console.log('\nbuildingHeight_m fallbacks:');
for (const tags of [{}, {height:'1e9'}, {height:'-3'}, {'building:levels':'99999'}, {height:'abc'}, {height:'0'}]) {
  console.log(`  ${JSON.stringify(tags).padEnd(28)} -> ${buildingHeight_m(tags as Record<string,string>)}`);
}
