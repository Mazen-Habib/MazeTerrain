/**
 * The radial line, hunted in the real terrain rather than a smooth fixture.
 *
 * The bottom face is a flat fan at z = 0 and cannot crease, so a line visible
 * on the underside and in the slicer's first layer means the bottom is not the
 * single disc it should be. Either `chainBoundary` found more than one ring, or
 * the ring doubles back on itself and the skirt follows it inward.
 *
 * Everything here uses the REAL DEM for the reported area.
 */
import { realHeightfield } from './lib/realdem';
import { buildClippedTerrainMesh } from '../src/geometry/terrainClip';
import { selectionRingWorld } from '../src/geometry/selection';
import { scaleFor } from '../tests/helpers';
import type { SelectionShape } from '../src/geometry/selection';

const LON = 73.04;
const LAT = 33.73;
const radius_m = Number(process.argv[2] ?? 4650);
const cells = Number(process.argv[3] ?? 600);

const halfLat = (radius_m * 1.05) / 110574;
const halfLon = halfLat / Math.cos((LAT * Math.PI) / 180);
const bbox = { west: LON - halfLon, east: LON + halfLon, south: LAT - halfLat, north: LAT + halfLat };

console.log(`\nreal DEM, circle radius ${radius_m} m, ${cells} cells`);
const hf = await realHeightfield(bbox, 13, cells);
const scale = scaleFor(hf, { bbox });
console.log(`relief ${hf.min_m.toFixed(0)}..${hf.max_m.toFixed(0)} m, spacing ${hf.spacingX_m.toFixed(1)} m`);

const shape: SelectionShape = { kind: 'circle', lon: LON, lat: LAT, radius_m };
const ring = selectionRingWorld(shape, scale.origin);
const mesh = buildClippedTerrainMesh(hf, scale, ring);
console.log(`terrain: ${mesh.indices.length / 3} triangles`);

const { positions: P, indices: I } = mesh;

// --- how many pieces is the BOTTOM in? -------------------------------------
//
// Every triangle lying flat on z = 0 is bottom. If there is one disc, they form
// one connected component; more than one means the model's underside is split,
// which is exactly what a slicer draws an extra perimeter around.
const bottomTris: number[] = [];
for (let t = 0; t < I.length; t += 3) {
  const z = [P[I[t] * 3 + 2], P[I[t + 1] * 3 + 2], P[I[t + 2] * 3 + 2]];
  if (Math.max(...z) < 1e-6) bottomTris.push(t);
}
console.log(`\nbottom face: ${bottomTris.length} triangles`);

/** Union-find over the shared vertices of a triangle subset. */
function components(tris: number[]): number[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as number;
    return r;
  };
  const uni = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const t of tris) {
    for (const v of [I[t], I[t + 1], I[t + 2]]) if (!parent.has(v)) parent.set(v, v);
    uni(I[t], I[t + 1]);
    uni(I[t + 1], I[t + 2]);
  }
  const sizes = new Map<number, number>();
  for (const t of tris) {
    const r = find(I[t]);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  return [...sizes.values()].sort((a, b) => b - a);
}
const bottomParts = components(bottomTris);
console.log(`  in ${bottomParts.length} connected piece(s): ${bottomParts.slice(0, 6).join(', ')}`);

// --- does the bottom outline double back on itself? ------------------------
//
// A slit shows as two boundary edges running along the same line in opposite
// directions. Collect the bottom's open edges and look for coincident pairs.
const edgeCount = new Map<string, number>();
const key = (a: number, b: number) => {
  const pa = `${P[a * 3].toFixed(3)},${P[a * 3 + 1].toFixed(3)}`;
  const pb = `${P[b * 3].toFixed(3)},${P[b * 3 + 1].toFixed(3)}`;
  return pa < pb ? pa + '|' + pb : pb + '|' + pa;
};
for (const t of bottomTris) {
  for (let e = 0; e < 3; e++) {
    const k = key(I[t + e], I[t + ((e + 1) % 3)]);
    edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
  }
}
let openEdges = 0;
const openPoints: Array<[number, number]> = [];
for (const [k, n] of edgeCount) {
  if (n !== 1) continue;
  openEdges++;
  const [a] = k.split('|');
  const [x, y] = a.split(',').map(Number);
  openPoints.push([x, y]);
}
console.log(`  outline: ${openEdges} boundary edges`);

// How far in from the rim does the outline reach? A disc's outline is all at
// one radius; a slit reaches inward.
let maxR = 0;
for (const [x, y] of openPoints) maxR = Math.max(maxR, Math.hypot(x, y));
let inward = 0;
let deepest = maxR;
let deepestAt: [number, number] | null = null;
for (const [x, y] of openPoints) {
  const r = Math.hypot(x, y);
  if (r < maxR - 2) {
    inward++;
    if (r < deepest) {
      deepest = r;
      deepestAt = [x, y];
    }
  }
}
console.log(`  rim radius ${maxR.toFixed(1)} mm; ${inward} outline points reach further in`);
if (deepestAt) {
  console.log(
    `  deepest is ${(maxR - deepest).toFixed(1)} mm inside the rim, at ` +
      `${deepestAt[0].toFixed(1)}, ${deepestAt[1].toFixed(1)} mm`,
  );
}
