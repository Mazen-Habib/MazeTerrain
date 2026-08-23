/** Polygon layers against real OSM data: cost, validity, and what comes back. */
import { fetchOsm } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import { buildPolygonLayer, groupPolygons } from '../src/geometry/features';
import { validateMesh } from '../src/geometry/validate';
import { defaultLayers } from '../src/config/presets';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { LayerId } from '../src/data/osm/tags';

const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev)' } })) as unknown as typeof fetch;

const extent_km = Number(process.argv[2] ?? 2);
const LAT = 33.71, LON = 73.06;
const half = extent_km / 2;
const bbox = {
  west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - half / 110.574,
  north: LAT + half / 110.574,
};

const wanted: LayerId[] = ['buildings', 'water', 'greenery'];
const response = await fetchOsm(bbox, wanted, { fetchImpl: withAgent });
const features = normalise(response);
console.log(`\n${extent_km} km: ${response.elements.length} elements -> ${features.polygons.length} polygons`);

const hf = makeHeightfield(120, 120, (i, j) => 500 + i * 0.8 + j * 0.6, (extent_km * 1000) / 119);
const scale = scaleFor(hf);
const base = defaultLayers();
const layers = Object.fromEntries(
  Object.entries(base).map(([k, v]) => [k, { ...v, enabled: true }]),
);

const grouped = groupPolygons(features.polygons);
for (const layer of wanted) {
  const group = grouped.get(layer) ?? [];
  const t0 = Date.now();
  const built = buildPolygonLayer(layer, group, {
    heightfield: hf, scale, selection: null,
    nozzleDiameter_mm: 0.4, baseThickness_mm: 3,
    layers, triangleBudget: 2_000_000,
  });
  if (!built.part) { console.log(`  ${layer.padEnd(10)} ${group.length} polygons -> nothing`); continue; }
  const v = validateMesh(built.part.positions, built.part.indices);
  console.log(
    `  ${layer.padEnd(10)} ${String(group.length).padStart(5)} polygons -> ` +
    `${built.stats.triangles.toLocaleString().padStart(9)} tris  ${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
    `open ${v.openEdges} nonMan ${v.nonManifoldEdges}${built.stats.truncated ? '  TRUNCATED' : ''}`,
  );
}
