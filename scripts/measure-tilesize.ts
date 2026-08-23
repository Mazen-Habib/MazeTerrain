/**
 * How big can one Overpass query be, over dense city, with the real layers?
 *
 * The tile size was picked conservatively. Too small means many requests, and
 * the public instance drops connections long before the queries themselves are
 * a problem — so this measures where the real ceiling is.
 */
import { buildQuery, bboxArea_km2 } from '../src/data/osm/overpass';
import type { LayerId } from '../src/data/osm/tags';

const LAT = 33.7;
const LON = 73.06;
const layers: LayerId[] = ['roads', 'railways', 'trails'];

const kmPerLat = 110.574;
const kmPerLon = 111.32 * Math.cos((LAT * Math.PI) / 180);

for (const deg of [0.04, 0.06, 0.08, 0.12, 0.16]) {
  const bbox = { west: LON, east: LON + deg, south: LAT, north: LAT + deg };
  const area = bboxArea_km2(bbox);
  const query = buildQuery(bbox, layers);

  const t0 = Date.now();
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      headers: { 'User-Agent': 'MazeTerrain/0.1 (dev measurement)' },
    });
    const text = await res.text();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!res.ok) {
      console.log(`${deg}deg ${area.toFixed(0).padStart(4)} km2  HTTP ${res.status}  ${secs}s`);
      continue;
    }
    const n = (JSON.parse(text) as { elements: unknown[] }).elements.length;
    console.log(
      `${deg}deg ${area.toFixed(0).padStart(4)} km2  ok  ${secs}s  ` +
        `${n.toLocaleString().padStart(8)} elements  ${(text.length / 1e6).toFixed(1)} MB`,
    );
  } catch (err) {
    console.log(
      `${deg}deg ${area.toFixed(0).padStart(4)} km2  FAILED after ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s: ${String(err).slice(0, 70)}`,
    );
  }
  // Be a good citizen between probes.
  await new Promise((r) => setTimeout(r, 3000));
}
