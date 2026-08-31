/**
 * Does the insert still lose its clearance at a hairpin?
 *
 * The channel and the insert are two contours of ONE distance field, traced at
 * levels `w/2` and `w/2 - clearance`. On a continuous field those are exact
 * parallel offsets and the gap is the clearance everywhere. The roadmap says it
 * collapses to about a fifth at the sharpest turns; this measures whether that
 * is still true, and where.
 */
import { buildRouteSolid } from '../src/geometry/route';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { Route, RoutePoint } from '../src/data/gpx/types';
import type { MultiPolygon } from '../src/geometry/polygons';

const bbox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };
const hf = makeHeightfield(160, 160, () => 500, 25);
const scale = scaleFor(hf, { bbox, baseThickness_mm: 3 });

/** A switchback: down, hard turn, back up, with a given turn half-width. */
function hairpin(gap_m: number): RoutePoint[] {
  const origin = scale.origin;
  const pts: Array<[number, number]> = [
    [-800, gap_m], [200, gap_m], [400, 0], [200, -gap_m], [-800, -gap_m],
  ];
  // World metres -> lon/lat, the inverse of what the builder does.
  return pts.map(([x, y]) => {
    const lat = origin.lat + (y / 110574);
    const lon = origin.lon + x / (111320 * Math.cos((origin.lat * Math.PI) / 180));
    return { lon, lat };
  });
}

function boundaryPoints(mp: MultiPolygon): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const poly of mp) for (const ring of poly) for (const p of ring) out.push([p[0], p[1]]);
  return out;
}

/**
 * Smallest distance from any insert boundary point to any channel boundary
 * point, via a uniform grid — the all-pairs version is minutes on these counts.
 */
function minGap_m(
  insert: Array<[number, number]>,
  channel: Array<[number, number]>,
  cell_m: number,
): number {
  const buckets = new Map<string, Array<[number, number]>>();
  const key = (x: number, y: number) => `${Math.floor(x / cell_m)},${Math.floor(y / cell_m)}`;
  for (const p of channel) {
    const k = key(p[0], p[1]);
    const list = buckets.get(k);
    if (list) list.push(p);
    else buckets.set(k, [p]);
  }

  let worst = Infinity;
  for (const a of insert) {
    const cx = Math.floor(a[0] / cell_m);
    const cy = Math.floor(a[1] / cell_m);
    let near = Infinity;
    // Widen the ring until something is found, so a sparse area still answers.
    for (let ring = 1; ring <= 6 && !Number.isFinite(near); ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (const b of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
            const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
            if (d < near) near = d;
          }
        }
      }
    }
    if (near < worst) worst = near;
  }
  return worst;
}

const width_mm = 1.5;
const clearance_mm = 0.15;

console.log(`\nwidth ${width_mm} mm, clearance ${clearance_mm} mm per side`);
console.log(`scale ${scale.scale.toFixed(4)} mm/m -> clearance = ${(clearance_mm / scale.scale).toFixed(1)} m\n`);
console.log('turn half-width   min gap (mm)   as % of asked');

for (const gap_m of [800, 400, 200, 100, 50]) {
  const route: Route = {
    id: 'r', name: 'hairpin', source: 'gpx', smoothing: 0,
    points: hairpin(gap_m),
    distance_m: 0, elevationGain_m: null,
    bbox: { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north },
    style: {
      color: '#FF0000', width_mm, height_mm: 1, profile: 'raised',
      elevationSource: 'flat', demBlend: 0, visible: true,
    },
  };

  const common = { heightfield: hf, scale, selection: null, nozzleDiameter_mm: 0.4, baseThickness_mm: 3 };
  const channel = buildRouteSolid(route, {
    ...common,
    cut: { kind: 'cut' as const, depth_mm: 1, proud_mm: 0.4, toolTop_mm: 40 },
  });
  const insert = buildRouteSolid(route, {
    ...common,
    cut: { kind: 'insert' as const, depth_mm: 1, proud_mm: 0.4, clearance_mm },
  });

  const c = boundaryPoints(channel.footprint ?? []);
  const i = boundaryPoints(insert.footprint ?? []);
  if (c.length === 0 || i.length === 0) {
    console.log(`${String(gap_m).padStart(11)} m   (no footprint returned)`);
    continue;
  }

  const gap_mm = minGap_m(i, c, 40) * scale.scale;
  const pct = (gap_mm / clearance_mm) * 100;
  console.log(
    `${String(gap_m).padStart(11)} m   ${gap_mm.toFixed(4).padStart(10)}   ${pct.toFixed(0).padStart(9)}%`,
  );
}
