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

  it('leaves the body exactly where it was', () => {
    const parts = [boxPart('model', -50, 50), boxPart('insert:0', -20, 20)];
    expect(layOutForPrint(parts)[0].positions).toBe(parts[0].positions);
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
