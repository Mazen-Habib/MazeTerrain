/**
 * Keychain outline versus the selection (docs/02-feature-spec.md F13).
 *
 * The Outline setting and the map selection used to be independent, so they
 * could disagree: a circle drawn with the setting on Square built a disc whose
 * ring hole was placed for a square corner, outside the model. These pin the
 * three things that keep them the same shape.
 */
import { describe, expect, it } from 'vitest';
import {
  keychainSelection,
  modelRingLonLat,
  reshapeSelection,
  selectionBBox,
  selectionOutline,
  type SelectionShape,
} from '../src/geometry/selection';

const M_PER_DEG = (6378137 * Math.PI) / 180;

describe('the outline follows the selection', () => {
  it('reads a circle as a circle and a rectangle as a square', () => {
    expect(selectionOutline({ kind: 'circle', lon: 7, lat: 46, radius_m: 4000 })).toBe('circle');
    expect(
      selectionOutline({ kind: 'rectangle', bbox: { west: 7, south: 46, east: 7.1, north: 46.1 } }),
    ).toBe('square');
  });

  it('has no opinion about a free polygon', () => {
    const hexagon: SelectionShape = {
      kind: 'polygon',
      ring: [
        [7, 46],
        [7.1, 46],
        [7.15, 46.05],
        [7.1, 46.1],
        [7, 46.1],
        [6.95, 46.05],
      ],
    };
    expect(selectionOutline(hexagon)).toBeNull();
  });
});

describe('reshaping', () => {
  it('makes a square that is square on the ground, not in degrees', () => {
    const square = keychainSelection(7.6586, 45.9763, 4500, 'square');
    expect(square.kind).toBe('rectangle');
    const { west, south, east, north } = selectionBBox(square);
    const width_m = (east - west) * M_PER_DEG * Math.cos((45.9763 * Math.PI) / 180);
    const height_m = (north - south) * M_PER_DEG;
    expect(width_m).toBeCloseTo(9000, 0);
    expect(height_m).toBeCloseTo(9000, 0);
  });

  it('keeps the centre and the width when a circle becomes a square', () => {
    const circle: SelectionShape = { kind: 'circle', lon: 7.6586, lat: 45.9763, radius_m: 4500 };
    const square = reshapeSelection(circle, 'square');
    expect(selectionOutline(square)).toBe('square');
    const { west, south, east, north } = selectionBBox(square);
    expect((west + east) / 2).toBeCloseTo(7.6586, 9);
    expect((south + north) / 2).toBeCloseTo(45.9763, 9);
    expect((north - south) * M_PER_DEG).toBeCloseTo(9000, 0);
  });

  /** Flipping back and forth must not grow or drift the selection. */
  it('round-trips without growing', () => {
    let shape: SelectionShape = { kind: 'circle', lon: 7.6586, lat: 45.9763, radius_m: 4500 };
    for (let i = 0; i < 5; i++) {
      shape = reshapeSelection(reshapeSelection(shape, 'square'), 'circle');
    }
    expect(shape.kind).toBe('circle');
    if (shape.kind !== 'circle') return;
    expect(shape.radius_m).toBeCloseTo(4500, 3);
    expect(shape.lon).toBeCloseTo(7.6586, 9);
    expect(shape.lat).toBeCloseTo(45.9763, 9);
  });
});

describe('the ring the model is built from', () => {
  const rect: SelectionShape = {
    kind: 'rectangle',
    bbox: { west: 7.6, south: 45.94, east: 7.72, north: 46.01 },
  };
  const keychain = { enabled: true, cornerRadius_frac: 0.125 };

  it('rounds a rectangle in keychain mode, inside its own bbox', () => {
    const ring = modelRingLonLat(rect, keychain);
    expect(ring).not.toBeNull();
    const { west, south, east, north } = rect.bbox;
    for (const [lon, lat] of ring!) {
      expect(lon).toBeGreaterThanOrEqual(west - 1e-9);
      expect(lon).toBeLessThanOrEqual(east + 1e-9);
      expect(lat).toBeGreaterThanOrEqual(south - 1e-9);
      expect(lat).toBeLessThanOrEqual(north + 1e-9);
      // No vertex sits on a sharp corner.
      expect(Math.hypot(lon - east, lat - north)).toBeGreaterThan(1e-4);
    }
  });

  it('leaves a rectangle alone outside keychain mode, or with no rounding', () => {
    expect(modelRingLonLat(rect, { enabled: false, cornerRadius_frac: 0.125 })).toBeNull();
    expect(modelRingLonLat(rect, { enabled: true, cornerRadius_frac: 0 })).toBeNull();
  });

  it('passes a circle through unchanged', () => {
    const ring = modelRingLonLat({ kind: 'circle', lon: 7, lat: 46, radius_m: 4000 }, keychain);
    expect(ring!.length).toBeGreaterThanOrEqual(128);
  });
});
