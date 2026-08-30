/**
 * Filament, cost and time estimate (docs/02-feature-spec.md F9).
 *
 * The measurement half is checked against shapes whose volume and area are
 * known from school geometry, because a volume integral that is subtly wrong
 * still returns a plausible-looking number. The arithmetic half is checked for
 * the properties that make the estimate trustworthy — monotonic in infill,
 * bounded by the solid volume, and never claiming less plastic than the shell.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultFilamentProfile,
  estimateFilament,
  formatDuration,
  measurePart,
  measureParts,
  type FilamentProfile,
  type PartMeasure,
} from '../src/export/estimate';
import type { MeshPart } from '../src/geometry/types';

/** An axis-aligned box as a closed triangle mesh, corner at the origin. */
function box(w: number, d: number, h: number, name = 'box'): MeshPart {
  const positions = new Float32Array([
    0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0,
    0, 0, h, w, 0, h, w, d, h, 0, d, h,
  ]);
  // Outward winding, seen from outside each face.
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (normal -Z)
    4, 5, 6, 4, 6, 7, // top (+Z)
    0, 1, 5, 0, 5, 4, // front (-Y)
    1, 2, 6, 1, 6, 5, // right (+X)
    2, 3, 7, 2, 7, 6, // back (+Y)
    3, 0, 4, 3, 4, 7, // left (-X)
  ]);
  return { name, color: '#888888', positions, indices, manifold: true };
}

describe('measurePart', () => {
  it('gets the volume of a box right', () => {
    const m = measurePart(box(10, 20, 5));
    expect(m.volume_mm3).toBeCloseTo(1000, 3);
  });

  /**
   * The split is the whole point: a slicer treats a top face and a side wall
   * completely differently, and on a terrain model almost all the area is
   * up-facing.
   */
  it('separates the faces a slicer makes solid from the ones it perimeters', () => {
    const m = measurePart(box(10, 20, 5));
    // Top and bottom: 2 x 10 x 20.
    expect(m.solidArea_mm2).toBeCloseTo(400, 3);
    // Four sides: 2 x (10 x 5) + 2 x (20 x 5).
    expect(m.wallArea_mm2).toBeCloseTo(300, 3);
  });

  it('is unmoved by where the box sits', () => {
    const shifted = box(10, 20, 5);
    for (let i = 0; i < shifted.positions.length; i += 3) {
      shifted.positions[i] += 137;
      shifted.positions[i + 1] -= 62;
      shifted.positions[i + 2] += 9;
    }
    const m = measurePart(shifted);
    expect(m.volume_mm3).toBeCloseTo(1000, 2);
    expect(m.solidArea_mm2).toBeCloseTo(400, 2);
    expect(m.wallArea_mm2).toBeCloseTo(300, 2);
  });

  it('measures every part and keeps the names', () => {
    const measures = measureParts([box(10, 10, 10, 'terrain'), box(2, 2, 2, 'route:0')]);
    expect(measures.map((m) => m.name)).toEqual(['terrain', 'route:0']);
    expect(measures[0].volume_mm3).toBeCloseTo(1000, 3);
    expect(measures[1].volume_mm3).toBeCloseTo(8, 3);
  });

  it('reports nothing for an empty part rather than NaN', () => {
    const empty: MeshPart = {
      name: 'empty',
      color: '#000000',
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      manifold: true,
    };
    const m = measurePart(empty);
    expect(m.volume_mm3).toBe(0);
    expect(m.solidArea_mm2).toBe(0);
    expect(m.wallArea_mm2).toBe(0);
  });
});

describe('estimateFilament', () => {
  const profile = (patch: Partial<FilamentProfile> = {}): FilamentProfile => ({
    ...defaultFilamentProfile(0.2, 0.4),
    ...patch,
  });

  /** A block big enough that its interior dominates its shell. */
  const bigBlock = [measurePart(box(100, 100, 20))];

  it('uses the whole volume at 100% infill', () => {
    const e = estimateFilament(bigBlock, profile({ infill: 1 }));
    expect(e.material_mm3).toBeCloseTo(e.volume_mm3, 3);
    expect(e.fill).toBeCloseTo(1, 6);
  });

  /** More infill is more plastic. Sounds obvious; a sign error breaks it. */
  it('rises with infill, and never past solid', () => {
    let last = -1;
    for (const infill of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      const e = estimateFilament(bigBlock, profile({ infill }));
      expect(e.material_mm3).toBeGreaterThan(last);
      expect(e.material_mm3).toBeLessThanOrEqual(e.volume_mm3 + 1e-6);
      last = e.material_mm3;
    }
  });

  /**
   * Zero infill is not zero plastic — the shell is still printed. An estimate
   * that says otherwise would tell someone a model is free.
   */
  it('still charges for the shell at zero infill', () => {
    const e = estimateFilament(bigBlock, profile({ infill: 0 }));
    expect(e.material_mm3).toBeGreaterThan(0);
    expect(e.fill).toBeGreaterThan(0.05);
    expect(e.fill).toBeLessThan(0.5);
  });

  /** A small part is mostly shell, so infill barely moves it. */
  it('is nearly solid whatever the infill, once the part is small', () => {
    const small = [measurePart(box(3, 3, 3))];
    const hollow = estimateFilament(small, profile({ infill: 0 }));
    expect(hollow.fill).toBeGreaterThan(0.9);
  });

  it('never claims more plastic than the part is big', () => {
    const e = estimateFilament(bigBlock, profile({ wallLoops: 6, solidLayers: 12, infill: 1 }));
    expect(e.material_mm3).toBeLessThanOrEqual(e.volume_mm3 + 1e-6);
  });

  it('converts to mass, length and cost consistently', () => {
    const e = estimateFilament(bigBlock, profile({ infill: 1, density_g_cm3: 1.24, pricePerKg: 25 }));
    // 100 x 100 x 20 mm = 200 cm³, at 1.24 g/cm³.
    expect(e.mass_g).toBeCloseTo(200 * 1.24, 1);
    expect(e.cost).toBeCloseTo((200 * 1.24) / 1000 * 25, 3);

    // 1.75 mm filament: volume / cross-section, in metres.
    const crossSection = Math.PI * (1.75 / 2) ** 2;
    expect(e.length_m).toBeCloseTo(200_000 / crossSection / 1000, 3);
  });

  it('scales mass with the material, not with the geometry', () => {
    const pla = estimateFilament(bigBlock, profile({ density_g_cm3: 1.24 }));
    const abs = estimateFilament(bigBlock, profile({ density_g_cm3: 1.04 }));
    expect(abs.mass_g / pla.mass_g).toBeCloseTo(1.04 / 1.24, 6);
    expect(abs.material_mm3).toBeCloseTo(pla.material_mm3, 6);
  });

  it('adds parts together', () => {
    const one = estimateFilament([measurePart(box(10, 10, 10))], profile({ infill: 1 }));
    const two = estimateFilament(
      [measurePart(box(10, 10, 10)), measurePart(box(10, 10, 10, 'b'))],
      profile({ infill: 1 }),
    );
    expect(two.volume_mm3).toBeCloseTo(one.volume_mm3 * 2, 3);
    expect(two.mass_g).toBeCloseTo(one.mass_g * 2, 3);
  });

  /**
   * An inverted mesh has negative volume. Validation blocks it separately, but
   * one bad part must not drag the whole estimate negative.
   */
  it('ignores a part with negative volume instead of subtracting it', () => {
    const inverted: PartMeasure = {
      name: 'inside-out',
      volume_mm3: -5000,
      solidArea_mm2: 400,
      wallArea_mm2: 300,
    };
    const e = estimateFilament([...bigBlock, inverted], profile());
    const clean = estimateFilament(bigBlock, profile());
    expect(e.material_mm3).toBeCloseTo(clean.material_mm3, 6);
    expect(e.mass_g).toBeGreaterThan(0);
  });

  it('returns zeroes rather than NaN when there is nothing to print', () => {
    const e = estimateFilament([], profile());
    expect(e).toMatchObject({ volume_mm3: 0, material_mm3: 0, mass_g: 0, cost: 0, fill: 0 });
    expect(Number.isNaN(e.hours)).toBe(false);
  });

  it('takes longer at a lower speed and a finer layer', () => {
    const fast = estimateFilament(bigBlock, profile({ speed_mm_s: 120 }));
    const slow = estimateFilament(bigBlock, profile({ speed_mm_s: 30 }));
    expect(slow.hours).toBeCloseTo(fast.hours * 4, 3);

    const coarse = estimateFilament(bigBlock, profile({ layerHeight_mm: 0.3 }));
    const fine = estimateFilament(bigBlock, profile({ layerHeight_mm: 0.1 }));
    expect(fine.hours).toBeGreaterThan(coarse.hours);
  });

  /** A wider nozzle lays a wider line, so the shell holds more plastic. */
  it('spends more on the shell with a wider nozzle', () => {
    const fine = estimateFilament(bigBlock, profile({ nozzleDiameter_mm: 0.4, infill: 0 }));
    const wide = estimateFilament(bigBlock, profile({ nozzleDiameter_mm: 0.8, infill: 0 }));
    expect(wide.material_mm3).toBeGreaterThan(fine.material_mm3);
  });
});

describe('formatDuration', () => {
  it('reads as a person would say it', () => {
    expect(formatDuration(2.75)).toBe('2 h 45 m');
    expect(formatDuration(0.3)).toBe('18 m');
    expect(formatDuration(1)).toBe('1 h 0 m');
  });

  it('says nothing rather than "0 m" when there is no answer', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(NaN)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});
