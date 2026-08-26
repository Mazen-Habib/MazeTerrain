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
   * The reason it is built inside rather than outside: modelWidth_mm is
   * documented as the longest edge of the printed model, and a frame added
   * outside would quietly make a 100 mm model 116 mm.
   */
  it('stays inside the boundary, so the model does not grow', () => {
    const modelExtent = half_m * 2 * scale.scale;
    expect(xyExtent(built.mesh.positions)).toBeLessThanOrEqual(modelExtent + 1e-3);
  });

  it('leaves the middle of the model open', () => {
    // Nothing within the frame's own width of the centre.
    let nearest = Infinity;
    const p = built.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      nearest = Math.min(nearest, Math.hypot(p[i], p[i + 1]));
    }
    const modelHalf = half_m * scale.scale;
    expect(nearest).toBeGreaterThan(modelHalf - options.width_mm * 2);
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

    // A wider band reaches further in.
    let wideNearest = Infinity;
    for (let i = 0; i < wide.mesh.positions.length; i += 3) {
      wideNearest = Math.min(wideNearest, Math.hypot(wide.mesh.positions[i], wide.mesh.positions[i + 1]));
    }
    let narrowNearest = Infinity;
    for (let i = 0; i < built.mesh.positions.length; i += 3) {
      narrowNearest = Math.min(narrowNearest, Math.hypot(built.mesh.positions[i], built.mesh.positions[i + 1]));
    }
    expect(wideNearest).toBeLessThan(narrowNearest);
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
