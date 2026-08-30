/**
 * Contour lines (docs/02-feature-spec.md F3.1).
 *
 * Traced here as centrelines only; the ribbon, drape and extrusion downstream
 * are the machinery roads already use, so a contour inherits every fix made to
 * that path rather than repeating it.
 */
import { describe, expect, it } from 'vitest';
import {
  contourLevels,
  suggestInterval,
  suggestTerraceInterval,
  terraceHeightfield,
  traceContours,
} from '../src/geometry/contours';
import { sampleHeightfieldAt } from '../src/geometry/heightfield';
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

describe('suggestInterval', () => {
  /** A constant-gradient ramp, so the slope it should be sizing against is known. */
  const ramp = (gradient: number, spacing_m = 50) =>
    makeHeightfield(64, 64, (i) => i * spacing_m * gradient, spacing_m);

  it('grows with the steepness of the ground', () => {
    // A generous zScale, so the ring-height floor does not swallow both cases.
    const zScale = 0.05;
    const gentle = suggestInterval(ramp(0.05), 100, zScale, 0.7);
    const steep = suggestInterval(ramp(0.5), 100, zScale, 0.7);

    expect(steep).toBeGreaterThan(gentle);
  });

  it('keeps neighbouring rings from touching on the ground it sized for', () => {
    const gradient = 0.3;
    const width_m = 100;
    const interval = suggestInterval(ramp(gradient), width_m, 0.005, 0.7);

    // Horizontal separation on that slope, versus the width of one ribbon.
    expect(interval / gradient).toBeGreaterThanOrEqual(width_m * 2);
  });

  it('keeps a ring from burying the ring above it, however flat the ground', () => {
    const zScale = 0.005;
    const lineHeight_mm = 0.7;
    // Dead flat: nothing forces the interval apart except the ring height.
    const interval = suggestInterval(makeHeightfield(64, 64, () => 500, 50), 100, zScale, lineHeight_mm);

    expect(interval * zScale).toBeGreaterThanOrEqual(lineHeight_mm);
  });

  it('rounds to a number a map would print', () => {
    for (const gradient of [0.02, 0.11, 0.27, 0.4, 0.9]) {
      const interval = suggestInterval(ramp(gradient), 100, 0.005, 0.7);
      const magnitude = 10 ** Math.floor(Math.log10(interval));
      expect([1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]).toContain(interval / magnitude);
    }
  });
});

/**
 * Terraced contours (docs/02-feature-spec.md F3.1).
 *
 * Reported from a print: extruded isolines read as "lines looking like roads
 * that even go up the contour step". They are correct isolines — that is the
 * problem. The look people mean is a laser-cut plywood relief map, where the
 * terrain itself is a stack of flat shelves and the step edge IS the contour.
 */
describe('terraceHeightfield', () => {
  const ramp = () => makeHeightfield(40, 40, (i) => 100 + i * 5, 50);

  it('leaves only multiples of the interval', () => {
    const hf = ramp();
    terraceHeightfield(hf, 25);
    for (const v of hf.data) {
      expect(v / 25).toBeCloseTo(Math.round(v / 25), 9);
    }
  });

  /** Rounded DOWN, so a shelf sits at the level it is named for. */
  it('rounds down, never up', () => {
    const before = Array.from(ramp().data);
    const hf = ramp();
    terraceHeightfield(hf, 25);
    for (let i = 0; i < before.length; i++) {
      expect(hf.data[i]).toBeLessThanOrEqual(before[i] + 1e-9);
      expect(before[i] - hf.data[i]).toBeLessThan(25);
    }
  });

  /** Flat shelves are the whole point: neighbours mostly share a height. */
  it('makes flat shelves rather than a smooth slope', () => {
    const hf = ramp();
    terraceHeightfield(hf, 50);
    let same = 0;
    let total = 0;
    for (let j = 0; j < hf.rows; j++) {
      for (let i = 1; i < hf.cols; i++) {
        total++;
        if (hf.data[j * hf.cols + i] === hf.data[j * hf.cols + i - 1]) same++;
      }
    }
    // A 5 m/cell ramp terraced at 50 m: nine cells in ten are on a shelf.
    expect(same / total).toBeGreaterThan(0.85);
  });

  it('updates the range, because the vertical scale is computed from it', () => {
    const hf = ramp();
    terraceHeightfield(hf, 25);
    let min = Infinity;
    let max = -Infinity;
    for (const v of hf.data) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(hf.min_m).toBe(min);
    expect(hf.max_m).toBe(max);
  });

  it('counts the shelves it made', () => {
    const hf = ramp();
    // 100..295 m terraced at 50 m gives shelves at 100, 150, 200, 250.
    expect(terraceHeightfield(hf, 50)).toBe(4);
  });

  it('does nothing for an interval that is not a step', () => {
    const hf = ramp();
    const before = Array.from(hf.data);
    expect(terraceHeightfield(hf, 0)).toBe(0);
    expect(Array.from(hf.data)).toEqual(before);
  });

  /**
   * The reason terracing happens before ANYTHING is meshed: a route draping on
   * the old smooth surface would float over the shelves that replaced it.
   */
  it('is visible to the sampler everything else drapes with', () => {
    const hf = ramp();
    terraceHeightfield(hf, 50);
    // Two points on the same shelf read the same height.
    const a = sampleHeightfieldAt(hf, -800, 0);
    const b = sampleHeightfieldAt(hf, -790, 0);
    expect(Math.abs(a - b)).toBeLessThan(1);
  });
});

/**
 * The terrace interval is NOT the line interval.
 *
 * `suggestInterval` sizes the step so traced rings stay a ribbon-width apart —
 * the constraint that keeps thin lines from fusing. A shelf has no such
 * problem, and reusing that number gave three shelves on a real build where the
 * laser-cut reference look has ten.
 */
/** Mirrors TARGET_SHELVES in contours.ts. */
const TARGET = 12;

describe('suggestTerraceInterval', () => {
  it('aims for about a dozen shelves', () => {
    const interval = suggestTerraceInterval(0, 1200, 0.02, 0.2);
    const shelves = 1200 / interval;
    expect(shelves).toBeGreaterThan(7);
    expect(shelves).toBeLessThan(20);
  });

  /** A step under two layers is texture, not a step. */
  it('never proposes a step too shallow to print', () => {
    // A tiny range with a coarse layer height: the vertical floor must win.
    const layerHeight_mm = 0.3;
    const zScale = 0.01;
    const interval = suggestTerraceInterval(0, 20, zScale, layerHeight_mm);
    expect(interval * zScale).toBeGreaterThanOrEqual(2 * layerHeight_mm - 1e-9);
  });

  it('gives back numbers a map would print', () => {
    for (const range of [50, 300, 1200, 8000]) {
      const interval = suggestTerraceInterval(0, range, 0.02, 0.2);
      const mantissa = interval / Math.pow(10, Math.floor(Math.log10(interval)));
      expect([1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]).toContainEqual(
        Math.round(mantissa * 10) / 10,
      );
    }
  });

  it('has nothing to say about flat ground', () => {
    expect(suggestTerraceInterval(500, 500, 0.02, 0.2)).toBe(0);
  });

  /**
   * The reported bug, as a property rather than a comparison.
   *
   * A first pass reused `suggestInterval` and a real build came out with THREE
   * shelves where the laser-cut reference look has ten. Which of the two
   * intervals is numerically larger depends on range against slope and is not
   * worth asserting.
   *
   * The full property has two halves, and the second is not a failure: aim for
   * about a dozen shelves, UNLESS the model is too short to print them, in
   * which case the step sits exactly on the two-layer floor. A 1.7 mm tall
   * model cannot carry twelve readable shelves and should not pretend to.
   */
  it('lands near a dozen shelves, or on the printable floor when it cannot', () => {
    const zScale = 0.02;
    const layerHeight_mm = 0.2;
    const floor_m = (2 * layerHeight_mm) / zScale;

    for (const build of [
      makeHeightfield(60, 60, (i) => 500 + i * 40, 50),
      makeHeightfield(60, 60, (i, j) => 500 + i * 8 + j * 3, 50),
      makeHeightfield(60, 60, (i, j) => 500 + Math.hypot(i - 30, j - 30) * 2, 50),
    ]) {
      const range = build.max_m - build.min_m;
      const interval = suggestTerraceInterval(build.min_m, build.max_m, zScale, layerHeight_mm);
      const shelves = range / interval;

      if (range / TARGET >= floor_m) {
        expect(shelves).toBeGreaterThan(6);
        expect(shelves).toBeLessThan(25);
      } else {
        // Too short for a dozen: the step is the smallest one that prints.
        expect(interval * zScale).toBeGreaterThanOrEqual(2 * layerHeight_mm - 1e-9);
        expect(shelves).toBeGreaterThan(1);
      }
    }
  });
});
