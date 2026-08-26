/**
 * Contour lines (docs/02-feature-spec.md F3.1).
 *
 * Traced here as centrelines only; the ribbon, drape and extrusion downstream
 * are the machinery roads already use, so a contour inherits every fix made to
 * that path rather than repeating it.
 */
import { describe, expect, it } from 'vitest';
import { contourLevels, traceContours } from '../src/geometry/contours';
import { makeHeightfield } from './helpers';

describe('contourLevels', () => {
  /** Round numbers, as a map would use — not offsets from wherever terrain starts. */
  it('lands on multiples of the interval', () => {
    expect(contourLevels(517, 683, 50)).toEqual([550, 600, 650]);
  });

  it('excludes the exact floor and ceiling', () => {
    // A contour at the lowest point is the whole grid; at the highest, nothing.
    expect(contourLevels(500, 600, 50)).toEqual([550]);
  });

  it('returns nothing for flat ground', () => {
    expect(contourLevels(500, 500, 50)).toEqual([]);
  });

  it('refuses a nonsense interval rather than looping', () => {
    expect(contourLevels(0, 1000, 0)).toEqual([]);
    expect(contourLevels(0, 1000, -5)).toEqual([]);
  });

  it('caps a pathologically fine interval', () => {
    expect(contourLevels(0, 100000, 1).length).toBeLessThanOrEqual(2000);
  });
});

describe('traceContours', () => {
  /** A cone: every contour is a closed ring, and they nest. */
  const cone = makeHeightfield(60, 60, (i, j) => {
    const dx = i - 29.5;
    const dy = j - 29.5;
    return 600 - Math.hypot(dx, dy) * 4;
  }, 30);

  it('traces a ring per level on a cone', () => {
    const { lines, levels } = traceContours(cone, 20);
    expect(levels.length).toBeGreaterThan(2);
    expect(lines.length).toBeGreaterThanOrEqual(levels.length);
  });

  it('closes its rings inside the grid', () => {
    const { lines } = traceContours(cone, 20);
    // The highest ring is well inside the grid, so it must come back on itself.
    const longest = lines.reduce((a, b) => (a.length > b.length ? a : b));
    const gap = Math.hypot(
      longest[0][0] - longest[longest.length - 1][0],
      longest[0][1] - longest[longest.length - 1][1],
    );
    expect(gap).toBeLessThan(cone.spacingX_m);
  });

  it('puts every point of a level at that elevation', () => {
    const { lines } = traceContours(cone, 40);
    // Sample the heightfield under each contour point: it should read the level
    // it was traced for. Checked via the cone's own analytic form.
    for (const line of lines.slice(0, 3)) {
      for (const [x, y] of line.slice(0, 20)) {
        const i = x / cone.spacingX_m + 29.5;
        const j = y / cone.spacingY_m + 29.5;
        const z = 600 - Math.hypot(i - 29.5, j - 29.5) * 4;
        // Within a cell's worth of elevation change.
        expect(Math.abs(z - Math.round(z / 40) * 40)).toBeLessThan(4.5);
      }
    }
  });

  it('gives nothing for flat ground', () => {
    const flat = makeHeightfield(30, 30, () => 500, 30);
    expect(traceContours(flat, 50).lines).toEqual([]);
  });

  /** A ridge runs off the edge: an open contour is still a real contour. */
  it('keeps contours that leave the grid', () => {
    const ramp = makeHeightfield(40, 40, (i) => 500 + i * 5, 30);
    const { lines } = traceContours(ramp, 50);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeGreaterThanOrEqual(3);
  });

  it('produces more lines at a finer interval', () => {
    const coarse = traceContours(cone, 40).lines.length;
    const fine = traceContours(cone, 10).lines.length;
    expect(fine).toBeGreaterThan(coarse);
  });

  /**
   * Saddles are the case that tears a contour into fragments when neighbouring
   * cells resolve the ambiguity differently.
   */
  it('keeps a saddle connected', () => {
    const saddle = makeHeightfield(50, 50, (i, j) => {
      const x = (i - 24.5) / 10;
      const y = (j - 24.5) / 10;
      return 500 + (x * x - y * y) * 20;
    }, 30);
    const { lines } = traceContours(saddle, 20);
    expect(lines.length).toBeGreaterThan(0);
    // Fragmentation shows up as many very short pieces.
    const stubs = lines.filter((l) => l.length < 5).length;
    expect(stubs / lines.length).toBeLessThan(0.5);
  });
});
