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
