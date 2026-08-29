/**
 * GPX -> Route.
 *
 * Parsing goes through @tmcw/togeojson. Hand-rolling XML for this is a trap:
 * real exports from Strava, Garmin, Komoot and Wahoo differ in namespacing,
 * extensions and which of trk/rte/wpt they populate.
 */
import { gpx } from '@tmcw/togeojson';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { defaultRouteStyle, MAX_POINTS_PER_ROUTE, ROUTE_PALETTE, type Route, type RoutePoint } from './types';
import type { BBox } from '../../geometry/types';

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

export class GpxParseError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'GpxParseError';
    this.userMessage = userMessage;
  }
}

/** Great-circle distance, metres. Haversine — accurate at every scale we care about. */
export function haversine(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const dLat = (bLat - aLat) * DEG;
  const dLon = (bLon - aLon) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function routeDistance(points: RoutePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i - 1].lon, points[i - 1].lat, points[i].lon, points[i].lat);
  }
  return total;
}

/** Sum of positive elevation deltas. Null when the file has no usable elevation. */
export function elevationGain(points: RoutePoint[]): number | null {
  let gain = 0;
  let seen = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].ele;
    const b = points[i].ele;
    if (a === undefined || b === undefined) continue;
    seen++;
    if (b > a) gain += b - a;
  }
  return seen === 0 ? null : gain;
}

export function boundsOfPoints(points: RoutePoint[]): BBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    if (p.lon < west) west = p.lon;
    if (p.lon > east) east = p.lon;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  return { west, south, east, north };
}

/** Union of several bounding boxes. */
export function unionBBox(boxes: BBox[]): BBox | null {
  if (boxes.length === 0) return null;
  let out = { ...boxes[0] };
  for (const b of boxes.slice(1)) {
    out = {
      west: Math.min(out.west, b.west),
      south: Math.min(out.south, b.south),
      east: Math.max(out.east, b.east),
      north: Math.max(out.north, b.north),
    };
  }
  return out;
}

function coordsToPoints(coords: Position[], times: unknown): RoutePoint[] {
  const timeList = Array.isArray(times) ? times : null;
  const out: RoutePoint[] = [];

  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (!c || c.length < 2) continue;
    const lon = c[0];
    const lat = c[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const point: RoutePoint = { lon, lat };
    if (c.length > 2 && Number.isFinite(c[2])) point.ele = c[2];

    const raw = timeList?.[i];
    if (typeof raw === 'string') {
      const t = Date.parse(raw);
      if (Number.isFinite(t)) point.t = t;
    }

    out.push(point);
  }

  return out;
}

/**
 * Pull every line-like feature out of the GeoJSON togeojson produced.
 *
 * Real exports use `trk` (a recording of where you went). `rte` (a plan) and
 * bare `wpt` sequences are the fallbacks — rarer, but they exist and users who
 * have them have nothing else.
 */
function extractLines(fc: FeatureCollection): Array<{ name: string | null; points: RoutePoint[] }> {
  const out: Array<{ name: string | null; points: RoutePoint[] }> = [];
  const loosePoints: RoutePoint[] = [];

  /**
   * togeojson moved per-point times from `coordTimes` to
   * `coordinateProperties.times` in v7. Read both — users' files outlive our
   * dependency choices, and a missing time silently disables the spike filter.
   */
  const timesFor = (feature: Feature<Geometry>, lineIndex: number): unknown => {
    const props = feature.properties as Record<string, unknown> | null;
    const coordProps = props?.['coordinateProperties'] as Record<string, unknown> | undefined;
    const times = coordProps?.['times'] ?? props?.['coordTimes'];
    if (!Array.isArray(times)) return null;
    // For a MultiLineString the entry is an array per line.
    return Array.isArray(times[0]) ? times[lineIndex] : times;
  };

  const push = (feature: Feature<Geometry>, coords: Position[], lineIndex = 0) => {
    const points = coordsToPoints(coords, timesFor(feature, lineIndex));
    if (points.length >= 2) {
      const name = (feature.properties as Record<string, unknown> | null)?.['name'];
      out.push({ name: typeof name === 'string' && name.trim() ? name.trim() : null, points });
    }
  };

  for (const feature of fc.features) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type === 'LineString') {
      push(feature, g.coordinates);
    } else if (g.type === 'MultiLineString') {
      g.coordinates.forEach((line, i) => push(feature, line, i));
    } else if (g.type === 'Point') {
      const p = coordsToPoints([g.coordinates], null);
      if (p.length) loosePoints.push(p[0]);
    }
  }

  // A sequence of bare waypoints with no track is still a route the user drew
  // somewhere. Only fall back to it when there is no track at all.
  if (out.length === 0 && loosePoints.length >= 2) {
    out.push({ name: null, points: loosePoints });
  }

  return out;
}

/** Decimate evenly if a file blows past the hard cap, before any other work. */
function capPoints(points: RoutePoint[]): RoutePoint[] {
  if (points.length <= MAX_POINTS_PER_ROUTE) return points;
  const stride = Math.ceil(points.length / MAX_POINTS_PER_ROUTE);
  const out: RoutePoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

let routeCounter = 0;

/**
 * Parse one GPX document into routes. A file with several `<trk>` segments
 * yields several routes, each independently styleable (F1.1).
 */
export function parseGpxDocument(doc: Document, filename: string): Route[] {
  let fc: FeatureCollection;
  try {
    fc = gpx(doc) as FeatureCollection;
  } catch (err) {
    throw new GpxParseError(
      `${filename} could not be read as GPX (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  const lines = extractLines(fc);
  if (lines.length === 0) {
    throw new GpxParseError(
      `${filename} contains no track points. Export the activity as GPX rather than TCX or FIT.`,
    );
  }

  const base = filename.replace(/\.gpx$/i, '');

  return lines.map((line, i) => {
    const points = capPoints(line.points);
    const name = line.name ?? (lines.length > 1 ? `${base} (${i + 1})` : base);
    return {
      id: `route-${++routeCounter}`,
      name,
      points,
      source: 'gpx' as const,
      smoothing: 0,
      distance_m: routeDistance(points),
      elevationGain_m: elevationGain(points),
      bbox: boundsOfPoints(points),
      style: defaultRouteStyle(ROUTE_PALETTE[(routeCounter - 1) % ROUTE_PALETTE.length]),
    };
  });
}

/** Browser entry point: text -> routes. */
export function parseGpxText(text: string, filename: string): Route[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const failure = doc.getElementsByTagName('parsererror')[0];
  if (failure) {
    throw new GpxParseError(`${filename} is not valid XML and could not be parsed.`);
  }
  return parseGpxDocument(doc, filename);
}
