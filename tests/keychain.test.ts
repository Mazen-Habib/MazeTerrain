/**
 * Keychain geometry (docs/02-feature-spec.md F13).
 *
 * Two of these tests matter more than the rest. The envelope and the drill are
 * both handed straight to a CSG kernel, and a kernel fed a mesh that is not
 * closed does not throw — it returns something plausible and wrong, which then
 * gets exported and printed. So both are validated as solids here, at sizes and
 * shapes that include the degenerate ones: a rim that is barely thicker than
 * the fillet, and a fillet asked to be larger than the model.
 *
 * The other thing worth pinning is the hole's wall. `placeHole` is allowed to
 * shrink the hole, and the reason it is allowed is that the wall outside it is
 * what stops the keychain tearing off the ring. A regression that quietly
 * preferred the requested diameter would produce tags that break in a pocket,
 * which is exactly the failure this feature exists to avoid.
 */
import { describe, expect, it } from 'vitest';
import {
  FILLET_STEPS,
  buildEnvelope,
  buildHoleTool,
  circleRing,
  isCounterClockwise,
  placeHole,
  roundedSquareRing,
} from '../src/geometry/keychain';
import { validateMesh } from '../src/geometry/validate';
import type { Ring } from '../src/geometry/polygons';

function extent(ring: Ring): { w: number; h: number } {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** A flat rim, the simplest case: every boundary point at the same height. */
function flatRim(ring: Ring, z: number): number[] {
  return ring.map(() => z);
}

describe('outlines', () => {
  it('makes a square of the size asked for', () => {
    const ring = roundedSquareRing(40, 5);
    const { w, h } = extent(ring);
    expect(w).toBeCloseTo(40, 6);
    expect(h).toBeCloseTo(40, 6);
  });

  /**
   * The point of the shape. A sharp corner on a keychain is the one feature
   * that concentrates the whole edge into a point, so if a corner vertex ever
   * lands at (half, half) the rounding has silently stopped happening.
   */
  it('has no vertex at the sharp corner', () => {
    const ring = roundedSquareRing(40, 5);
    for (const [x, y] of ring) {
      expect(Math.hypot(x - 20, y - 20)).toBeGreaterThan(0.5);
    }
  });

  it('degrades to a plain square at zero corner radius', () => {
    expect(roundedSquareRing(40, 0)).toHaveLength(4);
  });

  /** Asking for more corner than there is model must not invert the shape. */
  it('clamps a corner radius larger than the model', () => {
    const ring = roundedSquareRing(40, 999);
    const { w, h } = extent(ring);
    expect(w).toBeLessThanOrEqual(40.0001);
    expect(h).toBeLessThanOrEqual(40.0001);
    expect(isCounterClockwise(ring)).toBe(true);
  });

  it('winds counter-clockwise, which everything downstream assumes', () => {
    expect(isCounterClockwise(roundedSquareRing(40, 5))).toBe(true);
    expect(isCounterClockwise(circleRing(40))).toBe(true);
  });

  it('makes a circle of the diameter asked for', () => {
    const { w, h } = extent(circleRing(40, 256));
    expect(w).toBeCloseTo(40, 1);
    expect(h).toBeCloseTo(40, 1);
  });
});

describe('the ring hole', () => {
  it('sits due north on a circle, inside the margin', () => {
    const { centre, radius, adjusted } = placeHole('circle', 40, 3.5, 1.6, 0);
    expect(adjusted).toBe(false);
    expect(centre[0]).toBeCloseTo(0, 6);
    // Hole edge to model edge is exactly the margin asked for.
    expect(20 - (centre[1] + radius)).toBeCloseTo(1.6, 6);
  });

  it('sits in the corner on a square, inside the margin', () => {
    const size = 40;
    const corner = 5;
    const { centre, radius } = placeHole('square', size, 3.5, 1.6, corner);
    expect(centre[0]).toBeCloseTo(centre[1], 6);
    // Distance from the corner arc's centre, plus the hole radius and the
    // margin, must not exceed the corner radius — that IS the wall.
    const arc = size / 2 - corner;
    const fromArc = Math.hypot(centre[0] - arc, centre[1] - arc);
    expect(fromArc + radius + 1.6).toBeLessThanOrEqual(corner + 1e-6);
  });

  /**
   * The wall wins. An 8 mm hole does not fit a 5 mm corner with 1.6 mm of wall,
   * and the answer is a smaller hole, not a thinner wall.
   */
  it('shrinks the hole rather than the wall, and says it did', () => {
    const { radius, adjusted } = placeHole('square', 40, 8, 1.6, 5);
    expect(adjusted).toBe(true);
    expect(radius * 2).toBeLessThan(8);
    expect(radius).toBeGreaterThan(0);
  });

  /**
   * The shipped defaults must not warn.
   *
   * They did: the first version of this constraint was conservative by a factor
   * of two, so a 3.5 mm hole in a 5 mm corner was refused when it fits with
   * 1.65 mm to spare. A warning that fires on settings nobody chose is how
   * people learn to ignore warnings.
   */
  it('fits the default hole in the default corner without complaint', () => {
    const { adjusted, radius } = placeHole('square', 40, 3.5, 1.6, 40 * 0.125);
    expect(adjusted).toBe(false);
    expect(radius).toBeCloseTo(1.75, 6);
  });

  /** The straight edges have to clear too, not just the corner arc. */
  it('keeps the margin against the straight edges as well', () => {
    for (const d of [2, 3, 3.5, 5, 6.5]) {
      const size = 40;
      const corner = 6;
      const { centre, radius } = placeHole('square', size, d, 1.6, corner);
      const toRightEdge = size / 2 - centre[0] - radius;
      const toTopEdge = size / 2 - centre[1] - radius;
      expect(toRightEdge).toBeGreaterThanOrEqual(1.6 - 1e-6);
      expect(toTopEdge).toBeGreaterThanOrEqual(1.6 - 1e-6);
    }
  });

  it('never returns a zero or negative radius, however impossible the ask', () => {
    for (const margin of [1.6, 10, 100]) {
      for (const size of [40, 12, 4]) {
        const { radius } = placeHole('square', size, 3.5, margin, size / 8);
        expect(radius).toBeGreaterThan(0);
      }
    }
  });
});

describe('the envelope', () => {
  const cases: Array<[string, Ring]> = [
    ['circle', circleRing(40, 128)],
    ['rounded square', roundedSquareRing(40, 5)],
    ['plain square', roundedSquareRing(40, 0)],
  ];

  it.each(cases)('is a closed solid for a %s outline', (_name, ring) => {
    const mesh = buildEnvelope({
      boundary_mm: ring,
      rimZ_mm: flatRim(ring, 4),
      edgeRadius_mm: 0.8,
      capZ_mm: 9,
    });
    const v = validateMesh(mesh.positions, mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.watertight).toBe(true);
    expect(v.inverted).toBe(false);
    expect(v.volume_mm3).toBeGreaterThan(0);
  });

  /**
   * A rim that varies is the real case — the top of the wall follows the
   * terrain, which is why this is an envelope and not a chamfered box.
   */
  it('is a closed solid when the rim rises and falls', () => {
    const ring = circleRing(40, 96);
    const rim = ring.map((_, i) => 2.2 + 2 * Math.abs(Math.sin((i / 96) * Math.PI * 3)));
    const mesh = buildEnvelope({ boundary_mm: ring, rimZ_mm: rim, edgeRadius_mm: 0.8, capZ_mm: 9 });
    const v = validateMesh(mesh.positions, mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.inverted).toBe(false);
  });

  /**
   * The degenerate case that motivated MAX_FILLET_FRACTION. A 2 mm rim with a
   * 5 mm fillet asked for would, unclamped, put the top fillet below the bottom
   * one and fold the profile back on itself.
   */
  it('survives a fillet larger than the rim is tall', () => {
    const ring = roundedSquareRing(40, 5);
    const mesh = buildEnvelope({
      boundary_mm: ring,
      rimZ_mm: flatRim(ring, 2),
      edgeRadius_mm: 5,
      capZ_mm: 9,
    });
    const v = validateMesh(mesh.positions, mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.inverted).toBe(false);
  });

  /**
   * The fillet has to actually be there. At z=0 the envelope must be INSIDE the
   * outline by the fillet radius, or the base edge is still a 90 degree arris
   * and the feature has done nothing.
   */
  it('pulls the base in by the fillet radius', () => {
    const ring = circleRing(40, 128);
    const r = 0.8;
    const mesh = buildEnvelope({
      boundary_mm: ring,
      rimZ_mm: flatRim(ring, 4),
      edgeRadius_mm: r,
      capZ_mm: 9,
    });

    let maxAtBase = 0;
    let maxAtFilletTop = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const d = Math.hypot(mesh.positions[i]!, mesh.positions[i + 1]!);
      const z = mesh.positions[i + 2]!;
      if (z < 1e-6) maxAtBase = Math.max(maxAtBase, d);
      // Where the bottom fillet ends and the straight wall begins. Sampling
      // mid-wall finds nothing: a straight run needs no vertices between its
      // ends, so the profile has none there.
      if (Math.abs(z - r) < 1e-6) maxAtFilletTop = Math.max(maxAtFilletTop, d);
    }
    expect(maxAtBase).toBeCloseTo(20 - r, 1);
    // Once the fillet is done the wall is at full width, or the envelope would
    // be shaving the model everywhere rather than at its edges.
    expect(maxAtFilletTop).toBeCloseTo(20, 1);
  });

  it('caps above the tallest thing it is asked to contain', () => {
    const ring = circleRing(40, 64);
    const mesh = buildEnvelope({
      boundary_mm: ring,
      rimZ_mm: flatRim(ring, 4),
      edgeRadius_mm: 0.8,
      capZ_mm: 12,
    });
    let top = -Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) top = Math.max(top, mesh.positions[i]!);
    expect(top).toBeGreaterThanOrEqual(12);
  });

  it('rejects a rim height list that does not match the outline', () => {
    expect(() =>
      buildEnvelope({
        boundary_mm: circleRing(40, 64),
        rimZ_mm: [1, 2, 3],
        edgeRadius_mm: 0.8,
        capZ_mm: 9,
      }),
    ).toThrow(/one rim height per boundary point/);
  });

  it('builds the profile at the documented resolution', () => {
    const ring = circleRing(40, 64);
    const mesh = buildEnvelope({
      boundary_mm: ring,
      rimZ_mm: flatRim(ring, 4),
      edgeRadius_mm: 0.8,
      capZ_mm: 9,
    });
    // Two quarter-circles plus the cap point, one column per outline point.
    const steps = 2 * (FILLET_STEPS + 1) + 1;
    expect(mesh.positions.length / 3).toBe(64 * steps);
  });
});

describe('the drill', () => {
  it('is a closed solid', () => {
    const mesh = buildHoleTool([5, 5], 1.75, -1, 10);
    const v = validateMesh(mesh.positions, mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.watertight).toBe(true);
    expect(v.inverted).toBe(false);
  });

  /**
   * Overshoot is deliberate: a cutter that stops exactly on the face it is
   * cutting leaves coplanar geometry, which is the standard way to make a
   * boolean kernel produce a hole that is nearly, but not quite, through.
   */
  it('overshoots the range it is given', () => {
    const mesh = buildHoleTool([0, 0], 1.75, -1, 10);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      lo = Math.min(lo, mesh.positions[i]!);
      hi = Math.max(hi, mesh.positions[i]!);
    }
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(9);
  });

  it('is round to within a tenth of a millimetre', () => {
    const r = 1.75;
    const mesh = buildHoleTool([3, -2], r, 0, 5, 64);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const d = Math.hypot(mesh.positions[i]! - 3, mesh.positions[i + 1]! + 2);
      expect(d).toBeCloseTo(r, 1);
    }
  });
});
