import { describe, expect, it } from 'vitest';
import { buildClippedTerrainMesh, coarsenRing } from '../src/geometry/terrainClip';
import { validateMesh, signedVolume, repairAndValidate } from '../src/geometry/validate';
import { selectionRingWorld } from '../src/geometry/selection';
import type { Ring } from '../src/geometry/polygons';
import { boundsOf, makeHeightfield, scaleFor } from './helpers';

/** A circle in world metres, centred on the model origin. */
function circle(radius_m: number, segments = 192): Ring {
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    ring.push([Math.cos(a) * radius_m, Math.sin(a) * radius_m]);
  }
  return ring;
}

function hexagon(radius_m: number): Ring {
  const ring: Ring = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ring.push([Math.cos(a) * radius_m, Math.sin(a) * radius_m]);
  }
  return ring;
}

const hf = makeHeightfield(61, 61, (i, j) => 500 + 120 * Math.sin(i / 7) * Math.cos(j / 6) + 3 * i);
const scale = scaleFor(hf);
// The grid spans 60 * 100 m = 6000 m, so a 2000 m radius sits well inside it.
const RADIUS_M = 2000;

describe('buildClippedTerrainMesh', () => {
  const mesh = buildClippedTerrainMesh(hf, scale, circle(RADIUS_M));

  it('produces a watertight, manifold solid', () => {
    const v = validateMesh(mesh.positions, mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.watertight).toBe(true);
    expect(v.manifold).toBe(true);
  });

  it('is not inside-out', () => {
    expect(signedVolume(mesh.positions, mesh.indices)).toBeGreaterThan(0);
    expect(validateMesh(mesh.positions, mesh.indices).inverted).toBe(false);
  });

  /**
   * docs/08-pitfalls.md#geometry-outside-boundary — the whole point. Clipping the
   * top surface but leaving the walls on the original rectangle is what leaves a
   * rectangular fringe on a circular model.
   */
  it('keeps every vertex inside the boundary, walls and base included', () => {
    const p = mesh.positions;
    const limit_mm = (RADIUS_M + Math.max(hf.spacingX_m, hf.spacingY_m)) * scale.scale;

    let outside = 0;
    for (let i = 0; i < p.length; i += 3) {
      if (Math.hypot(p[i], p[i + 1]) > limit_mm + 1e-6) outside++;
    }
    expect(outside).toBe(0);
  });

  it('has a round footprint rather than the grid rectangle', () => {
    const b = boundsOf(mesh.positions);
    const width = b.maxX - b.minX;
    const height = b.maxY - b.minY;
    expect(width / height).toBeCloseTo(1, 1);

    // A circle of this radius covers pi/4 of its bounding square. Sample the
    // footprint corners: they must be empty.
    const p = mesh.positions;
    let inCorner = 0;
    const r_mm = RADIUS_M * scale.scale;
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(p[i]) > r_mm * 0.9 && Math.abs(p[i + 1]) > r_mm * 0.9) inCorner++;
    }
    expect(inCorner).toBe(0);
  });

  it('still seats the base on z = 0 and the terrain above it', () => {
    const b = boundsOf(mesh.positions);
    expect(b.minZ).toBe(0);
    expect(b.maxZ).toBeGreaterThan(scale.baseThickness_mm);
  });

  it('needs no repair', () => {
    const repaired = repairAndValidate(mesh.positions, mesh.indices);
    expect(repaired.merged).toBe(0);
    expect(repaired.validation.manifold).toBe(true);
  });
});

describe('other selection shapes', () => {
  it('clips to a hexagon', () => {
    const mesh = buildClippedTerrainMesh(hf, scale, hexagon(RADIUS_M));
    expect(validateMesh(mesh.positions, mesh.indices).manifold).toBe(true);
  });

  it('clips to a concave freehand polygon', () => {
    // An L-shape: the case where a fan base or a convex assumption falls over.
    const l: Ring = [
      [-2000, -2000],
      [2000, -2000],
      [2000, -400],
      [0, -400],
      [0, 2000],
      [-2000, 2000],
    ];
    const mesh = buildClippedTerrainMesh(hf, scale, l);
    const v = validateMesh(mesh.positions, mesh.indices);
    expect(v.watertight).toBe(true);
    expect(v.manifold).toBe(true);
    expect(v.inverted).toBe(false);
  });

  it('clips to a rectangle inset from the grid', () => {
    const box: Ring = [
      [-1500, -900],
      [1500, -900],
      [1500, 900],
      [-1500, 900],
    ];
    const mesh = buildClippedTerrainMesh(hf, scale, box);
    expect(validateMesh(mesh.positions, mesh.indices).manifold).toBe(true);

    const b = boundsOf(mesh.positions);
    expect((b.maxX - b.minX) / (b.maxY - b.minY)).toBeCloseTo(3000 / 1800, 1);
  });

  it('accepts a selection larger than the grid', () => {
    const mesh = buildClippedTerrainMesh(hf, scale, circle(99_000));
    expect(validateMesh(mesh.positions, mesh.indices).manifold).toBe(true);
  });

  it('refuses a selection that misses the grid entirely', () => {
    const far: Ring = [
      [500_000, 500_000],
      [510_000, 500_000],
      [510_000, 510_000],
      [500_000, 510_000],
    ];
    expect(() => buildClippedTerrainMesh(hf, scale, far)).toThrow(/does not cover/i);
  });

  it('works from a real lon/lat selection shape', () => {
    const ring = selectionRingWorld(
      { kind: 'circle', lon: scale.origin.lon0, lat: scale.origin.lat0, radius_m: RADIUS_M },
      scale.origin,
    );
    const mesh = buildClippedTerrainMesh(hf, scale, ring);
    expect(validateMesh(mesh.positions, mesh.indices).manifold).toBe(true);
  });
});

describe('coarsenRing', () => {
  it('drops vertices closer together than one cell', () => {
    const dense: Ring = [];
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2;
      dense.push([Math.cos(a) * 100, Math.sin(a) * 100]);
    }
    const coarse = coarsenRing(dense, 20);
    expect(coarse.length).toBeLessThan(dense.length);
    expect(coarse.length).toBeGreaterThanOrEqual(3);
  });

  it('leaves an already-coarse ring alone', () => {
    const box: Ring = [
      [0, 0],
      [1000, 0],
      [1000, 1000],
      [0, 1000],
    ];
    expect(coarsenRing(box, 100)).toHaveLength(4);
  });

  it('never collapses a ring below a triangle', () => {
    const tiny: Ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(coarsenRing(tiny, 10_000).length).toBeGreaterThanOrEqual(3);
  });
});
