/**
 * Engraved label (docs/02-feature-spec.md F5.1).
 *
 * The font is coordinates typed by hand, and no assertion catches a letter that
 * is simply the wrong shape — `scripts/render-font.ts` draws it to a PNG for
 * that. What is testable is the layout arithmetic and the tool geometry: a
 * groove that cuts to the right depth, breaks the surface, and knows when it
 * has run off the plaque.
 */
import { describe, expect, it } from 'vitest';
import { CAP_HEIGHT, layoutText } from '../src/geometry/strokeFont';
import { buildLabelTool, labelCoverage } from '../src/geometry/label';
import { validateMesh } from '../src/geometry/validate';
import type { MultiPolygon } from '../src/geometry/polygons';

describe('layoutText', () => {
  it('scales to the cap height it is given', () => {
    const laid = layoutText('I', 7);
    let top = -Infinity;
    for (const path of laid.paths) for (const [, y] of path) top = Math.max(top, y);
    expect(top).toBeCloseTo(7, 6);
    expect(laid.height_mm).toBe(7);
  });

  it('sits on a baseline at zero', () => {
    const laid = layoutText('HELLO', 5);
    let bottom = Infinity;
    for (const path of laid.paths) for (const [, y] of path) bottom = Math.min(bottom, y);
    expect(bottom).toBeCloseTo(0, 6);
  });

  it('starts at x = 0 and gets wider with more text', () => {
    const one = layoutText('A', 5);
    const many = layoutText('AAAA', 5);

    let left = Infinity;
    for (const path of one.paths) for (const [x] of path) left = Math.min(left, x);
    expect(left).toBeCloseTo(0, 6);
    expect(many.width_mm).toBeGreaterThan(one.width_mm * 3);
  });

  it('sets lowercase as capitals rather than dropping it', () => {
    expect(layoutText('abc', 5).paths.length).toBe(layoutText('ABC', 5).paths.length);
    expect(layoutText('abc', 5).missing).toEqual([]);
  });

  it('names characters it cannot draw, and still leaves a gap for them', () => {
    const laid = layoutText('A€B', 5);
    expect(laid.missing).toEqual(['€']);
    expect(laid.width_mm).toBeGreaterThan(layoutText('AB', 5).width_mm);
  });

  it('has a glyph for everything a plaque needs', () => {
    const laid = layoutText("MARGALLA TRAIL 5 · 42.2 KM · 1,860 M · 33.7°N 73.1°E (2026)", 5);
    expect(laid.missing).toEqual([]);
  });

  it('lays out nothing for an empty string', () => {
    expect(layoutText('', 5).paths).toEqual([]);
    expect(layoutText('   ', 5).width_mm).toBeGreaterThan(0);
  });

  it('keeps a spacing that does not depend on cap height', () => {
    // Doubling the size doubles the width exactly — no fixed pixel gaps.
    expect(layoutText('MAZE', 10).width_mm).toBeCloseTo(layoutText('MAZE', 5).width_mm * 2, 6);
  });

  it('exposes the cap height its coordinates are drawn on', () => {
    expect(CAP_HEIGHT).toBe(14);
  });
});

const options = {
  capHeight_mm: 4,
  depth_mm: 0.6,
  strokeWidth_mm: 0.4,
  surfaceZ_mm: 6,
  centreX_mm: 0,
  baselineY_mm: -46,
};

function zRange(positions: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    lo = Math.min(lo, positions[i]);
    hi = Math.max(hi, positions[i]);
  }
  return [lo, hi];
}

describe('buildLabelTool', () => {
  const tool = buildLabelTool('MAZE 5', options);

  it('is a closed solid', () => {
    expect(tool.mesh.triangles).toBeGreaterThan(0);
    const v = validateMesh(tool.mesh.positions, tool.mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  /**
   * A tool that stops exactly at the surface leaves a skin over the groove —
   * the same fault the route channel had
   * (08-pitfalls.md#the-channel-decapitates-what-it-crosses), in miniature.
   */
  it('cuts to the depth asked for and breaks the surface above it', () => {
    const [lo, hi] = zRange(tool.mesh.positions);
    expect(lo).toBeCloseTo(options.surfaceZ_mm - options.depth_mm, 4);
    expect(hi).toBeGreaterThan(options.surfaceZ_mm);
  });

  it('centres the text on the point it is given', () => {
    let left = Infinity;
    let right = -Infinity;
    for (let i = 0; i < tool.mesh.positions.length; i += 3) {
      left = Math.min(left, tool.mesh.positions[i]);
      right = Math.max(right, tool.mesh.positions[i]);
    }
    expect((left + right) / 2).toBeCloseTo(options.centreX_mm, 1);
  });

  it('sits on the baseline it is given', () => {
    let bottom = Infinity;
    for (let i = 1; i < tool.mesh.positions.length; i += 3) {
      bottom = Math.min(bottom, tool.mesh.positions[i]);
    }
    // Within a stroke width: the groove straddles the baseline.
    expect(bottom).toBeGreaterThan(options.baselineY_mm - options.strokeWidth_mm);
  });

  it('builds nothing for text that is not there', () => {
    expect(buildLabelTool('', options).mesh.triangles).toBe(0);
    expect(buildLabelTool('   ', options).mesh.triangles).toBe(0);
    expect(buildLabelTool('MAZE', { ...options, depth_mm: 0 }).mesh.triangles).toBe(0);
  });
});

describe('labelCoverage', () => {
  /** A plaque 100 mm wide and 8 mm deep along the bottom edge. */
  const plaque: MultiPolygon = [
    [
      [
        [-50, -50],
        [50, -50],
        [50, -42],
        [-50, -42],
      ],
    ],
  ];

  it('reports everything on the plaque when the text fits', () => {
    expect(labelCoverage('MAZE', { ...options, baselineY_mm: -48 }, plaque)).toBe(1);
  });

  it('reports the shortfall when the text runs off the end', () => {
    const long = 'MARGALLA TRAIL AND THE WHOLE OF THE GALIYAT RANGE BESIDES';
    const coverage = labelCoverage(long, { ...options, capHeight_mm: 6, baselineY_mm: -48 }, plaque);

    expect(coverage).toBeLessThan(0.9);
    expect(coverage).toBeGreaterThan(0);
  });

  it('reports the shortfall when the text is taller than the band', () => {
    // Cap height 12 on an 8 mm band: the top of every letter is off the plaque.
    expect(labelCoverage('MAZE', { ...options, capHeight_mm: 12, baselineY_mm: -48 }, plaque)).toBeLessThan(0.8);
  });

  it('treats no text as fully covered rather than as a failure', () => {
    expect(labelCoverage('', options, plaque)).toBe(1);
    expect(labelCoverage('MAZE', options, [])).toBeLessThan(0.01);
  });
});
