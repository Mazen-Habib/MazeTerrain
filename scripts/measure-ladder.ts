/** Which default makes a city read like a map rather than a slab? */
import { fetchOsm } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import { ROAD_WIDTH_M, LAYER_BY_ID } from '../src/data/osm/tags';

const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev)' } })) as unknown as typeof fetch;

const extent_km = Number(process.argv[2] ?? 9.3);
const LAT = 33.7, LON = 73.06, half = extent_km / 2;
const bbox = {
  west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - half / 110.574, north: LAT + half / 110.574,
};

const lines = normalise(await fetchOsm(bbox, ['roads'], { fetchImpl: withAgent })).lines;
const kmPerLat = 110.574, kmPerLon = 111.32 * Math.cos((LAT * Math.PI) / 180);
const lengthBy = new Map<string, number>();
for (const l of lines) {
  let m = 0;
  for (let i = 1; i < l.points.length; i++) {
    const a = l.points[i - 1], b = l.points[i];
    m += Math.hypot((b[0] - a[0]) * kmPerLon * 1000, (b[1] - a[1]) * kmPerLat * 1000);
  }
  lengthBy.set(l.subtype, (lengthBy.get(l.subtype) ?? 0) + m);
}

const scale = 100 / (extent_km * 1000);
const modelArea = 100 * 100;
const present = LAYER_BY_ID.roads.subtypes.filter((s) => lengthBy.has(s));
const narrowest = Math.min(...present.map((s) => ROAD_WIDTH_M[s]));

console.log(`\n${extent_km} km, ${lines.length} ways, ${(([...lengthBy.values()].reduce((a,b)=>a+b,0))/1000).toFixed(0)} km of road`);
console.log(`narrowest class present: ${narrowest} m\n`);
console.log('floor  gamma   coverage   residential      motorway');
for (const floor of [0.4, 0.3, 0.2]) {
  for (const gamma of [0.5, 0.4, 0.3]) {
    const w = (s: string) => Math.max(ROAD_WIDTH_M[s] * scale, floor * Math.pow(ROAD_WIDTH_M[s] / narrowest, gamma));
    let cov = 0;
    for (const s of present) cov += (lengthBy.get(s)! * scale * w(s)) / modelArea;
    console.log(
      `${floor.toFixed(2)}   ${gamma.toFixed(1)}    ${(cov * 100).toFixed(1).padStart(5)}%   ` +
      `${w('residential').toFixed(2)} mm = ${(w('residential')/scale).toFixed(0).padStart(3)} m   ` +
      `${w('motorway').toFixed(2)} mm = ${(w('motorway')/scale).toFixed(0).padStart(3)} m`,
    );
  }
}
