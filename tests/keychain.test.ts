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
  roundedRectRing,
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

/** Distance from a point to the nearest outline segment. */
function toOutline(ring: Ring, [px, py]: [number, number]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % ring.length]!;
    const dx = bx - ax;
    const dy = by - ay;
    const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(px - (ax + dx * u), py - (ay + dy * u)));
  }
  return best;
}

/** Material between the hole and the outside, which must be at least the margin. */
function wall(ring: Ring, hole: { centre: [number, number]; radius: number }): number {
  return toOutline(ring, hole.centre) - hole.radius;
}

describe('the ring hole', () => {
  it('sits due north on a circle, with exactly the margin outside it', () => {
    const ring = circleRing(40, 192);
    const hole = placeHole(ring, 'north', 3.5, 1.6);
    expect(hole.adjusted).toBe(false);
    expect(hole.centre[0]).toBeCloseTo(0, 6);
    expect(hole.centre[1]).toBeGreaterThan(14);
    expect(wall(ring, hole)).toBeGreaterThanOrEqual(1.6 - 1e-6);
    expect(wall(ring, hole)).toBeLessThan(1.6 + 0.01);
  });

  it('hugs the corner on a rounded square, with exactly the margin outside it', () => {
    const ring = roundedSquareRing(40, 5);
    const hole = placeHole(ring, 'corner', 3.5, 1.6);
    expect(hole.centre[0]).toBeCloseTo(hole.centre[1], 6);
    expect(hole.centre[0]).toBeGreaterThan(14);
    expect(wall(ring, hole)).toBeGreaterThanOrEqual(1.6 - 1e-6);
    expect(wall(ring, hole)).toBeLessThan(1.6 + 0.01);
  });

  /**
   * The bug this placement was rewritten for.
   *
   * A circle selection with the outline setting still on Square: the old code
   * computed a square's corner, (16.2, 16.2), which is 22.9 mm from the middle
   * of a 40 mm disc — outside it. The drill cut nothing and the tag shipped
   * with no hole and no warning. Asked for a corner on a disc, it must still
   * land inside with its wall.
   */
  it('lands inside a circle even when asked for a corner', () => {
    const ring = circleRing(40, 192);
    const hole = placeHole(ring, 'corner', 3.5, 1.6);
    expect(Math.hypot(...hole.centre)).toBeLessThan(20 - 1.6 - 1.75 + 1e-6);
    expect(wall(ring, hole)).toBeGreaterThanOrEqual(1.6 - 1e-6);
  });

  /** A route fitted with a rectangle is rarely square. */
  it('finds the corner of a wide rounded rectangle', () => {
    const ring = roundedRectRing(60, 30, 5);
    const hole = placeHole(ring, 'corner', 3.5, 1.6);
    expect(hole.centre[0]).toBeGreaterThan(24);
    expect(hole.centre[1]).toBeGreaterThan(9);
    expect(wall(ring, hole)).toBeGreaterThanOrEqual(1.6 - 1e-6);
  });

  it('works in the sharp corner of a plain square', () => {
    const ring = roundedSquareRing(40, 0);
    const hole = placeHole(ring, 'corner', 3.5, 1.6);
    expect(hole.adjusted).toBe(false);
    expect(wall(ring, hole)).toBeGreaterThanOrEqual(1.6 - 1e-6);
    expect(wall(ring, hole)).toBeLessThan(1.6 + 0.01);
  });

  /**
   * A hole too big for the corner moves inward; it keeps its size and its wall.
   * Shrinking a hole that has room elsewhere would be refusing the user's size
   * for nothing.
   */
  it('moves a big hole inward rather than shrinking it', () => {
    const ring = roundedSquareRing(40, 5);
    const hole = placeHole(ring, 'corner', 8, 1.6);
    expect(hole.adjusted).toBe(false);
    expect(hole.radius).toBeCloseTo(4, 6);
    expect(wall(ring, hole)).toBeGreaterThanOrEqual(1.6 - 1e-6);
  });

  /** The wall wins when the model itself is too small: a smaller hole, not a thinner wall. */
  it('shrinks the hole rather than the wall, and says it did', () => {
    const ring = circleRing(10, 192);
    const hole = placeHole(ring, 'north', 8, 1.6);
    expect(hole.adjusted).toBe(true);
    expect(hole.radius * 2).toBeLessThan(8);
    expect(wall(ring, hole)).toBeGreaterThanOrEqual(1.6 - 1e-3);
  });

  /** The shipped defaults must not warn — a warning on settings nobody chose teaches people to ignore warnings. */
  it('fits the default hole in the default corner without complaint', () => {
    const hole = placeHole(roundedSquareRing(40, 40 * 0.125), 'corner', 3.5, 1.6);
    expect(hole.adjusted).toBe(false);
    expect(hole.radius).toBeCloseTo(1.75, 6);
  });

  it('never returns a zero or negative radius, however impossible the ask', () => {
    for (const margin of [1.6, 10, 100]) {
      for (const size of [40, 12, 4]) {
        for (const ring of [roundedSquareRing(size, size / 8), circleRing(size)]) {
          expect(placeHole(ring, 'corner', 3.5, margin).radius).toBeGreaterThan(0);
        }
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
