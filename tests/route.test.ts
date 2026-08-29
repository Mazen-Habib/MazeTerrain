import { describe, expect, it } from 'vitest';
import {
  denoise,
  maxDeviation,
  resample,
  simplifyPoints,
  toleranceForScale,
  type Pt,
} from '../src/data/gpx/simplify';
import { defaultRouteStyle, type Route } from '../src/data/gpx/types';
import { multiPolygonArea, normaliseWinding, ringArea } from '../src/geometry/ribbon';
import { buildRibbonField } from '../src/geometry/ribbonField';
import { buildRouteSolid, minPrintableWidth_mm, penetrationFor, pointInRing } from '../src/geometry/route';
import { fitSelectionToRoutes, selectionBBox, selectionRingLonLat } from '../src/geometry/selection';
import { validateMesh, signedVolume } from '../src/geometry/validate';
import { sampleHeightfieldAt } from '../src/geometry/heightfield';
import { makeHeightfield, scaleFor } from './helpers';

/** A straight route across the middle of the synthetic terrain, in ENU metres. */
function straightLine(n = 20, spacing = 100): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push([-((n - 1) * spacing) / 2 + i * spacing, 0]);
  return out;
}

describe('denoise', () => {
  it('drops exact duplicates', () => {
    const r = denoise([[0, 0], [0, 0], [10, 0]]);
    expect(r.points).toHaveLength(2);
    expect(r.duplicatesDropped).toBe(1);
  });

  /** docs/08-pitfalls.md#gps-spikes */
  it('drops a point implying over 200 km/h when timestamps exist', () => {
    const t0 = 1_700_000_000_000;
    const points: Pt[] = [[0, 0], [5000, 0], [100, 0]];
    const times = [t0, t0 + 1000, t0 + 2000];
    const r = denoise(points, times);
    expect(r.spikesDropped).toBe(1);
    expect(r.points).toHaveLength(2);
  });

  it('keeps a fast but plausible move', () => {
    const t0 = 1_700_000_000_000;
    // 10 m in 1 s = 36 km/h. A sprinter on a bike.
    const r = denoise([[0, 0], [10, 0]], [t0, t0 + 1000]);
    expect(r.spikesDropped).toBe(0);
  });

  it('does not guess at spikes without timestamps', () => {
    const r = denoise([[0, 0], [5000, 0], [100, 0]]);
    expect(r.spikesDropped).toBe(0);
    expect(r.points).toHaveLength(3);
  });
});

describe('simplifyPoints', () => {
  it('collapses a dense straight line', () => {
    const dense: Pt[] = Array.from({ length: 200 }, (_, i) => [i, 0] as Pt);
    expect(simplifyPoints(dense, 1).length).toBeLessThan(10);
  });

  /**
   * docs/08-pitfalls.md#hairpins-cut-off guard: the simplified line must never
   * deviate from the original by more than the print-space budget.
   */
  it('keeps switchbacks within the 0.15 mm print budget', () => {
    const scale = 100 / 9280; // 100 mm model over a 9.28 km selection
    const tolerance = toleranceForScale(scale);

    // Alpine-style switchbacks: 40 hairpins over 2 km.
    const hairpins: Pt[] = [];
    for (let i = 0; i < 400; i++) {
      hairpins.push([(i % 2 === 0 ? -60 : 60) + i * 0.5, i * 5]);
    }

    const simplified = simplifyPoints(hairpins, tolerance);
    const deviation_m = maxDeviation(hairpins, simplified);

    expect(deviation_m * scale).toBeLessThanOrEqual(0.15 + 1e-6);
    // ...and the hairpins survive rather than being flattened to a line.
    expect(simplified.length).toBeGreaterThan(100);
  });

  it('leaves a two-point line alone', () => {
    expect(simplifyPoints([[0, 0], [1, 1]], 10)).toHaveLength(2);
  });
});

describe('resample', () => {
  it('splits segments longer than the limit', () => {
    const out = resample([[0, 0], [100, 0]], 25);
    expect(out).toHaveLength(5);
    expect(out[1]).toEqual([25, 0]);
  });

  it('leaves short segments alone', () => {
    expect(resample([[0, 0], [10, 0]], 25)).toHaveLength(2);
  });

  it('preserves the endpoints exactly', () => {
    const out = resample([[0, 0], [7, 11]], 2);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([7, 11]);
  });
});

describe('buildRibbonField', () => {
  const ribbon = (line: Pt[], w: number) => buildRibbonField(line, w).polygons;

  it('produces a band of roughly length x width', () => {
    const area = multiPolygonArea(ribbon(straightLine(11, 100), 20));
    // 1000 m long, 20 m wide, plus two rounded end caps of radius 10.
    const expected = 1000 * 20 + Math.PI * 100;
    expect(area).toBeGreaterThan(expected * 0.95);
    expect(area).toBeLessThan(expected * 1.05);
  });

  /**
   * docs/08-pitfalls.md#self-intersecting-ribbon, and the reason this module
   * exists at all — both JS boolean libraries throw on exactly this input.
   */
  it('resolves an out-and-back into one simple polygon, not overlapping strips', () => {
    const out: Pt[] = [];
    for (let i = 0; i <= 10; i++) out.push([i * 100, 0]);
    for (let i = 10; i >= 0; i--) out.push([i * 100, 5]);

    const mp = ribbon(out, 40);
    expect(mp).toHaveLength(1);
    expect(mp[0]).toHaveLength(1);
    // The passes overlap almost completely, so the merged band is close to one
    // strip, nowhere near two.
    expect(multiPolygonArea(mp)).toBeLessThan(1.4 * 1000 * 40);
  });

  it('merges an exact retrace, which both boolean libraries crash on', () => {
    const there: Pt[] = [];
    for (let i = 0; i <= 20; i++) there.push([i * 50, 0]);
    const retrace: Pt[] = [...there, ...there.slice().reverse()];

    const mp = ribbon(retrace, 40);
    expect(mp).toHaveLength(1);
    expect(multiPolygonArea(mp)).toBeLessThan(1.3 * 1000 * 40);
  });

  it('leaves a hole in the middle of a lap', () => {
    const lap: Pt[] = [];
    const R = 500;
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      lap.push([Math.cos(a) * R, Math.sin(a) * R]);
    }

    const mp = ribbon(lap, 60);
    expect(mp).toHaveLength(1);
    const rings = mp[0];
    expect(rings.length).toBe(2);

    // The interior of the lap is enclosed by the outer ring and excluded by the hole.
    expect(pointInRing(0, 0, rings[0])).toBe(true);
    expect(pointInRing(0, 0, rings[1])).toBe(true);
    expect(ringArea(rings[0])).toBeGreaterThan(0);
    expect(ringArea(rings[1])).toBeLessThan(0);
  });

  it('survives a hairpin without a miter spike', () => {
    // A 180 degree turn: the classic miter explosion input.
    const hairpin: Pt[] = [[0, 0], [500, 0], [0, 1]];
    const mp = ribbon(hairpin, 30);

    let maxAbs = 0;
    for (const poly of mp) {
      for (const ring of poly) {
        for (const [x, y] of ring) maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
      }
    }
    // A level set stays within halfWidth of the centreline by definition.
    expect(maxAbs).toBeLessThan(560);
  });

  it('handles a figure-eight, which crosses itself at a point', () => {
    const eight: Pt[] = [];
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * Math.PI * 2;
      eight.push([Math.sin(t * 2) * 600, Math.sin(t) * 600]);
    }
    const mp = ribbon(eight, 50);
    expect(mp.length).toBeGreaterThanOrEqual(1);
    expect(multiPolygonArea(mp)).toBeGreaterThan(0);
  });

  it('returns nothing for a degenerate input', () => {
    expect(ribbon([[0, 0]], 10)).toEqual([]);
    expect(ribbon([[0, 0], [1, 0]], 0)).toEqual([]);
  });

  /**
   * docs/08-pitfalls.md#ribbon-sliver-rings — a real 10 km lap route produced
   * eight 3-and-4-vertex rings of ~0 m2 alongside its genuine holes. Handed to
   * earcut as holes they wreck the triangulation and the route solid comes back
   * non-manifold with a stray blade where the sliver was extruded.
   */
  it('emits no zero-area rings for a route that laps over itself', () => {
    const laps: Pt[] = [];
    for (let lap = 0; lap < 12; lap++) {
      for (let i = 0; i <= 90; i++) {
        const a = (i / 90) * Math.PI * 2;
        // Each lap wobbles slightly, so passes touch and pinch rather than
        // landing exactly on top of one another.
        const rr = 340 + Math.sin(a * 5 + lap) * 9 + lap * 0.7;
        laps.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
    }

    const result = buildRibbonField(laps, 34);
    const cellArea = result.stats.cell_m * result.stats.cell_m;

    for (const poly of result.polygons) {
      for (const ring of poly) {
        expect(ring.length).toBeGreaterThanOrEqual(3);
        expect(Math.abs(ringArea(ring))).toBeGreaterThanOrEqual(cellArea);
      }
    }
    // The lap still has its genuine hole in the middle.
    expect(result.polygons[0].length).toBeGreaterThanOrEqual(2);
  });

  it('builds a manifold solid from a lapping route', () => {
    const hf2 = makeHeightfield(50, 50, (i, j) => 180 + 0.05 * i + 0.04 * j);
    const scale2 = scaleFor(hf2);
    const laps: Pt[] = [];
    for (let lap = 0; lap < 10; lap++) {
      for (let i = 0; i <= 80; i++) {
        const a = (i / 80) * Math.PI * 2;
        const rr = 700 + Math.sin(a * 4 + lap) * 20 + lap * 2;
        laps.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
    }
    const R = 6378137;
    const DEG = Math.PI / 180;
    const route: Route = {
      id: 'laps',
      name: 'Laps',
      points: laps.map(([x, y]) => ({
        lon: scale2.origin.lon0 + x / (R * DEG * scale2.origin.cosLat0),
        lat: scale2.origin.lat0 + y / (R * DEG),
      })),
      source: 'gpx',
      smoothing: 0,
      distance_m: 0,
      elevationGain_m: null,
      bbox: { west: 0, south: 0, east: 0, north: 0 },
      style: defaultRouteStyle(),
    };

    const built = buildRouteSolid(route, {
      heightfield: hf2,
      scale: scale2,
      selection: null,
      nozzleDiameter_mm: 0.4,
      baseThickness_mm: 3,
    });
    expect(built.mesh.triangles).toBeGreaterThan(0);
    const v = validateMesh(built.mesh.positions, built.mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.manifold).toBe(true);
  });

  it('stays inside the grid cap for a long route', () => {
    const long: Pt[] = [];
    for (let i = 0; i < 4000; i++) long.push([i * 20, Math.sin(i / 50) * 500]);
    const result = buildRibbonField(long, 30);
    expect(result.stats.gridCells).toBeLessThanOrEqual(6_000_000);
    expect(result.polygons.length).toBeGreaterThan(0);
  });
});

describe('normaliseWinding', () => {
  it('makes outer rings counter-clockwise and holes clockwise', () => {
    const cw = [
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
    ] as Array<[number, number]>;
    const hole = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
    ] as Array<[number, number]>;

    const [poly] = normaliseWinding([[cw, hole]]);
    expect(ringArea(poly[0])).toBeGreaterThan(0);
    expect(ringArea(poly[1])).toBeLessThan(0);
  });
});

describe('penetration and width rules', () => {
  it('never penetrates less than 1 mm', () => {
    expect(penetrationFor(0.2)).toBe(1.0);
    expect(penetrationFor(4)).toBe(2);
  });

  // One nozzle, not two: a route is a ridge on solid base, so the slicer lays a
  // single extrusion. Two is the free-standing-wall rule.
  it('sets the minimum printable width at one nozzle', () => {
    expect(minPrintableWidth_mm(0.4)).toBe(0.4);
    expect(minPrintableWidth_mm(0.6)).toBeCloseTo(0.6, 10);
  });
});

/** The whole Stage 6 pipeline against a real synthetic heightfield. */
describe('buildRouteSolid', () => {
  const hf = makeHeightfield(60, 60, (i, j) => 500 + 3 * i + 2 * j + 40 * Math.sin(i / 6));
  const scale = scaleFor(hf);

  function routeFrom(points: Pt[], overrides: Partial<Route['style']> = {}): Route {
    // Convert ENU metres back to lon/lat the cheap way: the builder only needs
    // consistency with scale.origin.
    const R = 6378137;
    const DEG = Math.PI / 180;
    return {
      id: 'r1',
      name: 'Test route',
      points: points.map(([x, y]) => ({
        lon: scale.origin.lon0 + x / (R * DEG * scale.origin.cosLat0),
        lat: scale.origin.lat0 + y / (R * DEG),
      })),
      source: 'gpx',
      smoothing: 0,
      distance_m: 0,
      elevationGain_m: null,
      bbox: { west: 0, south: 0, east: 0, north: 0 },
      style: { ...defaultRouteStyle(), ...overrides },
    };
  }

  const options = {
    heightfield: hf,
    scale,
    selection: null,
    nozzleDiameter_mm: 0.4,
    baseThickness_mm: 3,
  };

  it('produces a watertight, manifold solid', () => {
    const built = buildRouteSolid(routeFrom(straightLine(30, 150)), options);
    expect(built.mesh.triangles).toBeGreaterThan(0);

    const v = validateMesh(built.mesh.positions, built.mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.watertight).toBe(true);
    expect(v.manifold).toBe(true);
    expect(v.inverted).toBe(false);
    expect(signedVolume(built.mesh.positions, built.mesh.indices)).toBeGreaterThan(0);
  });

  /**
   * docs/08-pitfalls.md#route-floats-or-sinks guard: every route vertex bottom
   * must be below the terrain surface at that XY, or the route detaches.
   */
  it('penetrates the terrain everywhere rather than resting on it', () => {
    const built = buildRouteSolid(routeFrom(straightLine(30, 150)), options);
    const p = built.mesh.positions;

    let below = 0;
    let above = 0;
    for (let i = 0; i < p.length; i += 3) {
      const x_mm = p[i];
      const y_mm = p[i + 1];
      const z_mm = p[i + 2];
      const x_m = x_mm / scale.scale;
      const y_m = y_mm / scale.scale;
      const terrain_m = sampleHeightfieldAt(hf, x_m, y_m);
      const terrainZ =
        scale.baseThickness_mm + Math.max(0, (terrain_m - scale.minElevation_m) * scale.zScale);

      if (z_mm < terrainZ - 1e-4) below++;
      else above++;
    }

    // Half the vertices are the draped underside; all of them must be under the
    // terrain surface.
    expect(below).toBeGreaterThan(0);
    expect(above).toBeGreaterThan(0);
    expect(below).toBe(above);
  });

  it('never dips below the build plate', () => {
    const built = buildRouteSolid(routeFrom(straightLine(30, 150)), {
      ...options,
      baseThickness_mm: 0.6,
    });
    const p = built.mesh.positions;
    for (let i = 2; i < p.length; i += 3) expect(p[i]).toBeGreaterThanOrEqual(0);
  });

  /** docs/08-pitfalls.md#unprintable-route-width */
  it('clamps a sub-nozzle width and says so', () => {
    const built = buildRouteSolid(routeFrom(straightLine(20, 150), { width_mm: 0.3 }), options);
    expect(built.stats.widthClamped).toBe(true);
    expect(built.stats.width_mm).toBe(0.4);
  });

  it('leaves a printable width alone', () => {
    const built = buildRouteSolid(routeFrom(straightLine(20, 150), { width_mm: 1.5 }), options);
    expect(built.stats.widthClamped).toBe(false);
    expect(built.stats.width_mm).toBe(1.5);
  });

  it('stays manifold on an out-and-back', () => {
    const there = straightLine(20, 150);
    const back: Pt[] = there.slice().reverse().map(([x, y]) => [x, y + 30] as Pt);
    const built = buildRouteSolid(routeFrom([...there, ...back]), options);
    expect(validateMesh(built.mesh.positions, built.mesh.indices).manifold).toBe(true);
  });

  it('stays manifold on a closed lap, which has a hole', () => {
    const lap: Pt[] = [];
    const R = 1200;
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      lap.push([Math.cos(a) * R, Math.sin(a) * R]);
    }
    const built = buildRouteSolid(routeFrom(lap), options);
    const v = validateMesh(built.mesh.positions, built.mesh.indices);
    expect(v.manifold).toBe(true);
    expect(v.inverted).toBe(false);
  });

  it('reports the length cut away by a selection', () => {
    const line = straightLine(40, 150);
    // A box covering only the middle of the route.
    const half: Array<[number, number]> = [
      [-1000, -500],
      [1000, -500],
      [1000, 500],
      [-1000, 500],
    ];
    const built = buildRouteSolid(routeFrom(line), { ...options, selection: half });
    expect(built.stats.clippedLength_m).toBeGreaterThan(0);
    expect(built.stats.length_m).toBeGreaterThan(0);
  });

  /** docs/08-pitfalls.md#geometry-outside-boundary */
  it('keeps every clipped vertex inside the selection', () => {
    const line = straightLine(40, 150);
    const box: Array<[number, number]> = [
      [-1000, -600],
      [1000, -600],
      [1000, 600],
      [-1000, 600],
    ];
    const built = buildRouteSolid(routeFrom(line), { ...options, selection: box });
    expect(built.mesh.triangles).toBeGreaterThan(0);

    const p = built.mesh.positions;
    let outside = 0;
    for (let i = 0; i < p.length; i += 3) {
      const x_m = p[i] / scale.scale;
      const y_m = p[i + 1] / scale.scale;
      // One cell of slack: the level set is sampled, so the cut edge lands
      // within a cell of the boundary rather than exactly on it.
      if (Math.abs(x_m) > 1000 + 60 || Math.abs(y_m) > 600 + 60) outside++;
    }
    expect(outside).toBe(0);
  });

  it('honours a flat elevation source', () => {
    const built = buildRouteSolid(
      routeFrom(straightLine(20, 150), { elevationSource: 'flat' }),
      options,
    );
    const p = built.mesh.positions;
    const tops = new Set<number>();
    for (let i = 2; i < p.length; i += 3) tops.add(Number(p[i].toFixed(3)));
    // Flat means exactly two distinct Z values: top and bottom.
    expect(tops.size).toBe(2);
  });
});

describe('selection', () => {
  it('turns a circle into an N-gon with at least 128 sides', () => {
    const ring = selectionRingLonLat({ kind: 'circle', lon: 7, lat: 46, radius_m: 5000 });
    expect(ring.length).toBeGreaterThanOrEqual(128);
  });

  it('bounds a circle to a box that contains it', () => {
    const shape = { kind: 'circle', lon: 7, lat: 46, radius_m: 5000 } as const;
    const b = selectionBBox(shape);
    for (const [lon, lat] of selectionRingLonLat(shape)) {
      expect(lon).toBeGreaterThanOrEqual(b.west - 1e-9);
      expect(lon).toBeLessThanOrEqual(b.east + 1e-9);
      expect(lat).toBeGreaterThanOrEqual(b.south - 1e-9);
      expect(lat).toBeLessThanOrEqual(b.north + 1e-9);
    }
  });

  it('fits a padded rectangle around the routes', () => {
    const routes = [
      { bbox: { west: 7, south: 45, east: 8, north: 46 }, style: defaultRouteStyle() },
    ] as unknown as Route[];

    const fitted = fitSelectionToRoutes(routes, 0.15);
    expect(fitted?.kind).toBe('rectangle');
    if (fitted?.kind !== 'rectangle') throw new Error('expected a rectangle');

    expect(fitted.bbox.west).toBeCloseTo(6.85, 6);
    expect(fitted.bbox.east).toBeCloseTo(8.15, 6);
    expect(fitted.bbox.south).toBeCloseTo(44.85, 6);
    expect(fitted.bbox.north).toBeCloseTo(46.15, 6);
  });

  it('still gives a usable area for a route that never moved', () => {
    const routes = [
      { bbox: { west: 7, south: 45, east: 7, north: 45 }, style: defaultRouteStyle() },
    ] as unknown as Route[];
    const fitted = fitSelectionToRoutes(routes);
    if (fitted?.kind !== 'rectangle') throw new Error('expected a rectangle');
    expect(fitted.bbox.east).toBeGreaterThan(fitted.bbox.west);
  });

  it('ignores hidden routes', () => {
    const routes = [
      { bbox: { west: 7, south: 45, east: 8, north: 46 }, style: { ...defaultRouteStyle(), visible: false } },
    ] as unknown as Route[];
    expect(fitSelectionToRoutes(routes)).toBeNull();
  });
});

/**
 * docs/08-pitfalls.md#unclosed-contour-chains — spires standing out of a dense
 * city model. A marching-squares chain that runs out of continuations was still
 * pushed as a ring, which gave it an implicit closing edge from its last point
 * back to its first, right across the feature.
 */
describe('ring closure', () => {
  it('encloses no more area than the band itself covers', () => {
    // A dense, self-touching tangle: the input that makes chains break. A
    // partial chain pushed as a ring encloses a region the band never covered,
    // so total area is the tell.
    const tangle: Pt[] = [];
    let length_m = 0;
    for (let i = 0; i < 900; i++) {
      const t = (i / 900) * Math.PI * 12;
      tangle.push([Math.cos(t) * (300 + Math.sin(t * 3.7) * 130), Math.sin(t * 1.4) * 320]);
      if (i > 0) {
        length_m += Math.hypot(
          tangle[i][0] - tangle[i - 1][0],
          tangle[i][1] - tangle[i - 1][1],
        );
      }
    }

    const width_m = 26;
    const result = buildRibbonField(tangle, width_m);
    expect(result.polygons.length).toBeGreaterThan(0);

    // length x width is a hard upper bound for a band that overlaps itself
    // constantly; the real figure is far lower.
    const area = multiPolygonArea(result.polygons);
    expect(area).toBeGreaterThan(0);
    expect(area).toBeLessThan(length_m * width_m);
  });

  it('keeps a tangle manifold once unclosed chains are dropped', () => {
    const hf3 = makeHeightfield(40, 40, () => 200);
    const scale3 = scaleFor(hf3);
    const tangle: Pt[] = [];
    for (let i = 0; i < 600; i++) {
      const t = (i / 600) * Math.PI * 9;
      tangle.push([Math.cos(t) * (500 + Math.sin(t * 4.3) * 200), Math.sin(t * 1.7) * 480]);
    }
    const R = 6378137;
    const DEG = Math.PI / 180;
    const built = buildRouteSolid(
      {
        id: 'tangle',
        name: 'Tangle',
        points: tangle.map(([x, y]) => ({
          lon: scale3.origin.lon0 + x / (R * DEG * scale3.origin.cosLat0),
          lat: scale3.origin.lat0 + y / (R * DEG),
        })),
        source: 'gpx',
        smoothing: 0,
        distance_m: 0,
        elevationGain_m: null,
        bbox: { west: 0, south: 0, east: 0, north: 0 },
        style: defaultRouteStyle(),
      },
      { heightfield: hf3, scale: scale3, selection: null, nozzleDiameter_mm: 0.4, baseThickness_mm: 3 },
    );

    expect(built.mesh.triangles).toBeGreaterThan(0);
    const v = validateMesh(built.mesh.positions, built.mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.manifold).toBe(true);

    // The spire itself: a blade reaching across the model. Every triangle edge
    // must stay within a few ribbon widths.
    const p = built.mesh.positions;
    const ix = built.mesh.indices;
    const limit_mm = built.stats.width_mm * 8;
    let longest = 0;
    for (let i = 0; i < ix.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = ix[i + e] * 3;
        const b = ix[i + ((e + 1) % 3)] * 3;
        const d = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
        if (d > longest) longest = d;
      }
    }
    expect(longest).toBeLessThan(limit_mm);
  });
});
