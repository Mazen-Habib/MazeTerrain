/**
 * Engraved label (docs/02-feature-spec.md F5.1).
 *
 * The font is coordinates typed by hand, and no assertion catches a letter that
 * is simply the wrong shape — `scripts/render-font.ts` draws it to a PNG for
 * that. What is testable is the layout arithmetic and the tool geometry: a
 * groove of a readable weight, cut to the right depth, set along the frame
 * rather than across it, and knowing when it has run off the plaque.
 */
import { describe, expect, it } from 'vitest';
import { CAP_HEIGHT, layoutText } from '../src/geometry/strokeFont';
import {
  buildBaseline,
  buildLabelTool,
  labelCoverage,
  placeText,
  resolveStrokeWidth_mm,
} from '../src/geometry/label';
import { validateMesh } from '../src/geometry/validate';
import type { MultiPolygon, Ring } from '../src/geometry/polygons';

describe('layoutText', () => {
  it('scales to the cap height it is given', () => {
    const laid = layoutText('I', 7);
    let top = -Infinity;
    for (const path of laid.paths) for (const [, y] of path) top = Math.max(top, y);
    expect(top).toBeCloseTo(7, 6);
    expect(laid.height_mm).toBe(7);
  });

  it('sits on a baseline at zero', () => {
    const laid = layoutText('HELLO', 5);
    let bottom = Infinity;
    for (const path of laid.paths) for (const [, y] of path) bottom = Math.min(bottom, y);
    expect(bottom).toBeCloseTo(0, 6);
  });

  it('starts at x = 0 and gets wider with more text', () => {
    const one = layoutText('A', 5);
    const many = layoutText('AAAA', 5);

    let left = Infinity;
    for (const path of one.paths) for (const [x] of path) left = Math.min(left, x);
    expect(left).toBeCloseTo(0, 6);
    expect(many.width_mm).toBeGreaterThan(one.width_mm * 3);
  });

  it('sets lowercase as capitals rather than dropping it', () => {
    expect(layoutText('abc', 5).paths.length).toBe(layoutText('ABC', 5).paths.length);
    expect(layoutText('abc', 5).missing).toEqual([]);
  });

  it('names characters it cannot draw, and still leaves a gap for them', () => {
    const laid = layoutText('A€B', 5);
    expect(laid.missing).toEqual(['€']);
    expect(laid.width_mm).toBeGreaterThan(layoutText('AB', 5).width_mm);
  });

  it('has a glyph for everything a plaque needs', () => {
    const laid = layoutText(
      'MARGALLA TRAIL 5 · 42.2 KM · 1,860 M · 33.7°N 73.1°E (2026)',
      5,
    );
    expect(laid.missing).toEqual([]);
  });

  it('lays out nothing for an empty string', () => {
    expect(layoutText('', 5).paths).toEqual([]);
    expect(layoutText('   ', 5).width_mm).toBeGreaterThan(0);
  });

  it('keeps a spacing that does not depend on cap height', () => {
    expect(layoutText('MAZE', 10).width_mm).toBeCloseTo(layoutText('MAZE', 5).width_mm * 2, 6);
  });

  it('exposes the cap height its coordinates are drawn on', () => {
    expect(CAP_HEIGHT).toBe(14);
  });

  it('keeps every glyph, so text can be set along a curve', () => {
    const laid = layoutText('MAZE', 5);
    expect(laid.glyphs.map((g) => g.char).join('')).toBe('MAZE');
    // Each one advances past the last.
    for (let i = 1; i < laid.glyphs.length; i++) {
      expect(laid.glyphs[i].x_mm).toBeGreaterThan(laid.glyphs[i - 1].x_mm);
    }
  });
});

const options = {
  capHeight_mm: 5,
  depth_mm: 0.6,
  strokeWidth_mm: 'auto' as number | 'auto',
  minStrokeWidth_mm: 0.4,
  surfaceZ_mm: 6,
};

/** A square model 100 mm across. The frame sits outside this. */
function squareRing(half = 50): Ring {
  return [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
}

function circleRing(radius: number, n = 180): Ring {
  const ring: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return ring;
}

/** Where the baseline sits so the text is centred across the band. */
const bandOffset = (frameWidth: number, cap: number) => (frameWidth + cap) / 2;

function zRange(positions: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    lo = Math.min(lo, positions[i]);
    hi = Math.max(hi, positions[i]);
  }
  return [lo, hi];
}

describe('stroke weight', () => {
  it('defaults to a bold weight, not a hairline', () => {
    const width = resolveStrokeWidth_mm(options);
    expect(width).toBeCloseTo(options.capHeight_mm / 7, 6);
    expect(width).toBeGreaterThan(options.minStrokeWidth_mm * 1.5);
  });

  it('scales with the label size, so weight stays proportional', () => {
    const small = resolveStrokeWidth_mm({ ...options, capHeight_mm: 4 });
    const large = resolveStrokeWidth_mm({ ...options, capHeight_mm: 12 });
    expect(large / small).toBeCloseTo(3, 6);
  });

  it('takes an explicit width', () => {
    expect(resolveStrokeWidth_mm({ ...options, strokeWidth_mm: 0.9 })).toBeCloseTo(0.9, 6);
  });

  it('never goes below one nozzle, however thin it is asked for', () => {
    expect(resolveStrokeWidth_mm({ ...options, strokeWidth_mm: 0.05 })).toBe(
      options.minStrokeWidth_mm,
    );
  });

  it('caps a weight that would weld the letters shut', () => {
    expect(resolveStrokeWidth_mm({ ...options, strokeWidth_mm: 99 })).toBeLessThan(
      options.capHeight_mm / 4,
    );
  });
});

describe('buildBaseline', () => {
  const at = (b: NonNullable<ReturnType<typeof buildBaseline>>) =>
    b.lengths.findIndex((l) => l >= b.centre_mm);

  it('starts at the bottom of the model and reads left to right', () => {
    const baseline = buildBaseline(squareRing(), bandOffset(10, 5));
    expect(baseline).not.toBeNull();

    const i = at(baseline!);
    expect(baseline!.points[i][1]).toBeLessThan(-50);
    expect(Math.abs(baseline!.points[i][0])).toBeLessThan(1);
    expect(baseline!.tangents[i][0]).toBeGreaterThan(0.9);
  });

  it('points the text up towards the model, so it reads the right way round', () => {
    const baseline = buildBaseline(squareRing(), bandOffset(10, 5));
    expect(baseline!.normals[at(baseline!)][1]).toBeGreaterThan(0.9);
  });

  it('sits outside the boundary, where the frame now is', () => {
    const baseline = buildBaseline(circleRing(50), bandOffset(10, 5));
    for (const [x, y] of baseline!.points) {
      expect(Math.hypot(x, y)).toBeGreaterThan(50);
    }
  });

  it('measures a circle round, not across', () => {
    const baseline = buildBaseline(circleRing(50), 0);
    expect(baseline!.total_mm).toBeCloseTo(2 * Math.PI * 50, 0);
  });

  it('refuses a boundary that is not one', () => {
    expect(buildBaseline([], 5)).toBeNull();
    expect(
      buildBaseline(
        [
          [0, 0],
          [1, 1],
        ],
        5,
      ),
    ).toBeNull();
  });
});

describe('placeText', () => {
  /**
   * The bug this replaces: text was laid on a straight line under the model, so
   * on a circular selection it ran off the band at both ends and read as though
   * the model were a rectangle.
   */
  it('follows a circular frame instead of cutting across it', () => {
    const radius = 50;
    const frameWidth = 10;
    const baseline = buildBaseline(circleRing(radius), bandOffset(frameWidth, 5))!;
    const placed = placeText('MARGALLA TRAIL', options, baseline);

    let near = Infinity;
    let far = 0;
    for (const path of placed.paths) {
      for (const [x, y] of path) {
        const r = Math.hypot(x, y);
        near = Math.min(near, r);
        far = Math.max(far, r);
      }
    }
    expect(near).toBeGreaterThan(radius);
    expect(far).toBeLessThan(radius + frameWidth);
  });

  it('keeps a straight bottom edge straight', () => {
    const baseline = buildBaseline(squareRing(), bandOffset(10, 5))!;
    const placed = placeText('MAZE', options, baseline);

    let lo = Infinity;
    let hi = -Infinity;
    for (const path of placed.paths) {
      for (const [, y] of path) {
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
    }
    expect(hi - lo).toBeCloseTo(options.capHeight_mm, 1);
  });

  it('centres the text on the bottom of the model', () => {
    const baseline = buildBaseline(squareRing(), bandOffset(10, 5))!;
    const placed = placeText('MAZE', options, baseline);

    let left = Infinity;
    let right = -Infinity;
    for (const path of placed.paths) {
      for (const [x] of path) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    expect((left + right) / 2).toBeCloseTo(0, 0);
  });

  it('sets lowercase as capitals rather than dropping it', () => {
    const baseline = buildBaseline(squareRing(), 7.5)!;
    expect(placeText('maze', options, baseline).paths.length).toBe(
      placeText('MAZE', options, baseline).paths.length,
    );
  });
});

describe('buildLabelTool', () => {
  const baseline = buildBaseline(squareRing(), bandOffset(10, 5))!;
  const tool = buildLabelTool('MAZE 5', options, baseline);

  it('is a closed solid', () => {
    expect(tool.mesh.triangles).toBeGreaterThan(0);
    const v = validateMesh(tool.mesh.positions, tool.mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  /**
   * A tool that stops exactly at the surface leaves a skin over the groove —
   * the same fault the route channel had
   * (08-pitfalls.md#the-channel-decapitates-what-it-crosses), in miniature.
   */
  it('cuts to the depth asked for and breaks the surface above it', () => {
    const [lo, hi] = zRange(tool.mesh.positions);
    expect(lo).toBeCloseTo(options.surfaceZ_mm - options.depth_mm, 4);
    expect(hi).toBeGreaterThan(options.surfaceZ_mm);
  });

  it('reports the weight it actually used', () => {
    expect(tool.strokeWidth_mm).toBeCloseTo(resolveStrokeWidth_mm(options), 6);
  });

  it('builds nothing for text that is not there', () => {
    expect(buildLabelTool('', options, baseline).mesh.triangles).toBe(0);
    expect(buildLabelTool('   ', options, baseline).mesh.triangles).toBe(0);
    expect(buildLabelTool('MAZE', { ...options, depth_mm: 0 }, baseline).mesh.triangles).toBe(0);
  });
});

describe('labelCoverage', () => {
  /** The frame band: a 100 mm square model with a 10 mm rim outside it. */
  const squareBand: MultiPolygon = [[squareRing(60), squareRing(50)]];
  const baseline = buildBaseline(squareRing(), bandOffset(10, 5))!;

  it('reports everything on the plaque when the text fits', () => {
    expect(labelCoverage('MAZE', options, baseline, squareBand)).toBe(1);
  });

  it('reports the shortfall when the text is taller than the band', () => {
    const tall = { ...options, capHeight_mm: 22 };
    const wide = buildBaseline(squareRing(), bandOffset(10, 22))!;
    expect(labelCoverage('MAZE', tall, wide, squareBand)).toBeLessThan(0.9);
  });

  it('treats no text as fully covered rather than as a failure', () => {
    expect(labelCoverage('', options, baseline, squareBand)).toBe(1);
    expect(labelCoverage('MAZE', options, baseline, [])).toBeLessThan(0.01);
  });
});
