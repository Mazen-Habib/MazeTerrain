/**
 * Picture frame (docs/02-feature-spec.md F5).
 *
 * The claims worth holding: it is a closed solid, it runs INSIDE the boundary
 * so the model stays the size it was asked for, it works for a shape that is
 * not a rectangle, and it says something when the terrain stands over it.
 */
import { describe, expect, it } from 'vitest';
import { buildFrame, frameSubmersion } from '../src/geometry/frame';
import { validateMesh, weldVertices } from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from './helpers';
import type { Ring } from '../src/geometry/polygons';

const hf = makeHeightfield(60, 60, () => 500);
const scale = scaleFor(hf);

/** The model's own boundary in world metres, as a rectangle. */
function boxRing(half_m: number): Ring {
  return [
    [-half_m, -half_m],
    [half_m, -half_m],
    [half_m, half_m],
    [-half_m, half_m],
  ];
}

function circleRing(radius_m: number, n = 96): Ring {
  const ring: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([Math.cos(a) * radius_m, Math.sin(a) * radius_m]);
  }
  return ring;
}

const half_m = ((60 - 1) * hf.spacingX_m) / 2;
const options = { width_mm: 8, height_mm: 3, baseThickness_mm: 3, scale };

function zRange(positions: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    lo = Math.min(lo, positions[i]);
    hi = Math.max(hi, positions[i]);
  }
  return [lo, hi];
}

function xyExtent(positions: Float32Array): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    lo = Math.min(lo, positions[i]);
    hi = Math.max(hi, positions[i]);
  }
  return hi - lo;
}

describe('buildFrame', () => {
  const built = buildFrame(boxRing(half_m), options);

  it('is a closed, manifold solid', () => {
    expect(built.mesh.triangles).toBeGreaterThan(0);
    const v = validateMesh(built.mesh.positions, built.mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  /** Everything downstream welds; a rim that only survives unwelded is no use. */
  it('stays manifold through a positional weld', () => {
    const w = weldVertices(built.mesh.positions, built.mesh.indices);
    expect(validateMesh(w.positions, w.indices).manifold).toBe(true);
  });

  it('runs from the build plate to the height it was asked for', () => {
    const [lo, hi] = zRange(built.mesh.positions);
    expect(lo).toBeCloseTo(0, 4);
    // Above the LOWEST ground, which sits on top of the base slab.
    expect(hi).toBeCloseTo(options.baseThickness_mm + options.height_mm, 4);
    expect(built.top_mm).toBeCloseTo(hi, 4);
  });

  /**
   * It was built INSIDE first, so that `modelWidth_mm` stayed literally the
   * longest edge of the print. That was the wrong trade: a 12.5 mm frame ate a
   * quarter of the map on every side. The map keeps its size and the frame is
   * added around it, exactly as a frame surrounds a picture.
   */
  it('is added outside the boundary, so the map keeps its full size', () => {
    const modelExtent = half_m * 2 * scale.scale;
    expect(xyExtent(built.mesh.positions)).toBeCloseTo(modelExtent + options.width_mm * 2, 1);
  });

  it('leaves the whole map open, taking nothing out of the middle', () => {
    // The band's inner edge is the boundary itself: nothing reaches inside it.
    let nearest = Infinity;
    const p = built.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      nearest = Math.min(nearest, Math.max(Math.abs(p[i]), Math.abs(p[i + 1])));
    }
    expect(nearest).toBeCloseTo(half_m * scale.scale, 1);
  });

  it('frames a circle as readily as a box', () => {
    const round = buildFrame(circleRing(half_m * 0.9), options);
    expect(round.mesh.triangles).toBeGreaterThan(0);
    expect(validateMesh(round.mesh.positions, round.mesh.indices).manifold).toBe(true);
  });

  it('gets wider when asked, without getting taller', () => {
    const wide = buildFrame(boxRing(half_m), { ...options, width_mm: 16 });
    const countRing = (m: Float32Array) => m.length;
    expect(countRing(wide.mesh.positions)).toBeGreaterThan(0);
    expect(zRange(wide.mesh.positions)[1]).toBeCloseTo(zRange(built.mesh.positions)[1], 4);

    // A wider band reaches further OUT, and its inner edge does not move.
    expect(xyExtent(wide.mesh.positions)).toBeGreaterThan(xyExtent(built.mesh.positions));
  });

  /**
   * A distance-field level set is a true parallel offset, which rounds every
   * convex corner. A rectangular map came out with rounded outer corners
   * against square inner ones — not what a picture frame looks like.
   */
  it('carries a square corner to a point instead of rounding it', () => {
    const corner = half_m * scale.scale + options.width_mm;
    let furthest = 0;
    const p = built.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      furthest = Math.max(furthest, Math.hypot(p[i], p[i + 1]));
    }
    // A mitred corner reaches the full diagonal; a rounded one falls short of it
    // by (sqrt(2) - 1) x width, which is 3.3 mm on this frame.
    expect(furthest).toBeCloseTo(Math.hypot(corner, corner), 1);
  });

  it('agrees with a true offset on a circle, where there are no corners to mitre', () => {
    const radius = half_m * 0.9;
    const round = buildFrame(circleRing(radius), options);
    let furthest = 0;
    const p = round.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      furthest = Math.max(furthest, Math.hypot(p[i], p[i + 1]));
    }
    expect(furthest).toBeCloseTo(radius * scale.scale + options.width_mm, 0);
  });

  it('builds nothing rather than something wrong when it is switched off', () => {
    expect(buildFrame(boxRing(half_m), { ...options, width_mm: 0 }).mesh.triangles).toBe(0);
    expect(buildFrame(boxRing(half_m), { ...options, height_mm: 0 }).mesh.triangles).toBe(0);
    expect(buildFrame([[0, 0], [1, 1]], options).mesh.triangles).toBe(0);
  });
});

describe('frameSubmersion', () => {
  const ring = boxRing(half_m);

  const step_m = half_m / 40;

  it('reports nothing when the ground is below the rim', () => {
    const result = frameSubmersion(ring, () => 4, 6, step_m);
    expect(result.fraction).toBe(0);
    expect(result.worst_mm).toBe(0);
  });

  it('reports the share of the edge the ground stands over, and by how much', () => {
    // The eastern half of the boundary is above a 6 mm rim.
    const groundZ = (x_m: number) => (x_m > 0 ? 9 : 2);
    const result = frameSubmersion(ring, groundZ, 6, step_m);

    expect(result.fraction).toBeCloseTo(0.5, 1);
    expect(result.worst_mm).toBeCloseTo(3, 6);
  });

  /**
   * The bug this replaces: a rectangular selection is a ring of four points, so
   * sampling only the ring's vertices tested the four corners of the model and
   * called an entirely buried edge clear.
   */
  it('samples along each edge, not just at its corners', () => {
    // High only in the middle of each side — no corner sees it.
    const groundZ = (x_m: number, y_m: number) =>
      Math.abs(x_m) < half_m * 0.5 || Math.abs(y_m) < half_m * 0.5 ? 9 : 2;

    expect(frameSubmersion(ring, groundZ, 6, step_m).fraction).toBeGreaterThan(0.3);
    // With one sample per edge, every one of them lands on a corner and misses it.
    expect(frameSubmersion(ring, groundZ, 6, half_m * 4).fraction).toBe(0);
  });

  it('handles an empty boundary without dividing by zero', () => {
    expect(frameSubmersion([], () => 10, 1, step_m)).toEqual({ fraction: 0, worst_mm: 0 });
  });
});
