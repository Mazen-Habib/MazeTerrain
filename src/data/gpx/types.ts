/**
 * Route model (docs/02-feature-spec.md F1).
 *
 * A route is the subject of the product, not a layer. Everything else on the
 * model is supporting cast.
 */
import type { BBox } from '../../geometry/types';

/** A single recorded point. `ele` is the file's value and is not to be trusted (F1.4). */
export interface RoutePoint {
  lon: number;
  lat: number;
  /** Metres, from the GPX `<ele>`. Opt-in only — see elevationSource. */
  ele?: number;
  /** Epoch ms, from `<time>`. Used for the speed-spike filter when present. */
  t?: number;
}

/** Where a route's Z comes from (F1.4). Default `dem` — see OPEN-QUESTIONS R2. */
export type ElevationSource = 'dem' | 'gpx' | 'flat';

/** Recorded, or drawn on the map (F1.3). */
export type RouteSource = 'gpx' | 'drawn';

/** How the route meets the terrain (F1.2). Phase 1 ships `raised` only. */
export type RouteProfile = 'raised' | 'engraved' | 'separate';

export interface RouteStyle {
  color: string;
  /**
   * PRINT millimetres, never world metres. A 2 m trail on a 100 mm model
   * spanning 5 km would be 0.04 mm — invisible.
   * See docs/08-pitfalls.md#unprintable-route-width and OPEN-QUESTIONS R1.
   */
  width_mm: number;
  height_mm: number;
  profile: RouteProfile;
  elevationSource: ElevationSource;
  /** 0-1, 1.0 = pure DEM. Only consulted when elevationSource is 'gpx'. */
  demBlend: number;
  visible: boolean;
}

export interface Route {
  id: string;
  /** From `<name>`, else the filename. */
  name: string;
  /**
   * Where the line came from (docs/02-feature-spec.md F1.3).
   *
   * A drawn route is for someone with no GPX — a route they remember, a planned
   * one, a race course off a PDF. It enters exactly the same pipeline as a
   * recorded one; the only thing that differs is that a hand-drawn line is
   * angular where a recorded one is noisy, so it gets `smoothing` and a
   * recorded one does not need it.
   */
  source: RouteSource;
  /**
   * Chaikin rounding applied before the line is built, 0-1.
   *
   * Zero leaves the polyline exactly as drawn. Meaningful for a drawn route,
   * where clicked corners are hard; a recorded track is already smooth enough
   * and carries 0.
   */
  smoothing: number;
  points: RoutePoint[];
  /** Great-circle length of the raw track, metres. */
  distance_m: number;
  /** Sum of positive `<ele>` deltas, metres. Null when the file carries no elevation. */
  elevationGain_m: number | null;
  bbox: BBox;
  style: RouteStyle;
}

/** docs/02-feature-spec.md F1.2 defaults. */
export function defaultRouteStyle(color = '#FF0D00'): RouteStyle {
  return {
    color,
    width_mm: 1.5,
    height_mm: 1.2,
    profile: 'raised',
    elevationSource: 'dem',
    demBlend: 1.0,
    visible: true,
  };
}

/** Distinct starting colours so a multi-file upload is readable without fiddling. */
export const ROUTE_PALETTE = [
  '#FF0D00',
  '#2E86DE',
  '#F5A623',
  '#7ED321',
  '#9B51E0',
  '#00B8A9',
  '#E84393',
  '#FF7A45',
];

/** Hard cap before simplification (F1.1). */
export const MAX_POINTS_PER_ROUTE = 50_000;
