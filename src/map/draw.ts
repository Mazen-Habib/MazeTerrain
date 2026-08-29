/**
 * Selection shape drawing and editing — the maths, with no map in sight.
 *
 * Kept pure so the interaction can be tested without a WebGL context. MapView
 * turns pointer events into calls here and renders whatever comes back.
 *
 * docs/03-architecture.md suggests `terra-draw` or `mapbox-gl-draw` for this.
 * Neither draws a hexagon, and neither gives the centre-drag / edge-drag handle
 * pair the reference products use, so the interaction is hand-rolled — about
 * two hundred lines against a dependency plus an adapter plus its own opinions
 * about geometry. The shapes still normalise to the same SelectionShape union
 * the geometry pipeline already clips against, so nothing downstream changes.
 */
import { enuOrigin, projectENU, unprojectENU } from '../geometry/coords';
import type { SelectionShape } from '../geometry/selection';
import type { BBox } from '../geometry/types';

/**
 * `route` is not a selection shape — it draws a LINE, and finishes into a Route
 * rather than a SelectionShape (docs/02-feature-spec.md F1.3). It rides the same
 * click-to-add-vertex machinery as `polygon` because the interaction is
 * identical; only what comes out of it differs.
 */
export type DrawTool = 'rectangle' | 'square' | 'circle' | 'hexagon' | 'polygon' | 'route';

/** Tools that place vertices one click at a time rather than by dragging. */
export function isClickTool(tool: DrawTool | null): boolean {
  return tool === 'polygon' || tool === 'route';
}

export type LonLat = [number, number];

/** Metres between two geographic points, via the local ENU frame. */
export function metresBetween(a: LonLat, b: LonLat): number {
  const origin = enuOrigin(a[0], a[1]);
  const [x, y] = projectENU(b[0], b[1], origin);
  return Math.hypot(x, y);
}

function regularPolygon(centre: LonLat, radius_m: number, sides: number, rotation = 0): LonLat[] {
  const origin = enuOrigin(centre[0], centre[1]);
  const ring: LonLat[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    ring.push(unprojectENU(Math.cos(a) * radius_m, Math.sin(a) * radius_m, origin));
  }
  return ring;
}

/** Bounding box of two corners, in either order. */
function bboxOf(a: LonLat, b: LonLat): BBox {
  return {
    west: Math.min(a[0], b[0]),
    east: Math.max(a[0], b[0]),
    south: Math.min(a[1], b[1]),
    north: Math.max(a[1], b[1]),
  };
}

/**
 * A square on the ground, not a square in degrees.
 *
 * A degree of longitude is shorter than a degree of latitude everywhere except
 * the equator, so equalising the two spans in degrees would print a rectangle.
 */
function squareFromDrag(start: LonLat, current: LonLat): BBox {
  const origin = enuOrigin(start[0], start[1]);
  const [dx, dy] = projectENU(current[0], current[1], origin);
  const side = Math.max(Math.abs(dx), Math.abs(dy));

  const corner = unprojectENU(Math.sign(dx || 1) * side, Math.sign(dy || 1) * side, origin);
  return bboxOf(start, corner);
}

/** Build a shape from a press-drag-release. Rect and square drag corner to corner; the rest grow from the centre. */
export function shapeFromDrag(
  tool: DrawTool,
  start: LonLat,
  current: LonLat,
): SelectionShape | null {
  if (tool === 'rectangle') {
    const bbox = bboxOf(start, current);
    return bbox.east === bbox.west || bbox.north === bbox.south
      ? null
      : { kind: 'rectangle', bbox };
  }

  if (tool === 'square') {
    const bbox = squareFromDrag(start, current);
    return bbox.east === bbox.west ? null : { kind: 'rectangle', bbox };
  }

  const radius_m = metresBetween(start, current);
  if (radius_m < 1) return null;

  if (tool === 'circle') {
    return { kind: 'circle', lon: start[0], lat: start[1], radius_m };
  }

  if (tool === 'hexagon') {
    // Flat-top, which is how a hexagon tile reads on a print bed.
    return { kind: 'polygon', ring: regularPolygon(start, radius_m, 6, Math.PI / 6) };
  }

  return null;
}

export interface ShapeHandles {
  centre: LonLat;
  /** Drag target that changes the shape's size. */
  resize: LonLat;
}

export function shapeCentre(shape: SelectionShape): LonLat {
  if (shape.kind === 'circle') return [shape.lon, shape.lat];
  if (shape.kind === 'rectangle') {
    return [(shape.bbox.west + shape.bbox.east) / 2, (shape.bbox.south + shape.bbox.north) / 2];
  }
  let lon = 0;
  let lat = 0;
  for (const p of shape.ring) {
    lon += p[0];
    lat += p[1];
  }
  return [lon / shape.ring.length, lat / shape.ring.length];
}

export function shapeHandles(shape: SelectionShape): ShapeHandles {
  const centre = shapeCentre(shape);

  if (shape.kind === 'circle') {
    const origin = enuOrigin(centre[0], centre[1]);
    return { centre, resize: unprojectENU(shape.radius_m, 0, origin) };
  }
  if (shape.kind === 'rectangle') {
    return { centre, resize: [shape.bbox.east, shape.bbox.north] };
  }
  // Polygons resize from whichever vertex is furthest out, so the handle is
  // always on the outline the user can see.
  let best = shape.ring[0];
  let bestDistance = -1;
  for (const p of shape.ring) {
    const d = metresBetween(centre, p);
    if (d > bestDistance) {
      bestDistance = d;
      best = p;
    }
  }
  return { centre, resize: best };
}

/** Slide a whole shape by a geographic delta. */
export function moveShape(shape: SelectionShape, dLon: number, dLat: number): SelectionShape {
  if (shape.kind === 'circle') {
    return { ...shape, lon: shape.lon + dLon, lat: shape.lat + dLat };
  }
  if (shape.kind === 'rectangle') {
    return {
      kind: 'rectangle',
      bbox: {
        west: shape.bbox.west + dLon,
        east: shape.bbox.east + dLon,
        south: shape.bbox.south + dLat,
        north: shape.bbox.north + dLat,
      },
    };
  }
  return {
    kind: 'polygon',
    ring: shape.ring.map(([lon, lat]) => [lon + dLon, lat + dLat] as LonLat),
  };
}

/** Resize a shape so its handle follows the pointer, keeping the centre fixed. */
export function resizeShape(shape: SelectionShape, pointer: LonLat): SelectionShape {
  const centre = shapeCentre(shape);

  if (shape.kind === 'circle') {
    const radius_m = Math.max(1, metresBetween(centre, pointer));
    return { ...shape, radius_m };
  }

  if (shape.kind === 'rectangle') {
    const halfLon = Math.abs(pointer[0] - centre[0]);
    const halfLat = Math.abs(pointer[1] - centre[1]);
    if (halfLon === 0 || halfLat === 0) return shape;
    return {
      kind: 'rectangle',
      bbox: {
        west: centre[0] - halfLon,
        east: centre[0] + halfLon,
        south: centre[1] - halfLat,
        north: centre[1] + halfLat,
      },
    };
  }

  const current = metresBetween(centre, shapeHandles(shape).resize);
  if (current <= 0) return shape;
  const factor = Math.max(0.02, metresBetween(centre, pointer) / current);

  const origin = enuOrigin(centre[0], centre[1]);
  return {
    kind: 'polygon',
    ring: shape.ring.map((p) => {
      const [x, y] = projectENU(p[0], p[1], origin);
      return unprojectENU(x * factor, y * factor, origin);
    }),
  };
}

/** Close an in-progress polygon. Needs at least a triangle. */
export function finishPolygon(points: LonLat[]): SelectionShape | null {
  return points.length >= 3 ? { kind: 'polygon', ring: [...points] } : null;
}

/** GeoJSON outline for rendering. Circles are already N-gons by this point. */
export function shapeToGeoJSON(shape: SelectionShape): GeoJSON.Feature<GeoJSON.Polygon> {
  const ring: LonLat[] =
    shape.kind === 'rectangle'
      ? [
          [shape.bbox.west, shape.bbox.south],
          [shape.bbox.east, shape.bbox.south],
          [shape.bbox.east, shape.bbox.north],
          [shape.bbox.west, shape.bbox.north],
        ]
      : shape.kind === 'circle'
        ? regularPolygon([shape.lon, shape.lat], shape.radius_m, 192)
        : shape.ring;

  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
  };
}

export function pointsToGeoJSON(points: LonLat[]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: points.length >= 2 ? points : [] },
  };
}
