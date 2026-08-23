/**
 * The whole large-area path: fetch, build, validate.
 *
 * The case this exists for is a 100 km route, which needs a selection tens of
 * kilometres across — the size that previously returned no map data at all.
 */
import { fetchOsm, tileBBox, bboxArea_km2 } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import {
  buildLineLayer,
  buildPolygonLayer,
  groupLines,
  groupPolygons,
  waterRings,
  type LayerSettings,
} from '../src/geometry/features';
import { validateMesh } from '../src/geometry/validate';
import { bboxRingWorld } from '../src/geometry/selection';
import { defaultLayers } from '../src/config/presets';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import { LAYER_BY_ID, type LayerId } from '../src/data/osm/tags';

const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, {
    ...init,
    headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev verification)' },
  })) as unknown as typeof fetch;

const extent_km = Number(process.argv[2] ?? 21.4);
const withBuildings = process.argv.includes('--buildings');

const LAT = 33.7;
const LON = 73.06;
const half = extent_km / 2;
const bbox = {
  west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - half / 110.574,
  north: LAT + half / 110.574,
};

const wanted: LayerId[] = withBuildings
  ? ['roads', 'railways', 'trails', 'water', 'greenery', 'buildings']
  : ['roads', 'railways', 'trails', 'water'];

console.log(
  `\n${extent_km} km = ${bboxArea_km2(bbox).toFixed(0)} km2 -> ${tileBBox(bbox).length} tiles` +
    `${withBuildings ? ', buildings on' : ''}`,
);

const t0 = Date.now();
const response = await fetchOsm(bbox, wanted, {
  fetchImpl: withAgent,
  onAttempt: (m) => process.stdout.write(`\r  ${m}          `),
});
const fetch_s = (Date.now() - t0) / 1000;
const features = normalise(response);
console.log(
  `\n  fetch ${fetch_s.toFixed(1)}s: ${response.elements.length.toLocaleString()} elements -> ` +
    `${features.lines.length.toLocaleString()} lines, ${features.polygons.length.toLocaleString()} polygons`,
);

// A grid at roughly the printable step for a 100 mm model.
const cells = 400;
const hf = makeHeightfield(
  cells,
  cells,
  (i, j) => 500 + i * 0.4 + j * 0.3,
  (extent_km * 1000) / (cells - 1),
);
const scale = scaleFor(hf);
const clip = bboxRingWorld(bbox, scale.origin);

const base = defaultLayers();
const layers: Record<string, LayerSettings> = Object.fromEntries(
  Object.entries(base).map(([k, v]) => [k, { ...v, enabled: wanted.includes(k as LayerId) }]),
);

const water = waterRings(features.polygons, scale);
const lines = groupLines(features.lines);
const polygons = groupPolygons(features.polygons);

let total = 0;
let budget = 2_000_000;
const build0 = Date.now();

for (const layer of wanted) {
  const isLine = LAYER_BY_ID[layer].kind === 'line';
  const group = isLine ? (lines.get(layer) ?? []) : (polygons.get(layer) ?? []);
  if (group.length === 0) {
    console.log(`  ${layer.padEnd(10)} nothing in this area`);
    continue;
  }

  const t = Date.now();
  const opts = {
    heightfield: hf,
    scale,
    selection: clip,
    nozzleDiameter_mm: 0.4,
    baseThickness_mm: 3,
    layers,
    triangleBudget: budget,
  };
  const built = isLine
    ? buildLineLayer(layer, lines.get(layer) ?? [], water, opts)
    : buildPolygonLayer(layer, polygons.get(layer) ?? [], opts);

  if (!built.part) {
    console.log(`  ${layer.padEnd(10)} ${group.length} features -> nothing`);
    continue;
  }

  const v = validateMesh(built.part.positions, built.part.indices);
  total += built.stats.triangles;
  budget -= built.stats.triangles;

  console.log(
    `  ${layer.padEnd(10)} ${String(group.length).padStart(6)} features -> ` +
      `${built.stats.triangles.toLocaleString().padStart(9)} tris  ` +
      `${((Date.now() - t) / 1000).toFixed(1)}s  ` +
      `open ${v.openEdges} nonMan ${v.nonManifoldEdges}` +
      `${built.stats.truncated ? '  TRUNCATED' : ''}` +
      `${built.stats.crowdedSubtypes.length ? `  crowded: ${built.stats.crowdedSubtypes.join(',')}` : ''}`,
  );
}

console.log(
  `\n  TOTAL ${total.toLocaleString()} feature triangles, ` +
    `build ${((Date.now() - build0) / 1000).toFixed(1)}s, fetch ${fetch_s.toFixed(1)}s`,
);
