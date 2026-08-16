import { describe, expect, it } from 'vitest';
import { readTriangleCount, stlFilename, stlHeader, writeBinarySTL } from '../src/export/stl';
import { buildTerrainMesh } from '../src/geometry/terrain';
import { validateMesh } from '../src/geometry/validate';
import type { MeshPart } from '../src/geometry/types';
import { makeHeightfield, scaleFor } from './helpers';

function partFrom(positions: Float32Array, indices: Uint32Array): MeshPart {
  return { name: 'terrain', color: '#A0907A', positions, indices, manifold: true };
}

describe('writeBinarySTL', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2]);

  it('uses the documented byte layout', () => {
    const buffer = writeBinarySTL([partFrom(positions, indices)]);
    // 80-byte header + uint32 count + 50 bytes per triangle.
    expect(buffer.byteLength).toBe(80 + 4 + 50);
    expect(readTriangleCount(buffer)).toBe(1);
  });

  it('writes attribution into the 80-byte header', () => {
    const buffer = writeBinarySTL([partFrom(positions, indices)]);
    const header = new TextDecoder().decode(new Uint8Array(buffer, 0, 80)).replace(/\0+$/, '');
    expect(header).toContain('MazeTerrain');
    expect(header).toContain('OpenStreetMap');
    expect(stlHeader().length).toBeLessThanOrEqual(80);
  });

  it('writes vertices in millimetres, unscaled', () => {
    const buffer = writeBinarySTL([partFrom(positions, indices)]);
    const view = new DataView(buffer);
    // First vertex starts after header + count + 12 bytes of normal.
    expect(view.getFloat32(80 + 4 + 12, true)).toBe(0);
    expect(view.getFloat32(80 + 4 + 24, true)).toBe(1);
  });

  it('computes a real face normal rather than emitting zeros', () => {
    const buffer = writeBinarySTL([partFrom(positions, indices)]);
    const view = new DataView(buffer);
    expect(view.getFloat32(80 + 4, true)).toBeCloseTo(0, 6);
    expect(view.getFloat32(80 + 8, true)).toBeCloseTo(0, 6);
    expect(view.getFloat32(80 + 12, true)).toBeCloseTo(1, 6);
  });

  it('merges every part into one body', () => {
    const buffer = writeBinarySTL([
      partFrom(positions, indices),
      partFrom(positions, indices),
    ]);
    expect(readTriangleCount(buffer)).toBe(2);
    expect(buffer.byteLength).toBe(80 + 4 + 100);
  });

  it('round-trips a real terrain mesh', () => {
    const hf = makeHeightfield(20, 15, (i, j) => 500 + 10 * i - 4 * j);
    const mesh = buildTerrainMesh(hf, scaleFor(hf));
    expect(validateMesh(mesh.positions, mesh.indices).manifold).toBe(true);

    const buffer = writeBinarySTL([partFrom(mesh.positions, mesh.indices)]);
    expect(readTriangleCount(buffer)).toBe(mesh.indices.length / 3);
    expect(buffer.byteLength).toBe(84 + (mesh.indices.length / 3) * 50);
  });

  it('keeps a non-ASCII header inside 80 bytes', () => {
    const buffer = writeBinarySTL([partFrom(positions, indices)], '© MazeTerrain — test');
    expect(buffer.byteLength).toBe(80 + 4 + 50);
  });
});

describe('stlFilename', () => {
  it('follows the documented convention', () => {
    const name = stlFilename('islamabad-margalla', 100, new Date(Date.UTC(2026, 7, 17)));
    expect(name).toBe('mazeterrain_islamabad-margalla_100mm_20260817.stl');
  });

  it('keeps a fractional size readable', () => {
    const name = stlFilename('matterhorn', 74.8, new Date(Date.UTC(2026, 7, 17)));
    expect(name).toBe('mazeterrain_matterhorn_74.8mm_20260817.stl');
  });
});
