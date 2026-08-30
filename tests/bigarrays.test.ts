/**
 * The call-stack rule, enforced (docs/08-pitfalls.md#call-stack-overflow).
 *
 * `f(...array)` passes one argument per element. Measured on this engine the
 * ceiling sits between 100k and 200k arguments; past it comes `RangeError:
 * Maximum call stack size exceeded`. The sizes are routine — a coastline
 * relation member, a densely resampled model boundary.
 *
 * Two things this file learned the hard way, both worth keeping in mind when
 * adding to it:
 *
 * 1. **Size the fixture against the single spread call, not the total.** The
 *    first version of these tests built 150k points across TWO members, so each
 *    `push(...fragment)` carried 75k and sailed under the limit. The tests
 *    passed with the bug deliberately reinstated, which makes them worse than
 *    no tests at all.
 * 2. **Only guard the sites that can actually overflow.** `clipMultiPolygonToRing`
 *    and the buildings sheet were changed to loops for consistency, but each of
 *    their spreads carries the pieces of ONE polygon — a handful. A test there
 *    would assert nothing and imply a risk that is not real.
 *
 * Both tests below were confirmed to FAIL with their fix reverted.
 */
import { describe, expect, it } from 'vitest';
import { assembleRings } from '../src/data/osm/normalise';
import { buildBaseline } from '../src/geometry/label';
import type { Ring } from '../src/geometry/polygons';

/** Past the measured ceiling, in a SINGLE spread's worth of elements. */
const OVER_THE_LIMIT = 200_000;

describe('assembleRings joins a long way without spreading it', () => {
  /**
   * A multipolygon whose second member is one very long open way — a lake
   * shore, or a coastline. The forward-joining branch used a spread while the
   * reversed branch beside it already looped, so which way round the relation
   * happened to arrive decided whether the app crashed.
   */
  it('chains a member of 200k points onto a short one', () => {
    // A closed loop cut unevenly: a stub, and the rest of the circle.
    const stub: Array<{ lat: number; lon: number }> = [];
    const long: Array<{ lat: number; lon: number }> = [];

    const stubSteps = 10;
    for (let i = 0; i <= stubSteps; i++) {
      const a = (i / stubSteps) * 0.05;
      stub.push({ lon: Math.cos(a), lat: Math.sin(a) });
    }
    for (let i = 0; i <= OVER_THE_LIMIT; i++) {
      const a = 0.05 + (i / OVER_THE_LIMIT) * (Math.PI * 2 - 0.05);
      long.push({ lon: Math.cos(a), lat: Math.sin(a) });
    }

    const rings = assembleRings(
      [
        { type: 'way' as const, ref: 1, role: 'outer', geometry: stub },
        { type: 'way' as const, ref: 2, role: 'outer', geometry: long },
      ],
      'outer',
    );

    expect(rings).toHaveLength(1);
    expect(rings[0].length).toBeGreaterThan(OVER_THE_LIMIT);

    // Joined, not merely concatenated: the seam has to be continuous.
    const ring = rings[0];
    let worstGap = 0;
    for (let i = 1; i < ring.length; i++) {
      const gap = Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
      if (gap > worstGap) worstGap = gap;
    }
    expect(worstGap).toBeLessThan(0.01);
  });

  /** The reversed branch, which already looped. Kept so it stays that way. */
  it('chains a long member that arrives back to front', () => {
    const stub: Array<{ lat: number; lon: number }> = [];
    const long: Array<{ lat: number; lon: number }> = [];
    for (let i = 0; i <= 10; i++) {
      stub.push({ lon: Math.cos((i / 10) * 0.05), lat: Math.sin((i / 10) * 0.05) });
    }
    // Reversed, so its LAST point meets the stub's tail.
    for (let i = OVER_THE_LIMIT; i >= 0; i--) {
      const a = 0.05 + (i / OVER_THE_LIMIT) * (Math.PI * 2 - 0.05);
      long.push({ lon: Math.cos(a), lat: Math.sin(a) });
    }

    const rings = assembleRings(
      [
        { type: 'way' as const, ref: 1, role: 'outer', geometry: stub },
        { type: 'way' as const, ref: 2, role: 'outer', geometry: long },
      ],
      'outer',
    );
    expect(rings).toHaveLength(1);
    expect(rings[0].length).toBeGreaterThan(OVER_THE_LIMIT);
  });
});

describe('buildBaseline measures a long boundary without spreading it', () => {
  /**
   * The baseline resamples the boundary every 0.25 mm, so its point count is
   * set by the model's PERIMETER, not by the ring it was handed. The spread was
   * over that resampled array, so a big enough frame overflowed on its own.
   */
  it('survives a boundary that resamples past the spread limit', () => {
    const radius_mm = 9_000;
    const ring: Ring = Array.from({ length: 2_000 }, (_, i) => {
      const a = (i / 2_000) * Math.PI * 2;
      return [Math.cos(a) * radius_mm, Math.sin(a) * radius_mm] as [number, number];
    });

    const baseline = buildBaseline(ring, 5);
    expect(baseline).not.toBeNull();
    expect(baseline!.points.length).toBeGreaterThan(OVER_THE_LIMIT);

    // What the spread was computing: a band a thousandth of the model's height.
    // It must come out positive and finite, not NaN.
    expect(baseline!.total_mm).toBeGreaterThan(0);
    expect(Number.isFinite(baseline!.centre_mm)).toBe(true);
    expect(Number.isFinite(baseline!.total_mm)).toBe(true);
  });
});
