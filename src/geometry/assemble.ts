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
import { resolveGrid, resolveScale, worldToPrint } from './coords';
import { buildHeightfield, sampleHeightfieldAt, smoothHeightfield } from './heightfield';
import { buildTerrainMesh } from './terrain';
import { buildClippedTerrainMesh } from './terrainClip';
import { findFloatingVertices, repairAndValidate, validateMesh } from './validate';
import { BooleanError, subtractParts, unionParts } from './boolean';
import { buildRouteSolid } from './route';
import { traceContours, suggestInterval } from './contours';
import { buildFrame, frameSubmersion } from './frame';
import { buildBaseline, buildLabelTool, labelCoverage } from './label';
import { buildRibbonField, FEATURE_CELLS_PER_HALF_WIDTH } from './ribbonField';
import type { MultiPolygon } from './polygons';
import { extrudeDraped } from './extrude';
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
import type { Ring } from './polygons';
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
 *
 * Raised from 2 M once feature layers started following the terrain properly.
 * Draping a dense city's roads at the terrain step costs roughly nine times
 * what an undraped ribbon did — measured at 1.78 M for 6 009 road ways over
 * 9.3 km — and 2 M would have truncated that mid-layer. The triangle-count
 * warning still fires at 2 M, so the cost stays visible.
 * See docs/08-pitfalls.md#feature-triangle-explosion.
 */
const FEATURE_TRIANGLE_BUDGET = 6_000_000;

/**
 * Total area of a multipolygon footprint in print mm2, holes subtracted.
 *
 * Used to say how much of the plate the contours have taken over, which is the
 * measure that actually tracks legibility — counting rings does not, because
 * rings that have merged are no longer rings.
 */
function footprintArea_mm2(polygons: MultiPolygon, scale_mm_per_m: number): number {
  const k = scale_mm_per_m * scale_mm_per_m;
  let total = 0;
  for (const polygon of polygons) {
    for (let r = 0; r < polygon.length; r++) {
      const ring = polygon[r];
      let twice = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        twice += p[0] * q[1] - q[0] * p[1];
      }
      total += (r === 0 ? 1 : -1) * Math.abs(twice / 2) * k;
    }
  }
  return total;
}

/**
 * How far above the tallest thing in the model a cutting tool reaches.
 *
 * The tool is never printed, so a generous margin costs nothing but guarantees
 * the subtract opens the channel through every layer rather than shaving the
 * bottom off whatever it crosses.
 */
const CUT_TOOL_HEADROOM_MM = 5;

/**
 * Share of the boundary the terrain may stand over before the frame is worth a
 * word. A peak that happens to touch the edge is not a problem; a rim buried
 * along a third of its length is not a rim.
 */
const FRAME_SUBMERSION_LIMIT = 0.15;

/** Tallest a label may be relative to the frame it is cut into. */
const LABEL_MAX_SHARE_OF_FRAME = 0.55;

/** Share of the label that must land on the plaque before it is worth a word. */
const LABEL_COVERAGE_LIMIT = 0.99;

/**
 * Share of the plate above which contours have stopped being lines. Measured on
 * real mountain terrain: a quarter still reads as a relief map, and the 86% a
 * fixed 50 m interval produced there did not.
 */
const CONTOUR_COVERAGE_LIMIT = 0.3;

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
          const auto = config.layers[layer]?.minWidth_mm === 'auto';
          warnings.push({
            level: 'warn',
            code: 'feature-below-nozzle',
            message: auto
              ? `${LAYER_BY_ID[layer].label} were thinned to ` +
                `${built.stats.narrowestWidth_mm.toFixed(2)} mm so the street pattern stays ` +
                `readable at this size — at your ${config.nozzleDiameter_mm} mm nozzle they ` +
                `would otherwise cover most of the model. An FDM slicer will drop lines this ` +
                `fine, so set ${LAYER_BY_ID[layer].label} → Min width to ` +
                `${config.nozzleDiameter_mm} mm if you are printing this, and expect them to ` +
                `crowd.`
              : `The narrowest ${label} print at ` +
                `${built.stats.narrowestWidth_mm.toFixed(2)} mm, under your ` +
                `${config.nozzleDiameter_mm} mm nozzle. An FDM slicer will drop them; ` +
                `raise "Min width" in the layer if you are printing this.`,
          });
        }

        if (built.stats.tooNarrow > 0 || built.stats.shortened > 0) {
          const bits: string[] = [];
          if (built.stats.tooNarrow > 0) {
            bits.push(
              `${built.stats.tooNarrow} were narrower than your ` +
                `${config.nozzleDiameter_mm} mm nozzle and were left out`,
            );
          }
          if (built.stats.shortened > 0) {
            bits.push(
              `${built.stats.shortened} were shortened because they would have printed as ` +
                `spikes taller than four times their own footprint`,
            );
          }
          const total = built.stats.features + built.stats.tooNarrow;
          const mostlyGone = total > 0 && built.stats.tooNarrow / total > 0.5;
          warnings.push({
            level: 'warn',
            code: 'building-unprintable',
            message: mostlyGone
              ? `Most buildings cannot be shown at this size: ${built.stats.tooNarrow} of ` +
                `${total} are narrower than your ${config.nozzleDiameter_mm} mm nozzle and were ` +
                `left out. Buildings need roughly a 2 km selection or smaller to read as ` +
                `buildings — turn the layer off, or select a smaller area.`
              : `Of the buildings here, ${bits.join(', and ')}.`,
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

  // --- Stage 5b: contour lines (docs/02-feature-spec.md F3.1) ---------------
  //
  // Traced as centrelines and then built by the same ribbon-and-drape path the
  // road layers use, so they inherit its fixes rather than repeating them.
  const contourParts: MeshPart[] = [];
  if (config.contours.enabled) {
    // One nozzle wide: a contour is a hairline by nature, and anything wider
    // reads as a terrace rather than a line.
    const width_m = config.nozzleDiameter_mm / scale.scale;
    const height_mm = Math.max(0.1, config.contours.lineHeight_mm);

    // The interval that keeps rings apart on THIS terrain at THIS size. Used
    // directly when set to auto, and as the advice when a fixed one crowds.
    const suggested_m = suggestInterval(heightfield, width_m, scale.zScale, height_mm);
    const interval_m =
      config.contours.interval_m === 'auto' ? suggested_m : config.contours.interval_m;

    report({
      stage: 'building-features',
      percent: FEATURES_END,
      detail: `Tracing contours every ${interval_m} m`,
    });

    const traced = traceContours(heightfield, interval_m);
    if (traced.lines.length === 0) {
      warnings.push({
        level: 'warn',
        code: 'contours-empty',
        message:
          `No contours at ${interval_m} m — this area only spans ` +
          `${(heightfield.max_m - heightfield.min_m).toFixed(0)} m. Reduce the interval.`,
      });
    } else {
      const ribbon = buildRibbonField(
        traced.lines,
        width_m,
        featureClip,
        FEATURE_CELLS_PER_HALF_WIDTH,
      );
      if (ribbon.polygons.length > 0) {
        const mesh = extrudeDraped(
          ribbon.polygons,
          (x_m, y_m) =>
            worldToPrint(x_m, y_m, sampleHeightfieldAt(heightfield, x_m, y_m), scale)[2],
          (x_m, y_m) => [x_m * scale.scale, y_m * scale.scale],
          {
            height_mm,
            penetration_mm: Math.max(1.0, height_mm * 0.5),
            minBottom_mm: Math.min(0.2, config.baseThickness_mm / 2),
            maxEdge_m: Math.max(heightfield.spacingX_m, width_m),
          },
        );
        if (mesh.triangles > 0) {
          contourParts.push({
            name: 'contours',
            color: TERRAIN_COLOR,
            positions: mesh.positions,
            indices: mesh.indices,
            manifold: true,
          });
        }
      }
      // Crowding is not a matter of how many rings there are — it is how much
      // of the plate they end up covering once neighbours touch and merge.
      // Vertical spacing alone missed this badly: 49 rings reported as "0.22 mm
      // apart" were in fact fused across 86% of the model.
      const covered_mm2 = footprintArea_mm2(ribbon.polygons, scale.scale);
      const plate_mm2 = Math.max(
        1,
        (heightfield.cols - 1) * heightfield.spacingX_m * scale.scale *
          (heightfield.rows - 1) * heightfield.spacingY_m * scale.scale,
      );
      const coverage = covered_mm2 / plate_mm2;
      if (coverage > CONTOUR_COVERAGE_LIMIT) {
        warnings.push({
          level: 'warn',
          code: 'contours-crowded',
          message:
            `${traced.levels.length} contour rings at ${interval_m} m cover ` +
            `${(coverage * 100).toFixed(0)}% of the model — on ground this steep they touch ` +
            `and merge into a crust rather than reading as separate lines. ` +
            (config.contours.interval_m === 'auto'
              ? 'Raise the interval, or lower the vertical exaggeration.'
              : `Try ${suggested_m} m, or switch the interval to Auto.`),
        });
      }
      // A ring taller than the gap to the ring above simply buries it.
      const spacing_mm = interval_m * scale.zScale;
      if (height_mm > spacing_mm) {
        warnings.push({
          level: 'warn',
          code: 'contours-crowded',
          message:
            `Each ring stands ${height_mm.toFixed(2)} mm proud but the rings are only ` +
            `${spacing_mm.toFixed(2)} mm apart vertically, so every ring buries the ` +
            `${Math.floor(height_mm / Math.max(spacing_mm, 1e-6))} above it. ` +
            `Drop the contour height to about ${(spacing_mm * 0.6).toFixed(1)} mm, ` +
            `or raise the interval.`,
        });
      }

      report({
        stage: 'building-features',
        percent: FEATURES_END,
        detail: `${traced.levels.length} contour level(s) every ${interval_m} m`,
      });
    }
    throwIfAborted();
  }

  // --- Stage 5c: frame (docs/02-feature-spec.md F5) -------------------------
  const frameParts: MeshPart[] = [];
  if (config.frame.enabled) {
    report({
      stage: 'building-features',
      percent: FEATURES_END,
      detail: `Framing the model, ${config.frame.width_mm} mm`,
    });

    const built = buildFrame(featureClip, {
      width_mm: config.frame.width_mm,
      height_mm: config.frame.height_mm,
      baseThickness_mm: config.baseThickness_mm,
      scale,
    });

    if (built.mesh.triangles > 0) {
      frameParts.push({
        name: 'frame',
        color: TERRAIN_COLOR,
        positions: built.mesh.positions,
        indices: built.mesh.indices,
        manifold: true,
      });

      // A frame the ground stands over is not a frame. Sampled on the boundary
      // itself, which is where the two meet.
      const submerged = frameSubmersion(
        featureClip,
        (x_m, y_m) => worldToPrint(x_m, y_m, sampleHeightfieldAt(heightfield, x_m, y_m), scale)[2],
        built.top_mm,
        // One terrain cell: finer buys nothing, because the ground between two
        // samples was interpolated from them in the first place.
        heightfield.spacingX_m,
      );
      if (submerged.fraction > FRAME_SUBMERSION_LIMIT) {
        warnings.push({
          level: 'warn',
          code: 'frame-submerged',
          message:
            `The terrain stands over the frame along ${(submerged.fraction * 100).toFixed(0)}% ` +
            `of the edge, by up to ${submerged.worst_mm.toFixed(1)} mm. Raise the frame to about ` +
            `${(config.frame.height_mm + submerged.worst_mm).toFixed(1)} mm, or lower the ` +
            `vertical exaggeration, if you want an unbroken rim.`,
        });
      }
      // --- F5.1: engrave the label into the frame's top face ---------------
      //
      // Subtracted from the FRAME alone, not the whole model. The tool is a few
      // hundred triangles against a rim of a few dozen, so this stays a
      // millisecond-scale boolean and works in every colour mode rather than
      // only the ones that already union everything.
      const labelText = config.label.text.trim();
      if (labelText.length > 0) {
        const capHeight_mm = Math.min(
          config.label.capHeight_mm,
          // Never taller than the plaque it sits on.
          config.frame.width_mm * LABEL_MAX_SHARE_OF_FRAME,
        );
        const options = {
          capHeight_mm,
          depth_mm: Math.min(config.label.depth_mm, config.frame.height_mm * 0.75),
          strokeWidth_mm: config.label.strokeWidth_mm,
          minStrokeWidth_mm: config.nozzleDiameter_mm,
          surfaceZ_mm: built.top_mm,
        };

        // Set along the frame itself, so a circular model gets curved text
        // rather than a straight line running off the band at both ends. The
        // baseline sits so the text is centred across the band's width, with
        // its top towards the model.
        const ringPrint: Ring = featureClip.map(
          ([x_m, y_m]) => [x_m * scale.scale, y_m * scale.scale] as [number, number],
        );
        const baseline = buildBaseline(ringPrint, (config.frame.width_mm + capHeight_mm) / 2);

        const label = baseline
          ? buildLabelTool(labelText, options, baseline)
          : { mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), triangles: 0 }, width_mm: 0, strokeWidth_mm: 0, missing: [] as string[] };
        if (label.missing.length > 0) {
          warnings.push({
            level: 'warn',
            code: 'label-unsupported-characters',
            message:
              `The label font has no glyph for ${label.missing.map((c) => `"${c}"`).join(', ')}. ` +
              `Those characters are left blank. It is a single-stroke engraving font: ` +
              `A–Z, 0–9 and common punctuation.`,
          });
        }

        if (label.mesh.triangles > 0) {
          const coverage = labelCoverage(labelText, options, baseline!, built.footprint_mm);
          if (coverage < LABEL_COVERAGE_LIMIT) {
            warnings.push({
              level: 'warn',
              code: 'label-overruns-frame',
              message:
                `Only ${(coverage * 100).toFixed(0)}% of the label lands on the frame — the rest ` +
                `engraves nothing. It is ${label.width_mm.toFixed(0)} mm wide, on a ` +
                `${baseline!.total_mm.toFixed(0)} mm rim. Shorten the text, reduce the label ` +
                `size, or make the model larger.`,
            });
          }

          try {
            const engraved = await subtractParts(
              frameParts[0],
              [
                {
                  name: 'label',
                  color: TERRAIN_COLOR,
                  positions: label.mesh.positions,
                  indices: label.mesh.indices,
                  manifold: true,
                },
              ],
              { name: 'frame', color: TERRAIN_COLOR },
            );
            frameParts[0] = engraved;
          } catch (err) {
            // A frame with no caption beats no model at all.
            warnings.push({
              level: 'warn',
              code: 'label-failed',
              message:
                `The label could not be engraved: ` +
                `${err instanceof BooleanError ? err.userMessage : String(err)}. ` +
                `The frame was left plain.`,
            });
          }
        }

        if (capHeight_mm < config.label.capHeight_mm) {
          warnings.push({
            level: 'warn',
            code: 'label-shrunk',
            message:
              `The label was reduced to ${capHeight_mm.toFixed(1)} mm so it fits inside a ` +
              `${config.frame.width_mm} mm frame. Widen the frame for larger text.`,
          });
        }
      }
    } else {
      // Almost always a frame wider than the selection is across.
      warnings.push({
        level: 'warn',
        code: 'frame-empty',
        message:
          `No frame was built at ${config.frame.width_mm} mm wide. That is probably wider ` +
          `than half the model — try a narrower frame.`,
      });
    }
    throwIfAborted();
  } else if (config.frame.enabled === false && config.label.text.trim().length > 0) {
    // Not a silent no-op: the text was typed and nothing appeared.
    warnings.push({
      level: 'warn',
      code: 'label-needs-frame',
      message:
        'The label is engraved into the frame, which is switched off, so nothing was ' +
        'engraved. Turn Frame on — the base is the underside of the model, and text there ' +
        'reads backwards.',
    });
  }

  // --- Stage 6: route solids ------------------------------------------------
  //
  // A cutting tool has to enclose everything the channel passes through. The
  // terrain is the least of it: roads, buildings and contour rings all stand
  // proud of the ground by amounts that depend on the data, so the only safe
  // ceiling is the top of what has actually been built.
  let bodyTop_mm = -Infinity;
  for (const part of [mesh, ...featureParts, ...contourParts, ...frameParts]) {
    const positions = part.positions;
    for (let i = 2; i < positions.length; i += 3) {
      if (positions[i] > bodyTop_mm) bodyTop_mm = positions[i];
    }
  }
  const toolTop_mm = Number.isFinite(bodyTop_mm) ? bodyTop_mm + CUT_TOOL_HEADROOM_MM : undefined;

  const visibleRoutes = routes.filter((r) => r.style.visible);
  const routeParts: MeshPart[] = [];
  /**
   * The same routes built as cutting tools, for `single-cutout`.
   *
   * Built from the same centreline and width as the visible route, so what gets
   * cut is exactly what would have been raised — the two cannot drift.
   */
  const cutTools: MeshPart[] = [];
  /** The pieces that seat in those channels, for the inlay sub-mode. */
  const insertParts: MeshPart[] = [];
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
        const common = {
          heightfield,
          scale,
          selection: featureClip,
          nozzleDiameter_mm: config.nozzleDiameter_mm,
          baseThickness_mm: config.baseThickness_mm,
        };

        const tool = buildRouteSolid(toRoute(record), {
          ...common,
          cut: {
            kind: 'cut' as const,
            depth_mm: config.cutout.insetDepth_mm,
            // Passed even though the channel is not inset: it makes the channel
            // resolve on the same grid as the insert that must fit it.
            ...(config.cutout.subMode === 'inlay'
              ? { clearance_mm: config.cutout.clearance_mm }
              : {}),
            // Only a fallback: toolTop_mm below puts the top above everything
            // that was built, which is the height that actually matters.
            proud_mm: Math.max(1, config.cutout.insetDepth_mm),
            ...(toolTop_mm !== undefined ? { toolTop_mm } : {}),
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

          // The flat floor sits under the route's LOWEST point, so on a route
          // that climbs, the channel is as deep as the climb. That is the cost
          // of a flat-bottomed insert (OPEN-QUESTIONS Q10) and the user should
          // hear about it rather than discover it in the slicer.
          // From the GROUND the channel crosses, not the tool's own extent: the
          // tool is given a flat top above the whole model, so its height says
          // nothing about the terrain underneath it.
          const [lowGround, highGround] = tool.stats.groundRange_mm ?? [0, 0];
          const relief_mm = highGround - lowGround;
          if (relief_mm > 3 * config.cutout.insetDepth_mm) {
            warnings.push({
              level: 'warn',
              code: 'cutout-deep-channel',
              message:
                `"${record.name}" climbs ${relief_mm.toFixed(1)} mm across the model, and the ` +
                `channel floor is flat, so at the high end it cuts ` +
                `${(relief_mm + config.cutout.insetDepth_mm).toFixed(1)} mm deep. Reduce the ` +
                `vertical exaggeration, or use a shorter route, if that is more material ` +
                `than you want removed.`,
            });
          }
        }

        // The inlay sub-mode also emits the piece that seats in that channel.
        if (config.cutout.subMode === 'inlay') {
          const insert = buildRouteSolid(toRoute(record), {
            ...common,
            cut: {
              kind: 'insert' as const,
              depth_mm: config.cutout.insetDepth_mm,
              proud_mm: config.cutout.insertProud_mm,
              clearance_mm: config.cutout.clearance_mm,
              // The channel's floor, not one worked out from the narrower
              // insert footprint, or the insert does not seat on it.
              ...(tool.stats.flatBottom_mm !== undefined
                ? { floor_mm: tool.stats.flatBottom_mm }
                : {}),
            },
          });
          if (insert.mesh.triangles > 0) {
            insertParts.push({
              name: `insert:${i}`,
              color: record.style.color,
              positions: insert.mesh.positions,
              indices: insert.mesh.indices,
              manifold: true,
            });
          }
          if (insert.stats.width_mm <= 2 * config.nozzleDiameter_mm) {
            warnings.push({
              level: 'warn',
              code: 'insert-too-narrow',
              message:
                `"${record.name}" leaves an insert only ${insert.stats.width_mm.toFixed(2)} mm ` +
                `wide once ${config.cutout.clearance_mm} mm clearance is taken off each side. ` +
                `Widen the route, or reduce the clearance.`,
            });
          }
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
  for (const part of [...featureParts, ...contourParts, ...frameParts, ...routeParts]) {
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

  let parts = [terrainPart, ...featureParts, ...contourParts, ...frameParts, ...routeParts];

  // Anything draped should sit within its own height of the ground. When it
  // does not it shows as a cone or blade standing out of the model, and every
  // other check still passes because the mesh is watertight either way.
  for (const part of [...featureParts, ...contourParts, ...routeParts]) {
    const layer = config.layers[part.name];
    const height_mm =
      part.name === 'contours'
        ? Math.max(0.1, config.contours.lineHeight_mm)
        : layer
          ? Math.max(0.1, layer.height_mm * layer.heightScale)
          : 1.5;
    // Generous: three times the feature's own height, and never less than 2 mm.
    const allowed = Math.max(2, height_mm * 3);
    const floating = findFloatingVertices(terrainPart.positions, part.positions, allowed);
    if (floating.count > 0 && floating.at) {
      warnings.push({
        level: 'warn',
        code: 'floating-geometry',
        message:
          `${floating.count} point(s) of the ${part.name} layer stand up to ` +
          `${floating.worst_mm.toFixed(1)} mm above the ground beneath them — they will look ` +
          `like spikes. Worst at ${floating.at[0].toFixed(1)}, ${floating.at[1].toFixed(1)} mm ` +
          `from the model centre. This is a bug; please report it with those numbers.`,
      });
    }
  }

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
        const body = [terrainPart, ...featureParts, ...contourParts, ...frameParts];
        const base =
          body.length === 1
            ? body[0]
            : await unionParts(body, { name: 'model', color: TERRAIN_COLOR });

        parts = [
          await subtractParts(base, cutTools, { name: 'model', color: TERRAIN_COLOR }),
          // Inserts stay separate on purpose: the whole point is that they are
          // printed apart, in another colour, and pressed in afterwards.
          ...insertParts,
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
      parts = [terrainPart, ...featureParts, ...contourParts, ...frameParts, ...routeParts];
    }
  }

  let triangles = 0;
  let vertices = 0;
  for (const part of parts) {
    triangles += part.indices.length / 3;
    vertices += part.positions.length / 3;
  }

  // Measured over every part, not the terrain alone.
  //
  // The terrain's own extent is not the model's: a frame, a raised route and a
  // proud insert all stand above it, and an insert prints beside it. Reporting
  // the terrain's height understated what actually goes on the bed — silently,
  // and by exactly the amount the user had just dialled in.
  const dimensions_mm = boundsOfParts(parts) ?? mesh.dimensions_mm;

  warnings.push(...printChecks(config, dimensions_mm, triangles));

  const bundle: MeshBundle = {
    parts,
    stats: {
      triangles,
      vertices,
      dimensions_mm,
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

/** Width, depth and height across every part, print mm. Null if there is nothing. */
function boundsOfParts(parts: MeshPart[]): [number, number, number] | null {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];

  for (const part of parts) {
    const p = part.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (p[i + a] < lo[a]) lo[a] = p[i + a];
        if (p[i + a] > hi[a]) hi[a] = p[i + a];
      }
    }
  }

  if (!Number.isFinite(lo[0])) return null;
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
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
    source: 'gpx',
    smoothing: record.smoothing ?? 0,
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
