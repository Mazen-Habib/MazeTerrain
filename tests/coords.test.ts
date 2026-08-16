import { describe, expect, it } from 'vitest';
import {
  bboxCentre,
  enuOrigin,
  projectENU,
  resolveGrid,
  resolveScale,
  unprojectENU,
  worldExtent,
  worldToPrint,
  MAX_GRID_VERTICES,
} from '../src/geometry/coords';
import { testConfig } from './helpers';

describe('ENU projection', () => {
  it('round-trips lon/lat through world metres', () => {
    const o = enuOrigin(7.68, 45.98);
    for (const [lon, lat] of [
      [7.68, 45.98],
      [7.74, 46.02],
      [7.62, 45.94],
    ] as Array<[number, number]>) {
      const [x, y] = projectENU(lon, lat, o);
      const [lon2, lat2] = unprojectENU(x, y, o);
      expect(lon2).toBeCloseTo(lon, 10);
      expect(lat2).toBeCloseTo(lat, 10);
    }
  });

  it('puts the origin at zero', () => {
    const o = enuOrigin(-112.1, 36.08);
    expect(projectENU(-112.1, 36.08, o)).toEqual([0, 0]);
  });

  it('orients +X east and +Y north', () => {
    const o = enuOrigin(0, 45);
    const [xEast] = projectENU(0.1, 45, o);
    const [, yNorth] = projectENU(0, 45.1, o);
    expect(xEast).toBeGreaterThan(0);
    expect(yNorth).toBeGreaterThan(0);
  });
});

/**
 * docs/08-pitfalls.md#mercator-stretch guard: "Generate the same-size selection
 * at 0, 45 and 65 latitude; assert the real extents match."
 */
describe('latitude correction', () => {
  it('gives equal real extents for equal-size selections at any latitude', () => {
    const dLat = 0.1;
    const results = [0, 45, 65, 69].map((lat) => {
      const dLon = dLat / Math.cos((lat * Math.PI) / 180);
      const { extentX_m, extentY_m } = worldExtent({
        west: -dLon / 2,
        east: dLon / 2,
        south: lat - dLat / 2,
        north: lat + dLat / 2,
      });
      return { lat, extentX_m, extentY_m };
    });

    for (const r of results) {
      // A square-on-the-ground selection must stay square, or the model prints
      // stretched north-south.
      expect(r.extentX_m / r.extentY_m).toBeCloseTo(1, 3);
    }

    const first = results[0];
    for (const r of results.slice(1)) {
      expect(r.extentX_m).toBeCloseTo(first.extentX_m, 0);
      expect(r.extentY_m).toBeCloseTo(first.extentY_m, 0);
    }
  });

  it('does not treat Mercator units as metres', () => {
    // At 65N a naive Mercator reading would be 1/cos(65) = 2.37x too large.
    const { extentY_m } = worldExtent({ west: 0, east: 0.1, south: 64.95, north: 65.05 });
    const expected = 6378137 * 0.1 * (Math.PI / 180);
    expect(extentY_m).toBeCloseTo(expected, 0);
  });
});

describe('bboxCentre', () => {
  it('sits at the middle of the box', () => {
    const c = bboxCentre({ west: 10, east: 20, south: 30, north: 40 });
    expect(c.lon0).toBe(15);
    expect(c.lat0).toBe(35);
  });
});

describe('resolveGrid', () => {
  it('auto-resolution targets a few hundred samples on the long edge', () => {
    const grid = resolveGrid(testConfig());
    const longEdge = Math.max(grid.cols, grid.rows);
    expect(longEdge).toBeGreaterThan(300);
    expect(longEdge).toBeLessThan(900);
  });

  it('coarsens rather than exceeding the vertex cap', () => {
    // 1 degree square at 5 m/px would be roughly 22 000 x 22 000 = 484 M vertices.
    const grid = resolveGrid(
      testConfig({
        bbox: { west: 0, east: 1, south: 45, north: 46 },
        resolution_m: 5,
      }),
    );
    expect(grid.cols * grid.rows).toBeLessThanOrEqual(MAX_GRID_VERTICES);
    expect(grid.resolutionCoarsened).toBe(true);
  });

  it('clamps an out-of-range manual resolution', () => {
    expect(resolveGrid(testConfig({ resolution_m: 0.1 })).resolution_m).toBeGreaterThanOrEqual(5);
    expect(resolveGrid(testConfig({ resolution_m: 99999 })).resolution_m).toBeLessThanOrEqual(500);
  });
});

describe('resolveScale', () => {
  it('scales the longest edge to modelWidth_mm', () => {
    const config = testConfig({ modelWidth_mm: 100 });
    const s = resolveScale(config, 1600, 4400);
    const longEdge_m = Math.max(s.extentX_m, s.extentY_m);
    expect(longEdge_m * s.scale).toBeCloseTo(100, 6);
  });

  it('reduces exaggeration to respect maxHeight_mm', () => {
    const config = testConfig({ verticalExaggeration: 5, maxHeight_mm: 15 });
    const s = resolveScale(config, 1600, 4400);

    expect(s.exaggerationClamped).toBe(true);
    expect(s.effectiveExaggeration).toBeLessThan(5);

    const relief_m = 4400 - 1600;
    expect(relief_m * s.zScale).toBeCloseTo(15, 6);
  });

  it('leaves exaggeration alone when it already fits', () => {
    const config = testConfig({ verticalExaggeration: 1.5, maxHeight_mm: 100 });
    const s = resolveScale(config, 1600, 4400);
    expect(s.exaggerationClamped).toBe(false);
    expect(s.effectiveExaggeration).toBe(1.5);
  });

  it('survives perfectly flat terrain', () => {
    const s = resolveScale(testConfig(), 12, 12);
    expect(s.exaggerationClamped).toBe(false);
    expect(Number.isFinite(s.zScale)).toBe(true);
  });
});

describe('worldToPrint', () => {
  it('puts the lowest point at exactly baseThickness_mm', () => {
    const s = resolveScale(testConfig({ baseThickness_mm: 3 }), 1600, 4400);
    const [, , z] = worldToPrint(0, 0, 1600, s);
    expect(z).toBeCloseTo(3, 9);
  });

  it('never pushes terrain below the base plane, even with a negative sea level offset', () => {
    const s = resolveScale(testConfig({ seaLevelOffset_m: -500, baseThickness_mm: 3 }), 1600, 4400);
    const [, , z] = worldToPrint(0, 0, 1600, s);
    expect(z).toBeGreaterThanOrEqual(3);
  });

  it('is linear in XY', () => {
    const s = resolveScale(testConfig(), 0, 100);
    const [x1] = worldToPrint(1000, 0, 0, s);
    const [x2] = worldToPrint(2000, 0, 0, s);
    expect(x2).toBeCloseTo(x1 * 2, 6);
  });
});
