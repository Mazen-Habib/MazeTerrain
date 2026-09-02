/**
 * Hypsometric tints (docs/02-feature-spec.md F3.3).
 *
 * Reported as "the model generated looks very plain": a flat tan terrain, in a
 * preview and an export that both had the elevation data to do better. These
 * tests pin the two decisions that make the feature work rather than merely
 * look nice — bands rather than a gradient, and bands measured on the model's
 * own range rather than on absolute metres.
 */
import { describe, expect, it } from 'vitest';
import {
  SINGLE_COLOR,
  TERRAIN_BANDS,
  bandColorFor,
  bandIndexFor,
  bandTriangles,
  zRangeOf,
} from '../src/geometry/palette';

describe('the palette itself', () => {
  it('runs low to high and ends at the top of the range', () => {
    for (let i = 1; i < TERRAIN_BANDS.length; i++) {
      expect(TERRAIN_BANDS[i].upTo).toBeGreaterThan(TERRAIN_BANDS[i - 1].upTo);
    }
    expect(TERRAIN_BANDS[TERRAIN_BANDS.length - 1].upTo).toBe(1);
  });

  /** Four filaments is what an AMS carries; five bands is already a stretch. */
  it('has few enough bands for a real printer', () => {
    expect(TERRAIN_BANDS.length).toBeLessThanOrEqual(5);
  });

  it('gives every band a usable colour and a name a person would recognise', () => {
    for (const band of TERRAIN_BANDS) {
      expect(band.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(band.name.length).toBeGreaterThan(2);
    }
  });

  /** Low ground green, tops white — the convention every atlas uses. */
  it('goes green at the bottom and white at the top', () => {
    const green = bandColorFor(0).toLowerCase();
    const snow = bandColorFor(1).toLowerCase();

    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [lr, lg, lb] = rgb(green);
    expect(lg).toBeGreaterThan(lr);
    expect(lg).toBeGreaterThan(lb);

    const [sr, sg, sb] = rgb(snow);
    expect(Math.min(sr, sg, sb)).toBeGreaterThan(200);
  });

  /** A monochrome model reads as a landscape in green and as a biscuit in beige. */
  it('prints a single-colour model in green', () => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(SINGLE_COLOR.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });
});

describe('bandIndexFor', () => {
  it('covers the whole range with no gap', () => {
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const index = bandIndexFor(t);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(TERRAIN_BANDS.length);
    }
  });

  it('never goes down as the ground goes up', () => {
    let last = -1;
    for (let t = 0; t <= 1; t += 0.005) {
      const index = bandIndexFor(t);
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
    }
  });

  it('clamps rather than throwing on nonsense', () => {
    expect(bandIndexFor(-5)).toBe(0);
    expect(bandIndexFor(50)).toBe(TERRAIN_BANDS.length - 1);
    expect(bandIndexFor(NaN)).toBe(0);
  });
});

/** A ramp with two triangles per step, climbing z = 0 to z = 100. */
function ramp(steps: number): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const z = (i / steps) * 100;
    positions.push(i, 0, z, i, 1, z);
  }
  for (let i = 0; i < steps; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

describe('bandTriangles', () => {
  const { positions, indices } = ramp(200);

  it('gives one band per triangle', () => {
    const bands = bandTriangles(positions, indices, 0, 100)!;
    expect(bands).toHaveLength(indices.length / 3);
  });

  it('uses every band on a full-range ramp', () => {
    const bands = bandTriangles(positions, indices, 0, 100)!;
    expect(new Set(bands).size).toBe(TERRAIN_BANDS.length);
  });

  it('puts the bottom in the lowest band and the top in the highest', () => {
    const bands = bandTriangles(positions, indices, 0, 100)!;
    expect(bands[0]).toBe(0);
    expect(bands[bands.length - 1]).toBe(TERRAIN_BANDS.length - 1);
  });

  /**
   * Measured on the MODEL's range, not on absolute metres. A Dutch polder and
   * an alpine massif both want their tops to read as tops; anchoring snow to a
   * fixed altitude gives the polder none and the Himalaya nothing else.
   */
  it('bands a flat lowland the same way it bands a mountain range', () => {
    const alpine = bandTriangles(positions, indices, 0, 100)!;

    // The same shape a hundredth the height — a polder rather than a massif.
    const scaled = new Float32Array(positions);
    for (let i = 2; i < scaled.length; i += 3) scaled[i] /= 100;
    const polder = bandTriangles(scaled, indices, 0, 1)!;

    // Not bit-identical, and it should not be: the two meshes reach the same
    // fractions by different float32 routes, so a triangle sitting exactly on a
    // band edge can fall either side. What must match is the banding itself.
    expect(polder).toHaveLength(alpine.length);
    let differing = 0;
    for (let i = 0; i < alpine.length; i++) {
      if (polder[i] !== alpine[i]) differing++;
      // And never by more than one band — a boundary wobble, not a reshuffle.
      expect(Math.abs(polder[i] - alpine[i])).toBeLessThanOrEqual(1);
    }
    expect(differing / alpine.length).toBeLessThan(0.02);

    // And it really is a different mesh, not the same one twice. The LAST
    // vertex, because the first few sit at z = 0 in both and prove nothing.
    const topZ = positions.length - 1;
    expect(positions[topZ]).toBeCloseTo(100, 5);
    expect(scaled[topZ]).toBeCloseTo(1, 5);
  });

  /** Painting bands on ground with no relief would be painting noise. */
  it('declines a range of zero rather than banding noise', () => {
    expect(bandTriangles(positions, indices, 50, 50)).toBeNull();
    expect(bandTriangles(new Float32Array(0), new Uint32Array(0), 0, 1)).toBeNull();
  });

  /**
   * A triangle straddling a boundary takes its HIGHEST corner's band. On a
   * mountain that keeps the snowline crisp instead of letting the last row of
   * triangles dilute it.
   */
  it('resolves a straddling triangle upward', () => {
    const edge = TERRAIN_BANDS[0].upTo * 100;
    const straddle = {
      positions: new Float32Array([0, 0, edge - 1, 1, 0, edge + 1, 0, 1, edge - 1]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const bands = bandTriangles(straddle.positions, straddle.indices, 0, 100)!;
    expect(bands[0]).toBe(1);
  });
});

describe('zRangeOf', () => {
  it('finds the range', () => {
    expect(zRangeOf(new Float32Array([0, 0, -3, 0, 0, 9, 0, 0, 4]))).toEqual([-3, 9]);
  });

  it('has nothing to say about an empty buffer', () => {
    expect(zRangeOf(new Float32Array(0))).toBeNull();
  });
});

/**
 * The base slab must not be in the band range.
 *
 * A terrain part is a SOLID: it reaches down to z=0 at the underside of the
 * base, and the ground surface occupies only what is above `baseThickness_mm`.
 * Band against the whole solid and every surface triangle normalises to nearly
 * 1, so the model comes out white.
 *
 * Measured on a real build before the fix — a Punjab floodplain, 28 m of relief
 * on a 3 mm base — **101 102 of 102 104 triangles were assigned Snow**. Nothing
 * on screen disagreed, because the preview paints `part.color` and never reads
 * the bands.
 */
describe('banding a terrain solid', () => {
  /** A slab from z=0 to `base`, with a surface ramp of `relief` above it. */
  function slab(base: number, relief: number, steps = 20) {
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const x = i;
      const top = base + (relief * i) / steps;
      positions.push(x, 0, 0, x, 0, top);
    }
    for (let i = 0; i < steps; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
    };
  }

  it('spreads the palette across the ground when the base is excluded', () => {
    const { positions, indices } = slab(3, 0.08);
    const bands = bandTriangles(positions, indices, 3, 3.08);
    expect(bands).not.toBeNull();
    const used = new Set(bands!);
    // A ramp across the whole range must touch most of the palette, not one band.
    expect(used.size).toBeGreaterThan(2);
  });

  /**
   * The bug, stated as a test: including the base collapses everything into the
   * top band. This is what the old code did.
   */
  it('collapses into the top band when the base is included', () => {
    const { positions, indices } = slab(3, 0.08);
    const bands = bandTriangles(positions, indices, 0, 3.08);
    const counts = new Map<number, number>();
    for (const b of bands!) counts.set(b, (counts.get(b) ?? 0) + 1);
    const top = TERRAIN_BANDS.length - 1;
    // Nearly everything lands in Snow — which is the failure, reproduced.
    expect((counts.get(top) ?? 0) / bands!.length).toBeGreaterThan(0.9);
  });

  /** A dead flat surface has nothing to band, and must not be painted noise. */
  it('returns null for a surface with no relief', () => {
    const { positions, indices } = slab(3, 0);
    expect(bandTriangles(positions, indices, 3, 3)).toBeNull();
  });
});
