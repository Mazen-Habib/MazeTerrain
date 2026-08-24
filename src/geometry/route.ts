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
  /**
   * The flat floor this build used, print mm. Only set for cutout builds.
   *
   * Read back so the insert can be given the CHANNEL's floor rather than
   * computing its own — see `cut.floor_mm`.
   */
  flatBottom_mm?: number;
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
  /**
   * What this build of the route is for.
   *
   * All three share one centreline and one width calculation, so the ridge, the
   * channel and the insert are the same shape by construction rather than by
   * three code paths agreeing to stay in step.
   *
   * - `cut` reaches below the terrain to carve the channel, and above it so the
   *   subtract opens the surface instead of leaving a skin where the tool stops
   *   exactly at the terrain it was draped on.
   * - `insert` is the piece that seats in that channel: narrowed by the
   *   clearance on each side, standing `proud_mm` above the terrain.
   *
   * Both use a FLAT underside at one shared Z (OPEN-QUESTIONS **Q10**, resolved
   * 2026-08-23). A draped insert seats perfectly but needs supports under every
   * overhang; a flat one prints with none. The cost is that the channel is as
   * deep as the route's lowest point, so on steep ground it removes a lot of
   * material — `assemble` warns when that gets significant.
   */
  cut?: {
    kind: 'cut' | 'insert';
    /** Channel floor, measured below the LOWEST terrain the route crosses. */
    depth_mm: number;
    proud_mm: number;
    /** Gap per side between insert and cavity. Ignored for `cut`. */
    clearance_mm?: number;
    /**
     * Use this floor instead of computing one.
     *
     * The insert has to be given the channel's floor. Left to work it out
     * itself it would compute a different one: it is narrower, so its footprint
     * covers slightly different ground, and the lowest point under it is not
     * the lowest point under the channel. The insert would then float above the
     * floor, or on a side slope bind against it.
     */
    floor_mm?: number;
  };
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
  let width_mm = widthClamped ? minWidth_mm : style.width_mm;

  const width_m = width_mm / scale.scale;

  // The insert is the same ribbon, inset. Note it is the CONTOUR that moves,
  // not the width: the field is built at the channel's width and traced at a
  // lower level, so the two curves are exact offsets of each other. Building a
  // narrower ribbon instead put it on a different grid, and where a route
  // switchbacked the intended gap collapsed from 44 m to half a metre — the
  // insert and the channel wall then touched, which is what the speckling
  // along overlapping stretches was.
  const inset_m =
    options.cut?.kind === 'insert' ? (options.cut.clearance_mm ?? 0) / scale.scale : 0;
  if (inset_m > 0) {
    width_mm = Math.max(0.01, width_mm - 2 * (options.cut?.clearance_mm ?? 0));
  }

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
  // width_m is the CHANNEL's width in every case; the insert differs only by
  // the level its contour is traced at.
  const ribbon = buildRibbonField(centreline, width_m, selection, undefined, {
    inset_m,
    // The channel refines to the insert's grid even though it is not inset, so
    // the two contours are traced off one field and the gap is real.
    resolve_m: options.cut?.clearance_mm ? options.cut.clearance_mm / scale.scale : 0,
  });
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

  // One flat floor for the channel and the piece that seats in it, placed under
  // the lowest ground the route crosses so the channel exists along all of it.
  let flatBottom_mm: number | undefined;
  if (options.cut) {
    // Sampled over the FOOTPRINT, not the centreline. The ribbon is wide, and
    // its edges reach ground the centreline never crosses — often lower. Taking
    // the centreline minimum puts the floor above the lowest point the channel
    // actually spans, which makes the cut shallower than asked for there and,
    // on a side slope, leaves stretches with no channel cut at all.
    if (options.cut.floor_mm !== undefined) {
      flatBottom_mm = options.cut.floor_mm;
    } else {
      let lowest = Infinity;
      for (const polygon of footprint) {
        for (const ring of polygon) {
          for (const [x_m, y_m] of ring) lowest = Math.min(lowest, sampleTerrainZ(x_m, y_m));
        }
      }
      if (Number.isFinite(lowest)) flatBottom_mm = lowest - options.cut.depth_mm;
    }
  }

  const mesh = extrudeDraped(
    footprint,
    sampleTerrainZ,
    (x_m, y_m) => [x_m * scale.scale, y_m * scale.scale],
    {
      height_mm: options.cut ? options.cut.proud_mm : style.height_mm,
      penetration_mm: options.cut ? options.cut.depth_mm : penetrationFor(style.height_mm),
      ...(flatBottom_mm !== undefined ? { flatBottom_mm } : {}),
      // Keep the underside strictly inside the base slab, never coplanar with
      // it and never below the build plate. A cutting tool is exempt: it is
      // never printed, and clamping it would make the channel shallower than
      // asked for wherever the terrain dips.
      minBottom_mm: options.cut ? -Infinity : Math.min(0.2, options.baseThickness_mm / 2),
      // Never finer than the ribbon is wide: refining across it buys no
      // accuracy and doubles the sliver count. See features.ts for the numbers.
      maxEdge_m: Math.max(terrainStep_m, width_m),
    },
  );

  return {
    mesh,
    stats: {
      ...emptyStats,
      triangles: mesh.triangles,
      ...(flatBottom_mm !== undefined ? { flatBottom_mm } : {}),
    },
  };
}
