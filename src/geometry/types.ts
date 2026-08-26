/**
 * The worker's output contract (docs/03-architecture.md).
 *
 * The preview and every exporter consume this same object. There is no second
 * geometry path — if the preview and the export ever diverge, users stop trusting
 * both of them.
 */

/** A single printable body. Positions are print-space millimetres, +X east, +Y north, +Z up. */
export interface MeshPart {
  /** 'terrain' | 'route:0' | 'roads' | 'water' | ... */
  name: string;
  /** Hex colour, '#RRGGBB'. */
  color: string;
  /** xyz triples, print-space mm. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Computed on demand if absent. */
  normals?: Float32Array;
  manifold: boolean;
}

export interface MeshStats {
  triangles: number;
  vertices: number;
  dimensions_mm: [number, number, number];
  extent_km: [number, number];
  elevationRange_m: [number, number];
  watertight: boolean;
  demDataset: string;
  /** Effective vertical exaggeration after the maxHeight_mm clamp. */
  verticalExaggeration: number;
  /** Metres per grid sample actually used. */
  resolution_m: number;
  gridSize: [number, number];
  buildTime_ms: number;
}

export type WarningLevel = 'warn' | 'fail';

export interface PrintWarning {
  level: WarningLevel;
  code: string;
  message: string;
}

/**
 * What one layer's build actually did, so the Layers panel can reflect it back.
 *
 * Without this the panel shows a tick beside `residential` while the model has
 * no residential streets in it — the legibility filter having dropped them —
 * and the user has no way to see the difference between what they asked for and
 * what they got.
 */
export interface LayerBuildSummary {
  layer: string;
  /** Classes the filter left out at this size, in importance order. */
  dropped: string[];
  /** Classes that were built but will merge into solid areas at this size. */
  crowded: string[];
  /** Share of the model footprint this layer covers, 0-1. */
  coverage: number;
  /** Printed width range actually used, millimetres. */
  narrowestWidth_mm: number;
  widestWidth_mm: number;
  /** Floor at which every requested class would have fitted; 0 if none dropped. */
  suggestedMinWidth_mm: number;
}

export interface MeshBundle {
  parts: MeshPart[];
  stats: MeshStats;
  warnings: PrintWarning[];
  validation: ValidationResult;
  /** One entry per line layer that was built. */
  layers: LayerBuildSummary[];
}

/** docs/05-geometry-pipeline.md, Stage 9. */
export interface ValidationResult {
  manifold: boolean;
  watertight: boolean;
  /** Edges with != 2 adjacent faces. */
  openEdges: number;
  /** Edges with > 2 adjacent faces. */
  nonManifoldEdges: number;
  degenerateTriangles: number;
  /** Signed volume < 0 — the mesh is inside-out. */
  inverted: boolean;
  volume_mm3: number;
}

/** Axis-aligned geographic bounds, WGS84 degrees. */
export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Everything the worker needs to build a mesh. Serialisable; this is the dirty-state key. */
/**
 * docs/02-feature-spec.md F6. Three distinct behaviours that must not be
 * conflated: separate objects per layer, one body with the route raised, or one
 * body with the route cut out of it.
 */
export type ColorMode = 'multicolor' | 'single-raised' | 'single-cutout';

/** `groove` leaves a channel to paint or fill; `inlay` also emits the insert. */
export type CutoutSubMode = 'groove' | 'inlay';

export interface CutoutSettings {
  subMode: CutoutSubMode;
  /**
   * Gap between insert and cavity, per side.
   *
   * docs/02-feature-spec.md: "the clearance is the whole ballgame. Too tight
   * and the insert won't seat; too loose and it rattles."
   */
  clearance_mm: number;
  /** How deep the channel cuts below the terrain surface. */
  insetDepth_mm: number;
  /** How far the insert stands above the terrain once seated. */
  insertProud_mm: number;
}

/**
 * Raised rings at fixed elevation steps.
 *
 * Off by default, and most valuable in the single-colour modes: a monochrome
 * terrain has only its silhouette to read relief by.
 */
export interface ContourSettings {
  enabled: boolean;
  /**
   * Elevation step between rings, in real metres.
   *
   * 'auto' sizes it from the terrain's own slope so the rings stay separate.
   * A fixed interval cannot do that: whether 50 m rings read as lines or fuse
   * into a crust depends on how steep the ground is and how large the model is
   * (docs/08-pitfalls.md#contours-merge-into-a-crust).
   */
  interval_m: number | 'auto';
  /** How far a ring stands above the terrain, print mm. */
  lineHeight_mm: number;
}

/**
 * A flat-topped rim around the inside of the model's boundary.
 *
 * One control, not two: OPEN-QUESTIONS Q15 (resolved 2026-08-27) struck the
 * separate "brim", because a brim is a bed-adhesion setting that belongs to the
 * slicer and a narrow frame is the decorative lip the spec wanted.
 */
export interface FrameSettings {
  enabled: boolean;
  /** Band width, print mm. Narrow reads as an edge lip, wide as a picture frame. */
  width_mm: number;
  /** How far the top face stands above the lowest ground, print mm. */
  height_mm: number;
}

export interface GenerateConfig {
  bbox: BBox;
  dataset: string;
  /** Longest edge of the printed model. */
  modelWidth_mm: number;
  /** Solid material below the lowest terrain point. */
  baseThickness_mm: number;
  verticalExaggeration: number;
  /** Hard ceiling on printed relief; clamps the effective exaggeration. */
  maxHeight_mm: number;
  seaLevelOffset_m: number;
  /** DEM sampling step in metres, or 'auto' to target ~400-800 samples on the long edge. */
  resolution_m: number | 'auto';
  /** Laplacian smoothing passes. Cosmetic; flattens real features. */
  smoothing: number;
  /**
   * Drives the minimum-feature checks. Not decoration — the base-thickness
   * warning is expressed in layer heights (docs/02-feature-spec.md F8).
   */
  layerHeight_mm: number;
  /**
   * Printer bed, millimetres, or null for "do not check".
   *
   * The last of the F8 checks. A model larger than the bed is not a geometry
   * error and must not block export — plenty of people slice on one machine and
   * print on another, or intend to split the model — so this warns and says by
   * how much.
   */
  bedSize_mm: [number, number] | null;
  /** docs/02-feature-spec.md F6. */
  colorMode: ColorMode;
  cutout: CutoutSettings;
  /** docs/02-feature-spec.md F3.1. */
  contours: ContourSettings;
  /** docs/02-feature-spec.md F5. */
  frame: FrameSettings;
  /**
   * The printer's horizontal resolution limit. Not decoration either: it is the
   * floor on the terrain sampling step, because sampling finer than the nozzle
   * manufactures detail the printer cannot lay down.
   * See docs/08-pitfalls.md#sub-nozzle-terrain-detail.
   */
  nozzleDiameter_mm: number;
  /** Per-layer OSM feature settings, keyed by LayerId. */
  layers: Record<string, import('./features').LayerSettings>;
}

/** Config plus the routes to emboss. Kept separate so GenerateConfig stays serialisable-small. */
export interface GenerateRequest {
  config: GenerateConfig;
  /** Serialisable route records. Empty means terrain only, as in Phase 0. */
  routes: SerialisableRoute[];
  /** Selection outline in lon/lat, or null for the plain bbox rectangle. */
  selectionRing: Array<[number, number]> | null;
}

/** The subset of Route the worker needs — no React state, no functions. */
export interface SerialisableRoute {
  id: string;
  name: string;
  points: Array<{ lon: number; lat: number; ele?: number; t?: number }>;
  style: {
    color: string;
    width_mm: number;
    height_mm: number;
    profile: string;
    elevationSource: 'dem' | 'gpx' | 'flat';
    demBlend: number;
    visible: boolean;
  };
}

export type ProgressStage =
  | 'resolving'
  | 'fetching-dem'
  | 'fetching-osm'
  | 'building-features'
  | 'building-heightfield'
  | 'building-terrain'
  | 'building-routes'
  | 'validating'
  | 'done';

export interface Progress {
  stage: ProgressStage;
  /** 0-100, monotonic, derived from real work rather than a timer. */
  percent: number;
  detail: string;
}

export type ProgressCallback = (p: Progress) => void;
