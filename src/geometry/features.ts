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
import { DEFAULT_BUILDING_HEIGHT_M, LAYER_BY_ID, type LayerId } from '../data/osm/tags';
import type { Pt } from '../data/gpx/simplify';
import { resample, simplifyPoints, toleranceForScale } from '../data/gpx/simplify';
import { projectENU, worldToPrint, type ResolvedScale } from './coords';
import { extrudeDraped, type SolidMesh } from './extrude';
import { sampleHeightfieldAt, type Heightfield } from './heightfield';
import { clipPolygonToRing, convexPieces } from './clip';
import type { MultiPolygon, Polygon, Ring } from './polygons';
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
  /**
   * Narrowest printed line for this layer, or 'auto' for one nozzle diameter.
   *
   * A number is taken at face value, including below the nozzle. That is a real
   * choice: a model destined for resin, or for a render rather than a printer,
   * wants finer lines than an FDM nozzle can lay, and forcing everything up to
   * the nozzle is what turns a city into a slab.
   */
  minWidth_mm: number | 'auto';
  /**
   * Printed width per class, in millimetres, overriding the ladder.
   *
   * Sparse: a class absent from this map is on the ladder, which is what makes
   * the defaults follow the model's scale. An entry here is the final printed
   * width for that class — taking manual control of a class stops `widthScale`
   * second-guessing it, so what you set is what gets built.
   */
  subtypeWidth_mm: Record<string, number>;
  subtypes: string[];
  /**
   * Remove classes the model cannot legibly carry, rather than warning about
   * them. Off by default.
   *
   * Crowding is a judgement, not an error: a dense city that merges into solid
   * blocks is a legitimate thing to print, and refusing to build it is the tool
   * overruling the user. So by default every ticked class is built and a
   * warning says which ones will merge and what width would separate them.
   * Turning this on makes the same budget enforce instead of advise.
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
  /** True when any class had to be printed wider than true scale. */
  widthClamped: boolean;
  /** Widest printed line in this layer. */
  width_mm: number;
  /** Narrowest printed line in this layer — the one a nozzle has to manage. */
  narrowestWidth_mm: number;
  /** Classes left out because the model cannot carry them at this size. */
  droppedSubtypes: string[];
  /** Classes that will build but merge into solid areas at this size. */
  crowdedSubtypes: string[];
  /** Share of the model footprint this layer covers, 0-1. */
  coverage: number;
  /**
   * Floor at which every requested class would fit, when some were dropped.
   * Zero when nothing was dropped.
   */
  suggestedMinWidth_mm: number;
}

/**
 * Share of the model's footprint one line layer may cover before it stops
 * reading as a map. A quarter is generous — at a third, a street grid closes up.
 */
const COVERAGE_LIMIT = 0.25;

/**
 * Narrowest line a printer can lay down, in print millimetres.
 *
 * One nozzle diameter, not two. Two is the rule for a *free-standing* wall,
 * which needs an outward perimeter on each side. A road is a ridge sitting on
 * solid base, so any Arachne-era slicer lays it as a single extrusion.
 * See docs/08-pitfalls.md#sub-nozzle-features.
 */
export function autoMinWidth_mm(nozzleDiameter_mm: number): number {
  return nozzleDiameter_mm;
}

/** Nothing useful survives below this, whatever the arithmetic says. */
const ABSOLUTE_MIN_WIDTH_MM = 0.06;

/**
 * What "Auto" resolves to: the nozzle, unless that would bury the model.
 *
 * A fixed floor cannot be right at every scale. One nozzle is exactly right on
 * a neighbourhood, where roads are already wider than that at true scale. On a
 * city it is a disaster: measured over 9.3 km of Islamabad, 1 237 km of road at
 * a 0.4 mm floor covers **80.6% of the model**. That is not a map, it is a
 * slab with a few gaps in it — and no fixed floor fixes it, because the most
 * aggressive setting still covers a third.
 *
 * So Auto starts at the nozzle and comes down until the layer fits its
 * legibility budget. On a neighbourhood that first guess already fits and
 * nothing changes; on a city it drops until the street pattern reappears. When
 * it lands under the nozzle the build says so — a legible model that needs a
 * finer nozzle is a better default than an illegible one that prints, and the
 * user can raise it back with the Min width control either way.
 */
export function autoFloorForCoverage_mm(
  nozzleDiameter_mm: number,
  coverageAtNozzle: number,
): number {
  const start = autoMinWidth_mm(nozzleDiameter_mm);
  if (!(coverageAtNozzle > COVERAGE_LIMIT)) return start;
  const scaled = (start * COVERAGE_LIMIT) / coverageAtNozzle;
  return Math.max(ABSOLUTE_MIN_WIDTH_MM, Math.floor(scaled * 100) / 100);
}

export function resolveMinWidth_mm(
  setting: number | 'auto',
  nozzleDiameter_mm: number,
): number {
  if (setting === 'auto') return autoMinWidth_mm(nozzleDiameter_mm);
  return Math.max(0.01, setting);
}

/**
 * How hard class widths are compressed once they fall below the floor.
 *
 * Square root. At a city scale every road class is sub-nozzle — an 11 km model
 * puts a 20 m motorway at 0.18 mm and a 3 m track at 0.03 mm — so clamping each
 * to the floor gave all of them one identical width, and the street hierarchy
 * that makes a map readable disappeared. Real widths cannot be used and equal
 * widths are useless, so classes are spread on a ladder anchored at the floor:
 * the narrowest class prints at exactly the floor and wider classes rise by the
 * square root of their real ratio. Linear spread would put a motorway seven
 * times wider than a track and close the grid again; the root keeps the spread
 * near 2x, which reads as hierarchy without eating the model.
 */
const WIDTH_LADDER_GAMMA = 0.5;

/**
 * Printed width for one class.
 *
 * Never below the floor, never below true scale — the ladder only ever lifts,
 * so a model large enough to print roads at their real width is not exaggerated.
 */
export function ladderWidth_mm(
  natural_m: number,
  narrowest_m: number,
  floor_mm: number,
  scale_mm_per_m: number,
): number {
  const natural_mm = natural_m * scale_mm_per_m;
  if (!(narrowest_m > 0) || !(natural_m > 0)) return Math.max(floor_mm, natural_mm);
  const lifted = floor_mm * Math.pow(natural_m / narrowest_m, WIDTH_LADDER_GAMMA);
  return Math.max(natural_mm, lifted);
}

/**
 * The floor at which every requested class would fit.
 *
 * Dropping classes is the blunt lever. The sharp one is drawing the same roads
 * thinner, which keeps the whole street pattern and only costs fineness — so
 * the warning should name a number the user can type rather than telling them
 * to shrink their area. Coverage is very nearly linear in the floor, because
 * the ladder multiplies it through: halve the floor and every class halves,
 * except any already printing at true scale, which is why this is a suggestion
 * and the build still re-checks.
 */
export function minWidthToFit_mm(
  currentFloor_mm: number,
  requested_mm2: number,
  budget_mm2: number,
): number {
  if (!(requested_mm2 > budget_mm2) || !(currentFloor_mm > 0)) return currentFloor_mm;
  // Round down to a typable 0.01 mm so the suggestion actually clears the bar.
  return Math.max(0.01, Math.floor((currentFloor_mm * budget_mm2) / requested_mm2 * 100) / 100);
}

/**
 * What each class will print at, worked out from the tag tables alone.
 *
 * The Layers panel has to show a width beside every class before any OSM data
 * exists, so this mirrors `planLineLayer`'s ladder using the class's documented
 * real-world width instead of measured features. Once a preview is loaded the
 * panel uses the real numbers, which differ only in the ladder's anchor: this
 * assumes the narrowest ticked class is present, which is almost always true.
 */
export function estimatedWidths_mm(
  subtypes: string[],
  naturalWidth_m: (subtype: string) => number,
  settings: Pick<LayerSettings, 'widthScale' | 'subtypeWidth_mm'>,
  minWidth_mm: number,
  scale_mm_per_m: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (subtypes.length === 0) return out;

  let narrowest_m = Infinity;
  for (const subtype of subtypes) {
    const w = naturalWidth_m(subtype);
    if (w > 0) narrowest_m = Math.min(narrowest_m, w);
  }

  const overrides = settings.subtypeWidth_mm ?? {};
  for (const subtype of subtypes) {
    const override = overrides[subtype];
    out.set(
      subtype,
      override !== undefined && override > 0
        ? override
        : ladderWidth_mm(naturalWidth_m(subtype), narrowest_m, minWidth_mm, scale_mm_per_m) *
            settings.widthScale,
    );
  }
  return out;
}

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
 *
 * The first class that does not fit ends the list. Skipping it and carrying on
 * looked thriftier but produced nonsense cartography — on an 11 km Islamabad
 * model it dropped residential streets, then bought `track` and `pedestrian`
 * with the change, so the print showed footpaths through suburbs whose roads
 * were missing. A map is read top-down: cut the tail, never the middle.
 */
export function selectLegibleSubtypes(
  ordered: string[],
  lengthBySubtype: Map<string, number>,
  printedWidth_mm: (subtype: string) => number,
  scale_mm_per_m: number,
  modelArea_mm2: number,
): {
  kept: Set<string>;
  dropped: string[];
  /**
   * Classes from the point where cumulative coverage crosses the budget.
   *
   * Unlike `dropped` this does NOT exempt the most important class. That
   * exemption exists so an enabled layer never renders as nothing, which is a
   * rule about what to remove — as a rule about what to *warn* on it silences
   * the clearest case there is: one class, on its own, blanketing the model.
   */
  over: string[];
  /** Printed area the kept classes use. */
  spent_mm2: number;
  /** Printed area every requested class would use, kept or not. */
  requested_mm2: number;
  budget_mm2: number;
} {
  const kept = new Set<string>();
  const dropped: string[] = [];
  const over: string[] = [];
  const budget_mm2 = modelArea_mm2 * COVERAGE_LIMIT;
  let requested_mm2 = 0;
  for (const subtype of ordered) {
    const length_m = lengthBySubtype.get(subtype) ?? 0;
    if (length_m > 0) requested_mm2 += length_m * scale_mm_per_m * printedWidth_mm(subtype);
  }
  let spent = 0;

  for (let i = 0; i < ordered.length; i++) {
    const subtype = ordered[i];
    const length_m = lengthBySubtype.get(subtype);
    if (length_m === undefined || length_m <= 0) continue;

    const area_mm2 = length_m * scale_mm_per_m * printedWidth_mm(subtype);
    const overflows = spent + area_mm2 > budget_mm2;

    if (overflows && over.length === 0) {
      for (const rest of ordered.slice(i)) {
        if ((lengthBySubtype.get(rest) ?? 0) > 0) over.push(rest);
      }
    }

    if (overflows && kept.size > 0) {
      for (const rest of ordered.slice(i)) {
        if ((lengthBySubtype.get(rest) ?? 0) > 0) dropped.push(rest);
      }
      break;
    }
    kept.add(subtype);
    spent += area_mm2;
  }

  return { kept, dropped, over, spent_mm2: spent, requested_mm2, budget_mm2 };
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

/**
 * What a line layer will contain, decided before any geometry is built.
 *
 * The map preview and the mesh builder both read this, so what the map
 * highlights is what the model gets — by construction, not by two
 * implementations agreeing to stay in step.
 */
export interface LayerPlan {
  /** Subtypes that will be built. */
  kept: Set<string>;
  /** Subtypes cut from the build, in importance order. Empty unless the user
   *  asked for the filter to enforce, rather than warn. */
  dropped: string[];
  /**
   * Subtypes past the legibility budget: they will merge into solid areas
   * rather than read as separate streets.
   *
   * Reported whether or not they are dropped. Crowding is the user's call to
   * make — the model still builds, and a warning says what it will look like.
   */
  crowded: string[];
  /** Share of the model footprint this layer's lines cover, 0-1. */
  coverage: number;
  /** Printed width per subtype, millimetres, overrides applied. */
  widthBySubtype: Map<string, number>;
  /** What each subtype would print at on the ladder, ignoring any override. */
  autoWidthBySubtype: Map<string, number>;
  /** Printed width for one feature, millimetres. */
  widthFor: (subtype: string, width_m: number) => number;
  /** The floor in force, after resolving 'auto'. */
  minWidth_mm: number;
  /** Floor at which nothing would crowd; 0 when nothing does. */
  suggestedMinWidth_mm: number;
  /** Centrelines in local ENU metres, so the builder does not project twice. */
  projected: Map<LineFeature, Pt[]>;
}

export function planLineLayer(
  layer: LayerId,
  features: LineFeature[],
  settings: LayerSettings,
  scale: ResolvedScale,
  nozzleDiameter_mm: number,
): LayerPlan {
  const projected = new Map<LineFeature, Pt[]>();
  const lengthBySubtype = new Map<string, number>();
  const naturalBySubtype = new Map<string, number>();
  let narrowest_m = Infinity;

  for (const feature of features) {
    if (settings.subtypes.length > 0 && !settings.subtypes.includes(feature.subtype)) continue;
    const points = projectLine(feature.points, scale);
    if (points.length < 2) continue;
    projected.set(feature, points);
    lengthBySubtype.set(
      feature.subtype,
      (lengthBySubtype.get(feature.subtype) ?? 0) + lineLength(points),
    );
    naturalBySubtype.set(feature.subtype, feature.width_m);
    if (feature.width_m > 0) narrowest_m = Math.min(narrowest_m, feature.width_m);
  }

  const modelArea_mm2 = scale.extentX_m * scale.scale * (scale.extentY_m * scale.scale);

  /** Share of the model this layer would cover with a given floor. */
  const coverageWithFloor = (floor_mm: number) => {
    if (!(modelArea_mm2 > 0)) return 0;
    let area = 0;
    for (const [subtype, length_m] of lengthBySubtype) {
      const natural_m = naturalBySubtype.get(subtype) ?? 0;
      const w = ladderWidth_mm(natural_m, narrowest_m, floor_mm, scale.scale) * settings.widthScale;
      area += length_m * scale.scale * w;
    }
    return area / modelArea_mm2;
  };

  // 'auto' means "as fine as the printer needs, unless that buries the model".
  // An explicit number is taken at face value, including below the nozzle.
  const minWidth_mm =
    settings.minWidth_mm === 'auto'
      ? autoFloorForCoverage_mm(nozzleDiameter_mm, coverageWithFloor(autoMinWidth_mm(nozzleDiameter_mm)))
      : resolveMinWidth_mm(settings.minWidth_mm, nozzleDiameter_mm);

  // The ladder is anchored on the narrowest class actually present, so a
  // selection holding only motorways prints them at the floor rather than
  // several times it.
  const autoWidth = (width_m: number) =>
    ladderWidth_mm(width_m, narrowest_m, minWidth_mm, scale.scale) * settings.widthScale;

  const overrides = settings.subtypeWidth_mm ?? {};
  const widthFor = (subtype: string, width_m: number) => {
    const override = overrides[subtype];
    // An override is the final width. The floor does not raise it and
    // widthScale does not scale it: the user has said what they want, and the
    // below-nozzle warning covers the case where that is very thin.
    if (override !== undefined && override > 0) return Math.max(0.01, override);
    return autoWidth(width_m);
  };

  const widthBySubtype = new Map<string, number>();
  const autoWidthBySubtype = new Map<string, number>();
  for (const [subtype, natural_m] of naturalBySubtype) {
    widthBySubtype.set(subtype, widthFor(subtype, natural_m));
    autoWidthBySubtype.set(subtype, autoWidth(natural_m));
  }

  // Always work out which classes are past the budget. Whether that *removes*
  // them is a separate question, and by default the answer is no: a crowded
  // model is a legitimate thing to want, so it builds and the warning says the
  // streets will merge. Only an explicit opt-in makes the filter enforce.
  const legibility = selectLegibleSubtypes(
    LAYER_BY_ID[layer].subtypes,
    lengthBySubtype,
    (subtype) => widthBySubtype.get(subtype) ?? minWidth_mm,
    scale.scale,
    modelArea_mm2,
  );

  const enforce = settings.legibilityFilter;
  const crowded = legibility.over;

  return {
    kept: enforce ? legibility.kept : new Set(lengthBySubtype.keys()),
    dropped: enforce ? legibility.dropped : [],
    crowded,
    coverage: modelArea_mm2 > 0 ? legibility.requested_mm2 / modelArea_mm2 : 0,
    widthBySubtype,
    autoWidthBySubtype,
    widthFor,
    minWidth_mm,
    suggestedMinWidth_mm:
      crowded.length > 0
        ? minWidthToFit_mm(minWidth_mm, legibility.requested_mm2, legibility.budget_mm2)
        : 0,
    projected,
  };
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
    narrowestWidth_mm: Infinity,
    droppedSubtypes: [],
    crowdedSubtypes: [],
    coverage: 0,
    suggestedMinWidth_mm: 0,
  };

  if (!settings?.enabled || features.length === 0) {
    stats.narrowestWidth_mm = 0;
    return { part: null, stats };
  }

  const { heightfield, scale } = options;
  const terrainStep_m = Math.max(heightfield.spacingX_m, heightfield.spacingY_m);
  const height_mm = Math.max(0.1, settings.height_mm * settings.heightScale);
  const penetration_mm = Math.max(1.0, height_mm * 0.5);
  const minBottom_mm = Math.min(0.2, options.baseThickness_mm / 2);

  // Group every centreline by the printed width it resolves to. There are only
  // a handful of distinct road widths, so this turns thousands of separate
  // ribbon fields into two or three networks.
  const byWidth = new Map<number, { width_mm: number; lines: Pt[][]; bridges: Pt[][] }>();

  const plan = planLineLayer(layer, features, settings, scale, options.nozzleDiameter_mm);
  const { projected, widthFor } = plan;
  const selection = { kept: plan.kept, dropped: plan.dropped };

  stats.droppedSubtypes = plan.dropped;
  stats.crowdedSubtypes = plan.crowded;
  stats.coverage = plan.coverage;
  stats.suggestedMinWidth_mm = plan.suggestedMinWidth_mm;

  for (const feature of features) {
    const projectedPoints = projected.get(feature);
    if (!projectedPoints) continue;
    if (!selection.kept.has(feature.subtype)) continue;

    const natural_mm = feature.width_m * scale.scale * settings.widthScale;
    const width_mm = widthFor(feature.subtype, feature.width_m);
    if (width_mm > natural_mm + 1e-6) stats.widthClamped = true;
    stats.width_mm = Math.max(stats.width_mm, width_mm);
    stats.narrowestWidth_mm = Math.min(stats.narrowestWidth_mm, width_mm);

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

  if (byWidth.size === 0) {
    stats.narrowestWidth_mm = 0;
    return { part: null, stats };
  }

  const drapeZ = (x_m: number, y_m: number) =>
    worldToPrint(x_m, y_m, sampleHeightfieldAt(heightfield, x_m, y_m), scale)[2];

  const extrudeOptions = {
    height_mm,
    penetration_mm,
    minBottom_mm,
    // Vertices wherever the terrain has them. Without this the contour of a
    // long straight road is two edges with almost nothing between them, so one
    // triangle spans hundreds of metres of ground it never sampled and the
    // terrain punches straight through the road.
    maxEdge_m: terrainStep_m,
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


/**
 * Build one MeshPart for a whole polygon layer.
 *
 * Water areas, greenery, sand and buildings all reduce to the same thing: a
 * footprint clipped to the selection and handed to the shared draped extruder.
 * They differ only in how tall they stand.
 *
 * Buildings are the exception that earns its own branch. Every other polygon
 * layer is a flat sheet at one height, so the whole layer is one extrusion.
 * Buildings each have their own height from the OSM tag cascade, so they are
 * extruded per feature and merged — the same many-solids-in-one-part shape the
 * line layers already produce, and for the same reason: welding a merged solid
 * fuses the ones that touch (docs/08-pitfalls.md#weld-fuses-merged-solids).
 */
export function buildPolygonLayer(
  layer: LayerId,
  features: PolygonFeature[],
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
    narrowestWidth_mm: 0,
    droppedSubtypes: [],
    crowdedSubtypes: [],
    coverage: 0,
    suggestedMinWidth_mm: 0,
  };

  if (!settings?.enabled || features.length === 0) return { part: null, stats };

  const { heightfield, scale } = options;
  // Draped surfaces have to carry vertices wherever the terrain does, or a
  // large flat footprint spans ground it never sampled and the terrain pokes
  // through it. See docs/08-pitfalls.md#undraped-features-let-terrain-through.
  const terrainStep_m = Math.max(heightfield.spacingX_m, heightfield.spacingY_m);
  const minBottom_mm = Math.min(0.2, options.baseThickness_mm / 2);
  const drapeZ = (x_m: number, y_m: number) =>
    worldToPrint(x_m, y_m, sampleHeightfieldAt(heightfield, x_m, y_m), scale)[2];
  const toPrintXY = (x_m: number, y_m: number): [number, number] => [
    x_m * scale.scale,
    y_m * scale.scale,
  ];

  // Decomposed once, not once per feature: a freehand outline can be hundreds
  // of vertices and ear-clipping it for every building would dominate the build.
  const clipPieces = options.selection ? convexPieces(options.selection) : null;

  const clip = (rings: Ring[]): Polygon[] => {
    if (!options.selection || !clipPieces) return [rings];
    return clipPolygonToRing(rings, options.selection, clipPieces);
  };

  const isBuildings = layer === 'buildings';
  const solids: SolidMesh[] = [];
  const sheet: MultiPolygon = [];
  let spent = 0;

  for (const feature of features) {
    if (settings.subtypes.length > 0 && !settings.subtypes.includes(feature.subtype)) continue;

    const rings = feature.rings
      .map((ring) => projectLine(ring, scale))
      .filter((ring) => ring.length >= 3);
    if (rings.length === 0) continue;

    const clipped = clip(rings as Ring[]);
    if (clipped.length === 0) continue;
    stats.features++;

    if (!isBuildings) {
      sheet.push(...clipped);
      continue;
    }

    // A building's height comes from the tag cascade, and `min_height` lifts
    // the bottom for the upper part of a stepped building — but the bottom
    // still has to reach the terrain, or the solid floats.
    const real_m = feature.height_m ?? DEFAULT_BUILDING_HEIGHT_M;
    const height_mm = Math.max(
      0.1,
      real_m * scale.zScale * settings.heightScale,
    );

    if (spent >= options.triangleBudget) {
      stats.truncated = true;
      break;
    }

    const mesh = extrudeDraped(clipped, drapeZ, toPrintXY, {
      height_mm,
      penetration_mm: Math.max(1.0, height_mm * 0.25),
      minBottom_mm,
      maxEdge_m: terrainStep_m,
    });
    if (mesh.triangles > 0) {
      solids.push(mesh);
      spent += mesh.triangles;
      stats.width_mm = Math.max(stats.width_mm, height_mm);
    }
  }

  if (!isBuildings && sheet.length > 0) {
    const height_mm = Math.max(0.1, settings.height_mm * settings.heightScale);
    const mesh = extrudeDraped(sheet, drapeZ, toPrintXY, {
      height_mm,
      penetration_mm: Math.max(1.0, height_mm * 0.5),
      minBottom_mm,
      maxEdge_m: terrainStep_m,
    });
    if (mesh.triangles > 0) solids.push(mesh);
    stats.width_mm = height_mm;
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

/** Group normalised polygons by layer, so each layer builds once. */
export function groupPolygons(polygons: PolygonFeature[]): Map<LayerId, PolygonFeature[]> {
  const grouped = new Map<LayerId, PolygonFeature[]>();
  for (const polygon of polygons) {
    const list = grouped.get(polygon.layer);
    if (list) list.push(polygon);
    else grouped.set(polygon.layer, [polygon]);
  }
  return grouped;
}
