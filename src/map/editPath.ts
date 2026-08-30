/**
 * Vertex editing for a drawn line (docs/02-feature-spec.md F1.3).
 *
 * F1.3 asks for "drag vertices, insert, delete" after a route is drawn. What
 * shipped first was undo-while-drawing, which only helps before the line is
 * finished — the moment a route existed, the sole way to move one point was to
 * draw the whole thing again.
 *
 * The maths lives here rather than in MapView for the same reason `draw.ts`
 * does: an array operation on lon/lat pairs is worth testing, and a WebGL
 * context is not worth standing up to test it. MapView turns pointer events
 * into calls here and renders whatever comes back.
 */
import { enuOrigin, projectENU, unprojectENU } from '../geometry/coords';
import type { LonLat } from './draw';

/** A line needs two ends. Deleting past this would leave a point, not a route. */
export const MIN_ROUTE_POINTS = 2;

/**
 * Above this, vertex editing is not offered.
 *
 * A recorded marathon carries twenty thousand points; drawing a handle on each
 * one — plus a midpoint between them — is forty thousand circles for an
 * interaction nobody wants on a recorded track anyway. Hand-drawn routes are
 * tens of points, so the cap is never felt where the feature is aimed.
 */
export const MAX_EDITABLE_POINTS = 500;

export function canEditVertices(points: readonly LonLat[]): boolean {
  return points.length >= MIN_ROUTE_POINTS && points.length <= MAX_EDITABLE_POINTS;
}

/** Move one vertex. Out-of-range indices leave the line alone. */
export function moveVertex(points: readonly LonLat[], index: number, to: LonLat): LonLat[] {
  if (index < 0 || index >= points.length) return [...points];
  const next = [...points];
  next[index] = to;
  return next;
}

/**
 * Remove one vertex, or null when that would leave less than a line.
 *
 * Null rather than an unchanged array so the caller can tell "nothing to do"
 * from "refused", and say so.
 */
export function deleteVertex(points: readonly LonLat[], index: number): LonLat[] | null {
  if (index < 0 || index >= points.length) return null;
  if (points.length <= MIN_ROUTE_POINTS) return null;
  return points.filter((_, i) => i !== index);
}

/** Insert a vertex so it lands AT `index`, pushing the rest along. */
export function insertVertex(points: readonly LonLat[], index: number, at: LonLat): LonLat[] {
  const where = Math.max(0, Math.min(points.length, index));
  const next = [...points];
  next.splice(where, 0, at);
  return next;
}

/**
 * Halfway between two points, on the ground.
 *
 * Averaging degrees is off by metres at these spans — invisible — but the rest
 * of the module works in the local ENU frame and a midpoint handle that does
 * not sit on the drawn line is exactly the kind of thing that reads as a bug.
 */
export function midpoint(a: LonLat, b: LonLat): LonLat {
  const origin = enuOrigin(a[0], a[1]);
  const [x, y] = projectENU(b[0], b[1], origin);
  return unprojectENU(x / 2, y / 2, origin);
}

/**
 * Handles for the whole line: one per vertex, one per gap.
 *
 * `role` tells the two apart on the map and in the hit test. `index` means
 * different things for each, deliberately: for a vertex it is the point to move
 * or delete, for a midpoint it is where a new point would land — which is the
 * index the drag then continues with, so one gesture inserts and positions.
 */
export function vertexHandles(points: readonly LonLat[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  if (!canEditVertices(points)) return { type: 'FeatureCollection', features: [] };

  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];

  for (let i = 0; i < points.length; i++) {
    features.push({
      type: 'Feature',
      properties: {
        role: 'vertex',
        index: i,
        // The ends are worth marking: direction of travel is visible in the
        // model and reversing it is a different control.
        end: i === 0 ? 'start' : i === points.length - 1 ? 'finish' : null,
      },
      geometry: { type: 'Point', coordinates: points[i] },
    });
  }

  for (let i = 1; i < points.length; i++) {
    features.push({
      type: 'Feature',
      properties: { role: 'midpoint', index: i },
      geometry: { type: 'Point', coordinates: midpoint(points[i - 1], points[i]) },
    });
  }

  return { type: 'FeatureCollection', features };
}
