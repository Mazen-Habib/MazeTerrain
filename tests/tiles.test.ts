/**
 * Splitting a model into bed-sized tiles (docs/02-feature-spec.md F12).
 *
 * The planning is arithmetic and is tested as arithmetic. The cutting is a
 * manifold-3d boolean, so it is tested through `layOutForPrint`, which is where
 * a mis-grouped tile would actually hurt: a tile's layers have to travel
 * together or a multicolour model comes apart on the plate.
 */
import { describe, expect, it } from 'vitest';
import {
  BED_MARGIN_MM,
  cellBox,
  planTiles,
  tileLabel,
  xyExtent,
  zExtent,
} from '../src/geometry/tiles';
import { dropSeparateToPlate, layOutForPrint, printUnit } from '../src/export/layout';
import type { MeshPart } from '../src/geometry/types';

const BED: [number, number] = [256, 256];

describe('planTiles', () => {
  it('leaves a model that fits alone', () => {
    expect(planTiles(100, 100, BED)).toBeNull();
    // Right up to the margin.
    expect(planTiles(256 - BED_MARGIN_MM, 256 - BED_MARGIN_MM, BED)).toBeNull();
  });

  /**
   * A bed's nominal size is not all printable — clips, purge line, exclusion
   * zones. A tile sized to the last millimetre is the one that fails at layer
   * 200.
   */
  it('holds a margin back from the stated bed size', () => {
    // 256 - 5 = 251 usable, so 252 must split and 251 must not.
    expect(planTiles(256, 100, BED)).not.toBeNull();
    expect(planTiles(252, 100, BED)).not.toBeNull();
    expect(planTiles(251, 100, BED)).toBeNull();
  });

  it('splits along the axis that is too big', () => {
    const plan = planTiles(400, 100, BED)!;
    expect(plan.cols).toBe(2);
    expect(plan.rows).toBe(1);
    expect(plan.cells).toHaveLength(2);
  });

  it('splits both ways when both are too big', () => {
    const plan = planTiles(400, 400, BED)!;
    expect(plan.cols).toBe(2);
    expect(plan.rows).toBe(2);
    expect(plan.cells).toHaveLength(4);
  });

  /** A 300 x 100 model goes on a 250 x 210 bed turned, and needs no cutting. */
  it('turns the bed rather than cutting when that is enough', () => {
    expect(planTiles(200, 100, [110, 220])).toBeNull();
  });

  it('turns the bed when doing so needs fewer tiles', () => {
    // 300 x 100 on a 120 x 320 bed: straight is 3 x 1, turned is 1 x 1.
    const plan = planTiles(300, 100, [120, 320]);
    expect(plan).toBeNull();
  });

  /**
   * Equal tiles, not full-bed tiles with a remainder. A 1 mm sliver is
   * unprintable, and three equal thirds reassemble more easily than two full
   * tiles and an offcut.
   */
  it('makes the tiles equal rather than leaving a sliver', () => {
    const plan = planTiles(500, 100, BED)!;
    expect(plan.cols).toBe(2);
    expect(plan.tileWidth_mm).toBeCloseTo(250, 6);
    for (const cell of plan.cells) {
      expect(cell.x1 - cell.x0).toBeCloseTo(250, 6);
    }
  });

  it('tiles the whole model with no gap and no overlap', () => {
    const plan = planTiles(400, 300, BED)!;
    const xs = [...new Set(plan.cells.flatMap((c) => [c.x0, c.x1]))].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-200, 6);
    expect(xs[xs.length - 1]).toBeCloseTo(200, 6);

    // Every cell's right edge is the next cell's left edge.
    const row0 = plan.cells.filter((c) => c.row === 0).sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < row0.length; i++) {
      expect(row0[i].x0).toBeCloseTo(row0[i - 1].x1, 6);
    }
  });

  it('produces tiles that actually fit the bed', () => {
    for (const [w, d] of [
      [400, 100],
      [400, 400],
      [1000, 260],
      [257, 257],
    ] as const) {
      const plan = planTiles(w, d, BED);
      if (!plan) continue;
      const usable = 256 - BED_MARGIN_MM;
      const fits =
        (plan.tileWidth_mm <= usable && plan.tileDepth_mm <= usable) ||
        (plan.tileDepth_mm <= usable && plan.tileWidth_mm <= usable);
      expect(fits).toBe(true);
    }
  });

  it('refuses a bed smaller than its own margin', () => {
    expect(planTiles(100, 100, [3, 3])).toBeNull();
  });

  it('labels cells the way a map grid reads', () => {
    const plan = planTiles(400, 400, BED)!;
    expect(plan.cells.map(tileLabel)).toEqual(['A1', 'B1', 'A2', 'B2']);
  });
});

describe('cellBox', () => {
  it('reaches past the model in Z so the cut is purely vertical', () => {
    const box = cellBox({ row: 0, col: 0, x0: -10, x1: 10, y0: -5, y1: 5 }, -3, 40);
    const zs: number[] = [];
    for (let i = 2; i < box.positions.length; i += 3) zs.push(box.positions[i]);
    expect(Math.min(...zs)).toBe(-3);
    expect(Math.max(...zs)).toBe(40);
  });

  /**
   * A box wound inside out intersects to nothing, and the tile would vanish
   * without a word. Signed volume catches it: positive means outward-facing.
   */
  it('is wound outward, or every tile would come back empty', () => {
    const box = cellBox({ row: 0, col: 0, x0: 0, x1: 2, y0: 0, y1: 3, }, 0, 4);
    const P = box.positions;
    const I = box.indices;
    let volume6 = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3;
      const b = I[t + 1] * 3;
      const c = I[t + 2] * 3;
      volume6 +=
        P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) -
        P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) +
        P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    }
    expect(volume6 / 6).toBeCloseTo(2 * 3 * 4, 6);
  });
});

function part(name: string, x0: number, x1: number, z0 = 0, z1 = 5): MeshPart {
  return {
    name,
    color: '#888888',
    positions: new Float32Array([x0, 0, z0, x1, 0, z0, x1, 4, z1, x0, 4, z1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    manifold: true,
  };
}

describe('extents', () => {
  it('measures across every part', () => {
    const parts = [part('a', -10, 0, 0, 3), part('b', 0, 25, 1, 8)];
    expect(xyExtent(parts)).toMatchObject({ width_mm: 35, centreX_mm: 7.5 });
    expect(zExtent(parts)).toEqual([0, 8]);
  });

  it('has nothing to say about no geometry', () => {
    expect(xyExtent([])).toBeNull();
    expect(zExtent([])).toBeNull();
  });
});

describe('tiles as print units', () => {
  /**
   * The grouping that matters: a tile of a multicolour model is several parts,
   * one per layer, and they have to move as one. Moving them independently
   * scatters a tile's roads away from its own terrain.
   */
  it('groups a tile’s layers into one piece', () => {
    expect(printUnit(part('tile:A1:terrain', 0, 1))).toBe('tile:A1');
    expect(printUnit(part('tile:A1:roads', 0, 1))).toBe('tile:A1');
    expect(printUnit(part('tile:B2:terrain', 0, 1))).toBe('tile:B2');
    expect(printUnit(part('insert:0', 0, 1))).toBe('insert:0');
    expect(printUnit(part('terrain', 0, 1))).toBe('body');
  });

  it('moves a tile’s layers together, not one by one', () => {
    const parts = [
      part('tile:A1:terrain', -50, 0),
      part('tile:A1:roads', -30, -10),
      part('tile:B1:terrain', 0, 50),
      part('tile:B1:roads', 10, 30),
    ];
    const laid = layOutForPrint(parts);

    // Each tile's two layers move by the SAME amount, so its roads stay on its
    // terrain. That is the invariant — not that any one tile sits still. Tiles
    // are packed to fit the bed, so where a given tile lands is the packer's
    // business and asserting an absolute position would only pin the current
    // arrangement in place.
    const shift = (i: number) => laid[i].positions[0] - parts[i].positions[0];
    expect(shift(0)).toBe(shift(1));
    expect(shift(2)).toBe(shift(3));

    // And the two tiles genuinely end up apart.
    expect(shift(0)).not.toBe(shift(2));
  });

  it('drops a tile by its own lowest point, not layer by layer', () => {
    const parts = [
      part('body', 0, 10),
      // A tile whose roads sit above its terrain, as roads do.
      part('tile:A1:terrain', 20, 30, 4, 9),
      part('tile:A1:roads', 22, 28, 7, 10),
    ];
    const dropped = dropSeparateToPlate(parts);

    const minZ = (p: MeshPart) => {
      let lo = Infinity;
      for (let i = 2; i < p.positions.length; i += 3) lo = Math.min(lo, p.positions[i]);
      return lo;
    };
    // The tile as a whole lands on the plate...
    expect(minZ(dropped[1])).toBeCloseTo(0, 6);
    // ...and the roads keep their 3 mm of height above it rather than being
    // dropped onto the plate themselves.
    expect(minZ(dropped[2])).toBeCloseTo(3, 6);
  });
});
