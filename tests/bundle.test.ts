import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { bundleFilename, readmeText, writePartBundle } from '../src/export/bundle';
import { readTriangleCount } from '../src/export/stl';
import type { MeshPart } from '../src/geometry/types';

function part(name: string, triangles: number): MeshPart {
  const positions = new Float32Array(triangles * 9);
  const indices = new Uint32Array(triangles * 3);
  for (let i = 0; i < triangles * 3; i++) {
    positions[i * 3] = i;
    positions[i * 3 + 1] = i * 2;
    positions[i * 3 + 2] = i * 3;
    indices[i] = i;
  }
  return { name, color: '#888888', positions, indices, manifold: true };
}

const options = { slug: 'islamabad', modelWidth_mm: 100, clearance_mm: 0.15 };

describe('writePartBundle', () => {
  const parts = [part('model', 12), part('insert:0', 6)];
  const files = unzipSync(new Uint8Array(writePartBundle(parts, options)));
  const text = (name: string) => new TextDecoder().decode(files[name]);

  it('writes one STL per part, not one merged STL', () => {
    expect(Object.keys(files).sort()).toEqual(
      ['README.txt', 'islamabad-insert-0.stl', 'islamabad-model.stl'].sort(),
    );
  });

  /** Merging is the failure this exists to prevent, so count the triangles. */
  it("keeps each part's geometry in its own file", () => {
    expect(readTriangleCount(files['islamabad-model.stl'].buffer as ArrayBuffer)).toBe(12);
    expect(readTriangleCount(files['islamabad-insert-0.stl'].buffer as ArrayBuffer)).toBe(6);
  });

  it('names the parts in the README in terms a person can act on', () => {
    const readme = text('README.txt');
    expect(readme).toContain('islamabad-model.stl');
    expect(readme).toContain('Terrain');
    expect(readme).toContain('islamabad-insert-0.stl');
    expect(readme).toContain('Route insert 1');
  });

  /** The clearance is the number that decides whether the insert seats. */
  it('states the clearance and what to do if the fit is wrong', () => {
    const readme = text('README.txt');
    expect(readme).toContain('0.15 mm per side');
    expect(readme).toMatch(/increase the clearance/i);
    expect(readme).toMatch(/reduce the clearance/i);
  });

  it('warns against moving the parts in the slicer', () => {
    expect(text('README.txt')).toMatch(/do NOT move or\s*rotate/);
  });

  /** CLAUDE.md: attribution is legally required, not decorative. */
  it('carries attribution', () => {
    const readme = text('README.txt');
    expect(readme).toMatch(/OpenStreetMap/);
    expect(readme).toMatch(/Copernicus/);
  });

  it('handles a single-part model', () => {
    const one = unzipSync(new Uint8Array(writePartBundle([part('model', 4)], options)));
    expect(Object.keys(one)).toHaveLength(2);
    expect(new TextDecoder().decode(one['README.txt'])).toContain('1 separate part');
  });
});

describe('bundleFilename', () => {
  it('names the archive like the other exports', () => {
    expect(bundleFilename('islamabad', 100, new Date('2026-08-23T00:00:00Z'))).toBe(
      'islamabad-100mm-2026-08-23-parts.zip',
    );
  });
});

describe('readmeText', () => {
  it('says how many parts there are', () => {
    expect(readmeText([part('model', 1), part('insert:0', 1)], options)).toContain(
      '2 separate parts',
    );
  });
});
