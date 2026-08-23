/**
 * Non-finite vertices and out-of-range indices.
 *
 * Every measurement so far compared heights with `>`, and every comparison
 * against NaN is false — so a NaN vertex is invisible to all of them, while a
 * renderer draws it as a needle shooting out of the model. Same for an index
 * pointing past the end of the vertex buffer: the triangle then reaches for
 * whatever is there, usually vertex zero, and draws a spike to it.
 *
 * That is the classic shape of the reported artefact, and exactly the class of
 * fault the existing checks cannot see: `validateMesh` counts edges, and a NaN
 * vertex still has perfectly well-paired edges.
 */
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
import { buildClippedTerrainMesh } from '../src/geometry/terrainClip';
import { selectionRingWorld } from '../src/geometry/selection';
import { unprojectENU } from '../src/geometry/coords';
import { defaultLayers } from '../src/config/presets';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import { LAYER_BY_ID, type LayerId } from '../src/data/osm/tags';
import type { Route, RoutePoint } from '../src/data/gpx/types';
import type { SelectionShape } from '../src/geometry/selection';

const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev)' } })) as unknown as typeof fetch;

const extent_km = Number(process.argv[2] ?? 2);
const LAT = 33.7, LON = 73.06, half = extent_km / 2;
const bbox = {
  west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - half / 110.574,
  north: LAT + half / 110.574,
};

const wanted: LayerId[] = ['roads', 'water', 'trails', 'railways', 'buildings', 'greenery'];
const features = normalise(await fetchOsm(bbox, wanted, { fetchImpl: withAgent }));
console.log(`\n${extent_km} km: ${features.lines.length} lines, ${features.polygons.length} polygons`);

const cells = 180;
const hf = makeHeightfield(
  cells, cells,
  // Nearly flat: the case where the vertical scale stays high and towers show.
  (i, j) => 500 + 1.5 * Math.sin(i / 15) + 1.2 * Math.cos(j / 19),
  (extent_km * 1000) / (cells - 1),
);
// The bbox matters: it sets the ENU origin, and without it the OSM features
// project millions of metres away and clip to nothing.
const scale = scaleFor(hf, { bbox });

// A circle, like the screenshot.
const radius = ((cells - 1) * hf.spacingX_m) * 0.45;
const shape: SelectionShape = {
  kind: 'polygon',
  ring: Array.from({ length: 96 }, (_, i) => {
    const t = (i / 96) * Math.PI * 2;
    return unprojectENU(radius * Math.cos(t), radius * Math.sin(t), scale.origin);
  }),
};
const ring = selectionRingWorld(shape, scale.origin);

const base = defaultLayers();
const layers: Record<string, LayerSettings> = Object.fromEntries(
  Object.entries(base).map(([k, v]) => [k, { ...v, enabled: wanted.includes(k as LayerId) }]),
);

/** A short route through the middle, so that path is exercised too. */
const routePoints: RoutePoint[] = [];
for (let i = 0; i <= 200; i++) {
  const t = i / 200;
  const [lon, lat] = unprojectENU(
    -radius * 0.8 + t * radius * 1.6,
    Math.sin(t * Math.PI * 3) * radius * 0.4,
    scale.origin,
  );
  routePoints.push({ lon, lat });
}
const route: Route = {
  id: 'r', name: 'diag', points: routePoints, distance_m: 0, elevationGain_m: null,
  bbox: { west: 0, south: 0, east: 0, north: 0 },
  style: {
    color: '#FF0D00', width_mm: 2, height_mm: 1.2, profile: 'raised',
    elevationSource: 'dem', demBlend: 0, visible: true,
  },
};

const parts: Array<{ name: string; positions: Float32Array; indices: Uint32Array }> = [];

const terrain = buildClippedTerrainMesh(hf, scale, ring);
parts.push({ name: 'terrain', positions: terrain.positions, indices: terrain.indices });

const water = waterRings(features.polygons, scale);
const lines = groupLines(features.lines);
const polys = groupPolygons(features.polygons);
const opts = {
  heightfield: hf, scale, selection: ring,
  nozzleDiameter_mm: 0.4, baseThickness_mm: 3, layers, triangleBudget: 6_000_000,
};

for (const layer of wanted) {
  const isLine = LAYER_BY_ID[layer].kind === 'line';
  const built = isLine
    ? buildLineLayer(layer, lines.get(layer) ?? [], water, opts)
    : buildPolygonLayer(layer, polys.get(layer) ?? [], opts);
  if (built.part) parts.push({ name: layer, positions: built.part.positions, indices: built.part.indices });
  if (built.stats.tooNarrow || built.stats.shortened) {
    console.log(`  ${layer}: ${built.stats.tooNarrow} too narrow to print, ${built.stats.shortened} shortened`);
  }
}

const routeSolid = buildRouteSolid(route, {
  heightfield: hf, scale, selection: ring, nozzleDiameter_mm: 0.4, baseThickness_mm: 3,
});
if (routeSolid.mesh.triangles > 0) {
  parts.push({ name: 'route', positions: routeSolid.mesh.positions, indices: routeSolid.mesh.indices });
}

console.log('\npart          verts     tris    NaN    Inf   |z|>1e4   idx>=verts   maxZ');
let bad = 0;
for (const part of parts) {
  const p = part.positions;
  let nan = 0, inf = 0, huge = 0, maxZ = -Infinity;
  for (let i = 0; i < p.length; i++) {
    const v = p[i];
    if (Number.isNaN(v)) nan++;
    else if (!Number.isFinite(v)) inf++;
    else if (Math.abs(v) > 1e4) huge++;
    if (i % 3 === 2 && Number.isFinite(v) && v > maxZ) maxZ = v;
  }
  const nVerts = p.length / 3;
  let oob = 0;
  for (let i = 0; i < part.indices.length; i++) if (part.indices[i] >= nVerts) oob++;
  bad += nan + inf + huge + oob;
  console.log(
    `${part.name.padEnd(12)} ${String(nVerts).padStart(7)} ${String(part.indices.length / 3).padStart(8)}` +
      ` ${String(nan).padStart(6)} ${String(inf).padStart(6)} ${String(huge).padStart(9)}` +
      ` ${String(oob).padStart(12)} ${maxZ.toFixed(2).padStart(7)}`,
  );
}
console.log(bad === 0 ? '\nclean\n' : `\n${bad} BAD VALUES\n`);
