/**
 * Does a large selection actually load now?
 *
 * The case that failed: a 21.4 km selection around Islamabad, which returned
 * nothing at all as a single query.
 */
import { fetchOsm, tileBBox, bboxArea_km2 } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import type { LayerId } from '../src/data/osm/tags';

const LAT = 33.7;
const LON = 73.06;
const layers: LayerId[] = ['roads', 'railways', 'trails'];

/**
 * Node sends no User-Agent and Overpass answers 406; a browser sends its own.
 * A harness detail, not a product one — but it is why this script injects one.
 */
const withAgent = ((url: string, init: RequestInit) =>
  fetch(url, {
    ...init,
    headers: { ...init.headers, 'User-Agent': 'MazeTerrain/0.1 (dev verification)' },
  })) as unknown as typeof fetch;

const extent_km = Number(process.argv[2] ?? 21.4);
const half = extent_km / 2;
const kmPerLat = 110.574;
const kmPerLon = 111.32 * Math.cos((LAT * Math.PI) / 180);
const bbox = {
  west: LON - half / kmPerLon,
  east: LON + half / kmPerLon,
  south: LAT - half / kmPerLat,
  north: LAT + half / kmPerLat,
};

const tiles = tileBBox(bbox);
console.log(
  `\n${extent_km} km selection = ${bboxArea_km2(bbox).toFixed(0)} km2 -> ${tiles.length} tiles ` +
    `(${bboxArea_km2(tiles[0]).toFixed(1)} km2 each)`,
);

const t0 = Date.now();
try {
  const response = await fetchOsm(bbox, layers, {
    fetchImpl: withAgent,
    onAttempt: (m) => process.stdout.write(`\r  ${m}          `),
  });
  const features = normalise(response);
  const byLayer: Record<string, number> = {};
  for (const l of features.lines) byLayer[l.layer] = (byLayer[l.layer] ?? 0) + 1;

  console.log(
    `\n  OK in ${((Date.now() - t0) / 1000).toFixed(1)}s: ` +
      `${response.elements.length.toLocaleString()} elements -> ` +
      `${features.lines.length.toLocaleString()} lines`,
  );
  console.log('  by layer:', JSON.stringify(byLayer));
} catch (err) {
  console.log(`\n  FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${String(err)}`);
}
