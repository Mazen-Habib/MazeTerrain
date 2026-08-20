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
import { repairAndValidate, validateMesh } from './validate';
import { buildRouteSolid } from './route';
import { selectionRingWorld, type SelectionShape } from './selection';
import type { Route } from '../data/gpx/types';
import type {
  GenerateConfig,
  GenerateRequest,
  MeshBundle,
  MeshPart,
  PrintWarning,
  ProgressCallback,
} from './types';

const TERRAIN_COLOR = '#A0907A';

/** Progress budget per stage, in percent. Monotonic, derived from real work. */
const DEM_START = 5;
const DEM_END = 45;
const HEIGHTFIELD_END = 60;
const TERRAIN_END = 80;
const ROUTES_END = 92;

export async function assemble(
  request: GenerateRequest,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<MeshBundle> {
  const { config, routes, selectionRing } = request;
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

  if (grid.belowNozzle) {
    warnings.push({
      level: 'warn',
      code: 'below-nozzle-detail',
      message:
        `Sampling step ${grid.resolution_m.toFixed(1)} m is finer than this printer can ` +
        `resolve (${grid.printableStep_m.toFixed(1)} m at a ${config.nozzleDiameter_mm} mm nozzle ` +
        `and ${config.modelWidth_mm} mm model). Ridges will come out as blades thinner than ` +
        `the nozzle. Switch the sampling step to Auto, or print the model larger.`,
    });
  }

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

  // --- Stage 6: route solids ------------------------------------------------
  const visibleRoutes = routes.filter((r) => r.style.visible);
  const routeParts: MeshPart[] = [];

  if (visibleRoutes.length > 0) {
    report({
      stage: 'building-routes',
      percent: TERRAIN_END,
      detail: `Embossing ${visibleRoutes.length} route(s)`,
    });

    const shape: SelectionShape | null = selectionRing
      ? { kind: 'polygon', ring: selectionRing }
      : null;
    const ringWorld = shape ? selectionRingWorld(shape, scale.origin) : null;

    for (let i = 0; i < visibleRoutes.length; i++) {
      const record = visibleRoutes[i];
      const built = buildRouteSolid(toRoute(record), {
        heightfield,
        scale,
        selection: ringWorld,
        nozzleDiameter_mm: config.nozzleDiameter_mm,
        baseThickness_mm: config.baseThickness_mm,
      });

      if (built.stats.widthClamped) {
        warnings.push({
          level: 'warn',
          code: 'route-width-clamped',
          message:
            `"${record.name}" was widened to ${built.stats.width_mm.toFixed(2)} mm — the minimum ` +
            `for a ${config.nozzleDiameter_mm} mm nozzle. Below it the slicer drops the route ` +
            `entirely.`,
        });
      }

      if (built.stats.clippedLength_m > 1) {
        warnings.push({
          level: 'warn',
          code: 'route-clipped',
          message:
            `"${record.name}" extends beyond your selection — ` +
            `${(built.stats.clippedLength_m / 1000).toFixed(1)} km will be cut. ` +
            `Use "Fit selection to routes" to include all of it.`,
        });
      }

      if (built.mesh.triangles === 0) {
        warnings.push({
          level: 'warn',
          code: 'route-empty',
          message: `"${record.name}" produced no geometry — it may fall entirely outside the selection.`,
        });
        continue;
      }

      routeParts.push({
        name: `route:${i}`,
        color: record.style.color,
        positions: built.mesh.positions,
        indices: built.mesh.indices,
        manifold: true,
      });

      report({
        stage: 'building-routes',
        percent: TERRAIN_END + ((ROUTES_END - TERRAIN_END) * (i + 1)) / visibleRoutes.length,
        detail: `Route ${i + 1} of ${visibleRoutes.length}`,
      });
      throwIfAborted();
    }
  }

  // --- Stage 9: validate ----------------------------------------------------
  report({ stage: 'validating', percent: ROUTES_END, detail: 'Checking the mesh is watertight' });

  const repaired = repairAndValidate(mesh.positions, mesh.indices);
  const validation = repaired.validation;

  // Each route is validated as its own closed solid. In multicolour mode the
  // parts stay separate and overlaps are expected — the route deliberately
  // penetrates the terrain (docs/05-geometry-pipeline.md Stage 7).
  for (const part of routeParts) {
    const check = repairAndValidate(part.positions, part.indices);
    part.positions = check.positions;
    part.indices = check.indices;
    part.manifold = check.validation.manifold;
    if (!check.validation.manifold) {
      warnings.push({
        level: 'fail',
        code: 'route-not-manifold',
        message:
          `${part.name} is not manifold: ${check.validation.openEdges} open edge(s), ` +
          `${check.validation.nonManifoldEdges} non-manifold edge(s). Export is blocked.`,
      });
    }
  }

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

  const slivers =
    validation.degenerateTriangles +
    routeParts.reduce((n, part) => n + countDegenerates(part), 0);
  if (slivers > 0) {
    warnings.push({
      level: 'warn',
      code: 'degenerate-triangles',
      message:
        `${slivers} zero-area triangle(s) in the mesh. Slicers discard these, and the solid ` +
        `is still watertight, but they are a sign the footprint had slivers.`,
    });
  }

  const terrainPart: MeshPart = {
    name: 'terrain',
    color: TERRAIN_COLOR,
    positions: repaired.positions,
    indices: repaired.indices,
    manifold: validation.manifold,
  };

  const parts = [terrainPart, ...routeParts];

  let triangles = 0;
  let vertices = 0;
  for (const part of parts) {
    triangles += part.indices.length / 3;
    vertices += part.positions.length / 3;
  }

  warnings.push(...printChecks(config, mesh.dimensions_mm, triangles));

  const bundle: MeshBundle = {
    parts,
    stats: {
      triangles,
      vertices,
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

function countDegenerates(part: MeshPart): number {
  return validateMesh(part.positions, part.indices).degenerateTriangles;
}

/** Rehydrate a worker-transferred route record into the shape the builder wants. */
function toRoute(record: GenerateRequest['routes'][number]): Route {
  return {
    id: record.id,
    name: record.name,
    points: record.points,
    distance_m: 0,
    elevationGain_m: null,
    bbox: { west: 0, south: 0, east: 0, north: 0 },
    style: {
      color: record.style.color,
      width_mm: record.style.width_mm,
      height_mm: record.style.height_mm,
      profile: 'raised',
      elevationSource: record.style.elevationSource,
      demBlend: record.style.demBlend,
      visible: record.style.visible,
    },
  };
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
