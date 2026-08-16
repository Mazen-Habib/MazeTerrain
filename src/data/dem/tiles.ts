/**
 * Slippy-map tile arithmetic and zoom selection.
 *
 * Tiles live in Web Mercator. That is fine — this is the one place Mercator is
 * correct, because we are addressing tiles, not measuring ground distance.
 * Everything downstream works in local ENU metres.
 */
import { clamp } from '../../geometry/coords';

/** Equatorial circumference, metres. */
const CIRCUMFERENCE_M = 40075016.686;

const DEG = Math.PI / 180;

/** Fractional tile X for a longitude. */
export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

/** Fractional tile Y for a latitude. */
export function latToTileY(lat: number, z: number): number {
  const rad = lat * DEG;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

export function tileXToLon(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Ground resolution of one tile pixel at a given zoom and latitude. */
export function metresPerPixel(z: number, lat: number, tileSize: number): number {
  return (CIRCUMFERENCE_M * Math.cos(lat * DEG)) / (Math.pow(2, z) * tileSize);
}

/**
 * Pick the lowest zoom whose ground resolution is at least as fine as the output
 * grid. Over-zooming the pyramid buys bandwidth, not detail
 * (docs/04-data-sources.md, sampling rules).
 */
export function chooseZoom(
  targetResolution_m: number,
  centreLat: number,
  tileSize: number,
  maxZoom: number,
): number {
  for (let z = 0; z <= maxZoom; z++) {
    if (metresPerPixel(z, centreLat, tileSize) <= targetResolution_m) return z;
  }
  return maxZoom;
}

export interface TileRange {
  z: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  /** Number of tiles across and down, inclusive of both ends. */
  nx: number;
  ny: number;
}

/**
 * Tile range covering a bbox, with a margin of whole tiles on every side.
 *
 * The margin is not optional: bilinear interpolation and any future normal
 * computation both read one sample beyond the edge, and without neighbours the
 * boundary of every model picks up a seam.
 */
export function tileRangeForBBox(
  west: number,
  south: number,
  east: number,
  north: number,
  z: number,
  margin = 1,
): TileRange {
  const maxIndex = Math.pow(2, z) - 1;
  const xMin = clamp(Math.floor(lonToTileX(west, z)) - margin, 0, maxIndex);
  const xMax = clamp(Math.floor(lonToTileX(east, z)) + margin, 0, maxIndex);
  // Tile Y runs south-ward, so the northern edge gives the smaller index.
  const yMin = clamp(Math.floor(latToTileY(north, z)) - margin, 0, maxIndex);
  const yMax = clamp(Math.floor(latToTileY(south, z)) + margin, 0, maxIndex);

  return { z, xMin, yMin, xMax, yMax, nx: xMax - xMin + 1, ny: yMax - yMin + 1 };
}

export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}
