/**
 * Clipping polygons to the selection.
 *
 * Line layers never needed this: their footprints are *derived* from a distance
 * field, so the selection is applied as a mask before the contour is traced.
 * Polygon layers arrive with their footprints already given, which is the one
 * place a real polygon clip is unavoidable — and the place a general boolean
 * library was removed from and never replaced
 * (docs/08-pitfalls.md#boolean-ribbon-union-unreliable).
 *
 * Sutherland-Hodgman does the job here where a general boolean kernel was not
 * needed, because the clip region is a selection outline rather than arbitrary
 * geometry: four of the five selection shapes are convex, and a convex clip is
 * exactly the case Sutherland-Hodgman is correct for. A freehand polygon can be
 * concave, so it is first cut into triangles and the subject clipped against
 * each — the pieces are disjoint and stay separate solids, the same way line
 * layers already merge many solids into one part without welding.
 *
 * Holes come out right without special handling, because for any convex clip C
 *
 *     (outer \ hole) ∩ C  ==  (outer ∩ C) \ (hole ∩ C)
 *
 * so clipping every ring independently is the whole algorithm.
 */
import earcut from 'earcut';
import type { MultiPolygon, Pair, Polygon, Ring } from './polygons';

/** Ring bounds, for rejecting the vast majority of polygons cheaply. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(ring: Ring): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/**
 * Twice the signed area, positive for counter-clockwise.
 *
 * This walks prev->current rather than current->next, which flips the sign
 * relative to the more familiar form — hence the explicit note.
 */
export function signedArea2(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum;
}

/**
 * Is every turn in the same direction?
 *
 * Collinear vertices are ignored rather than treated as a reversal — OSM rings
 * and resampled selection circles are full of them, and calling those concave
 * would send every circular selection down the slow path.
 */
export function isConvexRing(ring: Ring): boolean {
  if (ring.length < 4) return true;
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const c = ring[(i + 2) % ring.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Left of, or on, the directed edge a->b. */
function inside(p: Pair, a: Pair, b: Pair, ccw: boolean): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  return ccw ? cross >= 0 : cross <= 0;
}

function intersect(p: Pair, q: Pair, a: Pair, b: Pair): Pair {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const denom = dx * ey - dy * ex;
  if (denom === 0) return [q[0], q[1]];
  const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / denom;
  return [p[0] + t * dx, p[1] + t * dy];
}

/**
 * Clip one ring against a convex ring.
 *
 * Returns an empty ring when nothing survives. The result is closed implicitly,
 * like every other ring in the pipeline.
 */
export function clipRingToConvex(subject: Ring, clip: Ring): Ring {
  if (subject.length < 3 || clip.length < 3) return [];
  const ccw = signedArea2(clip) > 0;

  let output: Ring = subject;
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const input = output;
    output = [];

    for (let j = 0; j < input.length; j++) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];
      const currentIn = inside(current, a, b, ccw);
      const previousIn = inside(previous, a, b, ccw);

      if (currentIn) {
        if (!previousIn) output.push(intersect(previous, current, a, b));
        output.push(current);
      } else if (previousIn) {
        output.push(intersect(previous, current, a, b));
      }
    }
  }

  return output;
}

/** Every vertex strictly inside a convex ring means the whole ring is. */
function ringInsideConvex(ring: Ring, clip: Ring): boolean {
  const ccw = signedArea2(clip) > 0;
  for (const p of ring) {
    for (let i = 0; i < clip.length; i++) {
      if (!inside(p, clip[i], clip[(i + 1) % clip.length], ccw)) return false;
    }
  }
  return true;
}

/** Cut a possibly-concave ring into convex pieces. Triangles are always convex. */
export function convexPieces(clip: Ring): Ring[] {
  if (isConvexRing(clip)) return [clip];

  const flat: number[] = [];
  for (const [x, y] of clip) flat.push(x, y);
  const tris = earcut(flat);

  const pieces: Ring[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    pieces.push([clip[tris[i]], clip[tris[i + 1]], clip[tris[i + 2]]]);
  }
  return pieces;
}

/** Drop rings too small to matter, in square metres. */
const MIN_AREA_M2 = 1e-6;

/**
 * Clip a polygon (outer ring first, holes after) to a selection outline.
 *
 * @returns zero, one or several polygons. Several only when the outline is
 *   concave and the polygon straddles it, in which case the pieces abut.
 */
export function clipPolygonToRing(polygon: Polygon, clip: Ring, clipPieces?: Ring[]): Polygon[] {
  const outer = polygon[0];
  if (!outer || outer.length < 3) return [];

  const clipBounds = boundsOf(clip);
  if (!boundsOverlap(boundsOf(outer), clipBounds)) return [];

  const pieces = clipPieces ?? convexPieces(clip);

  // Whole-polygon fast path. Worth having because it is the common case and it
  // returns the ORIGINAL vertices — a building fully inside the selection keeps
  // its exact corners rather than being rebuilt from intersections.
  if (pieces.length === 1 && ringInsideConvex(outer, clip)) return [polygon];

  const out: Polygon[] = [];
  for (const piece of pieces) {
    const clippedOuter = clipRingToConvex(outer, piece);
    if (clippedOuter.length < 3) continue;
    if (Math.abs(signedArea2(clippedOuter)) / 2 < MIN_AREA_M2) continue;

    const rings: Ring[] = [clippedOuter];
    for (let h = 1; h < polygon.length; h++) {
      const hole = clipRingToConvex(polygon[h], piece);
      if (hole.length >= 3 && Math.abs(signedArea2(hole)) / 2 >= MIN_AREA_M2) rings.push(hole);
    }
    out.push(rings);
  }

  return out;
}

/** Clip every polygon in a multipolygon, flattening the results. */
export function clipMultiPolygonToRing(multi: MultiPolygon, clip: Ring): MultiPolygon {
  const pieces = convexPieces(clip);
  const out: MultiPolygon = [];
  for (const polygon of multi) out.push(...clipPolygonToRing(polygon, clip, pieces));
  return out;
}
