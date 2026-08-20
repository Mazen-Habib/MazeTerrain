import { describe, expect, it } from 'vitest';
import {
  finishPolygon,
  metresBetween,
  moveShape,
  resizeShape,
  shapeCentre,
  shapeFromDrag,
  shapeHandles,
  shapeToGeoJSON,
  type LonLat,
} from '../src/map/draw';
import { selectionArea_km2, selectionBBox } from '../src/geometry/selection';
import { bboxCentre } from '../src/geometry/coords';

const CENTRE: LonLat = [7.68, 45.98];
const NORTH_60: LonLat = [18.95, 69.65];

describe('shapeFromDrag', () => {
  it('makes a rectangle from two corners in any order', () => {
    const a = shapeFromDrag('rectangle', [7.6, 45.9], [7.7, 46.0]);
    const b = shapeFromDrag('rectangle', [7.7, 46.0], [7.6, 45.9]);
    expect(a).toEqual(b);
    if (a?.kind !== 'rectangle') throw new Error('expected a rectangle');
    expect(a.bbox).toEqual({ west: 7.6, east: 7.7, south: 45.9, north: 46.0 });
  });

  /**
   * A degree of longitude is shorter than a degree of latitude everywhere but
   * the equator, so equalising the spans in degrees would print a rectangle.
   */
  it('makes a square that is square on the ground, not in degrees', () => {
    for (const start of [CENTRE, NORTH_60]) {
      const shape = shapeFromDrag('square', start, [start[0] + 0.2, start[1] + 0.05]);
      if (shape?.kind !== 'rectangle') throw new Error('expected a rectangle');

      const b = shape.bbox;
      const width_m = metresBetween([b.west, b.south], [b.east, b.south]);
      const height_m = metresBetween([b.west, b.south], [b.west, b.north]);
      expect(width_m / height_m).toBeCloseTo(1, 2);
    }
  });

  it('grows a circle from the centre outwards', () => {
    const shape = shapeFromDrag('circle', CENTRE, [7.72, 45.98]);
    if (shape?.kind !== 'circle') throw new Error('expected a circle');
    expect(shape.lon).toBe(CENTRE[0]);
    expect(shape.lat).toBe(CENTRE[1]);
    expect(shape.radius_m).toBeCloseTo(metresBetween(CENTRE, [7.72, 45.98]), 3);
  });

  it('makes a hexagon with six sides at the requested radius', () => {
    const shape = shapeFromDrag('hexagon', CENTRE, [7.72, 45.98]);
    if (shape?.kind !== 'polygon') throw new Error('expected a polygon');
    expect(shape.ring).toHaveLength(6);

    const radius = metresBetween(CENTRE, [7.72, 45.98]);
    for (const vertex of shape.ring) {
      expect(metresBetween(CENTRE, vertex) / radius).toBeCloseTo(1, 2);
    }
  });

  it('rejects a zero-size drag rather than making a degenerate selection', () => {
    expect(shapeFromDrag('rectangle', CENTRE, CENTRE)).toBeNull();
    expect(shapeFromDrag('circle', CENTRE, CENTRE)).toBeNull();
    expect(shapeFromDrag('hexagon', CENTRE, CENTRE)).toBeNull();
  });

  it('does not build a polygon from a drag', () => {
    expect(shapeFromDrag('polygon', CENTRE, [7.7, 46])).toBeNull();
  });
});

describe('finishPolygon', () => {
  it('needs at least a triangle', () => {
    expect(finishPolygon([CENTRE, [7.7, 46]])).toBeNull();
    expect(finishPolygon([CENTRE, [7.7, 46], [7.6, 46]])).not.toBeNull();
  });
});

describe('moveShape', () => {
  it('slides a shape without changing its size', () => {
    const circle = shapeFromDrag('circle', CENTRE, [7.72, 45.98]);
    if (circle?.kind !== 'circle') throw new Error('expected a circle');

    const moved = moveShape(circle, 0.5, -0.25);
    if (moved.kind !== 'circle') throw new Error('expected a circle');
    expect(moved.lon).toBeCloseTo(circle.lon + 0.5, 9);
    expect(moved.lat).toBeCloseTo(circle.lat - 0.25, 9);
    expect(moved.radius_m).toBe(circle.radius_m);
  });

  it('moves every vertex of a polygon by the same delta', () => {
    const hex = shapeFromDrag('hexagon', CENTRE, [7.72, 45.98]);
    if (hex?.kind !== 'polygon') throw new Error('expected a polygon');

    const moved = moveShape(hex, 1, 1);
    if (moved.kind !== 'polygon') throw new Error('expected a polygon');
    moved.ring.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(hex.ring[i][0] + 1, 9);
      expect(p[1]).toBeCloseTo(hex.ring[i][1] + 1, 9);
    });
  });

  it('keeps a rectangle the same size', () => {
    const rect = shapeFromDrag('rectangle', [7.6, 45.9], [7.7, 46.0]);
    if (rect?.kind !== 'rectangle') throw new Error('expected a rectangle');
    const moved = moveShape(rect, 0.1, 0.1);
    if (moved.kind !== 'rectangle') throw new Error('expected a rectangle');
    expect(moved.bbox.east - moved.bbox.west).toBeCloseTo(0.1, 9);
    expect(moved.bbox.north - moved.bbox.south).toBeCloseTo(0.1, 9);
  });
});

describe('resizeShape', () => {
  it('keeps the centre fixed while the handle follows the pointer', () => {
    const circle = shapeFromDrag('circle', CENTRE, [7.72, 45.98]);
    if (circle?.kind !== 'circle') throw new Error('expected a circle');

    const resized = resizeShape(circle, [7.78, 45.98]);
    if (resized.kind !== 'circle') throw new Error('expected a circle');
    expect(shapeCentre(resized)).toEqual(shapeCentre(circle));
    expect(resized.radius_m).toBeGreaterThan(circle.radius_m);
    expect(resized.radius_m).toBeCloseTo(metresBetween(CENTRE, [7.78, 45.98]), 2);
  });

  it('scales a polygon about its centre', () => {
    const hex = shapeFromDrag('hexagon', CENTRE, [7.72, 45.98]);
    if (hex?.kind !== 'polygon') throw new Error('expected a polygon');

    const before = metresBetween(shapeCentre(hex), shapeHandles(hex).resize);
    const resized = resizeShape(hex, [7.8, 45.98]);
    const after = metresBetween(shapeCentre(resized), shapeHandles(resized).resize);

    expect(after).toBeGreaterThan(before);
    if (resized.kind !== 'polygon') throw new Error('expected a polygon');
    expect(resized.ring).toHaveLength(6);
  });

  it('never collapses a shape to nothing', () => {
    const hex = shapeFromDrag('hexagon', CENTRE, [7.72, 45.98]);
    if (hex?.kind !== 'polygon') throw new Error('expected a polygon');
    const collapsed = resizeShape(hex, CENTRE);
    if (collapsed.kind !== 'polygon') throw new Error('expected a polygon');
    expect(metresBetween(shapeCentre(collapsed), collapsed.ring[0])).toBeGreaterThan(0);
  });
});

describe('shapeHandles', () => {
  it('puts the resize handle on the outline', () => {
    const circle = shapeFromDrag('circle', CENTRE, [7.72, 45.98]);
    if (circle?.kind !== 'circle') throw new Error('expected a circle');
    const handles = shapeHandles(circle);
    expect(metresBetween(handles.centre, handles.resize)).toBeCloseTo(circle.radius_m, 2);
  });
});

describe('shapeToGeoJSON', () => {
  it('closes the ring', () => {
    for (const shape of [
      shapeFromDrag('rectangle', [7.6, 45.9], [7.7, 46.0]),
      shapeFromDrag('circle', CENTRE, [7.72, 45.98]),
      shapeFromDrag('hexagon', CENTRE, [7.72, 45.98]),
    ]) {
      if (!shape) throw new Error('expected a shape');
      const ring = shapeToGeoJSON(shape).geometry.coordinates[0];
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });

  it('turns a circle into enough segments to read as round', () => {
    const circle = shapeFromDrag('circle', CENTRE, [7.72, 45.98]);
    if (!circle) throw new Error('expected a circle');
    expect(shapeToGeoJSON(circle).geometry.coordinates[0].length).toBeGreaterThan(128);
  });
});

describe('drawn shapes feed the geometry pipeline', () => {
  it('gives a circle an area of about pi r squared', () => {
    const circle = shapeFromDrag('circle', CENTRE, [7.72, 45.98]);
    if (circle?.kind !== 'circle') throw new Error('expected a circle');

    const area = selectionArea_km2(circle, bboxCentre(selectionBBox(circle)));
    const expected = (Math.PI * circle.radius_m ** 2) / 1e6;
    expect(area / expected).toBeCloseTo(1, 2);
  });

  it('bounds a hexagon inside its own bbox', () => {
    const hex = shapeFromDrag('hexagon', CENTRE, [7.72, 45.98]);
    if (hex?.kind !== 'polygon') throw new Error('expected a polygon');

    const b = selectionBBox(hex);
    for (const [lon, lat] of hex.ring) {
      expect(lon).toBeGreaterThanOrEqual(b.west - 1e-9);
      expect(lon).toBeLessThanOrEqual(b.east + 1e-9);
      expect(lat).toBeGreaterThanOrEqual(b.south - 1e-9);
      expect(lat).toBeLessThanOrEqual(b.north + 1e-9);
    }
  });
});
