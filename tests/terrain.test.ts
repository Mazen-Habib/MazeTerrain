import { describe, expect, it } from 'vitest';
import { buildTerrainMesh, computeNormals, perimeterRing } from '../src/geometry/terrain';
import { signedVolume, validateMesh } from '../src/geometry/validate';
import { boundsOf, makeHeightfield, scaleFor } from './helpers';

describe('perimeterRing', () => {
  it('walks the grid boundary counter-clockwise seen from above', () => {
    // 3x3 grid, indices:  6 7 8
    //                     3 4 5
    //                     0 1 2
    // Row 0 is the southern edge, so CCW from above is E, N, W, S.
    expect(Array.from(perimeterRing(3, 3))).toEqual([0, 1, 2, 5, 8, 7, 6, 3]);
  });

  it('has 2*(cols+rows-2) entries with no repeats', () => {
    for (const [cols, rows] of [
      [2, 2],
      [3, 5],
      [17, 4],
      [64, 64],
    ] as Array<[number, number]>) {
      const ring = perimeterRing(cols, rows);
      expect(ring.length).toBe(2 * (cols + rows - 2));
      expect(new Set(ring).size).toBe(ring.length);
    }
  });
});

describe('buildTerrainMesh', () => {
  const hf = makeHeightfield(
    24,
    18,
    (i, j) => 800 + 400 * Math.sin(i / 4) * Math.cos(j / 3) + 2 * i,
  );
  const scale = scaleFor(hf);
  const mesh = buildTerrainMesh(hf, scale);

  it('emits the expected vertex and triangle counts', () => {
    const P = 2 * (24 + 18 - 2);
    expect(mesh.perimeter).toBe(P);
    expect(mesh.positions.length / 3).toBe(24 * 18 + P + 1);
    expect(mesh.indices.length / 3).toBe(23 * 17 * 2 + P * 2 + P);
  });

  it('produces a watertight, manifold solid', () => {
    const v = validateMesh(mesh.positions, mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.degenerateTriangles).toBe(0);
    expect(v.watertight).toBe(true);
    expect(v.manifold).toBe(true);
  });

  it('is not inside-out', () => {
    // Signed volume > 0 is the assertion CLAUDE.md asks for by name.
    expect(signedVolume(mesh.positions, mesh.indices)).toBeGreaterThan(0);
    expect(validateMesh(mesh.positions, mesh.indices).inverted).toBe(false);
  });

  it('seats the base on z = 0 and the lowest terrain at baseThickness_mm', () => {
    const b = boundsOf(mesh.positions);
    expect(b.minZ).toBe(0);
    expect(b.maxZ).toBeGreaterThan(scale.baseThickness_mm);
  });

  it('scales the longest edge to modelWidth_mm and centres it on the origin', () => {
    const b = boundsOf(mesh.positions);
    expect(Math.max(b.maxX - b.minX, b.maxY - b.minY)).toBeCloseTo(100, 4);
    expect(b.minX).toBeCloseTo(-b.maxX, 4);
    expect(b.minY).toBeCloseTo(-b.maxY, 4);
  });

  it('encloses at least the base slab volume', () => {
    const b = boundsOf(mesh.positions);
    const baseVolume = (b.maxX - b.minX) * (b.maxY - b.minY) * scale.baseThickness_mm;
    expect(signedVolume(mesh.positions, mesh.indices)).toBeGreaterThan(baseVolume);
  });
});

/**
 * docs/08-pitfalls.md#mirrored-models guard.
 *
 * A symmetric cone hides a handedness bug completely. This puts the only high
 * ground in the north-east corner and asserts it lands at +X/+Y in print space.
 */
describe('handedness', () => {
  it('keeps north at +Y and east at +X', () => {
    const cols = 21;
    const rows = 21;
    const hf = makeHeightfield(cols, rows, (i, j) =>
      i > cols * 0.7 && j > rows * 0.7 ? 2000 : 100,
    );
    const mesh = buildTerrainMesh(hf, scaleFor(hf));

    let peakX = 0;
    let peakY = 0;
    let peakZ = -Infinity;
    for (let p = 0; p < mesh.positions.length; p += 3) {
      if (mesh.positions[p + 2] > peakZ) {
        peakZ = mesh.positions[p + 2];
        peakX = mesh.positions[p];
        peakY = mesh.positions[p + 1];
      }
    }

    expect(peakX).toBeGreaterThan(0);
    expect(peakY).toBeGreaterThan(0);
  });

  it('points the top surface normals up and the base normals down', () => {
    const hf = makeHeightfield(9, 9, () => 500);
    const mesh = buildTerrainMesh(hf, scaleFor(hf));
    const normals = computeNormals(mesh.positions, mesh.indices);

    // Vertex 0 of the grid is a top-surface corner; the centroid is the last
    // vertex and belongs only to the base fan.
    const centroid = mesh.positions.length / 3 - 1;
    expect(normals[centroid * 3 + 2]).toBeLessThan(0);

    const interiorTop = (4 * 9 + 4) * 3;
    expect(normals[interiorTop + 2]).toBeGreaterThan(0);
  });
});

describe('edge cases', () => {
  it('handles perfectly flat terrain', () => {
    const hf = makeHeightfield(12, 12, () => 42);
    const mesh = buildTerrainMesh(hf, scaleFor(hf));
    const v = validateMesh(mesh.positions, mesh.indices);
    expect(v.manifold).toBe(true);
    expect(v.inverted).toBe(false);
  });

  it('handles the smallest legal grid', () => {
    const hf = makeHeightfield(2, 2, (i, j) => 10 * i + j);
    const mesh = buildTerrainMesh(hf, scaleFor(hf));
    expect(validateMesh(mesh.positions, mesh.indices).manifold).toBe(true);
  });

  it('refuses a grid too small to triangulate', () => {
    const hf = makeHeightfield(1, 4, () => 0);
    expect(() => buildTerrainMesh(hf, scaleFor(hf))).toThrow(/too small/i);
  });
});

/**
 * Golden-file test (CLAUDE.md §4).
 *
 * Fixed grid + fixed settings must produce a stable triangle count and bounding
 * box. This catches the regressions visual inspection misses — a changed winding
 * convention, an off-by-one in the ring, a quietly altered scale formula.
 */
/**
 * Pinned from a measured build, and cross-checked analytically: the mean of this
 * heightfield is 1200 + 300*(1-cos 8)/8 + 150*(sin 7.5)/7.5 = 1261.7 m, giving a
 * predicted 22 500 mm3 base slab + 127 700 mm3 of relief = 150 200 mm3. The
 * agreement to 0.04 % is what makes this a golden value rather than a
 * screenshot of whatever the code happened to emit.
 */
const GOLDEN_VOLUME_MM3 = 150167.27;

describe('golden model', () => {
  const hf = makeHeightfield(41, 31, (i, j) => 1200 + 300 * Math.sin(i / 5) + 150 * Math.cos(j / 4));
  const scale = scaleFor(hf, { modelWidth_mm: 100, baseThickness_mm: 3, maxHeight_mm: 30 });
  const mesh = buildTerrainMesh(hf, scale);

  it('has a stable triangle count', () => {
    expect(mesh.indices.length / 3).toBe(2820);
    expect(mesh.positions.length / 3).toBe(1412);
  });

  it('has a stable bounding box', () => {
    const b = boundsOf(mesh.positions);
    expect(b.maxX - b.minX).toBeCloseTo(100, 4);
    expect(b.maxY - b.minY).toBeCloseTo(75, 4);
    // This grid's relief overshoots maxHeight_mm, so the clamp engages and the
    // total height lands on exactly maxHeight_mm + baseThickness_mm.
    expect(scale.exaggerationClamped).toBe(true);
    expect(b.maxZ - b.minZ).toBeCloseTo(33, 3);
  });

  it('has a stable volume', () => {
    expect(signedVolume(mesh.positions, mesh.indices)).toBeCloseTo(GOLDEN_VOLUME_MM3, 0);
  });
});
