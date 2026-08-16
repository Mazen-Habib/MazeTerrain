/**
 * Orchestrates the whole build and emits progress.
 *
 * Phase 0 covers stages 0, 1, 4, 8 and 9 of docs/05-geometry-pipeline.md.
 * Stages 2-3 (OSM fetch, project and clip), 5-6 (feature and route solids) and
 * 7 (boolean assembly) arrive in Phases 1-3 and slot in between
 * `building-heightfield` and `building-terrain` without changing this contract.
 */
import { buildMosaic } from '../data/dem/fetchTiles';
import { getDataset } from '../data/dem/datasets';
import { inpaintNoData } from '../data/dem/sampler';
import { chooseZoom, tileRangeForBBox } from '../data/dem/tiles';
import { resolveGrid, resolveScale } from './coords';
import { buildHeightfield, smoothHeightfield } from './heightfield';
import { buildTerrainMesh } from './terrain';
import { repairAndValidate } from './validate';
import type {
  GenerateConfig,
  MeshBundle,
  PrintWarning,
  ProgressCallback,
} from './types';

const TERRAIN_COLOR = '#A0907A';

/** Progress budget per stage, in percent. Monotonic, derived from real work. */
const DEM_START = 5;
const DEM_END = 45;
const HEIGHTFIELD_END = 60;
const TERRAIN_END = 90;

export async function assemble(
  config: GenerateConfig,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<MeshBundle> {
  const started = performance.now();
  const warnings: PrintWarning[] = [];

  const report: ProgressCallback = (p) => onProgress?.(p);
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };

  // --- Stage 0: resolve config ---------------------------------------------
  report({ stage: 'resolving', percent: 0, detail: 'Working out scale and grid' });

  const dataset = getDataset(config.dataset);
  const grid = resolveGrid(config);

  if (grid.resolutionCoarsened) {
    warnings.push({
      level: 'warn',
      code: 'resolution-coarsened',
      message:
        `Sampling step increased to ${grid.resolution_m.toFixed(1)} m to keep the grid ` +
        `under 1.5 M vertices. Reduce the selection area for finer detail.`,
    });
  }

  // --- Stage 1: fetch DEM ---------------------------------------------------
  const centreLat = grid.origin.lat0;
  const zoom = chooseZoom(grid.resolution_m, centreLat, dataset.tileSize, dataset.maxZoom);
  const range = tileRangeForBBox(
    config.bbox.west,
    config.bbox.south,
    config.bbox.east,
    config.bbox.north,
    zoom,
  );
  const tileTotal = range.nx * range.ny;

  report({
    stage: 'fetching-dem',
    percent: DEM_START,
    detail: `Fetching ${tileTotal} elevation tiles at zoom ${zoom}`,
  });

  const mosaic = await buildMosaic(
    dataset,
    range,
    (done, total) => {
      report({
        stage: 'fetching-dem',
        percent: DEM_START + ((DEM_END - DEM_START) * done) / total,
        detail: `Elevation tile ${done} of ${total}`,
      });
    },
    signal,
  );
  throwIfAborted();

  // --- Stage 1b: heightfield ------------------------------------------------
  report({
    stage: 'building-heightfield',
    percent: DEM_END,
    detail: 'Repairing gaps in the elevation data',
  });

  const repairedCells = inpaintNoData(mosaic);
  if (repairedCells > 0) {
    const fraction = repairedCells / mosaic.data.length;
    if (fraction > 0.25) {
      warnings.push({
        level: 'warn',
        code: 'dem-sparse',
        message:
          `${(fraction * 100).toFixed(0)} % of the elevation data for this area was missing ` +
          `and has been interpolated. The relief may not be accurate.`,
      });
    }
  }

  const heightfield = buildHeightfield(mosaic, grid);
  if (config.smoothing > 0) {
    report({
      stage: 'building-heightfield',
      percent: (DEM_END + HEIGHTFIELD_END) / 2,
      detail: `Smoothing, ${config.smoothing} pass(es)`,
    });
    smoothHeightfield(heightfield, config.smoothing);
  }
  throwIfAborted();

  // --- Stage 4 + 8: terrain surface, walls and base -------------------------
  report({
    stage: 'building-terrain',
    percent: HEIGHTFIELD_END,
    detail: `Triangulating ${heightfield.cols} x ${heightfield.rows} grid`,
  });

  const scale = resolveScale(config, heightfield.min_m, heightfield.max_m);

  if (scale.exaggerationClamped) {
    warnings.push({
      level: 'warn',
      code: 'exaggeration-clamped',
      message:
        `Vertical exaggeration reduced from ${scale.requestedExaggeration.toFixed(1)}x to ` +
        `${scale.effectiveExaggeration.toFixed(1)}x to respect the ` +
        `${config.maxHeight_mm} mm max height.`,
    });
  }

  const mesh = buildTerrainMesh(heightfield, scale);
  throwIfAborted();

  // --- Stage 9: validate ----------------------------------------------------
  report({ stage: 'validating', percent: TERRAIN_END, detail: 'Checking the mesh is watertight' });

  const repaired = repairAndValidate(mesh.positions, mesh.indices);
  const validation = repaired.validation;

  if (!validation.manifold) {
    warnings.push({
      level: 'fail',
      code: 'not-manifold',
      message:
        `The mesh is not manifold: ${validation.openEdges} open edge(s), ` +
        `${validation.nonManifoldEdges} non-manifold edge(s), ` +
        `${validation.degenerateTriangles} degenerate triangle(s). Export is blocked.`,
    });
  }
  if (validation.inverted) {
    warnings.push({
      level: 'fail',
      code: 'inverted',
      message: 'The mesh is inside-out (negative signed volume). Export is blocked.',
    });
  }

  const triangles = repaired.indices.length / 3;
  warnings.push(...printChecks(config, mesh.dimensions_mm, triangles));

  const bundle: MeshBundle = {
    parts: [
      {
        name: 'terrain',
        color: TERRAIN_COLOR,
        positions: repaired.positions,
        indices: repaired.indices,
        manifold: validation.manifold,
      },
    ],
    stats: {
      triangles,
      vertices: repaired.positions.length / 3,
      dimensions_mm: mesh.dimensions_mm,
      extent_km: [scale.extentX_m / 1000, scale.extentY_m / 1000],
      elevationRange_m: [heightfield.min_m, heightfield.max_m],
      watertight: validation.watertight,
      demDataset: dataset.label,
      verticalExaggeration: scale.effectiveExaggeration,
      resolution_m: scale.resolution_m,
      gridSize: [heightfield.cols, heightfield.rows],
      buildTime_ms: performance.now() - started,
    },
    warnings,
    validation,
  };

  report({ stage: 'done', percent: 100, detail: 'Done' });
  return bundle;
}

/**
 * The subset of the F8 legibility checks that has inputs in Phase 0.
 * The line-feature width checks arrive with the OSM layers in Phase 2.
 */
export function printChecks(
  config: GenerateConfig,
  dimensions_mm: [number, number, number],
  triangles: number,
): PrintWarning[] {
  const out: PrintWarning[] = [];
  const [w, d, h] = dimensions_mm;

  const minBase_mm = 3 * config.layerHeight_mm;
  if (config.baseThickness_mm < minBase_mm) {
    out.push({
      level: 'warn',
      code: 'thin-base',
      message:
        `Base is ${config.baseThickness_mm} mm — below the ${minBase_mm.toFixed(2)} mm minimum ` +
        `(3 layers at ${config.layerHeight_mm} mm). Thin bases warp off the bed. ` +
        `Increase base thickness to at least ${minBase_mm.toFixed(2)} mm; 3 mm is recommended.`,
    });
  }

  // Relief that cannot survive slicing. A model whose terrain is thinner than a
  // layer prints as a flat plate, and reporting "no issues" on it is worse than
  // saying nothing. See docs/08-pitfalls.md#invisible-relief.
  const relief_mm = h - config.baseThickness_mm;
  if (relief_mm < config.layerHeight_mm) {
    out.push({
      level: 'warn',
      code: 'invisible-relief',
      message:
        `Terrain relief is ${relief_mm.toFixed(2)} mm — below one ${config.layerHeight_mm} mm ` +
        `layer, so it will print as a flat plate. Raise vertical exaggeration, ` +
        `increase model width, or pick an area with more elevation change.`,
    });
  } else if (relief_mm < 3 * config.layerHeight_mm) {
    out.push({
      level: 'warn',
      code: 'low-relief',
      message:
        `Terrain relief is only ${relief_mm.toFixed(2)} mm (${(relief_mm / config.layerHeight_mm).toFixed(1)} layers). ` +
        `It will be hard to see. Raise vertical exaggeration for more contrast.`,
    });
  }

  const footprint = Math.min(w, d);
  if (h > 2 * footprint) {
    out.push({
      level: 'warn',
      code: 'tipping-risk',
      message:
        `Model is ${h.toFixed(1)} mm tall on a ${footprint.toFixed(1)} mm footprint. ` +
        `Above 2x footprint it tips over. Reduce vertical exaggeration or max height.`,
    });
  }

  if (triangles > 2_000_000) {
    out.push({
      level: 'warn',
      code: 'triangle-count',
      message:
        `${triangles.toLocaleString()} triangles — above 2 M, slicers get slow. ` +
        `Increase the sampling step to reduce it.`,
    });
  }

  return out;
}
