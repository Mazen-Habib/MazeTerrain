/**
 * Detached and floating geometry in a real cutout build.
 *
 * Two different faults look the same on screen: a piece of mesh that is not
 * connected to anything (an island), and a piece that is connected but sits
 * above the ground it should be resting on. This looks for both.
 */
import { readFileSync } from 'node:fs';
import { buildRouteSolid } from '../src/geometry/route';
import { buildTerrainMesh } from '../src/geometry/terrain';
import { validateMesh, findFloatingVertices } from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { Route, RoutePoint } from '../src/data/gpx/types';

const path = process.argv[2] ?? 'C:/Users/Mazen/Downloads/Galiyat Mountain Trail 100K Race Route.gpx';
const xml = readFileSync(path, 'utf8');

const points: RoutePoint[] = [];
const re = /lat="([-0-9.]+)"\s+lon="([-0-9.]+)"/g;
let m: RegExpExecArray | null;
while ((m = re.exec(xml))) points.push({ lat: Number(m[1]), lon: Number(m[2]) });

let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
for (const p of points) {
  minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
}
const bbox = { west: minLon, east: maxLon, south: minLat, north: maxLat };
const extent_km = (maxLat - minLat) * 110.574;
console.log(`\n${points.length} points, ${extent_km.toFixed(1)} km tall`);

const cells = 300;
const hf = makeHeightfield(
  cells, cells,
  (i, j) => 1600 + 700 * Math.sin(i / 30) + 550 * Math.cos(j / 26) + 90 * Math.sin(i / 7),
  (extent_km * 1000) / (cells - 1),
);
const scale = scaleFor(hf, { bbox });

function build(width_mm: number, height_mm: number, cut?: { kind: 'cut' | 'insert'; depth_mm: number; proud_mm: number; clearance_mm?: number }) {
  const route: Route = {
    id: 'r', name: 'galiyat', points, distance_m: 0, elevationGain_m: null, bbox,
    style: {
      color: '#FF0D00', width_mm, height_mm, profile: 'raised',
      elevationSource: 'dem', demBlend: 0, visible: true,
    },
  };
  return buildRouteSolid(route, {
    heightfield: hf, scale, selection: null,
    nozzleDiameter_mm: 0.4, baseThickness_mm: 3,
    ...(cut ? { cut } : {}),
  });
}

/** Connected components over shared vertex positions. */
function components(positions: Float32Array, indices: Uint32Array): number[] {
  const weld = new Map<string, number>();
  const canonical = new Int32Array(positions.length / 3);
  for (let v = 0; v < positions.length / 3; v++) {
    const k = `${positions[v*3].toFixed(4)},${positions[v*3+1].toFixed(4)},${positions[v*3+2].toFixed(4)}`;
    const seen = weld.get(k);
    if (seen === undefined) { weld.set(k, v); canonical[v] = v; } else canonical[v] = seen;
  }
  const parent = new Int32Array(positions.length / 3);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let v = 0; v < canonical.length; v++) union(v, canonical[v]);
  for (let k = 0; k < indices.length; k += 3) {
    union(indices[k], indices[k + 1]);
    union(indices[k + 1], indices[k + 2]);
  }
  const sizes = new Map<number, number>();
  for (let k = 0; k < indices.length; k += 3) {
    const r = find(indices[k]);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  return [...sizes.values()].sort((a, b) => b - a);
}

const terrain = buildTerrainMesh(hf, scale);

console.log('\nmode                 tris   parts  largest%  open nonMan  floating  maxAboveGround');
for (const [label, width_mm, height_mm, cut] of [
  ['raised h=1.2', 1.5, 1.2, undefined],
  ['raised h=3.9', 1.5, 3.9, undefined],
  ['cut tool', 1.5, 1.2, { kind: 'cut' as const, depth_mm: 1, proud_mm: 1, clearance_mm: 0.15 }],
  ['insert', 1.5, 3.9, { kind: 'insert' as const, depth_mm: 1, proud_mm: 0.4, clearance_mm: 0.15 }],
] as const) {
  const r = build(width_mm, height_mm, cut as never);
  if (r.mesh.triangles === 0) { console.log(`${label.padEnd(16)} nothing built`); continue; }
  const v = validateMesh(r.mesh.positions, r.mesh.indices);
  const comps = components(r.mesh.positions, r.mesh.indices);
  const f = findFloatingVertices(terrain.positions, r.mesh.positions, 2);

  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < r.mesh.positions.length; i += 3) { lo = Math.min(lo, r.mesh.positions[i]); hi = Math.max(hi, r.mesh.positions[i]); }

  console.log(
    `${label.padEnd(16)} ${String(r.mesh.triangles).padStart(7)} ${String(comps.length).padStart(6)}` +
    `  ${((comps[0] / (r.mesh.indices.length / 3)) * 100).toFixed(0).padStart(6)}%` +
    ` ${String(v.openEdges).padStart(5)} ${String(v.nonManifoldEdges).padStart(6)}` +
    ` ${String(f.count).padStart(9)}  ${f.worst_mm.toFixed(2)} mm   z ${lo.toFixed(2)}..${hi.toFixed(2)}`,
  );
}
