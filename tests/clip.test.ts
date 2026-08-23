import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  clipMultiPolygonToRing,
  clipPolygonToRing,
  clipRingToConvex,
  convexPieces,
  isConvexRing,
  signedArea2,
} from '../src/geometry/clip';
import type { Ring } from '../src/geometry/polygons';

const SQUARE: Ring = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

const area = (ring: Ring) => Math.abs(signedArea2(ring)) / 2;

/** A regular polygon, the way a circle or hexagon selection arrives. */
function regular(n: number, r: number, cx = 5, cy = 5): Ring {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)] as [number, number];
  });
}

describe('isConvexRing', () => {
  it('accepts a square either way round', () => {
    expect(isConvexRing(SQUARE)).toBe(true);
    expect(isConvexRing([...SQUARE].reverse())).toBe(true);
  });

  it('accepts a many-sided circle', () => {
    expect(isConvexRing(regular(64, 5))).toBe(true);
  });

  /** Collinear runs are everywhere in OSM; treating them as turns is wrong. */
  it('ignores collinear vertices', () => {
    expect(isConvexRing([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]])).toBe(true);
  });

  it('rejects an L shape', () => {
    expect(
      isConvexRing([[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]),
    ).toBe(false);
  });
});

describe('clipRingToConvex', () => {
  it('leaves a ring already inside untouched in area', () => {
    const inner: Ring = [[2, 2], [4, 2], [4, 4], [2, 4]];
    expect(area(clipRingToConvex(inner, SQUARE))).toBeCloseTo(4, 6);
  });

  it('returns nothing for a ring entirely outside', () => {
    const away: Ring = [[20, 20], [24, 20], [24, 24], [20, 24]];
    expect(clipRingToConvex(away, SQUARE)).toHaveLength(0);
  });

  it('cuts a straddling ring to the overlap', () => {
    const half: Ring = [[5, 5], [15, 5], [15, 15], [5, 15]];
    // Overlap with the 10x10 square is 5x5.
    expect(area(clipRingToConvex(half, SQUARE))).toBeCloseTo(25, 6);
  });

  it('clips the same whichever way the clip ring winds', () => {
    const half: Ring = [[5, 5], [15, 5], [15, 15], [5, 15]];
    const a = area(clipRingToConvex(half, SQUARE));
    const b = area(clipRingToConvex(half, [...SQUARE].reverse()));
    expect(a).toBeCloseTo(b, 6);
  });

  it('clips a square to a circle at the circle area', () => {
    const circle = regular(128, 4);
    const big: Ring = [[-10, -10], [20, -10], [20, 20], [-10, 20]];
    expect(area(clipRingToConvex(big, circle))).toBeCloseTo(Math.PI * 16, 1);
  });
});

describe('clipPolygonToRing', () => {
  it('keeps the ORIGINAL vertices when a polygon is fully inside', () => {
    const building: Ring = [[2, 2], [3, 2], [3, 3], [2, 3]];
    const [kept] = clipPolygonToRing([building], SQUARE);
    // Not merely equal in area — the same array, so corners are exact.
    expect(kept[0]).toBe(building);
  });

  it('drops a polygon with no overlap', () => {
    expect(clipPolygonToRing([[[20, 20], [24, 20], [24, 24]]], SQUARE)).toHaveLength(0);
  });

  /**
   * (outer \ hole) ∩ C == (outer ∩ C) \ (hole ∩ C), which is why clipping every
   * ring independently is correct rather than merely convenient.
   */
  it('keeps a hole, clipped alongside its outer ring', () => {
    const outer: Ring = [[-5, -5], [15, -5], [15, 15], [-5, 15]];
    const hole: Ring = [[4, 4], [6, 4], [6, 6], [4, 6]];
    const [poly] = clipPolygonToRing([outer, hole], SQUARE);

    expect(poly).toHaveLength(2);
    expect(area(poly[0])).toBeCloseTo(100, 6); // outer clipped to the square
    expect(area(poly[1])).toBeCloseTo(4, 6); // hole survives whole
  });

  /** A lake with an island, where the island falls outside the selection. */
  it('drops a hole that falls outside the clip', () => {
    const outer: Ring = [[-5, -5], [15, -5], [15, 15], [-5, 15]];
    const island: Ring = [[12, 12], [14, 12], [14, 14], [12, 14]];
    const [poly] = clipPolygonToRing([outer, island], SQUARE);

    expect(poly).toHaveLength(1);
    expect(area(poly[0])).toBeCloseTo(100, 6);
  });

  /**
   * When the outer ring is wholly inside the clip, so is every well-formed
   * hole — which is what makes the untouched fast path safe.
   */
  it('keeps holes intact on the fast path', () => {
    const outer: Ring = [[1, 1], [9, 1], [9, 9], [1, 9]];
    const hole: Ring = [[4, 4], [6, 4], [6, 6], [4, 6]];
    const [poly] = clipPolygonToRing([outer, hole], SQUARE);
    expect(poly).toHaveLength(2);
    expect(poly[1]).toBe(hole);
  });

  describe('concave selection outlines', () => {
    const L: Ring = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];

    it('cuts a concave outline into convex pieces', () => {
      const pieces = convexPieces(L);
      expect(pieces.length).toBeGreaterThan(1);
      for (const p of pieces) expect(isConvexRing(p)).toBe(true);
      // The pieces tile the original: areas sum to the L's area (64).
      expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(L), 6);
    });

    it('clips to the true concave area, not to its convex hull', () => {
      const big: Ring = [[-5, -5], [15, -5], [15, 15], [-5, 15]];
      const parts = clipPolygonToRing([big], L);
      const total = parts.reduce((s, p) => s + area(p[0]), 0);
      expect(total).toBeCloseTo(area(L), 6);
      // The convex hull of the L is the full 10x10 square; a hull-based clip
      // would have returned 100 and swallowed the notch.
      expect(total).toBeLessThan(100);
    });

    it('leaves a polygon inside the concave region whole', () => {
      const inside: Ring = [[1, 1], [3, 1], [3, 3], [1, 3]];
      const parts = clipPolygonToRing([inside], L);
      expect(parts.reduce((s, p) => s + area(p[0]), 0)).toBeCloseTo(4, 6);
    });
  });
});

describe('clipMultiPolygonToRing', () => {
  it('clips each polygon and flattens the result', () => {
    const multi = [
      [[[1, 1], [2, 1], [2, 2], [1, 2]] as Ring],
      [[[20, 20], [21, 20], [21, 21]] as Ring],
      [[[8, 8], [14, 8], [14, 14], [8, 14]] as Ring],
    ];
    const out = clipMultiPolygonToRing(multi, SQUARE);
    expect(out).toHaveLength(2);
    expect(out.reduce((s, p) => s + area(p[0]), 0)).toBeCloseTo(1 + 4, 6);
  });
});

describe('boundsOf', () => {
  it('bounds a ring', () => {
    expect(boundsOf(SQUARE)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });
});
