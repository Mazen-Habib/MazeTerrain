/**
 * Elevation profile strip (docs/02-feature-spec.md F11).
 *
 * The chart is the feature, so the chart is what is tested: does the silhouette
 * put the peaks where the route climbs, does it read left to right in distance
 * rather than in point index, and does the bar actually join the model rather
 * than touch it at a point.
 */
import { describe, expect, it } from 'vitest';
import {
  buildProfileStrip,
  profilePolygon,
  profileStats,
  sampleProfile,
  type ProfileSample,
} from '../src/geometry/profile';
import { validateMesh } from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from './helpers';
import type { Ring } from '../src/geometry/polygons';

const bbox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };

/** A ramp running west to east: elevation depends on x alone. */
function ramp(cells = 100, spacing = 50) {
  return makeHeightfield(cells, cells, (i) => 100 + i * 10, spacing);
}

/** A circular model boundary in world metres. */
function disc(radius_m: number, points = 180): Ring {
  return Array.from({ length: points }, (_, i) => {
    const a = (i / points) * Math.PI * 2;
    return [Math.cos(a) * radius_m, Math.sin(a) * radius_m] as [number, number];
  });
}

describe('sampleProfile', () => {
  const hf = ramp();

  it('samples the DEM along the route', () => {
    const route: Array<[number, number]> = [
      [-1000, 0],
      [1000, 0],
    ];
    const samples = sampleProfile(route, hf, 5);
    expect(samples).toHaveLength(5);
    // A west-to-east line across a west-to-east ramp climbs the whole way.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].elevation_m).toBeGreaterThan(samples[i - 1].elevation_m);
    }
  });

  it('spaces samples evenly by DISTANCE, not by point index', () => {
    // Points bunched at the start: eleven in the first tenth, two after.
    const route: Array<[number, number]> = [];
    for (let i = 0; i <= 10; i++) route.push([-1000 + i * 20, 0]);
    route.push([1000, 0]);

    const samples = sampleProfile(route, hf, 9);
    const steps = samples.slice(1).map((s, i) => s.distance_m - samples[i].distance_m);
    for (const step of steps) expect(step).toBeCloseTo(steps[0], 6);
  });

  it('starts at zero and ends at the route length', () => {
    const samples = sampleProfile(
      [
        [0, 0],
        [300, 400],
      ],
      hf,
      10,
    );
    expect(samples[0].distance_m).toBe(0);
    expect(samples[samples.length - 1].distance_m).toBeCloseTo(500, 6);
  });

  it('gives nothing for a route that is not a line', () => {
    expect(sampleProfile([], hf)).toEqual([]);
    expect(sampleProfile([[0, 0]], hf)).toEqual([]);
    // Two points in the same place have no length to sample along.
    expect(
      sampleProfile(
        [
          [5, 5],
          [5, 5],
        ],
        hf,
      ),
    ).toEqual([]);
  });
});

describe('profileStats', () => {
  const make = (elevations: number[]): ProfileSample[] =>
    elevations.map((elevation_m, i) => ({ distance_m: i * 100, elevation_m }));

  it('reports range, length and climb', () => {
    const stats = profileStats(make([100, 150, 120, 200]))!;
    expect(stats.range_m).toEqual([100, 200]);
    expect(stats.distance_m).toBe(300);
    // Up 50, down 30, up 80 — the descent does not count.
    expect(stats.gain_m).toBe(130);
  });

  it('counts no climb on a descent', () => {
    expect(profileStats(make([500, 400, 300]))!.gain_m).toBe(0);
  });

  it('has nothing to say about a single point', () => {
    expect(profileStats(make([100]))).toBeNull();
    expect(profileStats([])).toBeNull();
  });
});

describe('profilePolygon', () => {
  const samples: ProfileSample[] = [
    { distance_m: 0, elevation_m: 100 },
    { distance_m: 50, elevation_m: 300 },
    { distance_m: 100, elevation_m: 200 },
  ];

  it('spans the full width and depth given', () => {
    const ring = profilePolygon(samples, 80, 12);
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(80, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(12, 6);
  });

  /** The point of the chart: the tall bit must be where the route is high. */
  it('puts the peak where the route peaks', () => {
    const ring = profilePolygon(samples, 100, 10);
    const highest = ring.reduce((best, p) => (p[1] > best[1] ? p : best));
    // The summit is halfway along the route, so halfway along the bar.
    expect(highest[0]).toBeCloseTo(50, 6);
  });

  it('closes back along the baseline so the silhouette is a solid shape', () => {
    const ring = profilePolygon(samples, 100, 10);
    expect(ring[ring.length - 2]).toEqual([100, 0]);
    expect(ring[ring.length - 1]).toEqual([0, 0]);
  });

  /**
   * A flat route would otherwise map every point to zero height and produce a
   * degenerate sliver. A plain rectangle is the honest picture of flat ground.
   */
  it('draws a flat route as a full-depth bar, not a zero-height sliver', () => {
    const flat = profilePolygon(
      [
        { distance_m: 0, elevation_m: 42 },
        { distance_m: 100, elevation_m: 42 },
      ],
      100,
      10,
    );
    expect(Math.max(...flat.map((p) => p[1]))).toBeCloseTo(10, 6);
  });

  it('gives nothing when there is no room to draw', () => {
    expect(profilePolygon(samples, 0, 10)).toEqual([]);
    expect(profilePolygon(samples, 100, 0)).toEqual([]);
    expect(profilePolygon([samples[0]], 100, 10)).toEqual([]);
  });
});

describe('buildProfileStrip', () => {
  const hf = ramp();
  const scale = scaleFor(hf, { bbox, baseThickness_mm: 3 });
  const radius_m = ((100 - 1) * hf.spacingX_m) / 2;
  const ring = disc(radius_m);
  const route: Array<[number, number]> = [
    [-radius_m * 0.8, -radius_m * 0.3],
    [0, radius_m * 0.4],
    [radius_m * 0.8, -radius_m * 0.2],
  ];
  const options = {
    depth_mm: 14,
    height_mm: 1.2,
    overlap_mm: 3,
    baseThickness_mm: 3,
    scale,
  };

  const built = buildProfileStrip(route, ring, hf, options);

  it('builds a solid with the climb measured off the DEM', () => {
    expect(built.mesh.triangles).toBeGreaterThan(0);
    expect(built.stats).not.toBeNull();
    expect(built.stats!.gain_m).toBeGreaterThan(0);
    expect(built.top_mm).toBeCloseTo(4.2, 6);
  });

  /**
   * The reason the bar is pushed into the boundary at all: a straight edge
   * touches a circle at ONE POINT, and a joint with no area is not a joint.
   */
  it('overlaps the model instead of touching it at a tangent', () => {
    let minY_mm = Infinity;
    let maxY_mm = -Infinity;
    for (let i = 1; i < built.mesh.positions.length; i += 3) {
      const y = built.mesh.positions[i];
      if (y < minY_mm) minY_mm = y;
      if (y > maxY_mm) maxY_mm = y;
    }
    const modelBottom_mm = -radius_m * scale.scale;

    // The bar reaches past the model's lowest point, into the disc.
    expect(maxY_mm).toBeGreaterThan(modelBottom_mm);
    expect(maxY_mm - modelBottom_mm).toBeCloseTo(options.overlap_mm, 3);
    // And extends the full depth below it.
    expect(maxY_mm - minY_mm).toBeCloseTo(options.depth_mm, 3);
  });

  it('sits on the build plate and rises to the ridge top', () => {
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 2; i < built.mesh.positions.length; i += 3) {
      const z = built.mesh.positions[i];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    expect(minZ).toBeCloseTo(0, 6);
    expect(maxZ).toBeCloseTo(built.top_mm, 6);
  });

  /**
   * The plate and the ridge are separate prisms that overlap in Z. They must
   * not meet on a shared plane: coincident coplanar faces are the documented
   * road to a non-manifold export (08-pitfalls.md#non-manifold-export).
   */
  it('keeps both prisms closed, with the ridge reaching the plate', () => {
    const validation = validateMesh(built.mesh.positions, built.mesh.indices);
    expect(validation.openEdges).toBe(0);
    expect(validation.nonManifoldEdges).toBe(0);

    // The ridge starts at z = 0, inside the plate, not resting on its top face.
    let ridgeBottom = Infinity;
    for (let i = 2; i < built.mesh.positions.length; i += 3) {
      const z = built.mesh.positions[i];
      if (z > options.baseThickness_mm - 1e-6) continue;
      ridgeBottom = Math.min(ridgeBottom, z);
    }
    expect(ridgeBottom).toBeCloseTo(0, 6);
  });

  it('declines rather than guessing when there is no route', () => {
    const none = buildProfileStrip([], ring, hf, options);
    expect(none.mesh.triangles).toBe(0);
    expect(none.stats).toBeNull();
  });

  it('declines when the strip has no size', () => {
    expect(buildProfileStrip(route, ring, hf, { ...options, depth_mm: 0 }).mesh.triangles).toBe(0);
    expect(buildProfileStrip(route, ring, hf, { ...options, height_mm: 0 }).mesh.triangles).toBe(0);
  });
});

/**
 * The route that leaves the model (found 2026-08-30, by looking at a build).
 *
 * `sampleHeightfieldAt` clamps outside the grid, so a route running past the
 * selection sampled the edge value over and over and drew a dead-flat plateau
 * across a third of the bar. It looked exactly like real flat ground — the
 * worst kind of wrong, because nothing about it says "no data".
 */
describe('a route that runs outside the selection', () => {
  const hf = ramp();
  const radius_m = ((100 - 1) * hf.spacingX_m) / 2;
  const ring = disc(radius_m);

  // Starts far outside the disc to the west, ends inside it.
  const overhanging: Array<[number, number]> = [
    [-radius_m * 4, 0],
    [radius_m * 0.5, 0],
  ];

  it('charts only the part that is on the model', () => {
    const all = sampleProfile(overhanging, hf, 60);
    const trimmed = sampleProfile(overhanging, hf, 60, ring);

    expect(all.length).toBe(60);
    expect(trimmed.length).toBeGreaterThan(1);
    expect(trimmed.length).toBeLessThan(all.length);

    // Every sample kept is inside the boundary.
    for (const s of trimmed) {
      expect(s.inside).toBe(true);
    }
  });

  it('leaves no flat plateau where the DEM was clamped', () => {
    const trimmed = sampleProfile(overhanging, hf, 60, ring);
    // On a west-to-east ramp, every kept sample must still be climbing. A
    // clamped stretch shows as consecutive identical elevations.
    let repeats = 0;
    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed[i].elevation_m === trimmed[i - 1].elevation_m) repeats++;
    }
    expect(repeats).toBe(0);
  });

  it('re-bases distance so the chart starts at zero', () => {
    const trimmed = sampleProfile(overhanging, hf, 60, ring);
    expect(trimmed[0].distance_m).toBe(0);
    expect(trimmed[trimmed.length - 1].distance_m).toBeGreaterThan(0);
  });

  it('reports how much of the route it managed to cover', () => {
    const stats = profileStats(sampleProfile(overhanging, hf, 60, ring))!;
    expect(stats.covered).toBeGreaterThan(0);
    expect(stats.covered).toBeLessThan(0.5);
  });

  it('covers all of a route that stays inside', () => {
    const inside: Array<[number, number]> = [
      [-radius_m * 0.5, 0],
      [radius_m * 0.5, 0],
    ];
    const stats = profileStats(sampleProfile(inside, hf, 60, ring))!;
    expect(stats.covered).toBeCloseTo(1, 1);
  });

  it('gives nothing when the route misses the model entirely', () => {
    const away: Array<[number, number]> = [
      [radius_m * 3, radius_m * 3],
      [radius_m * 4, radius_m * 4],
    ];
    expect(sampleProfile(away, hf, 60, ring)).toEqual([]);
  });
});
