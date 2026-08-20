/**
 * Polygon helpers shared by the ribbon builder and the extruder.
 *
 * This module used to build the ribbon by 2D boolean union, as
 * docs/05-geometry-pipeline.md §6.3 specifies. That approach is gone: both JS
 * boolean libraries throw on ordinary route shapes. The ribbon is now a
 * distance-field level set (see ribbonField.ts), and what remains here is the
 * pure, dependency-free geometry the rest of the pipeline needs.
 *
 * See docs/08-pitfalls.md#boolean-ribbon-union-unreliable.
 */
import type { MultiPolygon, Ring } from './polygons';

/** Signed area of a ring. Positive is counter-clockwise. */
export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

/**
 * Force outer rings counter-clockwise and holes clockwise.
 *
 * earcut carries the input winding through to its output, and the extruder
 * needs tops facing +Z.
 */
export function normaliseWinding(mp: MultiPolygon): MultiPolygon {
  return mp.map((poly) =>
    poly.map((ring, index) => {
      const area = ringArea(ring);
      const wantPositive = index === 0;
      const isPositive = area > 0;
      return isPositive === wantPositive ? ring : ([...ring].reverse() as Ring);
    }),
  );
}

/** Drop the repeated closing vertex, which earcut does not want. */
export function openRing(ring: Ring): Ring {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

/**
 * Insert vertices so no ring edge exceeds `maxEdge_m`.
 *
 * Kept for callers that want boundary density directly. The extruder does NOT
 * use it: points inserted along a straight ring edge are exactly collinear, and
 * earcut discards exactly-collinear vertices, so the density is lost and the
 * walls stop matching the surface
 * (docs/08-pitfalls.md#triangulator-drops-vertices).
 */
export function densifyRing(ring: Ring, maxEdge_m: number): Ring {
  if (ring.length < 2 || maxEdge_m <= 0) return ring;

  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    out.push(a);

    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.ceil(len / maxEdge_m);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }

  return out;
}

export function densify(mp: MultiPolygon, maxEdge_m: number): MultiPolygon {
  return mp.map((poly) => poly.map((ring) => densifyRing(openRing(ring), maxEdge_m)));
}

/** Total area of a MultiPolygon, holes subtracted. */
export function multiPolygonArea(mp: MultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    for (let i = 0; i < poly.length; i++) {
      total += Math.abs(ringArea(poly[i])) * (i === 0 ? 1 : -1);
    }
  }
  return total;
}
