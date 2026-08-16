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
  it('auto-resolution targets a few hundred samples on the long edge when the nozzle allows', () => {
    // A 400 mm print of this selection is not nozzle-limited, so the grid target
    // governs. At 100 mm the nozzle floor wins instead — covered below.
    const grid = resolveGrid(testConfig({ modelWidth_mm: 400 }));
    expect(grid.resolutionNozzleLimited).toBe(false);
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

  /**
   * docs/08-pitfalls.md#sub-nozzle-terrain-detail — found when a 100 mm
   * Matterhorn came out with 0.167 mm grid spacing against a 0.4 mm nozzle,
   * turning real knife-edge ridges into unprintable blades.
   */
  describe('nozzle floor', () => {
    it('never auto-samples finer than one nozzle width', () => {
      const config = testConfig({ modelWidth_mm: 100, nozzleDiameter_mm: 0.4 });
      const grid = resolveGrid(config);
      const scale = config.modelWidth_mm / Math.max(grid.extentX_m, grid.extentY_m);

      expect(grid.resolution_m).toBeGreaterThanOrEqual(grid.printableStep_m - 1e-9);
      expect(grid.resolution_m * scale).toBeGreaterThanOrEqual(config.nozzleDiameter_mm - 1e-9);
      expect(grid.resolutionNozzleLimited).toBe(true);
    });

    it('gives a larger print more detail', () => {
      const small = resolveGrid(testConfig({ modelWidth_mm: 100 }));
      const large = resolveGrid(testConfig({ modelWidth_mm: 300 }));
      expect(large.resolution_m).toBeLessThan(small.resolution_m);
      expect(large.cols).toBeGreaterThan(small.cols);
    });

    it('gives a coarser nozzle less detail', () => {
      const fine = resolveGrid(testConfig({ nozzleDiameter_mm: 0.2 }));
      const draft = resolveGrid(testConfig({ nozzleDiameter_mm: 0.8 }));
      expect(draft.resolution_m).toBeGreaterThan(fine.resolution_m);
    });

    it('does not raise the step when the grid target is already coarser', () => {
      // A large selection is grid-target-limited, not nozzle-limited.
      const grid = resolveGrid(
        testConfig({ bbox: { west: 0, east: 1, south: 45, north: 46 }, modelWidth_mm: 300 }),
      );
      expect(grid.resolutionNozzleLimited).toBe(false);
    });

    it('honours an explicit sub-nozzle step but flags it', () => {
      // 20 m is under the ~37 m the nozzle can resolve here, but coarse enough
      // not to trip the vertex cap — so this tests the nozzle flag alone.
      const grid = resolveGrid(testConfig({ resolution_m: 20, modelWidth_mm: 100 }));
      expect(grid.resolution_m).toBe(20);
      expect(grid.resolutionCoarsened).toBe(false);
      expect(grid.printableStep_m).toBeGreaterThan(20);
      expect(grid.belowNozzle).toBe(true);
    });

    it('does not flag an explicit step that clears the nozzle', () => {
      const grid = resolveGrid(testConfig({ resolution_m: 200, modelWidth_mm: 100 }));
      expect(grid.belowNozzle).toBe(false);
    });
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
