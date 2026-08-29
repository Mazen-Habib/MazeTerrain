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
import { hasSeparateParts, layOutForPrint } from '../src/export/layout';
import type { MeshPart } from '../src/geometry/types';

function boxPart(name: string, x0: number, x1: number): MeshPart {
  const positions = new Float32Array([
    x0, -5, 0,
    x1, -5, 0,
    x1, 5, 0,
    x0, 5, 0,
    x0, -5, 2,
    x1, -5, 2,
    x1, 5, 2,
    x0, 5, 2,
  ]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7]);
  return { name, color: '#888888', positions, indices, manifold: true };
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

  it('reports whether laying out would move anything', () => {
    expect(hasSeparateParts([boxPart('model', -50, 50), boxPart('insert:0', -20, 20)])).toBe(true);
    expect(hasSeparateParts([boxPart('terrain', -50, 50)])).toBe(false);
    expect(hasSeparateParts([boxPart('insert:0', -20, 20)])).toBe(false);
  });
});
