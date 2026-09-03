/**
 * Laying parts out for a printer.
 *
 * The bug this exists for: cut-out inlay mode produces a body with a channel
 * and an insert sitting IN that channel. Correct on screen, and wrong in a file
 * going to a slicer — the slicer draws internal perimeters along the whole
 * route, which is exactly what showed up as "a line in the bottom of the model"
 * both in the preview and in the sliced result.
 */
import { describe, expect, it } from 'vitest';
import { dropSeparateToPlate, hasSeparateParts, layOutForPrint } from '../src/export/layout';
import type { MeshPart } from '../src/geometry/types';

function boxPart(name: string, x0: number, x1: number, z0 = 0, z1 = 2): MeshPart {
  const positions = new Float32Array([
    x0, -5, z0,
    x1, -5, z0,
    x1, 5, z0,
    x0, 5, z0,
    x0, -5, z1,
    x1, -5, z1,
    x1, 5, z1,
    x0, 5, z1,
  ]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7]);
  return { name, color: '#888888', positions, indices, manifold: true };
}

function zRange(part: MeshPart): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < part.positions.length; i += 3) {
    lo = Math.min(lo, part.positions[i]);
    hi = Math.max(hi, part.positions[i]);
  }
  return [lo, hi];
}

function xRange(part: MeshPart): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < part.positions.length; i += 3) {
    lo = Math.min(lo, part.positions[i]);
    hi = Math.max(hi, part.positions[i]);
  }
  return [lo, hi];
}

describe('layOutForPrint', () => {
  it('moves an insert clear of the body it was nested in', () => {
    // The insert overlaps the body exactly, as it does in the assembled model.
    const parts = [boxPart('model', -50, 50), boxPart('insert:0', -20, 20)];
    const laid = layOutForPrint(parts);

    const [, bodyMax] = xRange(laid[0]);
    const [insertMin] = xRange(laid[1]);
    expect(insertMin).toBeGreaterThan(bodyMax);
  });

  it('keeps the insert its own size, and its own height', () => {
    const parts = [boxPart('model', -50, 50), boxPart('insert:0', -20, 20)];
    const laid = layOutForPrint(parts);

    const [lo, hi] = xRange(laid[1]);
    expect(hi - lo).toBeCloseTo(40, 6);
    // Z is untouched: the insert prints on the flat underside it already has.
    for (let i = 2; i < laid[1].positions.length; i += 3) {
      expect([0, 2]).toContain(laid[1].positions[i]);
    }
  });

  it('lines several inserts up without overlapping each other', () => {
    const parts = [
      boxPart('model', -50, 50),
      boxPart('insert:0', -20, 20),
      boxPart('insert:1', -10, 10),
    ];
    const laid = layOutForPrint(parts);

    const [, firstMax] = xRange(laid[1]);
    const [secondMin] = xRange(laid[2]);
    expect(secondMin).toBeGreaterThan(firstMax);
  });

  /**
   * The body used to be pinned at the origin, and that was the bug.
   *
   * Leaving it centred is what forced every insert out to one side: it occupies
   * the middle of the bed, so the only space left is a flank half the model's
   * width, which nothing model-sized fits into. The body is now packed with
   * everything else.
   *
   * What must still hold is that a piece's PARTS move together — a multicolour
   * body whose roads drifted away from its terrain would be far worse than one
   * that is not at the origin.
   */
  it('moves the parts of one piece together', () => {
    const parts = [
      boxPart('terrain', -50, 50),
      boxPart('roads', -50, 50),
      boxPart('insert:0', -20, 20),
    ];
    const laid = layOutForPrint(parts);
    const shift = (i: number) => laid[i].positions[0] - parts[i].positions[0];
    expect(shift(0)).toBe(shift(1));
  });

  it('does nothing at all when there is no insert', () => {
    const parts = [boxPart('terrain', -50, 50), boxPart('roads', -50, 50)];
    expect(layOutForPrint(parts)).toBe(parts);
  });

  it('does nothing when there is nothing to move away FROM', () => {
    const parts = [boxPart('insert:0', -20, 20)];
    expect(layOutForPrint(parts)).toBe(parts);
  });

  it('reports whether the model prints as more than one piece', () => {
    expect(hasSeparateParts([boxPart('model', -50, 50), boxPart('insert:0', -20, 20)])).toBe(true);
    expect(hasSeparateParts([boxPart('terrain', -50, 50)])).toBe(false);
    // One piece, whatever it is called: nothing to lay out beside anything.
    expect(hasSeparateParts([boxPart('insert:0', -20, 20)])).toBe(false);

    // A multicolour model is many parts and ONE piece.
    expect(
      hasSeparateParts([
        boxPart('terrain', -50, 50),
        boxPart('roads', -50, 50),
        boxPart('water', -50, 50),
      ]),
    ).toBe(false);

    // A model split for the bed is all tiles and no body — the case that used
    // to come back false and hide the per-piece export.
    expect(
      hasSeparateParts([
        boxPart('tile:A1:terrain', -50, 0),
        boxPart('tile:A1:roads', -50, 0),
        boxPart('tile:B1:terrain', 0, 50),
      ]),
    ).toBe(true);
  });
});

/**
 * The insert floats above the bed (reported 2026-08-30, with a slicer
 * screenshot of the route hovering beside the terrain).
 *
 * An insert's underside sits at the CHANNEL FLOOR — millimetres up — which is
 * right in the assembled model and wrong the moment the part is printed on its
 * own. `layOutForPrint` originally moved parts sideways and deliberately left Z
 * alone, on the reasoning that the insert already had a flat underside. It
 * does; that underside was just not on the bed.
 */
describe('dropping parts onto the bed', () => {
  /** The real shape of the bug: body on the plate, insert starting well above. */
  const floating = () => [boxPart('model', -50, 50, 0, 8), boxPart('insert:0', -20, 20, 2.77, 4)];

  it('puts a floating insert on the bed when laying out for one file', () => {
    const laid = layOutForPrint(floating());
    expect(zRange(laid[1])[0]).toBeCloseTo(0, 6);
    // And keeps its height: dropped, not flattened.
    expect(zRange(laid[1])[1]).toBeCloseTo(4 - 2.77, 6);
  });

  it('puts it on the bed for the ZIP too, without moving it sideways', () => {
    const parts = floating();
    const dropped = dropSeparateToPlate(parts);
    expect(zRange(dropped[1])[0]).toBeCloseTo(0, 6);
    // Each part is its own file there, so X must not change.
    expect(xRange(dropped[1])).toEqual(xRange(parts[1]));
  });

  /**
   * The body is not dropped independently. In a multicolour model the parts are
   * separate objects that have to keep their relative heights, and lifting one
   * of them onto the bed on its own would take the model apart.
   */
  it('leaves assembled parts exactly where they are', () => {
    const parts = floating();
    const before = zRange(parts[0]);
    expect(zRange(dropSeparateToPlate(parts)[0])).toEqual(before);
    expect(zRange(layOutForPrint(parts)[0])).toEqual(before);
  });

  it('does nothing to a model with no separate parts', () => {
    const parts = [boxPart('terrain', -50, 50, 0, 8), boxPart('roads', -50, 50, 1, 3)];
    expect(dropSeparateToPlate(parts)).toBe(parts);
    expect(zRange(dropSeparateToPlate(parts)[1])[0]).toBeCloseTo(1, 6);
  });

  it('drops each insert by its own underside, not by a shared amount', () => {
    const parts = [
      boxPart('model', -50, 50, 0, 8),
      boxPart('insert:0', -20, 20, 2.77, 4),
      boxPart('insert:1', -10, 10, 5.5, 7),
    ];
    const dropped = dropSeparateToPlate(parts);
    expect(zRange(dropped[1])[0]).toBeCloseTo(0, 6);
    expect(zRange(dropped[2])[0]).toBeCloseTo(0, 6);
    expect(zRange(dropped[2])[1]).toBeCloseTo(1.5, 6);
  });

  it('survives an insert that is already on the bed', () => {
    const parts = [boxPart('model', -50, 50, 0, 8), boxPart('insert:0', -20, 20, 0, 4)];
    const dropped = dropSeparateToPlate(parts);
    expect(zRange(dropped[1])).toEqual([0, 4]);
  });
});

/**
 * Packing to a bed.
 *
 * Reported from a real print: a cut-out model with a route insert and a water
 * insert laid out in one row, ran off the side of a 220 mm Creality bed, and
 * had to be arranged by hand — which is the job this function exists to do.
 */
describe('fitting the bed', () => {
  const ENDER3 = [220, 220] as const;

  /** Three model-sized pieces: a body and two inserts, ~100 mm each. */
  const threePieces = () => [
    boxPart('model', -50, 50),
    boxPart('insert:0', -50, 50),
    boxPart('insert:water', -50, 50),
  ];

  const spanX = (parts: ReturnType<typeof threePieces>) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of parts) {
      const [a, b] = xRange(p);
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
    return hi - lo;
  };

  it('runs off the bed in a single row, which is why it wraps', () => {
    // Unbounded: the old behaviour, and still correct when no bed is known.
    const row = layOutForPrint(threePieces(), null);
    expect(spanX(row)).toBeGreaterThan(ENDER3[0]);
  });

  it('wraps into a grid that fits the bed', () => {
    const laid = layOutForPrint(threePieces(), ENDER3);
    expect(spanX(laid)).toBeLessThanOrEqual(ENDER3[0]);
  });

  it('keeps every piece inside the bed, not just the overall width', () => {
    const laid = layOutForPrint(threePieces(), ENDER3);
    for (const p of laid) {
      const [lo, hi] = xRange(p);
      expect(lo).toBeGreaterThanOrEqual(-ENDER3[0] / 2);
      expect(hi).toBeLessThanOrEqual(ENDER3[0] / 2);
    }
  });

  it('does not overlap the pieces it wrapped', () => {
    const laid = layOutForPrint(threePieces(), ENDER3);
    const boxes = laid.map((p) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < p.positions.length; i += 3) {
        minX = Math.min(minX, p.positions[i]);
        maxX = Math.max(maxX, p.positions[i]);
        minY = Math.min(minY, p.positions[i + 1]);
        maxY = Math.max(maxY, p.positions[i + 1]);
      }
      return { minX, maxX, minY, maxY };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlaps =
          a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
        expect(overlaps, `piece ${i} overlaps ${j}`).toBe(false);
      }
    }
  });

  /**
   * A piece wider than the whole bed cannot be helped, and must not send the
   * packer round forever looking for a row it fits in. F8 already warns about
   * a model too big for the plate; this only has to terminate.
   */
  it('places a piece wider than the bed rather than looping', () => {
    const parts = [boxPart('model', -300, 300), boxPart('insert:0', -20, 20)];
    const laid = layOutForPrint(parts, ENDER3);
    expect(laid).toHaveLength(2);
  });
});
