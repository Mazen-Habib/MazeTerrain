/**
 * Does the insert keep its clearance at a hairpin?
 *
 * Open defect (09-roadmap.md): "the gap between insert and channel drops to
 * about a fifth of the requested clearance at the sharpest turns". That note
 * predates several fixes to the ribbon field, so this measures the gap as it is
 * now rather than trusting it.
 *
 * The channel and the insert are two contours of ONE distance field, traced at
 * `w/2` and `w/2 - clearance`. On a continuous field those are exact parallel
 * offsets and the gap is the clearance everywhere; anywhere it is not, the
 * discretisation is the culprit.
 */
import { describe, expect, it } from 'vitest';
import { buildRouteSolid } from '../src/geometry/route';
import { makeHeightfield, scaleFor } from './helpers';
import { unprojectENU } from '../src/geometry/coords';
import type { Route, RoutePoint } from '../src/data/gpx/types';
import type { MultiPolygon } from '../src/geometry/polygons';

const bbox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };
const hf = makeHeightfield(160, 160, () => 500, 25);
const scale = scaleFor(hf, { bbox, baseThickness_mm: 3 });

/** A switchback with a given half-width at the turn, in world metres. */
function hairpinRoute(gap_m: number, width_mm: number): Route {
  const { origin } = scale;
  const pts: Array<[number, number]> = [
    [-800, gap_m],
    [200, gap_m],
    [400, 0],
    [200, -gap_m],
    [-800, -gap_m],
  ];
  // The pipeline's own inverse projection, not a hand-rolled one. A first
  // version read `origin.lat` / `origin.lon`, which do not exist — the fields
  // are `lat0` / `lon0` — so every point came out NaN and the build never
  // returned.
  const points: RoutePoint[] = pts.map(([x, y]) => {
    const [lon, lat] = unprojectENU(x, y, origin);
    return { lon, lat };
  });

  return {
    id: 'r',
    name: 'hairpin',
    source: 'gpx',
    smoothing: 0,
    points,
    distance_m: 0,
    elevationGain_m: null,
    bbox,
    style: {
      color: '#FF0000',
      width_mm,
      height_mm: 1,
      profile: 'raised',
      elevationSource: 'flat',
      demBlend: 0,
      visible: true,
    },
  };
}

function boundaryPoints(mp: MultiPolygon | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const poly of mp ?? []) for (const ring of poly) for (const p of ring) out.push([p[0], p[1]]);
  return out;
}

/**
 * Nearest channel point to each insert point, via a uniform grid.
 *
 * The bucket has to be SMALL. A first version used 40 m cells and was still
 * effectively all-pairs: contour points are dense along a curve, so nine
 * neighbouring buckets held thousands of points each and the search never
 * finished. Small cells plus a subsampled insert makes it seconds.
 */
function minGap_m(
  insert: Array<[number, number]>,
  channel: Array<[number, number]>,
  cell_m = 8,
): number {
  const buckets = new Map<string, Array<[number, number]>>();
  for (const p of channel) {
    const k = `${Math.floor(p[0] / cell_m)},${Math.floor(p[1] / cell_m)}`;
    const list = buckets.get(k);
    if (list) list.push(p);
    else buckets.set(k, [p]);
  }

  // Every insert point is not needed to find the tightest spot: the contour is
  // sampled far finer than the feature being measured.
  const step = Math.max(1, Math.floor(insert.length / 3000));

  let worst = Infinity;
  for (let idx = 0; idx < insert.length; idx += step) {
    const a = insert[idx];
    const cx = Math.floor(a[0] / cell_m);
    const cy = Math.floor(a[1] / cell_m);
    let near = Infinity;
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

/** The measured gap between channel wall and insert, print mm. */
function measureGap_mm(gap_m: number, width_mm: number, clearance_mm: number): number {
  const route = hairpinRoute(gap_m, width_mm);
  const common = {
    heightfield: hf,
    scale,
    selection: null,
    nozzleDiameter_mm: 0.4,
    baseThickness_mm: 3,
  };

  const channel = buildRouteSolid(route, {
    ...common,
    cut: { kind: 'cut' as const, depth_mm: 1, proud_mm: 0.4, toolTop_mm: 40 },
  });
  const insert = buildRouteSolid(route, {
    ...common,
    cut: { kind: 'insert' as const, depth_mm: 1, proud_mm: 0.4, clearance_mm },
  });

  const c = boundaryPoints(channel.footprint);
  const i = boundaryPoints(insert.footprint);
  if (c.length === 0 || i.length === 0) return NaN;

  return minGap_m(i, c) * scale.scale;
}

/**
 * A wide ribbon and a generous clearance, deliberately.
 *
 * The distance field must resolve the clearance across the whole model, so its
 * cell count goes as (modelWidth / clearance)^2 — a real 1.5 mm route with
 * 0.15 mm clearance needs roughly a 2700 x 2700 grid, and building ten of them
 * takes minutes. The question here is geometric and scale-free: does a tight
 * turn collapse the gap between two contours of one field? A 4 mm ribbon with
 * 0.5 mm clearance asks exactly that, at a fortieth of the cost.
 */
describe('insert clearance through a hairpin', () => {
  const width_mm = 4;
  const clearance_mm = 0.5;

  /**
   * The baseline: on a straight run the two contours are parallel offsets and
   * the gap should simply be the clearance. If this is wrong, nothing about the
   * turn measurements means anything.
   */
  it('holds the full clearance on an open turn', () => {
    const gap_mm = measureGap_mm(800, width_mm, clearance_mm);
    expect(gap_mm).toBeGreaterThan(clearance_mm * 0.8);
    expect(gap_mm).toBeLessThan(clearance_mm * 1.6);
  });

  /**
   * The defect, measured: it is gone, and the guard is set where it now sits
   * rather than where "not yet fatal" would be. Measured 2026-08-30 —
   * 100% of the asked clearance at turn half-widths of 5.03x, 1.89x and 0.75x
   * the ribbon's own half-width, the last of which genuinely folds back on
   * itself. 85% leaves room for grid wobble and still catches a real collapse.
   */
  it('keeps the clearance at the sharpest turn', () => {
    const measurements: Array<[number, number]> = [];
    for (const gap_m of [400, 150, 60]) {
      measurements.push([gap_m, measureGap_mm(gap_m, width_mm, clearance_mm)]);
    }

    for (const [gap_m, measured] of measurements) {
      expect(measured, `turn half-width ${gap_m} m`).toBeGreaterThan(clearance_mm * 0.85);
    }
  });

  /**
   * The numbers actually printed: a 1.5 mm route with the default 0.15 mm press
   * fit. The cheap fixture above answers the geometric question; this one
   * answers whether the answer survives at the ratio a user really builds at.
   */
  it('holds the clearance at real print settings too', () => {
    for (const gap_m of [150, 40]) {
      const measured = measureGap_mm(gap_m, 1.5, 0.15);
      expect(measured, `turn half-width ${gap_m} m`).toBeGreaterThan(0.15 * 0.85);
    }
  });
});

/**
 * A non-finite coordinate must not hang the build.
 *
 * Found by getting a test fixture wrong: reading `origin.lat` instead of
 * `origin.lat0` produced NaN for every point, and `buildRouteSolid` then never
 * returned — no error, no progress, just a worker spinning. NaN reaches the
 * distance field and the ribbon tracer cannot terminate on it.
 *
 * Real GPX and drawn routes should never contain one. "Should never" is not a
 * reason to hang if one does.
 */
describe('a route with a bad coordinate', () => {
  const options = {
    heightfield: hf,
    scale,
    selection: null,
    nozzleDiameter_mm: 0.4,
    baseThickness_mm: 3,
  };

  function withPoints(points: RoutePoint[]): Route {
    const base = hairpinRoute(200, 1.5);
    return { ...base, points };
  }

  it('returns rather than spinning when every point is NaN', () => {
    const nan = [
      { lon: NaN, lat: NaN },
      { lon: NaN, lat: NaN },
      { lon: NaN, lat: NaN },
    ];
    const built = buildRouteSolid(withPoints(nan), options);
    expect(built.mesh.triangles).toBe(0);
  });

  /** One bad reading in a good track loses the point, not the route. */
  it('drops a single bad point and builds the rest', () => {
    const good = hairpinRoute(200, 1.5).points;
    const spoiled = [...good];
    spoiled.splice(2, 0, { lon: Number.POSITIVE_INFINITY, lat: 0 });

    const built = buildRouteSolid(withPoints(spoiled), options);
    expect(built.mesh.triangles).toBeGreaterThan(0);
  });
});
