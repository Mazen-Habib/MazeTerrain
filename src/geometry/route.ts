/**
 * Stage 6: the route solid.
 *
 * "The route is the product. It gets more care than any other feature."
 * (docs/05-geometry-pipeline.md)
 */
import type { MultiPolygon, Ring } from './polygons';
import {
  denoise,
  resample,
  simplifyPoints,
  toleranceForScale,
  type Pt,
} from '../data/gpx/simplify';
import type { Route } from '../data/gpx/types';
import { projectENU, worldToPrint, type ResolvedScale } from './coords';
import { extrudeDraped, type SolidMesh } from './extrude';
import { sampleHeightfieldAt, type Heightfield } from './heightfield';
import { multiPolygonArea } from './ribbon';
import { buildRibbonField } from './ribbonField';

export interface RouteBuildStats {
  rawPoints: number;
  simplifiedPoints: number;
  duplicatesDropped: number;
  spikesDropped: number;
  /** Centreline length inside the selection, metres. */
  length_m: number;
  /** Centreline length cut away by the selection, metres. */
  clippedLength_m: number;
  width_m: number;
  width_mm: number;
  triangles: number;
  /** True when width_mm had to be raised to the nozzle minimum. */
  widthClamped: boolean;
}

export interface RouteBuildResult {
  mesh: SolidMesh;
  stats: RouteBuildStats;
}

/**
 * Minimum printable width is one nozzle diameter — a single extrusion. Below
 * it the slicer has nothing to lay and drops the geometry entirely. Two
 * diameters is the rule for a free-standing wall; a route is a ridge on solid
 * base (docs/08-pitfalls.md#sub-nozzle-features).
 */
export function minPrintableWidth_mm(nozzleDiameter_mm: number): number {
  return nozzleDiameter_mm;
}

/** docs/05-geometry-pipeline.md Stage 5: penetration is what makes the union clean. */
export function penetrationFor(height_mm: number): number {
  return Math.max(1.0, height_mm * 0.5);
}

/** Ray-casting point-in-ring. */
export function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Split a centreline's length into the part inside the selection and the part outside. */
function lengthInsideOutside(line: Pt[], selection: Ring | null): [number, number] {
  let inside = 0;
  let outside = 0;

  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!selection) {
      inside += len;
      continue;
    }
    // Classify by the midpoint. Segments are short after resampling, so the
    // error is bounded by one segment at each crossing.
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    if (pointInRing(mx, my, selection)) inside += len;
    else outside += len;
  }

  return [inside, outside];
}

export interface BuildRouteOptions {
  heightfield: Heightfield;
  scale: ResolvedScale;
  /** Selection boundary in world metres, or null to keep everything. */
  selection: Ring | null;
  nozzleDiameter_mm: number;
  baseThickness_mm: number;
}

export function buildRouteSolid(route: Route, options: BuildRouteOptions): RouteBuildResult {
  const { heightfield, scale, selection, nozzleDiameter_mm } = options;
  const { style } = route;

  // 1. Project to the local ENU frame the whole build shares.
  const projected: Pt[] = route.points.map((p) => projectENU(p.lon, p.lat, scale.origin));

  // 2. Denoise before anything else, or the simplifier preserves the spikes.
  const cleaned = denoise(
    projected,
    route.points.map((p) => p.t),
  );

  // 3. Simplify against a print-space budget, never a fixed metre value.
  const simplified = simplifyPoints(cleaned.points, toleranceForScale(scale.scale));

  // 4. Resample so the ribbon has vertices wherever the terrain does.
  const terrainStep_m = Math.max(heightfield.spacingX_m, heightfield.spacingY_m);
  const centreline = resample(simplified, terrainStep_m);

  const [insideLength, outsideLength] = lengthInsideOutside(centreline, selection);

  // 5. Width: print millimetres converted to world metres, clamped to printable.
  const minWidth_mm = minPrintableWidth_mm(nozzleDiameter_mm);
  const widthClamped = style.width_mm < minWidth_mm;
  const width_mm = widthClamped ? minWidth_mm : style.width_mm;
  const width_m = width_mm / scale.scale;

  const emptyStats: RouteBuildStats = {
    rawPoints: route.points.length,
    simplifiedPoints: simplified.length,
    duplicatesDropped: cleaned.duplicatesDropped,
    spikesDropped: cleaned.spikesDropped,
    length_m: insideLength,
    clippedLength_m: outsideLength,
    width_m,
    width_mm,
    triangles: 0,
    widthClamped,
  };

  if (centreline.length < 2) {
    return { mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), triangles: 0 }, stats: emptyStats };
  }

  // 6. Ribbon as a distance-field level set, then clipped to the selection like
  //    every other layer. The level set is self-intersection-free by
  //    construction — see ribbonField.ts for why the specced boolean union is
  //    not usable here.
  const ribbon = buildRibbonField(centreline, width_m, selection);
  const footprint: MultiPolygon = ribbon.polygons;
  if (footprint.length === 0 || multiPolygonArea(footprint) <= 0) {
    return { mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), triangles: 0 }, stats: emptyStats };
  }

  // 7. Drape and extrude.
  const flatZ = options.baseThickness_mm;
  const sampleTerrainZ =
    style.elevationSource === 'flat'
      ? () => flatZ
      : (x_m: number, y_m: number) =>
          worldToPrint(x_m, y_m, sampleHeightfieldAt(heightfield, x_m, y_m), scale)[2];

  const mesh = extrudeDraped(
    footprint,
    sampleTerrainZ,
    (x_m, y_m) => [x_m * scale.scale, y_m * scale.scale],
    {
      height_mm: style.height_mm,
      penetration_mm: penetrationFor(style.height_mm),
      // Keep the underside strictly inside the base slab, never coplanar with
      // it and never below the build plate.
      minBottom_mm: Math.min(0.2, options.baseThickness_mm / 2),
      maxEdge_m: terrainStep_m,
    },
  );

  return { mesh, stats: { ...emptyStats, triangles: mesh.triangles } };
}
