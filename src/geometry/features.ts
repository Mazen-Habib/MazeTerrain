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
import type { LayerId } from '../data/osm/tags';
import type { Pt } from '../data/gpx/simplify';
import { resample, simplifyPoints, toleranceForScale } from '../data/gpx/simplify';
import { projectENU, worldToPrint, type ResolvedScale } from './coords';
import { extrudeDraped, type SolidMesh } from './extrude';
import { sampleHeightfieldAt, type Heightfield } from './heightfield';
import type { Ring } from './polygons';
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
  };

  if (!settings?.enabled || features.length === 0) return { part: null, stats };

  const { heightfield, scale } = options;
  const terrainStep_m = Math.max(heightfield.spacingX_m, heightfield.spacingY_m);
  const minWidth_mm = Math.max(settings.minWidth_mm, 2 * options.nozzleDiameter_mm);
  const height_mm = Math.max(0.1, settings.height_mm * settings.heightScale);
  const penetration_mm = Math.max(1.0, height_mm * 0.5);
  const minBottom_mm = Math.min(0.2, options.baseThickness_mm / 2);

  const solids: SolidMesh[] = [];
  let spent = 0;

  for (const feature of features) {
    if (spent >= options.triangleBudget) {
      stats.truncated = true;
      break;
    }
    if (settings.subtypes.length > 0 && !settings.subtypes.includes(feature.subtype)) continue;

    const projected = projectLine(feature.points, scale);
    if (projected.length < 2) continue;

    const { segments, drowned } = splitAgainstWater(projected, feature.bridge, water);
    stats.drownedSegments += drowned;

    // Width lives in print space so a motorway is legible at any model size, and
    // is clamped to two nozzles or the slicer drops it entirely
    // (docs/08-pitfalls.md#sub-nozzle-features).
    const natural_mm = feature.width_m * scale.scale * settings.widthScale;
    const width_mm = Math.max(minWidth_mm, natural_mm);
    if (natural_mm < minWidth_mm) stats.widthClamped = true;
    stats.width_mm = Math.max(stats.width_mm, width_mm);
    const width_m = width_mm / scale.scale;

    for (const segment of segments) {
      // Twice the route's budget: 0.3 print mm of deviation is invisible on a
      // road and roughly halves the point count.
      const simplified = simplifyPoints(segment.points, 2 * toleranceForScale(scale.scale));
      const centreline = resample(simplified, terrainStep_m);
      if (centreline.length < 2) continue;

      const ribbon = buildRibbonField(
        centreline,
        width_m,
        options.selection,
        FEATURE_CELLS_PER_HALF_WIDTH,
      );
      if (ribbon.polygons.length === 0) continue;

      const sampleTerrainZ = segment.bridge
        ? bridgeSampler(centreline, heightfield, scale)
        : (x_m: number, y_m: number) =>
            worldToPrint(x_m, y_m, sampleHeightfieldAt(heightfield, x_m, y_m), scale)[2];

      const mesh = extrudeDraped(
        ribbon.polygons,
        sampleTerrainZ,
        (x_m, y_m) => [x_m * scale.scale, y_m * scale.scale],
        { height_mm, penetration_mm, minBottom_mm, maxEdge_m: terrainStep_m },
      );

      if (mesh.triangles > 0) {
        solids.push(mesh);
        spent += mesh.triangles;
        stats.features++;
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
