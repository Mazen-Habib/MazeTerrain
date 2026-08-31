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

  /**
   * The advice changed when separately-printed parts started being dropped onto
   * the bed: they no longer share one origin in Z, so "do not move them" became
   * false. What still holds — and is what actually breaks the fit — is scale.
   */
  it('warns against scaling the parts, and says they are already bed-ready', () => {
    const readme = text('README.txt');
    expect(readme).toMatch(/do NOT scale/);
    expect(readme).toMatch(/already sitting flat on the bed/);
    expect(readme).not.toMatch(/shares one origin/);
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

/**
 * The note for a model split across the bed (F12).
 *
 * A tiled model is many FILES and fewer PIECES — four pieces of three layers is
 * twelve files — and the header said "12 separate parts", which reads as twelve
 * things to glue together.
 */
describe('the note for a tiled model', () => {
  const tile = (piece: string, layer: string): MeshPart => ({
    name: `tile:${piece}:${layer}`,
    color: '#888888',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    manifold: true,
  });

  const parts = [
    tile('A1', 'terrain'),
    tile('A1', 'roads'),
    tile('B1', 'terrain'),
    tile('B1', 'roads'),
  ];
  const readme = readmeText(parts, { slug: 'zermatt', modelWidth_mm: 400, clearance_mm: 0.15 });

  it('counts pieces to glue, not files to print', () => {
    expect(readme).toMatch(/prints as 2 pieces, in 4 files/);
    expect(readme).not.toMatch(/4 separate parts/);
  });

  it('names the pieces and says how the grid reads', () => {
    expect(readme).toMatch(/cut into 2 pieces/);
    expect(readme).toContain('A1, B1');
    expect(readme).toMatch(/A1 is the front-left piece/);
  });

  it('labels each file by its piece and layer', () => {
    expect(readme).toContain('Piece A1 — terrain');
    expect(readme).toContain('Piece B1 — roads');
    expect(readme).not.toContain('Tile:A1');
  });

  it('explains the alignment pins and their fit', () => {
    expect(readme).toMatch(/alignment pins/);
    expect(readme).toMatch(/peg on one piece, a socket on the other/);
    expect(readme).toContain('0.15 mm clearance');
    // The old note promised the opposite; it must not survive.
    expect(readme).not.toMatch(/no alignment/);
  });

  /** No insert here, so none of the insert advice should appear. */
  it('leaves out the insert instructions when there is no insert', () => {
    expect(readme).not.toMatch(/undersized by/);
    expect(readme).not.toMatch(/press in/);
  });
});
