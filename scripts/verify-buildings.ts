/** Do buildings actually come out as buildings now? */
import { fetchOsm } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import { buildPolygonLayer, groupPolygons, type LayerSettings } from '../src/geometry/features';
import { validateMesh } from '../src/geometry/validate';
import { defaultLayers } from '../src/config/presets';
import { makeHeightfield, scaleFor } from '../tests/helpers';

const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev)' } })) as unknown as typeof fetch;

const LAT = 33.7, LON = 73.06;
for (const extent_km of [1, 2, 4, 9.2]) {
  const half = extent_km / 2;
  const bbox = {
    west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
    east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
    south: LAT - half / 110.574, north: LAT + half / 110.574,
  };
  const f = normalise(await fetchOsm(bbox, ['buildings'], { fetchImpl: withAgent }));
  const cells = 160;
  const hf = makeHeightfield(cells, cells, (i,j)=>500 + 2*Math.sin(i/15) + 1.5*Math.cos(j/19), (extent_km*1000)/(cells-1));
  const scale = scaleFor(hf, { bbox });
  const base = defaultLayers();
  const layers: Record<string, LayerSettings> = { ...base, buildings: { ...base.buildings, enabled: true } };

  const built = buildPolygonLayer('buildings', groupPolygons(f.polygons).get('buildings') ?? [], {
    heightfield: hf, scale, selection: null,
    nozzleDiameter_mm: 0.4, baseThickness_mm: 3, layers, triangleBudget: 6_000_000,
  });

  if (!built.part) { console.log(`\n${extent_km} km: nothing built (${built.stats.tooNarrow} too narrow)`); continue; }

  // Height of each building above the ground it sits on.
  const p = built.part.positions;
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  const v = validateMesh(built.part.positions, built.part.indices);

  console.log(
    `\n${extent_km} km  ${built.stats.features} built, ${built.stats.tooNarrow} too narrow, ${built.stats.shortened} shortened` +
    `\n  z ${lo.toFixed(2)}..${hi.toFixed(2)} mm  tris ${built.stats.triangles}  open ${v.openEdges} nonMan ${v.nonManifoldEdges}`,
  );
}
