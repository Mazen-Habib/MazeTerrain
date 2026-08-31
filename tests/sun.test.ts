/**
 * Sun position dial (docs/02-feature-spec.md F3.2).
 *
 * The dial is a polar mapping and the mapping is where the mistakes are, so it
 * lives in two pure functions and they are what is tested. The React part —
 * pointer capture, keyboard, the SVG — was verified in a real browser, which is
 * where a drag can actually be dragged.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SUN, R, dialFromSun, sunFromDial } from '../src/app/SunControl';

/** Whatever the current sun is when a reading does not depend on it. */
const ANY = { azimuth_deg: 123, altitude_deg: 45 };

describe('sunFromDial', () => {
  /**
   * North at the top, clockwise. The model's own +Y is north (CLAUDE.md), and a
   * dial that disagreed with the map would light the terrain from the wrong
   * side while looking right.
   */
  it('reads angle as a compass bearing', () => {
    expect(sunFromDial(0, -R, ANY).azimuth_deg).toBe(0); // up    = N
    expect(sunFromDial(R, 0, ANY).azimuth_deg).toBe(90); // right = E
    expect(sunFromDial(0, R, ANY).azimuth_deg).toBe(180); // down  = S
    expect(sunFromDial(-R, 0, ANY).azimuth_deg).toBe(270); // left  = W
  });

  it('reads the diagonals as the intercardinals', () => {
    const d = R * Math.SQRT1_2;
    expect(sunFromDial(d, -d, ANY).azimuth_deg).toBe(45); // NE
    expect(sunFromDial(-d, -d, ANY).azimuth_deg).toBe(315); // NW
  });

  /** Centre is overhead, rim is the horizon — the sun-path convention. */
  it('reads radius as altitude, inverted', () => {
    expect(sunFromDial(0, 0, ANY).altitude_deg).toBe(90);
    expect(sunFromDial(0, -R, ANY).altitude_deg).toBe(0);
    expect(sunFromDial(0, -R / 2, ANY).altitude_deg).toBe(45);
  });

  /** Dragging past the rim is still the horizon, not a negative sun. */
  it('clamps outside the dial rather than going below the horizon', () => {
    const far = sunFromDial(R * 5, 0, ANY);
    expect(far.altitude_deg).toBe(0);
    expect(far.azimuth_deg).toBe(90);
  });

  /**
   * The bug this file exists for. `atan2(0, -0)` is pi, not zero, so computing
   * a bearing at the exact centre snapped the compass to due south — a drag
   * through the middle of the dial swung the light right round on the way past.
   * At the centre the sun is overhead and its bearing means nothing, so the
   * current one is kept.
   */
  it('keeps the bearing when the sun goes overhead', () => {
    const current = { azimuth_deg: 315, altitude_deg: 45 };
    const overhead = sunFromDial(0, 0, current);
    expect(overhead.azimuth_deg).toBe(315);
    expect(overhead.altitude_deg).toBe(90);

    // And specifically not south, which is what the naive version returned.
    expect(overhead.azimuth_deg).not.toBe(180);
  });

  it('keeps the bearing anywhere inside the dead zone, not just dead centre', () => {
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, -1],
      [-1, 1],
    ] as const) {
      expect(sunFromDial(x, y, { azimuth_deg: 42, altitude_deg: 10 }).azimuth_deg).toBe(42);
    }
  });

  it('always reports a bearing in range', () => {
    for (let deg = 0; deg < 360; deg += 7) {
      const rad = (deg * Math.PI) / 180;
      const { azimuth_deg } = sunFromDial(Math.sin(rad) * R, -Math.cos(rad) * R, ANY);
      expect(azimuth_deg).toBeGreaterThanOrEqual(0);
      expect(azimuth_deg).toBeLessThan(360);
    }
  });
});

describe('dialFromSun', () => {
  /** Placement and reading have to be inverses, or the sun drifts as you drag. */
  it('round-trips with sunFromDial', () => {
    for (const sun of [
      { azimuth_deg: 0, altitude_deg: 0 },
      { azimuth_deg: 90, altitude_deg: 30 },
      { azimuth_deg: 200, altitude_deg: 60 },
      { azimuth_deg: 315, altitude_deg: 45 },
      { azimuth_deg: 359, altitude_deg: 15 },
    ]) {
      const { x, y } = dialFromSun(sun);
      const back = sunFromDial(x, y, ANY);
      expect(back.azimuth_deg).toBe(sun.azimuth_deg);
      expect(back.altitude_deg).toBe(sun.altitude_deg);
    }
  });

  it('puts an overhead sun at the centre and a horizon sun on the rim', () => {
    const overhead = dialFromSun({ azimuth_deg: 0, altitude_deg: 90 });
    expect(Math.hypot(overhead.x, overhead.y)).toBeCloseTo(0, 6);

    const horizon = dialFromSun({ azimuth_deg: 0, altitude_deg: 0 });
    expect(Math.hypot(horizon.x, horizon.y)).toBeCloseTo(R, 6);
  });

  it('puts north up and east right, matching the labels', () => {
    expect(dialFromSun({ azimuth_deg: 0, altitude_deg: 0 })).toMatchObject({ y: -R });
    const east = dialFromSun({ azimuth_deg: 90, altitude_deg: 0 });
    expect(east.x).toBeCloseTo(R, 6);
    expect(east.y).toBeCloseTo(0, 6);
  });
});

describe('the default', () => {
  /**
   * Shading lit from the upper left reads as raised; the same image lit from
   * the lower right reads as hollow. Every printed relief map in the last
   * century lights from the north-west for that reason, and MapLibre's own
   * default puts the sun overhead, which renders relief nearly flat.
   */
  it('lights from the north-west, part way up', () => {
    expect(DEFAULT_SUN.azimuth_deg).toBe(315);
    expect(DEFAULT_SUN.altitude_deg).toBeGreaterThan(20);
    expect(DEFAULT_SUN.altitude_deg).toBeLessThan(70);
  });
});
