/**
 * Route denoising, simplification and resampling (docs/05-geometry-pipeline.md §6.1-6.2).
 *
 * The order is load-bearing: denoise, then simplify, then resample.
 * Simplifying before denoising bakes GPS spikes into the kept points, and
 * resampling before simplifying is wasted work.
 */
import simplifyGeoJson from '@turf/simplify';
import { lineString } from '@turf/helpers';
import type { RoutePoint } from './types';

/** A point in local ENU metres. */
export type Pt = [number, number];

/**
 * Speed above which a point is a GPS artefact rather than an athlete.
 * Tunnels, tree cover, urban canyons and watch resets all produce these
 * (docs/08-pitfalls.md#gps-spikes).
 */
const MAX_PLAUSIBLE_SPEED_MS = 200 / 3.6;

/** Two points closer than this are the same point. */
const DUPLICATE_EPSILON_M = 0.05;

export interface DenoiseResult {
  points: Pt[];
  duplicatesDropped: number;
  spikesDropped: number;
}

/**
 * Drop duplicate and physically impossible points.
 *
 * The speed test needs timestamps. Where a file has none we drop duplicates
 * only, rather than guessing from distance alone — a long straight segment on a
 * sparse track is legitimate, and deleting it would be worse than keeping a
 * spike.
 */
export function denoise(points: Pt[], times?: Array<number | undefined>): DenoiseResult {
  const out: Pt[] = [];
  let duplicatesDropped = 0;
  let spikesDropped = 0;

  // Both distance and time must be measured from the last point we KEPT. Using
  // points[i - 1] instead means the excursion out to a spike is measured, then
  // the return trip is measured again, and one artefact deletes two points.
  let lastKeptTime: number | undefined;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = out[out.length - 1];
    const t = times?.[i];

    if (prev) {
      const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      if (d < DUPLICATE_EPSILON_M) {
        duplicatesDropped++;
        continue;
      }

      if (lastKeptTime !== undefined && t !== undefined) {
        const dt = (t - lastKeptTime) / 1000;
        if (dt > 0 && d / dt > MAX_PLAUSIBLE_SPEED_MS) {
          spikesDropped++;
          continue;
        }
      }
    }

    out.push(p);
    lastKeptTime = t;
  }

  return { points: out, duplicatesDropped, spikesDropped };
}

/**
 * Douglas-Peucker with a tolerance derived from PRINT resolution.
 *
 * Choosing the tolerance in metres without reference to model scale is what
 * makes switchbacks come out as straight lines
 * (docs/08-pitfalls.md#hairpins-cut-off). At 0.15 mm — a quarter of a 0.6 mm
 * nozzle — the deviation is invisible on the print and the point reduction is
 * typically 80-95%.
 */
export function simplifyPoints(points: Pt[], tolerance_m: number): Pt[] {
  if (points.length <= 2 || tolerance_m <= 0) return points;

  const simplified = simplifyGeoJson(lineString(points as unknown as number[][]), {
    tolerance: tolerance_m,
    highQuality: true,
  });

  const coords = simplified.geometry.coordinates as unknown as Pt[];
  return coords.length >= 2 ? coords : points;
}

/** The print-space deviation budget for simplification, in millimetres. */
export const SIMPLIFY_TOLERANCE_MM = 0.15;

export function toleranceForScale(scale_mm_per_m: number): number {
  return SIMPLIFY_TOLERANCE_MM / scale_mm_per_m;
}

/**
 * Insert points so no segment exceeds `maxSegment_m`.
 *
 * A ribbon can only follow the terrain where it has vertices. Long segments
 * produce visible floating chords over hills and hairline cracks in the valleys
 * (docs/08-pitfalls.md#gaps-between-features-and-terrain).
 */
export function resample(points: Pt[], maxSegment_m: number): Pt[] {
  if (points.length < 2 || maxSegment_m <= 0) return points;

  const out: Pt[] = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);

    const steps = Math.ceil(len / maxSegment_m);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + dx * t, a[1] + dy * t]);
    }
    out.push(b);
  }

  return out;
}

/** Maximum deviation of `simplified` from `original`, for the hairpin guard. */
export function maxDeviation(original: Pt[], simplified: Pt[]): number {
  let worst = 0;
  let j = 0;

  for (const p of original) {
    // Walk the simplified line forward; it shares vertices with the original in
    // order, so this stays linear.
    while (j + 2 < simplified.length && closer(p, simplified[j + 1], simplified[j])) j++;
    const d = pointToSegment(p, simplified[j], simplified[Math.min(j + 1, simplified.length - 1)]);
    if (d > worst) worst = d;
  }

  return worst;
}

function closer(p: Pt, a: Pt, b: Pt): boolean {
  return Math.hypot(p[0] - a[0], p[1] - a[1]) < Math.hypot(p[0] - b[0], p[1] - b[1]);
}

export function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);

  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Timestamps aligned with a RoutePoint list, for denoise(). */
export function timesOf(points: RoutePoint[]): Array<number | undefined> {
  return points.map((p) => p.t);
}
