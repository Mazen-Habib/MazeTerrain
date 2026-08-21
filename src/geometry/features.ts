/**
 * Stage 5: OSM line features as extruded solids.
 *
 * Roads, rails and trails reuse the route machinery — a level-set ribbon, then
 * the shared draped extruder — so there is one ribbon implementation in the
 * codebase rather than two that drift apart.
 *
 * The water/road interaction runs in the exact order docs/05-geometry-pipeline.md
 * Stage 2-3 sets out, because the order is what makes it correct:
 *
 *   a. split roads and rails against water polygons
 *   b. segments tagged bridge -> keep, flagged
 *   c. segments NOT tagged bridge that fall inside water -> delete
 *   d. tunnels never arrive here; they are dropped at classification
 *
 * A road diving under a river is the classic artefact.
 */
import type { LineFeature, PolygonFeature } from '../data/osm/normalise';
import { LAYER_BY_ID, type LayerId } from '../data/osm/tags';
import type { Pt } from '../data/gpx/simplify';
import { resample, simplifyPoints, toleranceForScale } from '../data/gpx/simplify';
import { projectENU, worldToPrint, type ResolvedScale } from './coords';
import { extrudeDraped, type SolidMesh } from './extrude';
import { sampleHeightfieldAt, type Heightfield } from './heightfield';
import type { MultiPolygon, Ring } from './polygons';
import { buildRibbonField, FEATURE_CELLS_PER_HALF_WIDTH } from './ribbonField';
import { pointInRing } from './route';
import type { MeshPart } from './types';

export interface LayerSettings {
  enabled: boolean;
  color: string;
  /** Print millimetres above the terrain. */
  height_mm: number;
  heightScale: number;
  widthScale: number;
  minWidth_mm: number;
  subtypes: string[];
  /**
   * Keep only as many classes as the model can legibly carry.
   *
   * Below a nozzle width nothing prints at true scale, so every road on a large
   * model is exaggerated — the question is how many classes to exaggerate before
   * the result is a solid mass rather than a map. At 21 km across, every road
   * class clamped to 0.8 mm would cover ~95% of a 100 mm model. Classes are
   * taken in importance order until printed coverage reaches its limit, so a
   * city shows motorways and primaries while a neighbourhood shows every lane.
   * See docs/08-pitfalls.md#sub-nozzle-classes-become-porridge.
   */
  legibilityFilter: boolean;
}

export interface BuildFeaturesOptions {
  heightfield: Heightfield;
  scale: ResolvedScale;
  selection: Ring | null;
  nozzleDiameter_mm: number;
  baseThickness_mm: number;
  layers: Record<string, LayerSettings>;
  /**
   * Triangles this layer may spend.
   *
   * Without a budget a dense city silently tries to build millions of triangles
   * and dies inside V8 with "Map maximum size exceeded" — a JS Map caps at
   * 16 777 216 entries, and the edge maps in validation and extrusion hold
   * roughly 1.5 per triangle. Stopping early with an explanation beats a
   * RangeError from the engine.
   */
  triangleBudget: number;
}

export interface FeatureBuildStats {
  layer: LayerId;
  features: number;
  triangles: number;
  /** True when the budget stopped this layer before every feature was built. */
  truncated: boolean;
  /** Segments deleted for running through water without a bridge tag. */
  drownedSegments: number;
  widthClamped: boolean;
  width_mm: number;
  /** Classes left out because they are narrower than the nozzle at this scale. */
  droppedSubtypes: string[];
}

/**
 * Share of the model's footprint one line layer may cover before it stops
 * reading as a map. A quarter is generous — at a third, a street grid closes up.
 */
const COVERAGE_LIMIT = 0.25;

/** Length of a projected line, metres. */
function lineLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

/**
 * Choose which classes the model can carry, in importance order.
 *
 * Each class costs printed area equal to its total length times its printed
 * width. Take classes while the running total stays under the limit; always
 * keep the most important one, so a layer that is on never renders as nothing.
 */
export function selectLegibleSubtypes(
  ordered: string[],
  lengthBySubtype: Map<string, number>,
  printedWidth_mm: (subtype: string) => number,
  scale_mm_per_m: number,
  modelArea_mm2: number,
): { kept: Set<string>; dropped: string[] } {
  const kept = new Set<string>();
  const dropped: string[] = [];
  const budget_mm2 = modelArea_mm2 * COVERAGE_LIMIT;
  let spent = 0;

  for (const subtype of ordered) {
    const length_m = lengthBySubtype.get(subtype);
    if (length_m === undefined || length_m <= 0) continue;

    const area_mm2 = length_m * scale_mm_per_m * printedWidth_mm(subtype);
    if (kept.size > 0 && spent + area_mm2 > budget_mm2) {
      dropped.push(subtype);
      continue;
    }
    kept.add(subtype);
    spent += area_mm2;
  }

  return { kept, dropped };
}

/** A run of consecutive points kept after the water split. */
interface Segment {
  points: Pt[];
  bridge: boolean;
}

function projectLine(points: Array<[number, number]>, scale: ResolvedScale): Pt[] {
  return points.map(([lon, lat]) => projectENU(lon, lat, scale.origin));
}

function insideAnyWater(x: number, y: number, water: Ring[]): boolean {
  for (const ring of water) if (pointInRing(x, y, ring)) return true;
  return false;
}

/**
 * Split a line where it enters water, dropping the wet parts unless the way is
 * a bridge. Classification is by segment midpoint, which is exact enough once
 * the line has been resampled to the terrain step.
 */
export function splitAgainstWater(
  points: Pt[],
  bridge: boolean,
  water: Ring[],
): { segments: Segment[]; drowned: number } {
  if (bridge || water.length === 0) {
    return { segments: [{ points, bridge }], drowned: 0 };
  }

  const segments: Segment[] = [];
  let current: Pt[] = [];
  let drowned = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const wet = insideAnyWater((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, water);

    if (wet) {
      drowned++;
      if (current.length >= 2) segments.push({ points: current, bridge: false });
      current = [];
      continue;
    }

    if (current.length === 0) current.push(a);
    current.push(b);
  }

  if (current.length >= 2) segments.push({ points: current, bridge: false });
  return { segments, drowned };
}

/**
 * A bridge deck is flat.
 *
 * Sampling the DEM under a bridge gives you the riverbed, so the deck dives into
 * the water it crosses. Interpolate linearly between the two approach ends and
 * ignore the terrain in between (docs/05-geometry-pipeline.md, Bridges).
 */
function bridgeSampler(
  points: Pt[],
  heightfield: Heightfield,
  scale: ResolvedScale,
): (x_m: number, y_m: number) => number {
  const start = points[0];
  const end = points[points.length - 1];
  const zAt = (p: Pt) => worldToPrint(p[0], p[1], sampleHeightfieldAt(heightfield, p[0], p[1]), scale)[2];

  const z0 = zAt(start);
  const z1 = zAt(end);
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSq = dx * dx + dy * dy;

  return (x_m, y_m) => {
    if (lengthSq === 0) return z0;
    let t = ((x_m - start[0]) * dx + (y_m - start[1]) * dy) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return z0 + (z1 - z0) * t;
  };
}

/** Concatenate solids into one part, so each layer is a single 3MF object. */
export function mergeSolids(meshes: SolidMesh[]): SolidMesh {
  let vertexCount = 0;
  let indexCount = 0;
  for (const m of meshes) {
    vertexCount += m.positions.length;
    indexCount += m.indices.length;
  }
  if (indexCount === 0) {
    return { positions: new Float32Array(0), indices: new Uint32Array(0), triangles: 0 };
  }

  const positions = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  let pOffset = 0;
  let iOffset = 0;
  let vertexBase = 0;

  for (const m of meshes) {
    positions.set(m.positions, pOffset);
    for (let i = 0; i < m.indices.length; i++) indices[iOffset + i] = m.indices[i] + vertexBase;
    pOffset += m.positions.length;
    iOffset += m.indices.length;
    vertexBase += m.positions.length / 3;
  }

  return { positions, indices, triangles: indexCount / 3 };
}

/** Water footprints in world metres, for the road-drowning test. */
export function waterRings(polygons: PolygonFeature[], scale: ResolvedScale): Ring[] {
  const rings: Ring[] = [];
  for (const polygon of polygons) {
    if (polygon.layer !== 'water') continue;
    // Outer ring only: a road crossing an island in a lake is on dry land, and
    // treating the hole as water would delete it.
    const outer = polygon.rings[0];
    if (outer && outer.length >= 3) rings.push(projectLine(outer, scale) as Ring);
  }
  return rings;
}

export interface LineLayerResult {
  part: MeshPart | null;
  stats: FeatureBuildStats;
}

/**
 * Build one MeshPart for a whole line layer.
 *
 * @param features every line already classified into this layer
 */
export function buildLineLayer(
  layer: LayerId,
  features: LineFeature[],
  water: Ring[],
  options: BuildFeaturesOptions,
): LineLayerResult {
  const settings = options.layers[layer];
  const stats: FeatureBuildStats = {
    layer,
    features: 0,
    triangles: 0,
    truncated: false,
    drownedSegments: 0,
    widthClamped: false,
    width_mm: 0,
    droppedSubtypes: [],
  };

  if (!settings?.enabled || features.length === 0) return { part: null, stats };

  const { heightfield, scale } = options;
  const terrainStep_m = Math.max(heightfield.spacingX_m, heightfield.spacingY_m);
  const minWidth_mm = Math.max(settings.minWidth_mm, 2 * options.nozzleDiameter_mm);
  const height_mm = Math.max(0.1, settings.height_mm * settings.heightScale);
  const penetration_mm = Math.max(1.0, height_mm * 0.5);
  const minBottom_mm = Math.min(0.2, options.baseThickness_mm / 2);

  // Group every centreline by the printed width it resolves to. There are only
  // a handful of distinct road widths, so this turns thousands of separate
  // ribbon fields into two or three networks.
  const byWidth = new Map<number, { width_mm: number; lines: Pt[][]; bridges: Pt[][] }>();

  const widthFor = (width_m: number) =>
    Math.max(minWidth_mm, width_m * scale.scale * settings.widthScale);

  // Decide which classes the model can carry before building anything.
  const projected = new Map<LineFeature, Pt[]>();
  const lengthBySubtype = new Map<string, number>();
  const widthBySubtype = new Map<string, number>();

  for (const feature of features) {
    if (settings.subtypes.length > 0 && !settings.subtypes.includes(feature.subtype)) continue;
    const points = projectLine(feature.points, scale);
    if (points.length < 2) continue;
    projected.set(feature, points);
    lengthBySubtype.set(
      feature.subtype,
      (lengthBySubtype.get(feature.subtype) ?? 0) + lineLength(points),
    );
    widthBySubtype.set(feature.subtype, widthFor(feature.width_m));
  }

  const modelArea_mm2 =
    scale.extentX_m * scale.scale * (scale.extentY_m * scale.scale);
  const selection = settings.legibilityFilter
    ? selectLegibleSubtypes(
        LAYER_BY_ID[layer].subtypes,
        lengthBySubtype,
        (subtype) => widthBySubtype.get(subtype) ?? minWidth_mm,
        scale.scale,
        modelArea_mm2,
      )
    : { kept: new Set(lengthBySubtype.keys()), dropped: [] as string[] };

  stats.droppedSubtypes = selection.dropped;

  for (const feature of features) {
    const projectedPoints = projected.get(feature);
    if (!projectedPoints) continue;
    if (!selection.kept.has(feature.subtype)) continue;

    const natural_mm = feature.width_m * scale.scale * settings.widthScale;
    const width_mm = Math.max(minWidth_mm, natural_mm);
    if (natural_mm < minWidth_mm) stats.widthClamped = true;
    stats.width_mm = Math.max(stats.width_mm, width_mm);

    // Quantise so near-identical widths share a field.
    const bucket = Math.round(width_mm * 20) / 20;
    let group = byWidth.get(bucket);
    if (!group) {
      group = { width_mm: bucket, lines: [], bridges: [] };
      byWidth.set(bucket, group);
    }

    const { segments, drowned } = splitAgainstWater(projectedPoints, feature.bridge, water);
    stats.drownedSegments += drowned;

    for (const segment of segments) {
      const simplified = simplifyPoints(segment.points, 2 * toleranceForScale(scale.scale));
      if (simplified.length < 2) continue;
      // Bridges need their own flat deck, so they cannot share a network field.
      if (segment.bridge) group.bridges.push(simplified);
      else group.lines.push(simplified);
      stats.features++;
    }
  }

  if (byWidth.size === 0) return { part: null, stats };

  const drapeZ = (x_m: number, y_m: number) =>
    worldToPrint(x_m, y_m, sampleHeightfieldAt(heightfield, x_m, y_m), scale)[2];

  const extrudeOptions = {
    height_mm,
    penetration_mm,
    minBottom_mm,
    // No subdivision. The contour is already sampled at a third of the ribbon's
    // half-width, and the solid digs penetration_mm into the terrain — which at
    // any city scale is far more than the chord error across a ribbon a couple
    // of millimetres wide. Uniform subdivision quadrupled every triangle to buy
    // accuracy the penetration already covers.
    maxEdge_m: Infinity,
  };

  const solids: SolidMesh[] = [];
  let spent = 0;

  /**
   * Triangles a contour will cost, before paying for them.
   *
   * Merging a layer into one network means there is no per-feature point to
   * stop at any more, so the budget has to be checked against an estimate up
   * front. Every ring point becomes a top triangle, a bottom triangle and two
   * wall triangles.
   */
  const estimateTriangles = (polygons: MultiPolygon): number => {
    let points = 0;
    for (const poly of polygons) for (const ring of poly) points += ring.length;
    return points * 4;
  };

  for (const group of byWidth.values()) {
    if (spent >= options.triangleBudget) {
      stats.truncated = true;
      break;
    }

    const width_m = group.width_mm / scale.scale;

    if (group.lines.length > 0) {
      const ribbon = buildRibbonField(
        group.lines,
        width_m,
        options.selection,
        FEATURE_CELLS_PER_HALF_WIDTH,
      );
      if (ribbon.polygons.length > 0) {
        if (spent + estimateTriangles(ribbon.polygons) > options.triangleBudget) {
          stats.truncated = true;
          break;
        }
        const mesh = extrudeDraped(
          ribbon.polygons,
          drapeZ,
          (x_m, y_m) => [x_m * scale.scale, y_m * scale.scale],
          extrudeOptions,
        );
        if (mesh.triangles > 0) {
          solids.push(mesh);
          spent += mesh.triangles;
        }
      }
    }

    // Each bridge keeps its own field and its own flat deck.
    for (const bridge of group.bridges) {
      if (spent >= options.triangleBudget) {
        stats.truncated = true;
        break;
      }
      const centreline = resample(bridge, terrainStep_m);
      const ribbon = buildRibbonField(
        centreline,
        width_m,
        options.selection,
        FEATURE_CELLS_PER_HALF_WIDTH,
      );
      if (ribbon.polygons.length === 0) continue;
      if (spent + estimateTriangles(ribbon.polygons) > options.triangleBudget) {
        stats.truncated = true;
        break;
      }

      const mesh = extrudeDraped(
        ribbon.polygons,
        bridgeSampler(centreline, heightfield, scale),
        (x_m, y_m) => [x_m * scale.scale, y_m * scale.scale],
        extrudeOptions,
      );
      if (mesh.triangles > 0) {
        solids.push(mesh);
        spent += mesh.triangles;
      }
    }
  }

  if (solids.length === 0) return { part: null, stats };

  const merged = mergeSolids(solids);
  stats.triangles = merged.triangles;

  return {
    part: {
      name: layer,
      color: settings.color,
      positions: merged.positions,
      indices: merged.indices,
      manifold: true,
    },
    stats,
  };
}

/** Group normalised lines by layer, so each layer builds once. */
export function groupLines(lines: LineFeature[]): Map<LayerId, LineFeature[]> {
  const grouped = new Map<LayerId, LineFeature[]>();
  for (const line of lines) {
    const list = grouped.get(line.layer);
    if (list) list.push(line);
    else grouped.set(line.layer, [line]);
  }
  return grouped;
}
