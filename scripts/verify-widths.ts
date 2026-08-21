/**
 * End-to-end check of the width model against real OSM data at the user's
 * 11.2 km Islamabad view: what widths are printed, how much is covered, and is
 * the result still manifold.
 */
import { buildLineLayer } from '../src/geometry/features';
import { defaultLayers } from '../src/config/presets';
import { classify } from '../src/data/osm/tags';
import { validateMesh } from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { LineFeature } from '../src/data/osm/normalise';

const LAT = 33.73, LON = 73.04, EXTENT_M = 11200;
const half = EXTENT_M / 2;
const mPerLat = 110900, mPerLon = 111320 * Math.cos((LAT * Math.PI) / 180);
const bbox = {
  s: LAT - half / mPerLat, n: LAT + half / mPerLat,
  w: LON - half / mPerLon, e: LON + half / mPerLon,
};

const q = `[out:json][timeout:120];way["highway"](${bbox.s},${bbox.w},${bbox.n},${bbox.e});out geom;`;
const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST', body: 'data=' + encodeURIComponent(q),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'MazeTerrain/0.1 (dev)' },
});
const data = await res.json();

const features: LineFeature[] = [];
for (const el of data.elements) {
  if (el.type !== 'way' || !el.geometry) continue;
  const c = classify(el.tags ?? {});
  if (!c || c.layer !== 'roads') continue;
  features.push({
    layer: 'roads', subtype: c.subtype, bridge: c.bridge, width_m: c.width_m ?? 6, layerOrder: 0,
    points: el.geometry.map((g: any) => [g.lon, g.lat] as [number, number]),
  });
}

// A 113 x 113 grid at 100 m covers 11.2 km, matching the user's extent.
const hf = makeHeightfield(113, 113, (i, j) => 500 + 2 * i + 1.5 * j);
const scale = scaleFor(hf);
const layers = defaultLayers();

for (const nozzle of [0.4, 0.2]) {
  for (const floor of ['auto', 0.1] as const) {
    const t0 = Date.now();
    const built = buildLineLayer('roads', features, [], {
      heightfield: hf, scale, selection: null,
      nozzleDiameter_mm: nozzle, baseThickness_mm: 3,
      layers: { ...layers, roads: { ...layers.roads, minWidth_mm: floor } },
      triangleBudget: 2_000_000,
    });
    const s = built.stats;
    let v = '-';
    if (built.part) {
      const r = validateMesh(built.part.positions, built.part.indices);
      v = `watertight ${r.watertight} openEdges ${r.openEdges} nonMan ${r.nonManifoldEdges}`;
    }
    console.log(
      `nozzle ${nozzle} floor ${String(floor).padEnd(4)} | ` +
      `width ${s.narrowestWidth_mm.toFixed(2)}-${s.width_mm.toFixed(2)} mm ` +
      `(${(s.narrowestWidth_mm / scale.scale).toFixed(0)}-${(s.width_mm / scale.scale).toFixed(0)} m real) | ` +
      `tris ${s.triangles.toLocaleString()} | ${(Date.now() - t0) / 1000}s`,
    );
    console.log(`   dropped: ${s.droppedSubtypes.join(', ') || '(none)'} | ${v}`);
  }
}
