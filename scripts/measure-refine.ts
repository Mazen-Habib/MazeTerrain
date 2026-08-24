/**
 * Refinement: what does each maxEdge choice cost, and what does it buy?
 *
 * Two things matter and they pull apart. Drape accuracy needs vertices ALONG
 * the ribbon, where the terrain changes. Refining ACROSS a ribbon two
 * millimetres wide buys nothing — the ground does not change over two
 * millimetres — and it is where the sliver triangles come from.
 */
import { readFileSync } from 'node:fs';
import { buildRibbonField } from '../src/geometry/ribbonField';
import { extrudeDraped } from '../src/geometry/extrude';
import { projectENU, worldToPrint } from '../src/geometry/coords';
import { sampleHeightfieldAt } from '../src/geometry/heightfield';
import { resample, simplifyPoints, toleranceForScale } from '../src/data/gpx/simplify';
import { validateMesh } from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { Pt } from '../src/data/gpx/simplify';

const xml = readFileSync(process.argv[2] ?? 'C:/Users/Mazen/Downloads/Milo_Marathon_2026.gpx', 'utf8');
const raw: Array<[number, number]> = [];
const re = /lat="([-0-9.]+)"\s+lon="([-0-9.]+)"/g;
let m: RegExpExecArray | null;
while ((m = re.exec(xml))) raw.push([Number(m[2]), Number(m[1])]);

let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
for (const [lon, lat] of raw) {
  minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
}
const bbox = { west: minLon, east: maxLon, south: minLat, north: maxLat };

const cells = 200;
const extent_m = (maxLat - minLat) * 110574;
const hf = makeHeightfield(
  cells, cells,
  (i, j) => 520 + 14 * Math.sin(i / 12) + 11 * Math.cos(j / 15),
  extent_m / (cells - 1),
);
const scale = scaleFor(hf, { bbox });
const step_m = hf.spacingX_m;

const centre = resample(
  simplifyPoints(raw.map(([lon, lat]) => projectENU(lon, lat, scale.origin)), toleranceForScale(scale.scale)),
  step_m,
);
const width_mm = 2;
const width_m = width_mm / scale.scale;
const ribbon = buildRibbonField(centre, width_m, null);

const drape = (x: number, y: number) => worldToPrint(x, y, sampleHeightfieldAt(hf, x, y), scale)[2];
const toXY = (x: number, y: number): [number, number] => [x * scale.scale, y * scale.scale];

console.log(`\nroute ${centre.length} points, ribbon ${width_mm} mm = ${width_m.toFixed(0)} m wide`);
console.log(`terrain step ${step_m.toFixed(1)} m = ${(step_m * scale.scale).toFixed(3)} mm\n`);

/** Worst gap between the built top and the ground, sampled along the centreline. */
function drapeError(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  const { positions: P, indices: I } = mesh;
  let worst = 0;
  const n = 600;
  for (let s = 0; s <= n; s++) {
    const t = (s / n) * (centre.length - 1);
    const i0 = Math.min(centre.length - 2, Math.floor(t));
    const f = t - i0;
    const x = centre[i0][0] + (centre[i0 + 1][0] - centre[i0][0]) * f;
    const y = centre[i0][1] + (centre[i0 + 1][1] - centre[i0][1]) * f;
    const [px, py] = toXY(x, y);
    const want = drape(x, y) + 1.2;

    let top = -Infinity;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      const d = (P[b + 1] - P[c + 1]) * (P[a] - P[c]) + (P[c] - P[b]) * (P[a + 1] - P[c + 1]);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((P[b + 1] - P[c + 1]) * (px - P[c]) + (P[c] - P[b]) * (py - P[c + 1])) / d;
      const v = ((P[c + 1] - P[a + 1]) * (px - P[c]) + (P[a] - P[c]) * (py - P[c + 1])) / d;
      const w = 1 - u - v;
      if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
      const z = u * P[a + 2] + v * P[b + 2] + w * P[c + 2];
      if (z > top) top = z;
    }
    if (top === -Infinity) continue;
    worst = Math.max(worst, Math.abs(top - want));
  }
  return worst;
}

function slivers(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  const { positions: P, indices: I } = mesh;
  let n = 0;
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
    const L = Math.max(
      Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1]),
      Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1]),
      Math.hypot(P[a] - P[c], P[a + 1] - P[c + 1]),
    );
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1];
    const alt = Math.abs(ux * vy - uy * vx) / Math.max(L, 1e-12);
    if (alt > 1e-12 && L / alt > 200) n++;
  }
  return n;
}

console.log('maxEdge              tris    slivers   drape err   open  nonMan');
for (const [label, maxEdge] of [
  ['none', Infinity],
  ['terrain step', step_m],
  ['2 x step', step_m * 2],
  ['ribbon width', width_m],
  ['max(step, width)', Math.max(step_m, width_m)],
] as const) {
  const mesh = extrudeDraped(ribbon.polygons, drape, toXY, {
    height_mm: 1.2, penetration_mm: 1, minBottom_mm: 0.2, maxEdge_m: maxEdge as number,
  });
  const v = validateMesh(mesh.positions, mesh.indices);
  const sl = slivers(mesh);
  console.log(
    `${label.padEnd(18)} ${String(mesh.triangles).padStart(7)} ${String(sl).padStart(8)}` +
      ` (${((sl / mesh.triangles) * 100).toFixed(0).padStart(2)}%) ${drapeError(mesh).toFixed(3).padStart(9)} mm` +
      ` ${String(v.openEdges).padStart(5)} ${String(v.nonManifoldEdges).padStart(6)}`,
  );
}
