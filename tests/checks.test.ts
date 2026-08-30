import { describe, expect, it } from 'vitest';
import { printChecks } from '../src/geometry/assemble';
import { testConfig } from './helpers';

function codes(warnings: ReturnType<typeof printChecks>) {
  return warnings.map((w) => w.code);
}

describe('printChecks', () => {
  it('passes a healthy model silently', () => {
    const config = testConfig({ baseThickness_mm: 3, layerHeight_mm: 0.2 });
    expect(printChecks(config, [100, 75, 13], 500_000)).toEqual([]);
  });

  it('warns on a base thinner than three layers', () => {
    const config = testConfig({ baseThickness_mm: 0.4, layerHeight_mm: 0.2 });
    const w = printChecks(config, [100, 75, 13], 1000);
    expect(codes(w)).toContain('thin-base');
    expect(w[0].message).toMatch(/0\.60 mm minimum/);
  });

  it('warns when the model is tall enough to tip over', () => {
    const config = testConfig({ baseThickness_mm: 3 });
    expect(codes(printChecks(config, [40, 30, 90], 1000))).toContain('tipping-risk');
  });

  it('warns above two million triangles', () => {
    const config = testConfig();
    expect(codes(printChecks(config, [100, 75, 13], 2_400_000))).toContain('triangle-count');
  });

  /**
   * docs/08-pitfalls.md#invisible-relief — found on the Flevoland preset, where
   * 16 m of relief over 13.6 km at 100 mm gives 0.18 mm of printed terrain.
   */
  /** docs/02-feature-spec.md F8, final check. */
  describe('bed size', () => {
    const bed = (size: [number, number] | null) => testConfig({ bedSize_mm: size });

    it('says nothing when the model fits', () => {
      expect(codes(printChecks(bed([256, 256]), [200, 150, 20], 1000))).not.toContain(
        'over-bed-size',
      );
    });

    it('warns when the model is larger than the bed', () => {
      const w = printChecks(bed([256, 256]), [300, 300, 20], 1000);
      expect(codes(w)).toContain('over-bed-size');
      expect(w.find((x) => x.code === 'over-bed-size')!.message).toMatch(/300 × 300/);
      // Never blocks: printing in sections is a legitimate plan.
      expect(w.every((x) => x.level === 'warn')).toBe(true);
    });

    /** A 300 x 100 model fits a 250 x 210 bed if you turn it. */
    it('counts a model that fits when rotated', () => {
      expect(codes(printChecks(bed([250, 210]), [200, 240, 20], 1000))).not.toContain(
        'over-bed-size',
      );
    });

    it('checks nothing when the user turned it off', () => {
      expect(codes(printChecks(bed(null), [900, 900, 20], 1000))).not.toContain('over-bed-size');
    });
  });

  describe('relief legibility', () => {
    it('flags relief below one layer height', () => {
      const config = testConfig({ baseThickness_mm: 3, layerHeight_mm: 0.2 });
      const w = printChecks(config, [100, 82, 3.18], 600_000);
      expect(codes(w)).toContain('invisible-relief');
      expect(w[0].message).toMatch(/flat plate/);
    });

    it('flags relief that is legible but faint', () => {
      const config = testConfig({ baseThickness_mm: 3, layerHeight_mm: 0.2 });
      expect(codes(printChecks(config, [100, 82, 3.4], 600_000))).toContain('low-relief');
    });

    it('says nothing once relief clears three layers', () => {
      const config = testConfig({ baseThickness_mm: 3, layerHeight_mm: 0.2 });
      expect(codes(printChecks(config, [100, 82, 3.8], 600_000))).toEqual([]);
    });

    it('scales the threshold with layer height', () => {
      // 0.3 mm of relief is fine at 0.05 mm layers and invisible at 0.4 mm.
      const fine = testConfig({ baseThickness_mm: 3, layerHeight_mm: 0.05 });
      const coarse = testConfig({ baseThickness_mm: 3, layerHeight_mm: 0.4 });
      expect(codes(printChecks(fine, [100, 82, 3.3], 1000))).toEqual([]);
      expect(codes(printChecks(coarse, [100, 82, 3.3], 1000))).toContain('invisible-relief');
    });
  });
});

/**
 * The bed check after a split (F12).
 *
 * A tiled model is deliberately larger than the bed; each PIECE is not. Saying
 * both "split into 4 pieces to fit your bed" and "larger than your bed" in the
 * same build is how a user learns to stop reading warnings.
 */
describe('bed check on a split model', () => {
  const config = testConfig({ bedSize_mm: [256, 256] });

  it('complains about an oversized model that was not split', () => {
    const warnings = printChecks(config, [400, 400, 30], 1000);
    const bed = warnings.find((w) => w.code === 'over-bed-size');
    expect(bed).toBeDefined();
    expect(bed!.message).toMatch(/Split to fit the bed/);
  });

  it('says nothing once the pieces fit, however big the model is', () => {
    const warnings = printChecks(config, [400, 400, 30], 1000, [200, 200, 30]);
    expect(warnings.find((w) => w.code === 'over-bed-size')).toBeUndefined();
  });

  /** Splitting is not a promise that it worked — a huge model can still overrun. */
  it('still complains when even the largest piece is too big', () => {
    const warnings = printChecks(config, [2000, 2000, 30], 1000, [300, 300, 30]);
    const bed = warnings.find((w) => w.code === 'over-bed-size');
    expect(bed).toBeDefined();
    expect(bed!.message).toMatch(/Even split/);
    expect(bed!.message).toMatch(/300 × 300/);
  });

  it('counts a piece that fits the bed turned', () => {
    const turned = testConfig({ bedSize_mm: [180, 300] });
    expect(
      printChecks(turned, [400, 400, 30], 1000, [280, 170, 30]).find(
        (w) => w.code === 'over-bed-size',
      ),
    ).toBeUndefined();
  });
});
