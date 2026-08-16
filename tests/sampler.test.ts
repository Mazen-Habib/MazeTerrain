import { describe, expect, it } from 'vitest';
import { decodePixels, TERRARIUM_NODATA } from '../src/data/dem/datasets';
import { inpaintNoData, isNoData, sampleBilinear, type Mosaic } from '../src/data/dem/sampler';
import { chooseZoom, latToTileY, lonToTileX, metresPerPixel, tileRangeForBBox } from '../src/data/dem/tiles';

function mosaic(width: number, height: number, values: number[]): Mosaic {
  return {
    data: Float32Array.from(values),
    width,
    height,
    z: 10,
    tileSize: 256,
    originPxX: 0,
    originPxY: 0,
  };
}

describe('terrarium decoding', () => {
  it('decodes the reference formula', () => {
    // (R*256 + G + B/256) - 32768
    const rgba = new Uint8ClampedArray([128, 100, 128, 255]);
    const out = new Float32Array(1);
    decodePixels(rgba, out, 'terrarium');
    expect(out[0]).toBeCloseTo(128 * 256 + 100 + 0.5 - 32768, 6);
  });

  it('decodes sea level', () => {
    const rgba = new Uint8ClampedArray([128, 0, 0, 255]);
    const out = new Float32Array(1);
    decodePixels(rgba, out, 'terrarium');
    expect(out[0]).toBe(0);
  });

  it('decodes black pixels to the NoData sentinel', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255]);
    const out = new Float32Array(1);
    decodePixels(rgba, out, 'terrarium');
    expect(out[0]).toBe(TERRARIUM_NODATA);
    expect(isNoData(out[0])).toBe(true);
  });

  it('decodes the mapbox formula', () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 255]);
    const out = new Float32Array(1);
    decodePixels(rgba, out, 'mapbox');
    // Float32 storage, so ~1e-4 absolute precision at this magnitude. That is
    // three orders of magnitude below a printable layer, which is what matters.
    expect(out[0]).toBeCloseTo(-10000 + (1 * 65536 + 2 * 256 + 3) * 0.1, 3);
  });
});

describe('sampleBilinear', () => {
  // 2x2: 0 10
  //      20 30   (row 0 first)
  const m = mosaic(2, 2, [0, 10, 20, 30]);

  it('returns exact values at grid points', () => {
    expect(sampleBilinear(m, 0, 0)).toBe(0);
    expect(sampleBilinear(m, 1, 0)).toBe(10);
    expect(sampleBilinear(m, 0, 1)).toBe(20);
    expect(sampleBilinear(m, 1, 1)).toBe(30);
  });

  it('interpolates rather than snapping to the nearest neighbour', () => {
    // Nearest-neighbour would give 0 or 30 here; bilinear gives the mean.
    expect(sampleBilinear(m, 0.5, 0.5)).toBeCloseTo(15, 6);
    expect(sampleBilinear(m, 0.25, 0)).toBeCloseTo(2.5, 6);
    expect(sampleBilinear(m, 0, 0.75)).toBeCloseTo(15, 6);
  });

  it('produces a linear ramp across a linear field, with no terracing', () => {
    const width = 8;
    const ramp = mosaic(
      width,
      2,
      Array.from({ length: width * 2 }, (_, i) => (i % width) * 3),
    );
    for (let k = 0; k <= 20; k++) {
      const x = (k / 20) * (width - 1);
      expect(sampleBilinear(ramp, x, 0)).toBeCloseTo(x * 3, 5);
    }
  });

  it('clamps outside the mosaic instead of returning NaN', () => {
    expect(sampleBilinear(m, -5, -5)).toBe(0);
    expect(sampleBilinear(m, 99, 99)).toBe(30);
  });
});

describe('inpaintNoData', () => {
  it('fills a hole from its valid neighbours', () => {
    const m = mosaic(3, 3, [10, 10, 10, 10, TERRARIUM_NODATA, 10, 10, 10, 10]);
    const repaired = inpaintNoData(m);
    expect(repaired).toBe(1);
    expect(m.data[4]).toBeCloseTo(10, 6);
  });

  it('leaves valid data untouched', () => {
    const original = [1, 2, 3, 4, TERRARIUM_NODATA, 6, 7, 8, 9];
    const m = mosaic(3, 3, original);
    inpaintNoData(m);
    for (let i = 0; i < 9; i++) {
      if (i !== 4) expect(m.data[i]).toBe(original[i]);
    }
  });

  it('never leaves a sentinel behind, even for a large hole', () => {
    const width = 12;
    const data = new Array(width * width).fill(TERRARIUM_NODATA);
    // Only the outer ring is valid.
    for (let i = 0; i < width; i++) {
      data[i] = 100;
      data[(width - 1) * width + i] = 100;
      data[i * width] = 100;
      data[i * width + width - 1] = 100;
    }
    const m = mosaic(width, width, data);
    inpaintNoData(m);
    for (let i = 0; i < m.data.length; i++) {
      expect(isNoData(m.data[i])).toBe(false);
    }
  });

  it('does nothing when there is nothing to repair', () => {
    const m = mosaic(2, 2, [1, 2, 3, 4]);
    expect(inpaintNoData(m)).toBe(0);
  });
});

describe('tile arithmetic', () => {
  it('maps the prime meridian and equator to the tile grid centre', () => {
    expect(lonToTileX(0, 1)).toBeCloseTo(1, 9);
    expect(latToTileY(0, 1)).toBeCloseTo(1, 9);
  });

  it('runs tile Y southward', () => {
    expect(latToTileY(60, 4)).toBeLessThan(latToTileY(-60, 4));
  });

  it('picks a zoom at least as fine as the requested resolution', () => {
    const lat = 46;
    const z = chooseZoom(30, lat, 512, 14);
    expect(metresPerPixel(z, lat, 512)).toBeLessThanOrEqual(30);
    // ...and not needlessly finer.
    expect(metresPerPixel(z - 1, lat, 512)).toBeGreaterThan(30);
  });

  it('includes a one-tile margin so bilinear sampling has neighbours', () => {
    const z = 10;
    const bare = tileRangeForBBox(7.62, 45.94, 7.74, 46.02, z, 0);
    const withMargin = tileRangeForBBox(7.62, 45.94, 7.74, 46.02, z, 1);
    expect(withMargin.xMin).toBe(bare.xMin - 1);
    expect(withMargin.xMax).toBe(bare.xMax + 1);
    expect(withMargin.yMin).toBe(bare.yMin - 1);
    expect(withMargin.yMax).toBe(bare.yMax + 1);
  });

  it('clamps the range at the edges of the world', () => {
    const r = tileRangeForBBox(-180, -85, -179, -84, 2, 1);
    expect(r.xMin).toBeGreaterThanOrEqual(0);
    expect(r.yMax).toBeLessThanOrEqual(3);
  });
});
