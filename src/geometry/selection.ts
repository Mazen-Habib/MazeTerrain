/**
 * Area selection (docs/02-feature-spec.md F2).
 *
 * Circles and hexagons become N-gons here, at the boundary, so that everything
 * downstream — terrain clipping, feature clipping, walls — has exactly one
 * code path and one boundary polygon to clip against
 * (docs/08-pitfalls.md#geometry-outside-boundary).
 */
import type { Ring } from './polygons';
import type { BBox } from './types';
import { projectENU, type EnuOrigin } from './coords';
import { unionBBox } from '../data/gpx/parse';
import type { Route } from '../data/gpx/types';

/** F2 requires N >= 128 so a printed circle reads as a circle. */
export const CIRCLE_SEGMENTS = 192;

export type SelectionShape =
  | { kind: 'rectangle'; bbox: BBox }
  | { kind: 'circle'; lon: number; lat: number; radius_m: number }
  | { kind: 'polygon'; ring: Array<[number, number]> };

const DEG = Math.PI / 180;
const EARTH_RADIUS_M = 6378137;

/** Selection outline as a closed lon/lat ring. */
export function selectionRingLonLat(shape: SelectionShape): Array<[number, number]> {
  switch (shape.kind) {
    case 'rectangle': {
      const { west, south, east, north } = shape.bbox;
      return [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
      ];
    }
    case 'circle': {
      const ring: Array<[number, number]> = [];
      const dLat = (shape.radius_m / EARTH_RADIUS_M) / DEG;
      const dLon = dLat / Math.cos(shape.lat * DEG);
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
        ring.push([shape.lon + Math.cos(a) * dLon, shape.lat + Math.sin(a) * dLat]);
      }
      return ring;
    }
    case 'polygon':
      return shape.ring;
  }
}

/** Axis-aligned bounds of a selection — what the DEM fetcher needs. */
export function selectionBBox(shape: SelectionShape): BBox {
  if (shape.kind === 'rectangle') return shape.bbox;

  const ring = selectionRingLonLat(shape);
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, south, east, north };
}

/** Selection outline in local ENU metres, ready to clip against. */
export function selectionRingWorld(shape: SelectionShape, origin: EnuOrigin): Ring {
  return selectionRingLonLat(shape).map(([lon, lat]) => projectENU(lon, lat, origin)) as Ring;
}

/**
 * The bbox itself as a clip ring, in local ENU metres.
 *
 * A rectangle selection has no outline to clip against — the terrain is simply
 * the whole grid — so features used to be bounded only by the Overpass query
 * having asked for that exact bbox. Once large areas are fetched as
 * grid-aligned tiles that stopped being true: tiles are deliberately not
 * clipped to the selection, so features arrive from up to a tile beyond it and
 * would be built hanging off the edge of the terrain.
 *
 * Corners are projected rather than derived from the extent, so this holds
 * wherever the ENU origin sits.
 */
export function bboxRingWorld(bbox: BBox, origin: EnuOrigin): Ring {
  return [
    projectENU(bbox.west, bbox.south, origin),
    projectENU(bbox.east, bbox.south, origin),
    projectENU(bbox.east, bbox.north, origin),
    projectENU(bbox.west, bbox.north, origin),
  ] as Ring;
}

/** Padding applied by "Fit selection to routes" (F2). */
export const FIT_PADDING = 0.15;

/**
 * A circle enclosing the routes (docs/07-ui-spec.md, first-run flow).
 *
 * Used for the selection drawn AUTOMATICALLY on a first upload, where the point
 * is that the user sees something already working before touching a setting —
 * and a disc is the shape a route model is usually printed as. The explicit
 * "Fit selection to routes" button still gives a rectangle, which wastes less
 * area on a route that runs mostly one way; the difference is that pressing it
 * is a deliberate act and this is not.
 */
export function fitCircleToRoutes(routes: Route[], padding = FIT_PADDING): SelectionShape | null {
  const boxes = routes.filter((r) => r.style.visible).map((r) => r.bbox);
  const union = unionBBox(boxes);
  if (!union) return null;

  const lon = (union.west + union.east) / 2;
  const lat = (union.south + union.north) / 2;
  const midLat = (lat * Math.PI) / 180;

  // Half-diagonal, so the whole bounding box fits inside the circle.
  const halfWidth_m = ((union.east - union.west) / 2) * 111320 * Math.cos(midLat);
  const halfHeight_m = ((union.north - union.south) / 2) * 110574;
  const radius_m = Math.hypot(halfWidth_m, halfHeight_m) * (1 + padding);

  // A route that never moved still needs an area around it.
  return { kind: 'circle', lon, lat, radius_m: Math.max(radius_m, 250) };
}

/**
 * Size a rectangle around every visible route.
 *
 * What "Fit selection to routes" gives, and the tighter of the two: a route
 * that runs mostly one way wastes far less area in a box than in a disc
 * (docs/08-pitfalls.md#route-outside-selection).
 */
export function fitSelectionToRoutes(
  routes: Route[],
  padding = FIT_PADDING,
): SelectionShape | null {
  const boxes = routes.filter((r) => r.style.visible).map((r) => r.bbox);
  const union = unionBBox(boxes);
  if (!union) return null;

  const width = union.east - union.west;
  const height = union.north - union.south;

  // A point route, or one that never moved, still needs an area around it.
  const padLon = Math.max(width * padding, 0.002);
  const padLat = Math.max(height * padding, 0.002);

  return {
    kind: 'rectangle',
    bbox: {
      west: union.west - padLon,
      south: union.south - padLat,
      east: union.east + padLon,
      north: union.north + padLat,
    },
  };
}

/** Real-world area of a selection, km². Used for the live readout and the caps. */
export function selectionArea_km2(shape: SelectionShape, origin: EnuOrigin): number {
  const ring = selectionRingWorld(shape, origin);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(sum / 2) / 1e6;
}
