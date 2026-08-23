/** What does draping roads properly cost on a real city? */
import { fetchOsm } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import { buildLineLayer, groupLines, type LayerSettings } from '../src/geometry/features';
import { validateMesh } from '../src/geometry/validate';
import { bboxRingWorld } from '../src/geometry/selection';
import { defaultLayers } from '../src/config/presets';
import { makeHeightfield, scaleFor } from '../tests/helpers';

const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev)' } })) as unknown as typeof fetch;

const extent_km = Number(process.argv[2] ?? 9.3);
const LAT = 33.7, LON = 73.06, half = extent_km / 2;
const bbox = {
  west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - half / 110.574, north: LAT + half / 110.574,
};

const response = await fetchOsm(bbox, ['roads'], { fetchImpl: withAgent });
const lines = groupLines(normalise(response).lines).get('roads') ?? [];

// Grid at the nozzle-limited step for a 100 mm model at 0.4 mm.
const cells = 251;
const step = (extent_km * 1000) / (cells - 1);
const hf = makeHeightfield(cells, cells, (i, j) => 500 + 70 * Math.sin(i / 20) + 55 * Math.cos(j / 24), step);
const scale = scaleFor(hf);
const layers = defaultLayers() as Record<string, LayerSettings>;

console.log(`\n${extent_km} km, ${lines.length} road ways, terrain step ${step.toFixed(1)} m`);

const t0 = Date.now();
const built = buildLineLayer('roads', lines, [], {
  heightfield: hf, scale, selection: bboxRingWorld(bbox, scale.origin),
  nozzleDiameter_mm: 0.4, baseThickness_mm: 3, layers, triangleBudget: 20_000_000,
});
const v = built.part ? validateMesh(built.part.positions, built.part.indices) : null;
console.log(
  `  ${built.stats.triangles.toLocaleString().padStart(10)} tris  ${((Date.now()-t0)/1000).toFixed(1)}s` +
  `  open ${v?.openEdges} nonMan ${v?.nonManifoldEdges}${built.stats.truncated ? '  TRUNCATED' : ''}`,
);
