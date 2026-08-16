/**
 * Projection and scale. The ONLY place world<->print arithmetic happens.
 *
 * CLAUDE.md: "One conversion function, one direction, one place: worldToPrint()
 * in the geometry module. Nothing else may do the maths inline."
 *
 * Three coordinate spaces, one path (docs/03-architecture.md):
 *   geographic (lon/lat, WGS84)  ->  world (metres, local ENU)  ->  print (mm)
 *
 * We never use raw Web Mercator for world space. Its scale factor is 1/cos(lat):
 * 2x at 60 degrees, 3.9x at 75. See docs/08-pitfalls.md#mercator-stretch.
 */
import type { BBox, GenerateConfig } from './types';

/** WGS84 semi-major axis. */
export const EARTH_RADIUS_M = 6378137;

const DEG = Math.PI / 180;

/** Local East-North-Up frame, centred on the selection centroid. */
export interface EnuOrigin {
  lon0: number;
  lat0: number;
  /** cos(lat0), cached — it is in every forward and inverse call. */
  cosLat0: number;
}

export function enuOrigin(lon0: number, lat0: number): EnuOrigin {
  return { lon0, lat0, cosLat0: Math.cos(lat0 * DEG) };
}

export function bboxCentre(bbox: BBox): EnuOrigin {
  return enuOrigin((bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2);
}

/**
 * Geographic -> world metres. Accurate to well under a metre across a 120 km
 * selection, and it removes the entire "my model is stretched" bug class.
 */
export function projectENU(lon: number, lat: number, o: EnuOrigin): [number, number] {
  return [
    EARTH_RADIUS_M * (lon - o.lon0) * DEG * o.cosLat0,
    EARTH_RADIUS_M * (lat - o.lat0) * DEG,
  ];
}

/** World metres -> geographic. Exact inverse of projectENU. */
export function unprojectENU(x_m: number, y_m: number, o: EnuOrigin): [number, number] {
  return [
    o.lon0 + x_m / (EARTH_RADIUS_M * DEG * o.cosLat0),
    o.lat0 + y_m / (EARTH_RADIUS_M * DEG),
  ];
}

export interface WorldExtent {
  origin: EnuOrigin;
  extentX_m: number;
  extentY_m: number;
}

/** Real-world size of a bbox, latitude-corrected. */
export function worldExtent(bbox: BBox): WorldExtent {
  const origin = bboxCentre(bbox);
  const [xMin, yMin] = projectENU(bbox.west, bbox.south, origin);
  const [xMax, yMax] = projectENU(bbox.east, bbox.north, origin);
  return { origin, extentX_m: xMax - xMin, extentY_m: yMax - yMin };
}

/** Hard cap on grid vertices before we coarsen automatically (docs/05, Stage 0). */
export const MAX_GRID_VERTICES = 1_500_000;

/** Auto-resolution targets this many samples on the long edge. */
const AUTO_GRID_TARGET = 600;
const MIN_RESOLUTION_M = 5;
const MAX_RESOLUTION_M = 500;

export interface ResolvedScale {
  origin: EnuOrigin;
  extentX_m: number;
  extentY_m: number;
  /** mm per metre, uniform in XY. */
  scale: number;
  /** mm per metre vertically, after the maxHeight clamp. */
  zScale: number;
  /** What the user asked for. */
  requestedExaggeration: number;
  /** What we could actually give them. */
  effectiveExaggeration: number;
  exaggerationClamped: boolean;
  resolution_m: number;
  cols: number;
  rows: number;
  /** True when MAX_GRID_VERTICES forced a coarser step than requested. */
  resolutionCoarsened: boolean;
  minElevation_m: number;
  maxElevation_m: number;
  baseThickness_mm: number;
  seaLevelOffset_m: number;
}

/**
 * Stage 0 of the pipeline: turn a config plus a known elevation range into every
 * scale factor the rest of the build needs.
 *
 * Elevation range is required up front because the vertical exaggeration clamp
 * depends on it. Callers that do not yet know the range pass the config through
 * resolveGrid() first, fetch, then call this.
 */
export function resolveScale(
  config: GenerateConfig,
  minElevation_m: number,
  maxElevation_m: number,
): ResolvedScale {
  const grid = resolveGrid(config);
  const scale = config.modelWidth_mm / Math.max(grid.extentX_m, grid.extentY_m);

  const relief_m = Math.max(0, maxElevation_m - minElevation_m + config.seaLevelOffset_m);
  const requestedExaggeration = config.verticalExaggeration;

  let effectiveExaggeration = requestedExaggeration;
  let exaggerationClamped = false;

  const requestedHeight_mm = relief_m * scale * requestedExaggeration;
  if (requestedHeight_mm > config.maxHeight_mm && relief_m > 0) {
    effectiveExaggeration = config.maxHeight_mm / (relief_m * scale);
    exaggerationClamped = true;
  }

  return {
    origin: grid.origin,
    extentX_m: grid.extentX_m,
    extentY_m: grid.extentY_m,
    scale,
    zScale: scale * effectiveExaggeration,
    requestedExaggeration,
    effectiveExaggeration,
    exaggerationClamped,
    resolution_m: grid.resolution_m,
    cols: grid.cols,
    rows: grid.rows,
    resolutionCoarsened: grid.resolutionCoarsened,
    minElevation_m,
    maxElevation_m,
    baseThickness_mm: config.baseThickness_mm,
    seaLevelOffset_m: config.seaLevelOffset_m,
  };
}

export interface ResolvedGrid {
  origin: EnuOrigin;
  extentX_m: number;
  extentY_m: number;
  resolution_m: number;
  cols: number;
  rows: number;
  resolutionCoarsened: boolean;
}

/**
 * Grid dimensions only — everything that can be known before the DEM arrives.
 * Split out because the fetcher needs the grid to choose a tile zoom.
 */
export function resolveGrid(config: GenerateConfig): ResolvedGrid {
  const { origin, extentX_m, extentY_m } = worldExtent(config.bbox);
  const longEdge_m = Math.max(extentX_m, extentY_m);

  let resolution_m =
    config.resolution_m === 'auto'
      ? clamp(longEdge_m / AUTO_GRID_TARGET, MIN_RESOLUTION_M, MAX_RESOLUTION_M)
      : clamp(config.resolution_m, MIN_RESOLUTION_M, MAX_RESOLUTION_M);

  let cols = Math.ceil(extentX_m / resolution_m) + 1;
  let rows = Math.ceil(extentY_m / resolution_m) + 1;
  let resolutionCoarsened = false;

  // Guard rail: coarsen rather than blow up the tab.
  //
  // Iterated, because the +1 and the ceil() mean a single sqrt() correction can
  // still land just over the cap. A guard rail that only mostly holds is not a
  // guard rail.
  while (cols * rows > MAX_GRID_VERTICES) {
    const factor = Math.max(1.01, Math.sqrt((cols * rows) / MAX_GRID_VERTICES));
    resolution_m = resolution_m * factor;
    cols = Math.ceil(extentX_m / resolution_m) + 1;
    rows = Math.ceil(extentY_m / resolution_m) + 1;
    resolutionCoarsened = true;
  }

  return { origin, extentX_m, extentY_m, resolution_m, cols, rows, resolutionCoarsened };
}

/**
 * World metres -> print millimetres. The one conversion.
 *
 * XY is centred on the selection centroid, so the model straddles the origin.
 * Z is measured from the build plate: baseThickness_mm of solid material, then
 * the exaggerated relief on top.
 *
 * The relief term is clamped at zero so a negative seaLevelOffset_m cannot push
 * the terrain surface down through the base and invert the solid.
 */
export function worldToPrint(
  x_m: number,
  y_m: number,
  elevation_m: number,
  s: ResolvedScale,
): [number, number, number] {
  const relief_mm = Math.max(
    0,
    (elevation_m - s.minElevation_m + s.seaLevelOffset_m) * s.zScale,
  );
  return [x_m * s.scale, y_m * s.scale, s.baseThickness_mm + relief_mm];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
