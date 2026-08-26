/**
 * Does the route channel leave severed geometry hanging over it?
 *
 * The claim: cutting the route out of the terrain removes the part of a
 * building or road that the channel passes through and leaves the rest
 * floating. If that happens, the freed piece is a DETACHED component of the
 * body — which is exactly what a component count finds, and what no manifold
 * check would ever notice, because a floating block is a perfectly good closed
 * solid.
 *
 * Built against real OSM and real elevation, at the reported size.
 */
import { readFileSync } from 'node:fs';
import { realHeightfield } from './lib/realdem';
import { fetchOsm } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import {
  buildLineLayer,
  buildPolygonLayer,
  groupLines,
  groupPolygons,
  waterRings,
  type LayerSettings,
} from '../src/geometry/features';
import { buildRouteSolid } from '../src/geometry/route';
import { buildTerrainMesh } from '../src/geometry/terrain';
import { subtractParts, unionParts } from '../src/geometry/boolean';
import { sampleHeightfieldAt } from '../src/geometry/heightfield';
import { worldToPrint } from '../src/geometry/coords';
import { defaultLayers } from '../src/config/presets';
import { scaleFor } from '../tests/helpers';
import { LAYER_BY_ID, type LayerId } from '../src/data/osm/tags';
import type { Route, RoutePoint } from '../src/data/gpx/types';
import type { MeshPart } from '../src/geometry/types';

const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, {
    ...init,
    headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev)' },
  })) as unknown as typeof fetch;

const gpx = process.argv[2] ?? 'C:/Users/Mazen/Downloads/Milo_Marathon_2026.gpx';
const extent_km = Number(process.argv[3] ?? 9.2);

const xml = readFileSync(gpx, 'utf8');
const points: RoutePoint[] = [];
const re = /lat="([-0-9.]+)"\s+lon="([-0-9.]+)"/g;
let m: RegExpExecArray | null;
while ((m = re.exec(xml))) points.push({ lat: Number(m[1]), lon: Number(m[2]) });

let sLat = 0;
let sLon = 0;
for (const p of points) {
  sLat += p.lat;
  sLon += p.lon;
}
const LAT = sLat / points.length;
const LON = sLon / points.length;
const half = extent_km / 2;
const bbox = {
  west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - half / 110.574,
  north: LAT + half / 110.574,
};

console.log(`\n${extent_km} km around ${LAT.toFixed(3)}, ${LON.toFixed(3)}`);
const hf = await realHeightfield(bbox, 12, 420);
const scale = scaleFor(hf, { bbox });
console.log(`relief ${hf.min_m.toFixed(0)}..${hf.max_m.toFixed(0)} m, scale ${scale.scale.toFixed(5)} mm/m`);

const wanted: LayerId[] = ['roads', 'buildings', 'water', 'trails'];
const features = normalise(await fetchOsm(bbox, wanted, { fetchImpl: withAgent }));
console.log(`${features.lines.length} lines, ${features.polygons.length} polygons`);

const base = defaultLayers();
const layers: Record<string, LayerSettings> = Object.fromEntries(
  Object.entries(base).map(([k, v]) => [k, { ...v, enabled: wanted.includes(k as LayerId) }]),
);

const route: Route = {
  id: 'r',
  name: 'route',
  points,
  distance_m: 0,
  elevationGain_m: null,
  bbox,
  style: {
    color: '#FF0D00',
    width_mm: 2,
    height_mm: 1.2,
    profile: 'raised',
    elevationSource: 'dem',
    demBlend: 0,
    visible: true,
  },
};

const opts = {
  heightfield: hf,
  scale,
  selection: null,
  nozzleDiameter_mm: 0.4,
  baseThickness_mm: 3,
  layers,
  triangleBudget: 6_000_000,
};

const terrainZAt = (x_m: number, y_m: number): number =>
  worldToPrint(x_m, y_m, sampleHeightfieldAt(hf, x_m, y_m), scale)[2];
const drapeZ = (x_mm: number, y_mm: number): number =>
  terrainZAt(x_mm / scale.scale, y_mm / scale.scale);

const terrain = buildTerrainMesh(hf, scale);
const body: MeshPart[] = [
  { name: 'terrain', color: '#cccccc', positions: terrain.positions, indices: terrain.indices, manifold: true },
];

const water = waterRings(features.polygons, scale);
const lines = groupLines(features.lines);
const polys = groupPolygons(features.polygons);
for (const layer of wanted) {
  const built =
    LAYER_BY_ID[layer].kind === 'line'
      ? buildLineLayer(layer, lines.get(layer) ?? [], water, opts)
      : buildPolygonLayer(layer, polys.get(layer) ?? [], opts);
  if (built.part) {
    body.push({
      name: layer,
      color: '#cccccc',
      positions: built.part.positions,
      indices: built.part.indices,
      manifold: true,
    });
  }
}

console.log('\nhow far each layer stands above the ground it sits on:');
for (const part of body) {
  if (part.name === 'terrain') continue;
  let worst = 0;
  for (let i = 0; i < part.positions.length; i += 3) {
    const above = part.positions[i + 2] - drapeZ(part.positions[i], part.positions[i + 1]);
    if (above > worst) worst = above;
  }
  console.log(`  ${part.name.padEnd(10)} up to ${worst.toFixed(2)} mm proud`);
}

const insetDepth_mm = 1;
const toolProud_mm = Math.max(1, insetDepth_mm);
// The ceiling the tool now uses: the top of everything actually built.
let bodyTop_mm = -Infinity;
for (const part of body) {
  for (let i = 2; i < part.positions.length; i += 3) {
    if (part.positions[i] > bodyTop_mm) bodyTop_mm = part.positions[i];
  }
}
const useFlatTop = process.argv[4] !== 'draped';
console.log(
  useFlatTop
    ? `the cut tool reaches a flat ${(bodyTop_mm + 5).toFixed(2)} mm, above everything built`
    : `the top of the cut tool sits ${toolProud_mm.toFixed(2)} mm above the terrain`,
);

const tool = buildRouteSolid(route, {
  heightfield: hf,
  scale,
  selection: null,
  nozzleDiameter_mm: 0.4,
  baseThickness_mm: 3,
  cut: {
    kind: 'cut' as const,
    depth_mm: insetDepth_mm,
    proud_mm: toolProud_mm,
    clearance_mm: 0.15,
    ...(useFlatTop ? { toolTop_mm: bodyTop_mm + 5 } : {}),
  },
});
console.log(`cut tool: ${tool.mesh.triangles} triangles`);

const merged = await unionParts(body, { name: 'model', color: '#cccccc' });
console.log(`body: ${merged.indices.length / 3} triangles`);

const cutBody = await subtractParts(
  merged,
  [{ name: 'cut', color: '#ff0000', positions: tool.mesh.positions, indices: tool.mesh.indices, manifold: true }],
  { name: 'model', color: '#cccccc' },
);
console.log(`after the cut: ${cutBody.indices.length / 3} triangles`);

/** Connected components over welded positions. */
function components(positions: Float32Array, indices: Uint32Array): number[][] {
  const n = positions.length / 3;
  const weld = new Map<string, number>();
  const canon = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    const k =
      positions[v * 3].toFixed(3) + ',' + positions[v * 3 + 1].toFixed(3) + ',' + positions[v * 3 + 2].toFixed(3);
    const seen = weld.get(k);
    if (seen === undefined) {
      weld.set(k, v);
      canon[v] = v;
    } else canon[v] = seen;
  }
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const uni = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let v = 0; v < n; v++) uni(v, canon[v]);
  for (let k = 0; k < indices.length; k += 3) {
    uni(indices[k], indices[k + 1]);
    uni(indices[k + 1], indices[k + 2]);
  }
  const groups = new Map<number, number[]>();
  for (let k = 0; k < indices.length; k += 3) {
    const r = find(indices[k]);
    const g = groups.get(r);
    if (g) g.push(k);
    else groups.set(r, [k]);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

// The control. Without it, pieces that were already loose get blamed on the cut.
const before = components(merged.positions, merged.indices);
console.log(`
body BEFORE the cut: ${before.length} connected component(s), ` +
  `largest ${((before[0].length / (merged.indices.length / 3)) * 100).toFixed(1)}%`);

// What ARE the pieces that were already loose? A solid that merely sits on the
// terrain is fine; one that floats above it is not.
console.log('  the pre-existing loose pieces, and how far each clears the ground:');
for (const g of before.slice(1, 12)) {
  let gap = Infinity;
  let lo = Infinity;
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const k of g) {
    for (let e = 0; e < 3; e++) {
      const v = merged.indices[k + e] * 3;
      const z = merged.positions[v + 2];
      const ground = drapeZ(merged.positions[v], merged.positions[v + 1]);
      if (z - ground < gap) gap = z - ground;
      if (z < lo) lo = z;
      cx += merged.positions[v];
      cy += merged.positions[v + 1];
      n++;
    }
  }
  console.log(
    `    ${String(g.length).padStart(5)} tris  lowest z ${lo.toFixed(2)} mm  ` +
      `clears the ground by ${gap.toFixed(2)} mm  at ${(cx / n).toFixed(1)}, ${(cy / n).toFixed(1)}`,
  );
}

const comps = components(cutBody.positions, cutBody.indices);
const total = cutBody.indices.length / 3;
console.log(`\nbody after the cut: ${comps.length} connected component(s)`);
console.log(`  largest holds ${((comps[0].length / total) * 100).toFixed(1)}% of the triangles`);

if (comps.length > 1) {
  console.log(`  ${comps.length - 1} DETACHED piece(s) that the channel cut free:`);
  for (const g of comps.slice(1, 10)) {
    let lo = Infinity;
    let hi = -Infinity;
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const k of g) {
      for (let e = 0; e < 3; e++) {
        const v = cutBody.indices[k + e] * 3;
        lo = Math.min(lo, cutBody.positions[v + 2]);
        hi = Math.max(hi, cutBody.positions[v + 2]);
        cx += cutBody.positions[v];
        cy += cutBody.positions[v + 1];
        n++;
      }
    }
    console.log(
      `    ${String(g.length).padStart(6)} tris  z ${lo.toFixed(2)}..${hi.toFixed(2)} mm  ` +
        `at ${(cx / n).toFixed(1)}, ${(cy / n).toFixed(1)} mm from centre`,
    );
  }
}
