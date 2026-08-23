/**
 * Are the cones in the DEM, or made by the pipeline?
 *
 * Sharp terrain-coloured spikes poke through the road layer on a city model.
 * This reads real elevation tiles and asks how far individual cells stand above
 * their neighbours. A median is used rather than a mean, because a mean is
 * dragged up by the spike itself and hides it.
 */
import { decodePng } from './lib/png';
import { decodePixels } from '../src/data/dem/datasets';

const LAT = Number(process.argv[2] ?? 33.7);
const LON = Number(process.argv[3] ?? 73.06);
const ZOOM = Number(process.argv[4] ?? 12);

const n = 2 ** ZOOM;
const x = Math.floor(((LON + 180) / 360) * n);
const y = Math.floor(
  ((1 - Math.log(Math.tan((LAT * Math.PI) / 180) + 1 / Math.cos((LAT * Math.PI) / 180)) / Math.PI) / 2) * n,
);

// AWS Tilezen serves PNG; Mapterhorn serves WebP, which Node cannot decode.
// Same terrarium encoding, so the shape of the data is comparable.
const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`;
console.log(`\n${url}`);

const res = await fetch(url, { headers: { 'User-Agent': 'MazeTerrain/0.1 (dev)' } });
if (!res.ok) {
  console.log(`HTTP ${res.status}`);
  process.exit(1);
}

const png = decodePng(new Uint8Array(await res.arrayBuffer()));
const { width, height, data } = png;

const elev = new Float32Array(width * height);
decodePixels(data as unknown as Uint8ClampedArray, elev, 'terrarium');

let lo = Infinity;
let hi = -Infinity;
for (const v of elev) {
  if (v < lo) lo = v;
  if (v > hi) hi = v;
}

// Metres per pixel at this zoom and latitude.
const mPerPx = (156543.03392 * Math.cos((LAT * Math.PI) / 180)) / 2 ** ZOOM;
console.log(`${width}x${height} px @ ~${mPerPx.toFixed(1)} m/px, ${lo.toFixed(0)}-${hi.toFixed(0)} m`);

const deltas: number[] = [];
let worst = { x: 0, y: 0, delta: 0, value: 0, median: 0 };
const over = new Map<number, number>();

for (let j = 1; j < height - 1; j++) {
  for (let i = 1; i < width - 1; i++) {
    const v = elev[j * width + i];
    const ring: number[] = [];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        ring.push(elev[(j + dj) * width + (i + di)]);
      }
    }
    ring.sort((a, b) => a - b);
    const median = (ring[3] + ring[4]) / 2;
    const delta = v - median;
    deltas.push(delta);
    if (delta > worst.delta) worst = { x: i, y: j, delta, value: v, median };
    for (const t of [2, 5, 10, 20, 40]) if (delta > t) over.set(t, (over.get(t) ?? 0) + 1);
  }
}

deltas.sort((a, b) => a - b);
const pct = (p: number) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))].toFixed(2);
const total = deltas.length;

console.log(`\nmetres above the median of the 8 neighbours:`);
console.log(`  p50 ${pct(0.5)}   p90 ${pct(0.9)}   p99 ${pct(0.99)}   p99.9 ${pct(0.999)}   max ${deltas[total - 1].toFixed(1)}`);
for (const t of [2, 5, 10, 20, 40]) {
  const c = over.get(t) ?? 0;
  console.log(`  over +${String(t).padStart(2)} m: ${String(c).padStart(6)}  (${((c / total) * 100).toFixed(3)} %)`);
}
console.log(`  worst pixel (${worst.x},${worst.y}) = ${worst.value.toFixed(0)} m vs neighbour median ${worst.median.toFixed(0)} m`);
