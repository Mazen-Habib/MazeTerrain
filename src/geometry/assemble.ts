/**
 * Orchestrates the whole build and emits progress.
 *
 * Phase 0 covers stages 0, 1, 4, 8 and 9 of docs/05-geometry-pipeline.md.
 * Stages 2-3 (OSM fetch, project and clip), 5-6 (feature and route solids) and
 * 7 (boolean assembly) arrive in Phases 1-3 and slot in between
 * `building-heightfield` and `building-terrain` without changing this contract.
 */
import { buildMosaic, TileFetchError } from '../data/dem/fetchTiles';
import { getDataset } from '../data/dem/datasets';
import { inpaintNoData } from '../data/dem/sampler';
import { chooseZoom, tileRangeForBBox } from '../data/dem/tiles';
import { resolveGrid, resolveScale } from './coords';
import { buildHeightfield, smoothHeightfield } from './heightfield';
import { buildTerrainMesh } from './terrain';
import { buildClippedTerrainMesh } from './terrainClip';
import { repairAndValidate, validateMesh } from './validate';
import { BooleanError, subtractParts, unionParts } from './boolean';
import { buildRouteSolid } from './route';
import {
  buildLineLayer,
  buildPolygonLayer,
  groupLines,
  groupPolygons,
  waterRings,
} from './features';
import { fetchOsm, OverpassError } from '../data/osm/overpass';
import { normalise } from '../data/osm/normalise';
import { LAYER_BY_ID, type LayerId } from '../data/osm/tags';
import { bboxRingWorld, selectionRingWorld, type SelectionShape } from './selection';
import type { Route } from '../data/gpx/types';
import type {
  GenerateConfig,
  GenerateRequest,
  LayerBuildSummary,
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
const TERRAIN_END = 64;
const OSM_END = 72;
const FEATURES_END = 82;
const ROUTES_END = 92;

/** Never drop below this looking for coverage; the model would be meaningless. */
const MIN_DEM_ZOOM = 6;

/**
 * Triangles the OSM feature layers may spend between them.
 *
 * A JavaScript Map holds at most 16 777 216 entries, and the edge maps in
 * validation and extrusion hold roughly 1.5 per triangle, so a build that emits
 * more than about 11 M triangles dies inside V8 with "Map maximum size
 * exceeded" — an engine error that tells the user nothing. This budget stops
 * well short of it and explains itself.
 * See docs/08-pitfalls.md#feature-triangle-explosion.
 */
const FEATURE_TRIANGLE_BUDGET = 2_000_000;

export async function assemble(
  request: GenerateRequest,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<MeshBundle> {
  const { config, routes, selectionRing } = request;
  const started = performance.now();
  const warnings: PrintWarning[] = [];
  const layerSummaries: LayerBuildSummary[] = [];

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

  // Coverage is zoom-dependent by region. Mapterhorn serves z14 over
  // Switzerland, where swissALTI3D exists, and 404s at z14 over Pakistan while
  // serving z12 there happily. Asking for a zoom the region does not have
  // returns nothing but NoData, which the inpainter then flattens to zero — a
  // blank plate reported as a healthy watertight model.
  // See docs/08-pitfalls.md#dem-zoom-beyond-coverage.
  let zoom = chooseZoom(grid.resolution_m, centreLat, dataset.tileSize, dataset.maxZoom);
  let range = tileRangeForBBox(
    config.bbox.west,
    config.bbox.south,
    config.bbox.east,
    config.bbox.north,
    zoom,
  );

  report({
    stage: 'fetching-dem',
    percent: DEM_START,
    detail: `Fetching ${range.nx * range.ny} elevation tiles at zoom ${zoom}`,
  });

  const onTile = (done: number, total: number) => {
    report({
      stage: 'fetching-dem',
      percent: DEM_START + ((DEM_END - DEM_START) * done) / total,
      detail: `Elevation tile ${done} of ${total}`,
    });
  };

  let fetched = await buildMosaic(dataset, range, onTile, signal);
  throwIfAborted();

  let droppedZoom = false;
  while (fetched.missingTiles === fetched.totalTiles && zoom > MIN_DEM_ZOOM) {
    zoom--;
    droppedZoom = true;
    range = tileRangeForBBox(
      config.bbox.west,
      config.bbox.south,
      config.bbox.east,
      config.bbox.north,
      zoom,
    );
    report({
      stage: 'fetching-dem',
      percent: DEM_START,
      detail: `No coverage at that detail — retrying at zoom ${zoom}`,
    });
    fetched = await buildMosaic(dataset, range, onTile, signal);
    throwIfAborted();
  }

  if (fetched.missingTiles === fetched.totalTiles) {
    throw new TileFetchError(
      `No DEM coverage for bbox at any zoom down to ${MIN_DEM_ZOOM}`,
      `${dataset.label} has no elevation data for this area. Try the other ` +
        `elevation dataset, or pick a different location.`,
    );
  }

  if (droppedZoom) {
    warnings.push({
      level: 'warn',
      code: 'dem-zoom-reduced',
      message:
        `${dataset.label} has no tiles at the detail this selection asked for, so a ` +
        `coarser zoom (${zoom}) was used. The relief is real but softer than the ` +
        `sampling step suggests.`,
    });
  }

  if (fetched.missingTiles > 0) {
    warnings.push({
      level: 'warn',
      code: 'dem-partial-coverage',
      message:
        `${fetched.missingTiles} of ${fetched.totalTiles} elevation tiles were missing and ` +
        `have been interpolated from their neighbours.`,
    });
  }

  const mosaic = fetched.mosaic;

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

  // A selection ring means the model is a circle, hexagon or freehand polygon,
  // and the terrain has to be clipped to it — surface, walls and base alike
  // (docs/08-pitfalls.md#geometry-outside-boundary). Without one the selection
  // is the bbox rectangle and the whole grid is the model.
  const shape: SelectionShape | null = selectionRing
    ? { kind: 'polygon', ring: selectionRing }
    : null;
  const ringWorld = shape ? selectionRingWorld(shape, scale.origin) : null;

  // Features and routes are always clipped, even without a shape. For a
  // rectangle the bbox ring is exactly the terrain edge, so nothing legitimate
  // is cut — but it is what stops tiled OSM fetches, which reach a whole tile
  // beyond the selection, from building roads off the side of the model.
  const featureClip = ringWorld ?? bboxRingWorld(config.bbox, scale.origin);

  const mesh = ringWorld
    ? buildClippedTerrainMesh(heightfield, scale, ringWorld)
    : buildTerrainMesh(heightfield, scale);
  throwIfAborted();

  // --- Stages 2-3 + 5: OSM features ----------------------------------------
  const enabledLayers = (Object.keys(config.layers) as LayerId[]).filter(
    (id) => config.layers[id]?.enabled && LAYER_BY_ID[id],
  );
  const featureParts: MeshPart[] = [];

  if (enabledLayers.length > 0) {
    report({ stage: 'fetching-osm', percent: TERRAIN_END, detail: 'Fetching map data' });

    try {
      const response = await fetchOsm(config.bbox, enabledLayers, {
        ...(signal ? { signal } : {}),
        onAttempt: (detail) => report({ stage: 'fetching-osm', percent: TERRAIN_END, detail }),
      });
      throwIfAborted();

      const features = normalise(response);
      report({
        stage: 'building-features',
        percent: OSM_END,
        detail:
          `Building ${features.lines.length + features.polygons.length} map features`,
      });

      // Water footprints are needed even when the water layer is off, because a
      // road running through a river has to be deleted either way.
      const water = waterRings(features.polygons, scale);
      const grouped = groupLines(features.lines);
      const groupedPolygons = groupPolygons(features.polygons);
      const featureOptions = {
        heightfield,
        scale,
        selection: featureClip,
        nozzleDiameter_mm: config.nozzleDiameter_mm,
        baseThickness_mm: config.baseThickness_mm,
        layers: config.layers,
        triangleBudget: FEATURE_TRIANGLE_BUDGET,
      };
      let featureTriangles = 0;

      let done = 0;
      for (const layer of enabledLayers) {
        const isLine = LAYER_BY_ID[layer].kind === 'line';
        const lines = grouped.get(layer) ?? [];
        const polygons = groupedPolygons.get(layer) ?? [];
        const count = isLine ? lines.length : polygons.length;

        if (count === 0) {
          // Naming the empty layer beats printing nothing and saying nothing
          // (docs/08-pitfalls.md#sparse-osm-data).
          warnings.push({
            level: 'warn',
            code: 'layer-empty',
            message: `No ${LAYER_BY_ID[layer].label.toLowerCase()} found in this area.`,
          });
          done++;
          continue;
        }

        const remaining = Math.max(0, FEATURE_TRIANGLE_BUDGET - featureTriangles);
        const built = isLine
          ? buildLineLayer(layer, lines, water, {
              ...featureOptions,
              triangleBudget: remaining,
            })
          : buildPolygonLayer(layer, polygons, {
              ...featureOptions,
              triangleBudget: remaining,
            });
        if (built.part) featureParts.push(built.part);
        featureTriangles += built.stats.triangles;
        layerSummaries.push({
          layer,
          dropped: built.stats.droppedSubtypes,
          crowded: built.stats.crowdedSubtypes,
          coverage: built.stats.coverage,
          narrowestWidth_mm: built.stats.narrowestWidth_mm,
          widestWidth_mm: built.stats.width_mm,
          suggestedMinWidth_mm: built.stats.suggestedMinWidth_mm,
        });

        if (built.stats.truncated) {
          warnings.push({
            level: 'warn',
            code: 'feature-budget-reached',
            message:
              `This area has more ${LAYER_BY_ID[layer].label.toLowerCase()} than the model can ` +
              `carry, so some were left out after ${FEATURE_TRIANGLE_BUDGET.toLocaleString()} ` +
              `triangles. Reduce the selection area, or turn off layers you do not need.`,
          });
        }

        if (built.stats.droppedSubtypes.length > 0) {
          warnings.push({
            level: 'warn',
            code: 'classes-dropped',
            message:
              `${built.stats.droppedSubtypes.join(', ')} were left out, because ` +
              `"Only classes the model can carry" is on for ` +
              `${LAYER_BY_ID[layer].label.toLowerCase()}. Turn it off to build them ` +
              `anyway, or set Min width to about ` +
              `${built.stats.suggestedMinWidth_mm.toFixed(2)} mm to fit them all.`,
          });
        } else if (built.stats.crowdedSubtypes.length > 0) {
          // Built, not blocked. Say what it will look like and how to change it.
          warnings.push({
            level: 'warn',
            code: 'classes-crowded',
            message:
              `${built.stats.crowdedSubtypes.join(', ')} were built, but at this size they ` +
              `cover ${(built.stats.coverage * 100).toFixed(0)}% of the model and will merge ` +
              `into solid areas rather than read as separate streets. ` +
              `Set ${LAYER_BY_ID[layer].label} → Min width to about ` +
              `${built.stats.suggestedMinWidth_mm.toFixed(2)} mm to keep them distinct, ` +
              `or untick the classes you do not need.`,
          });
        }

        const label = LAYER_BY_ID[layer].label.toLowerCase();

        if (built.stats.widthClamped) {
          warnings.push({
            level: 'warn',
            code: 'feature-width-clamped',
            message:
              `${LAYER_BY_ID[layer].label} are drawn wider than true scale, ` +
              `${built.stats.narrowestWidth_mm.toFixed(2)}–${built.stats.width_mm.toFixed(2)} mm, ` +
              `so the narrowest class still prints. Classes stay in proportion to each other.`,
          });
        }

        // The floor is the user's to set, so say plainly when it is under the
        // nozzle rather than silently raising it back up.
        if (built.stats.narrowestWidth_mm > 0 &&
            built.stats.narrowestWidth_mm < config.nozzleDiameter_mm - 1e-6) {
          warnings.push({
            level: 'warn',
            code: 'feature-below-nozzle',
            message:
              `The narrowest ${label} print at ` +
              `${built.stats.narrowestWidth_mm.toFixed(2)} mm, under your ` +
              `${config.nozzleDiameter_mm} mm nozzle. An FDM slicer will drop them; ` +
              `raise "Min width" in the layer if you are printing this.`,
          });
        }

        done++;
        report({
          stage: 'building-features',
          percent: OSM_END + ((FEATURES_END - OSM_END) * done) / enabledLayers.length,
          detail: `${LAYER_BY_ID[layer].label}: ${built.stats.features} feature(s)`,
        });
        throwIfAborted();
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      // A missing basemap layer must not cost the user their terrain.
      warnings.push({
        level: 'warn',
        code: 'osm-unavailable',
        message:
          err instanceof OverpassError
            ? err.userMessage
            : `Could not load map features: ${err instanceof Error ? err.message : String(err)}. ` +
              `The terrain and route were built without them.`,
      });
    }
  }

  // --- Stage 6: route solids ------------------------------------------------
  const visibleRoutes = routes.filter((r) => r.style.visible);
  const routeParts: MeshPart[] = [];
  /**
   * The same routes built as cutting tools, for `single-cutout`.
   *
   * Built from the same centreline and width as the visible route, so what gets
   * cut is exactly what would have been raised — the two cannot drift.
   */
  const cutTools: MeshPart[] = [];
  const wantsCut = config.colorMode === 'single-cutout';

  if (visibleRoutes.length > 0) {
    report({
      stage: 'building-routes',
      percent: TERRAIN_END,
      detail: `Embossing ${visibleRoutes.length} route(s)`,
    });

    for (let i = 0; i < visibleRoutes.length; i++) {
      const record = visibleRoutes[i];
      const built = buildRouteSolid(toRoute(record), {
        heightfield,
        scale,
        selection: featureClip,
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

      if (wantsCut && built.stats.triangles > 0) {
        const tool = buildRouteSolid(toRoute(record), {
          heightfield,
          scale,
          selection: featureClip,
          nozzleDiameter_mm: config.nozzleDiameter_mm,
          baseThickness_mm: config.baseThickness_mm,
          cut: {
            depth_mm: config.cutout.insetDepth_mm,
            // Generous: the tool only has to clear the local surface, and a
            // channel that fails to break through is worse than a tall tool.
            proud_mm: Math.max(1, config.cutout.insetDepth_mm),
          },
        });
        if (tool.mesh.triangles > 0) {
          cutTools.push({
            name: `cut:${i}`,
            color: record.style.color,
            positions: tool.mesh.positions,
            indices: tool.mesh.indices,
            manifold: true,
          });
        }
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
  for (const part of [...featureParts, ...routeParts]) {
    // Feature layers are a MERGE of many closed solids that legitimately touch
    // at junctions. Welding them would fuse those solids into edges with four
    // adjacent faces and report a non-manifold layer that is nothing of the
    // kind — in multicolour mode overlapping parts are expected
    // (docs/05-geometry-pipeline.md Stage 7). Each solid is closed by
    // construction and mergeSolids offsets indices, so validate as-is.
    const merged = featureParts.includes(part);
    const check = merged
      ? { validation: validateMesh(part.positions, part.indices) }
      : repairAndValidate(part.positions, part.indices);

    if (!merged) {
      const repaired = check as ReturnType<typeof repairAndValidate>;
      part.positions = repaired.positions;
      part.indices = repaired.indices;
    }
    part.manifold = check.validation.manifold;
    if (!check.validation.manifold) {
      warnings.push({
        level: 'fail',
        code: 'part-not-manifold',
        message:
          `Layer "${part.name}" is not manifold: ${check.validation.openEdges} open edge(s), ` +
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

  let parts = [terrainPart, ...featureParts, ...routeParts];

  // --- Stage 7: colour mode (docs/02-feature-spec.md F6) --------------------
  //
  // Multicolour is the default and needs nothing: the parts already ARE the
  // answer. The single-colour modes collapse them into one body, which is a
  // real 3D boolean and the one place a CSG kernel is worth its weight.
  if (config.colorMode !== 'multicolor' && parts.length > 1) {
    report({
      stage: 'building-routes',
      percent: ROUTES_END,
      detail:
        config.colorMode === 'single-raised'
          ? 'Merging into one body'
          : 'Cutting the route out of the terrain',
    });

    try {
      if (config.colorMode === 'single-raised') {
        parts = [
          await unionParts(parts, { name: 'model', color: TERRAIN_COLOR }),
        ];
      } else {
        // Everything except the routes is the body; the routes become the tool.
        const body = [terrainPart, ...featureParts];
        const base =
          body.length === 1
            ? body[0]
            : await unionParts(body, { name: 'model', color: TERRAIN_COLOR });

        parts = [
          await subtractParts(base, cutTools, { name: 'model', color: TERRAIN_COLOR }),
        ];

        if (cutTools.length === 0) {
          warnings.push({
            level: 'warn',
            code: 'cutout-without-route',
            message:
              'Cutout mode has no route to cut. Upload a GPX, or switch back to ' +
              'multicolour — as it stands this is just the terrain.',
          });
        }
      }
      throwIfAborted();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      // Falling back to multicolour leaves the user with a usable model and an
      // explanation, rather than nothing at all.
      warnings.push({
        level: 'warn',
        code: 'boolean-failed',
        message:
          err instanceof BooleanError
            ? `${err.userMessage} The model was left as separate parts instead.`
            : `Could not combine the parts into one body: ` +
              `${err instanceof Error ? err.message : String(err)}. ` +
              `The model was left as separate parts instead.`,
      });
      parts = [terrainPart, ...featureParts, ...routeParts];
    }
  }

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
    layers: layerSummaries,
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

  // The model does not have to fit the bed — splitting it is a legitimate plan,
  // and Phase 4 has multi-tile output — so this says by how much and stops.
  if (config.bedSize_mm) {
    const [bedW, bedD] = config.bedSize_mm;
    // Either orientation counts: a 300 x 100 model fits a 250 x 210 bed turned.
    const fits =
      (w <= bedW && d <= bedD) || (w <= bedD && d <= bedW);
    if (!fits) {
      const over = Math.max(w - Math.max(bedW, bedD), d - Math.min(bedW, bedD));
      out.push({
        level: 'warn',
        code: 'over-bed-size',
        message:
          `Model is ${w.toFixed(0)} × ${d.toFixed(0)} mm, larger than your ` +
          `${bedW} × ${bedD} mm bed by about ${Math.max(1, Math.round(over))} mm. ` +
          `Reduce the model size, or print it in sections.`,
      });
    }
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
