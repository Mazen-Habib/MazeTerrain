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

export interface MeshBundle {
  parts: MeshPart[];
  stats: MeshStats;
  warnings: PrintWarning[];
  validation: ValidationResult;
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
   * The printer's horizontal resolution limit. Not decoration either: it is the
   * floor on the terrain sampling step, because sampling finer than the nozzle
   * manufactures detail the printer cannot lay down.
   * See docs/08-pitfalls.md#sub-nozzle-terrain-detail.
   */
  nozzleDiameter_mm: number;
}

export type ProgressStage =
  | 'resolving'
  | 'fetching-dem'
  | 'building-heightfield'
  | 'building-terrain'
  | 'validating'
  | 'done';

export interface Progress {
  stage: ProgressStage;
  /** 0-100, monotonic, derived from real work rather than a timer. */
  percent: number;
  detail: string;
}

export type ProgressCallback = (p: Progress) => void;
