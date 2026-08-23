/**
 * 3MF export.
 *
 * Every assertion goes through the actual ZIP: unzip, read the entry, parse the
 * XML. A writer tested against its own string-building would pass while
 * producing a file no slicer opens.
 */
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import {
  attributionText,
  buildModelXml,
  displayColor,
  threeMFFilename,
  writeThreeMF,
} from '../src/export/threemf';
import type { MeshPart } from '../src/geometry/types';

/** A unit tetrahedron — four vertices, four faces, closed. */
function part(name: string, color: string, offset = 0): MeshPart {
  return {
    name,
    color,
    positions: new Float32Array([
      offset, 0, 0,
      offset + 1, 0, 0,
      offset, 1, 0,
      offset, 0, 1,
    ]),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    manifold: true,
  };
}

function open(buffer: ArrayBuffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const text = (name: string) => new TextDecoder().decode(files[name]);
  return { files, text };
}

function parseModel(buffer: ArrayBuffer): Document {
  const { text } = open(buffer);
  return new DOMParser().parseFromString(text('3D/3dmodel.model'), 'text/xml') as unknown as Document;
}

describe('displayColor', () => {
  it('adds the alpha byte 3MF parsers expect', () => {
    expect(displayColor('#4A4A4A')).toBe('#4A4A4AFF');
  });

  it('expands shorthand and tolerates a missing hash', () => {
    expect(displayColor('#abc')).toBe('#AABBCCFF');
    expect(displayColor('ff0d00')).toBe('#FF0D00FF');
  });
});

describe('writeThreeMF — container', () => {
  const buffer = writeThreeMF([part('terrain', '#A0907A')]);

  it('is a ZIP with the entries the format requires', () => {
    const { files } = open(buffer);
    expect(Object.keys(files).sort()).toEqual(
      ['3D/3dmodel.model', 'README.txt', '[Content_Types].xml', '_rels/.rels'].sort(),
    );
  });

  it('declares the model content type and relationship', () => {
    const { text } = open(buffer);
    expect(text('[Content_Types].xml')).toContain('3dmanufacturing-3dmodel+xml');
    expect(text('_rels/.rels')).toContain('/3D/3dmodel.model');
  });

  /** CLAUDE.md: attribution strings are legally required, not decorative. */
  it('carries attribution in the package and in the model metadata', () => {
    const { text } = open(buffer);
    expect(text('README.txt')).toMatch(/OpenStreetMap contributors/);
    expect(text('README.txt')).toMatch(/ODbL|Open Database License/);
    expect(text('README.txt')).toMatch(/Copernicus/);
    expect(text('3D/3dmodel.model')).toMatch(/OpenStreetMap contributors/);
  });

  it('compresses — the XML is highly repetitive', () => {
    const big = writeThreeMF([part('terrain', '#A0907A')]);
    const raw = buildModelXml([part('terrain', '#A0907A')]).byteLength;
    expect(big.byteLength).toBeLessThan(raw + 512);
  });
});

describe('writeThreeMF — model', () => {
  const parts = [
    part('terrain', '#A0907A'),
    part('roads', '#4A4A4A', 5),
    part('route:0', '#FF0D00', 10),
  ];
  const doc = parseModel(writeThreeMF(parts));
  const objects = Array.from(doc.getElementsByTagName('object'));

  it('is millimetres, always', () => {
    expect(doc.documentElement.getAttribute('unit')).toBe('millimeter');
  });

  it('gives every part its own object', () => {
    expect(objects).toHaveLength(3);
    expect(objects.map((o) => o.getAttribute('name'))).toEqual([
      'Terrain',
      'Roads',
      'Route 1',
    ]);
  });

  /**
   * The detail that makes slicers pre-assign filaments. Without pid/pindex the
   * file opens as one grey blob even though the materials are all present.
   */
  it('puts pid and pindex on every object, pointing at its own material', () => {
    objects.forEach((object, index) => {
      expect(object.getAttribute('pid')).toBe('1');
      expect(object.getAttribute('pindex')).toBe(String(index));
    });
  });

  it('declares one base material per part, in the same order', () => {
    const bases = Array.from(doc.getElementsByTagName('m:base'));
    expect(bases).toHaveLength(3);
    expect(bases.map((b) => b.getAttribute('displaycolor'))).toEqual([
      '#A0907AFF',
      '#4A4A4AFF',
      '#FF0D00FF',
    ]);
  });

  it('references every object from the build, or it will not load', () => {
    const items = Array.from(doc.getElementsByTagName('item'));
    const built = items.map((i) => i.getAttribute('objectid')).sort();
    const declared = objects.map((o) => o.getAttribute('id')).sort();
    expect(built).toEqual(declared);
  });

  /** Slicers handle per-item transforms inconsistently; parts are already placed. */
  it('uses no per-item transforms', () => {
    for (const item of Array.from(doc.getElementsByTagName('item'))) {
      expect(item.getAttribute('transform')).toBeFalsy();
    }
  });

  it('writes the vertices and triangles it was given', () => {
    const first = objects[0];
    expect(first.getElementsByTagName('vertex')).toHaveLength(4);
    expect(first.getElementsByTagName('triangle')).toHaveLength(4);

    const v0 = first.getElementsByTagName('vertex')[0];
    expect(Number(v0.getAttribute('x'))).toBeCloseTo(0, 6);

    const t0 = first.getElementsByTagName('triangle')[0];
    expect(t0.getAttribute('v1')).toBe('0');
    expect(t0.getAttribute('v2')).toBe('2');
    expect(t0.getAttribute('v3')).toBe('1');
  });

  it('keeps each part indexed from zero, not into a merged buffer', () => {
    // Objects are separate meshes: the second part's triangles must reference
    // its own four vertices, not offsets into the first part's.
    const second = objects[1];
    const refs = Array.from(second.getElementsByTagName('triangle')).flatMap((t) => [
      Number(t.getAttribute('v1')),
      Number(t.getAttribute('v2')),
      Number(t.getAttribute('v3')),
    ]);
    expect(Math.max(...refs)).toBeLessThan(4);
  });

  it('escapes a name that would otherwise break the XML', () => {
    const doc2 = parseModel(writeThreeMF([part('a & b <c>', '#FFFFFF')]));
    expect(doc2.getElementsByTagName('object')).toHaveLength(1);
    expect(doc2.getElementsByTagName('object')[0].getAttribute('name')).toBe('A & b <c>');
  });

  it('handles an empty part list without producing a broken file', () => {
    const doc3 = parseModel(writeThreeMF([]));
    expect(doc3.getElementsByTagName('object')).toHaveLength(0);
    expect(doc3.getElementsByTagName('item')).toHaveLength(0);
  });
});

describe('threeMFFilename', () => {
  it('names the file like the STL export does', () => {
    expect(threeMFFilename('islamabad', 100, new Date('2026-08-22T00:00:00Z'))).toBe(
      'islamabad-100mm-2026-08-22.3mf',
    );
  });
});

describe('attributionText', () => {
  it('names both data sources and the licence', () => {
    const text = attributionText();
    expect(text).toMatch(/OpenStreetMap/);
    expect(text).toMatch(/ODbL/);
    expect(text).toMatch(/Copernicus/);
  });
});
