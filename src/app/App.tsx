/**
 * Phase 1 shell: map, selection tools, routes, 3D preview, export.
 *
 * Layout follows docs/07-ui-spec.md — settings left, viewport right, shape
 * tools pinned top-right of the viewport, status strip along the bottom, and a
 * Map / 3D Model toggle that switches views of one project rather than two
 * modes with separate state.
 *
 * State lives in React rather than the zustand stores docs/03-architecture.md
 * proposes. It is all owned here and passed down one level; introducing a store
 * mid-phase would be a refactor with no user-visible payoff. Worth revisiting
 * when Phase 2 adds forty layer controls.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEM_DATASETS } from '../data/dem/datasets';
import { BED_PRESETS, defaultConfig, PRESETS } from '../config/presets';
import { GpxParseError, parseRouteFile, routeDistance } from '../data/gpx/parse';
import { defaultRouteStyle, ROUTE_PALETTE, type Route } from '../data/gpx/types';
import { stlFilename, stlHeader, writeBinarySTL } from '../export/stl';
import { writeThreeMF, threeMFFilename } from '../export/threemf';
import { writePartBundle, bundleFilename } from '../export/bundle';
import { dropSeparateToPlate, hasSeparateParts, layOutForPrint } from '../export/layout';
import { bboxCentre, resolveGrid } from '../geometry/coords';
import {
  fitCircleToRoutes,
  fitSelectionToRoutes,
  selectionArea_km2,
  boxIntersectsRing,
  selectionBBox,
  selectionRingLonLat,
  type SelectionShape,
} from '../geometry/selection';
import type {
  BBox,
  ColorMode,
  CutoutSubMode,
  GenerateConfig,
  MeshBundle,
  Progress,
  ProgressStage,
  SerialisableRoute,
} from '../geometry/types';
import type { LineFeature } from '../data/osm/normalise';
import { normalise } from '../data/osm/normalise';
import { fetchOsm, OverpassError, planOsmTiles } from '../data/osm/overpass';
import { buildFeaturePreview, enabledLineLayers } from '../map/featurePreview';
import { resolveScale } from '../geometry/coords';
import { BASEMAPS } from '../map/basemaps';
import type { DrawTool, LonLat } from '../map/draw';
import { MapView } from '../map/MapView';
import { Viewer, type ShadingMode } from '../preview/Viewer';
import { cancelGeneration, generate, terminateWorker } from '../workers/client';
import { NumberField } from './NumberField';
import { RoutePanel } from './RoutePanel';
import { ICONS, Rail, Section, readOpenGroup, writeOpenGroup, type GroupId } from './Section';
import { SunControl, DEFAULT_SUN, type SunPosition } from './SunControl';
import { SUPPORT_LABEL, SUPPORT_URL } from '../config/support';
import { applyTheme, readTheme, type Theme } from '../config/theme';
import {
  formatArea,
  formatElevation,
  formatElevationRange,
  formatExtent,
  formatGroundLength,
  readUnit,
  writeUnit,
  UNIT_LABEL,
  type DistanceUnit,
} from '../config/units';
import { EstimatePanel, defaultFilamentSettings, type FilamentSettings } from './EstimatePanel';
import { ExportMenu } from './ExportMenu';
import { printerProfile } from '../export/estimate';
import { LayersPanel } from './LayersPanel';
import { ProjectPanel } from './ProjectPanel';
import {
  ProjectError,
  decodeHash,
  encodeHash,
  parseProject,
  serialiseProject,
  type Settings,
} from '../config/project';
import type { LayerId } from '../data/osm/tags';
import type { LayerSettings } from '../geometry/features';

const STAGE_LABELS: Array<{ stages: ProgressStage[]; label: string }> = [
  { stages: ['resolving'], label: 'Working out the scale' },
  { stages: ['fetching-dem'], label: 'Fetching elevation data' },
  { stages: ['building-heightfield'], label: 'Building the heightfield' },
  { stages: ['building-terrain'], label: 'Building the terrain' },
  { stages: ['fetching-osm', 'building-features'], label: 'Adding map features' },
  { stages: ['building-routes'], label: 'Embossing your route' },
  { stages: ['validating', 'done'], label: 'Finalising the mesh' },
];

const STAGE_ORDER: ProgressStage[] = [
  'resolving',
  'fetching-dem',
  'building-heightfield',
  'building-terrain',
  'fetching-osm',
  'building-features',
  'building-routes',
  'validating',
  'done',
];

const TOOLS: Array<{ id: DrawTool; label: string; glyph: string }> = [
  { id: 'rectangle', label: 'Rectangle', glyph: '▭' },
  { id: 'square', label: 'Square', glyph: '◻' },
  { id: 'circle', label: 'Circle', glyph: '◯' },
  { id: 'hexagon', label: 'Hexagon', glyph: '⬡' },
  { id: 'polygon', label: 'Polygon', glyph: '⬠' },
];

const SHADING: Array<{ id: ShadingMode; label: string }> = [
  { id: 'natural', label: 'Natural' },
  { id: 'elevation', label: 'Elevation' },
  { id: 'slope', label: 'Slope' },
  { id: 'wireframe', label: 'Wireframe' },
];

/**
 * Bounds of a lon/lat list, by loop.
 *
 * Never `Math.min(...points.map(...))`: spread arguments blow the call stack
 * past roughly 100k elements (docs/08-pitfalls.md#call-stack-overflow). A
 * drawn route is small, but a recorded one is not, and the shape of the code
 * is what gets copied to the next place.
 */
function bboxOfPoints(points: readonly LonLat[]): BBox {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, east, south, north };
}

function toSerialisable(routes: Route[]): SerialisableRoute[] {
  return routes.map((r) => ({
    id: r.id,
    name: r.name,
    points: r.points,
    smoothing: r.smoothing,
    style: { ...r.style },
  }));
}

/**
 * A shared link, decoded once.
 *
 * At module scope rather than in an effect so the app never paints the default
 * model and then jumps to the shared one: by the time anything renders, this is
 * already the initial state. Null when the hash is absent or unreadable.
 */
/**
 * Where a map-data fetch stops being incidental and becomes something to warn
 * about. Two minutes: long enough that silence reads as a hang.
 */
const SLOW_FETCH_S = 120;

/**
 * Where "slow" becomes "not in one pass".
 *
 * A 100 km ultramarathon is the case this has to serve, and it lands around
 * 150 requests once tiles outside the outline are dropped — roughly ten
 * minutes. 500 leaves generous headroom above that while still being reached
 * long before the numbers get silly: a selection spanning several countries
 * plans thousands of requests and some hours, and telling someone to "leave it
 * running" is then a promise the app cannot keep.
 *
 * It is still not a refusal. Cached areas cost no request and no delay, so
 * pressing Generate repeatedly does get there — it just is not one sitting, and
 * saying so is more useful than a spinner that never ends.
 */
const HUGE_FETCH_TILES = 500;

/** A rough duration, in the units someone waiting actually thinks in. */
function fetchTimeLabel(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

const SHARED = typeof window === 'undefined' ? null : decodeHash(window.location.hash);

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'model'
  );
}

export function App() {
  /**
   * The selection, or null when there is none.
   *
   * Nullable on purpose. Clearing a selection has to actually leave the app
   * with nothing selected — resetting to some default shape would just be a
   * differently-placed box the user then has to remove again.
   */
  const [shape, setShape] = useState<SelectionShape | null>(() =>
    SHARED ? SHARED.shape : { kind: 'rectangle', bbox: PRESETS[0].bbox },
  );
  const [areaLabel, setAreaLabel] = useState(() =>
    SHARED ? SHARED.areaLabel : PRESETS[0].label,
  );
  const [tool, setTool] = useState<DrawTool | null>(null);
  /** The route whose vertices are being dragged on the map (F1.3), or null. */
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  /**
   * Slicer settings for the filament estimate (F9).
   *
   * Deliberately NOT part of GenerateConfig: none of it moves a vertex, so
   * changing infill must not mark the model dirty or ask for a rebuild.
   */
  const [filament, setFilament] = useState<FilamentSettings>(defaultFilamentSettings);
  const [basemapId, setBasemapId] = useState(BASEMAPS[0].id);
  /**
   * Display units (Q14). Read once on mount — `localStorage` is not available
   * during a server render, and this is a preference, not model state.
   *
   * Deliberately NOT part of `config`: changing it must not mark the model
   * dirty. Nothing about the mesh depends on which word sits after the number.
   */
  const [unit, setUnit] = useState<DistanceUnit>(() => readUnit());

  /**
   * Which sidebar group is open. One at a time (see `Section`).
   *
   * Read once on mount, like the units preference, and persisted so the panel
   * comes back where it was left rather than resetting to step one on every
   * reload.
   */
  const [openGroup, setOpenGroup] = useState<GroupId | null>(() => readOpenGroup());

  /**
   * Sidebar collapsed to an icon rail.
   *
   * The map and the 3D preview are the point of the app, and 340px of settings
   * is a lot of screen to keep spending once they are set.
   */
  const [railed, setRailed] = useState(() => {
    try {
      return localStorage.getItem('mazeterrain.rail') === '1';
    } catch {
      return false;
    }
  });

  const toggleRail = useCallback(() => {
    setRailed((v) => {
      try {
        localStorage.setItem('mazeterrain.rail', v ? '0' : '1');
      } catch {
        // Session-only is fine.
      }
      return !v;
    });
  }, []);

  /** Light or dark. Stamped on <html>, so every token flips at once. */
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleGroup = useCallback((id: GroupId) => {
    setOpenGroup((current) => {
      const next = current === id ? null : id;
      writeOpenGroup(next);
      return next;
    });
  }, []);
  /**
   * Live terrain on by default (F3.2).
   *
   * It used to be off, which meant the map opened as a flat street plan and the
   * relief the whole app is about was one checkbox away and easy to miss. The
   * sun dial below has nothing to light without it, so the two ship together.
   */
  const [terrain3d, setTerrain3d] = useState(true);
  /** Where the light comes from on the live terrain (F3.2). Lighting only. */
  const [sun, setSun] = useState<SunPosition>(DEFAULT_SUN);
  const [view, setView] = useState<'map' | '3d'>('map');
  const [shading, setShading] = useState<ShadingMode>('natural');
  const [autoSpin, setAutoSpin] = useState(false);
  const [cursor, setCursor] = useState<LonLat | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const [locating, setLocating] = useState(false);
  /** Where the map should fly to next, or null. Consumed by MapView. */
  const [flyTo, setFlyTo] = useState<LonLat | null>(null);

  const [settings, setSettings] = useState<Settings>(() => {
    if (SHARED) return SHARED.settings;
    const { bbox: _bbox, ...rest } = defaultConfig(PRESETS[0].bbox);
    return rest;
  });

  /**
   * Which printer is selected, from the bed size.
   *
   * The bed size is what the config stores, so this reads back through it —
   * which means the two Bambu machines are indistinguishable, both being
   * 256 x 256. That costs nothing: they share Bambu Studio's slicer profile
   * anyway, so the estimate is identical either way.
   */
  const printerId = useMemo(() => {
    const bed = settings.bedSize_mm;
    if (!bed) return null;
    return (
      BED_PRESETS.find((b) => b.size && b.size[0] === bed[0] && b.size[1] === bed[1])?.id ?? null
    );
  }, [settings.bedSize_mm]);

  /**
   * Pick up the selected printer's stock slicer settings.
   *
   * The owner asked for the estimate to use printer defaults rather than ask
   * for numbers. Changing printer therefore RESETS walls, solid layers, infill
   * and speed — anything typed in for the old printer described a different
   * machine. Price and material are deliberately not touched: those are facts
   * about the spool on the shelf, not about the printer.
   */
  useEffect(() => {
    const profile = printerProfile(printerId);
    setFilament((current) => ({ ...current, ...profile }));
  }, [printerId]);
  const [autoResolution, setAutoResolution] = useState(true);
  const [routes, setRoutes] = useState<Route[]>([]);

  const [progress, setProgress] = useState<Progress | null>(null);
  const [bundle, setBundle] = useState<MeshBundle | null>(null);
  /**
   * What went wrong, and how loudly to say it.
   *
   * A cancelled build is not a failure — the user asked for it — and painting
   * it in the same red as "the DEM server is down" teaches people to ignore the
   * red box.
   */
  const [error, setError] = useState<{ level: 'fail' | 'notice'; text: string } | null>(null);
  const [dirty, setDirty] = useState(true);

  /**
   * OSM lines for the current selection, fetched on demand so the map can show
   * what the model will contain before it is built. Held raw: re-filtering when
   * a class is ticked or the width changes is instant and costs no network.
   */
  const [previewLines, setPreviewLines] = useState<LineFeature[] | null>(null);
  const [previewBBox, setPreviewBBox] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const busy = progress !== null;
  const builtSlug = useRef('model');

  const config: GenerateConfig = useMemo(
    // With no selection there is nothing to size the model to. The bbox falls
    // back so the rest of the config stays a valid object; Generate is disabled
    // in that state, so the value is never built from.
    () => ({ ...settings, bbox: shape ? selectionBBox(shape) : PRESETS[0].bbox }),
    [settings, shape],
  );

  const update = useCallback((patch: Partial<Omit<GenerateConfig, 'bbox'>>) => {
    setSettings((c) => ({ ...c, ...patch }));
    setDirty(true);
  }, []);

  const applyShape = useCallback(
    (next: SelectionShape, label?: string, moveMap = false) => {
      setShape(next);
      if (label) setAreaLabel(label);
      if (moveMap) setFitNonce((n) => n + 1);
      setDirty(true);
    },
    [],
  );

  /**
   * Remove the selection.
   *
   * The feature preview belongs to the selection it was fetched for, so it goes
   * too — leaving roads highlighted for an area that is no longer selected
   * would be worse than showing nothing.
   */
  // Dev-only, beside the map and bundle handles: lets an exact selection be
  // reproduced from the console when chasing a reported artefact.
  if (import.meta.env.DEV) {
    (window as unknown as { __setShape?: (s: SelectionShape) => void }).__setShape = (next) =>
      applyShape(next, 'Diagnostic selection', true);
  }

  const clearShape = useCallback(() => {
    setShape(null);
    setTool(null);
    setPreviewLines(null);
    setPreviewBBox(null);
    setPreviewError(null);
    setDirty(true);
  }, []);

  const onPreset = useCallback(
    (id: string) => {
      const next = PRESETS.find((p) => p.id === id);
      if (next) applyShape({ kind: 'rectangle', bbox: next.bbox }, next.label, true);
    },
    [applyShape],
  );

  /** The primary first-run path: upload a GPX and the selection is already right. */
  const fitToRoutes = useCallback(
    (list: Route[], shape: 'rectangle' | 'circle' = 'rectangle') => {
      const fitted = shape === 'circle' ? fitCircleToRoutes(list) : fitSelectionToRoutes(list);
      if (fitted) {
        applyShape(fitted, list.length === 1 ? list[0].name : `${list.length} routes`, true);
      }
    },
    [applyShape],
  );

  /**
   * A hand-drawn route becomes a Route and enters the same pipeline as a
   * recorded one (docs/02-feature-spec.md F1.3).
   *
   * It carries `smoothing` because a clicked polyline is all hard corners,
   * where a recorded track never is. Everything else about it — styling,
   * elevation, the geometry it builds — is identical.
   */
  const onRouteDrawn = useCallback((points: LonLat[]) => {
    if (points.length < 2) return;

    setRoutes((current) => {
      const drawn = current.filter((r) => r.source === 'drawn').length + 1;
      const route: Route = {
        id: `drawn-${Date.now()}`,
        name: `Drawn route ${drawn}`,
        source: 'drawn',
        smoothing: 0.5,
        points: points.map(([lon, lat]) => ({ lon, lat })),
        distance_m: routeDistance(points.map(([lon, lat]) => ({ lon, lat }))),
        // No recorded elevation to gain: a drawn route drapes on the DEM.
        elevationGain_m: null,
        bbox: bboxOfPoints(points),
        style: defaultRouteStyle(ROUTE_PALETTE[current.length % ROUTE_PALETTE.length]),
      };
      return [...current, route];
    });
    setDirty(true);
    setError(null);
  }, []);

  /**
   * Centre the map near the user (docs/07-ui-spec.md, first-run flow).
   *
   * A button rather than something the app does on load. The spec asks for the
   * map to open on the user's approximate location, but doing that
   * automatically fires a browser permission prompt at someone who has not yet
   * worked out what the app is — and a denied prompt is hard to undo. Asking
   * for it costs one click and only ever happens because the user chose to.
   *
   * The selection is deliberately not moved: the map view and the thing being
   * printed are separate, and silently relocating someone's selection would be
   * a much ruder surprise than a map pan.
   */
  const goToMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError({
        level: 'notice',
        text: 'This browser will not share a location. Pan the map to your area instead.',
      });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        setError(null);
        setFlyTo([position.coords.longitude, position.coords.latitude]);
      },
      (err) => {
        setLocating(false);
        setError({
          level: 'notice',
          text:
            err.code === err.PERMISSION_DENIED
              ? 'Location permission was declined, so the map stayed where it was. Pan to your area instead, or allow location from the browser address bar.'
              : 'Could not work out where you are. Pan the map to your area instead.',
        });
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  }, []);

  /**
   * A vertex was dragged, inserted or deleted on the map (F1.3).
   *
   * Distance and bbox are derived from the points, so they are recomputed here
   * rather than left stale — the route list shows the distance, and a wrong one
   * after a drag is worse than none. Elevation is not: a drawn route drapes on
   * the DEM and carries no recorded gain either way.
   */
  const onRouteEdited = useCallback((id: string, points: LonLat[]) => {
    if (points.length < 2) return;
    const next = points.map(([lon, lat]) => ({ lon, lat }));
    setRoutes((current) =>
      current.map((r) =>
        r.id === id
          ? {
              ...r,
              points: next,
              distance_m: routeDistance(next),
              bbox: bboxOfPoints(points),
            }
          : r,
      ),
    );
    setDirty(true);
  }, []);

  const onSmoothing = useCallback((id: string, value: number) => {
    setRoutes((current) =>
      current.map((r) => (r.id === id ? { ...r, smoothing: Math.max(0, Math.min(1, value)) } : r)),
    );
    setDirty(true);
  }, []);

  /**
   * Flip the direction of travel.
   *
   * Visible in the model wherever the route is not symmetric — a tapered end,
   * or an insert that has to go in the right way round — and the only way to
   * fix a line drawn backwards short of drawing it again.
   */
  const onReverse = useCallback((id: string) => {
    setRoutes((current) =>
      current.map((r) => (r.id === id ? { ...r, points: [...r.points].reverse() } : r)),
    );
    setDirty(true);
  }, []);

  const onUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);

      const parsed: Route[] = [];
      const failures: string[] = [];
      for (const file of Array.from(files)) {
        try {
          for (const route of await parseRouteFile(file)) parsed.push(route);
        } catch (err) {
          failures.push(err instanceof GpxParseError ? err.userMessage : String(err));
        }
      }

      if (failures.length > 0) setError({ level: 'fail', text: failures.join(' ') });
      if (parsed.length === 0) return;

      setRoutes((current) => {
        const next = [...current, ...parsed];
        // First upload: fit the map and draw a selection without being asked,
        // so the user sees a working model before touching a setting
        // (docs/07-ui-spec.md, first-run flow). A circle, because that is the
        // shape a route model is usually printed as; the explicit fit button
        // still gives a rectangle.
        if (current.length === 0) fitToRoutes(next, 'circle');
        return next;
      });
      setDirty(true);
    },
    [fitToRoutes],
  );

  const updateRoute = useCallback((id: string, patch: Partial<Route['style']>) => {
    setRoutes((c) => c.map((r) => (r.id === id ? { ...r, style: { ...r.style, ...patch } } : r)));
    setDirty(true);
  }, []);

  const updateLayer = useCallback((id: LayerId, patch: Partial<LayerSettings>) => {
    setSettings((c) => ({
      ...c,
      layers: { ...c.layers, [id]: { ...c.layers[id], ...patch } },
    }));
    setDirty(true);
  }, []);

  const removeRoute = useCallback((id: string) => {
    setRoutes((c) => c.filter((r) => r.id !== id));
    setEditingRouteId((current) => (current === id ? null : current));
    setDirty(true);
  }, []);

  const gridPreview = useMemo(() => {
    try {
      return resolveGrid(config);
    } catch {
      return null;
    }
  }, [config]);

  /**
   * What the OSM fetch is about to cost, before it starts.
   *
   * Recomputed with the selection because that is what drives it. Cheap: this
   * counts grid cells, it does not touch the network.
   */
  /** For the Map layers group badge, so a closed group still says how many. */
  const enabledLayerCount = useMemo(
    () => (Object.keys(settings.layers) as LayerId[]).filter((id) => settings.layers[id]?.enabled).length,
    [settings.layers],
  );

  const osmPlan = useMemo(() => {
    if (!shape) return null;
    const enabled = (Object.keys(settings.layers) as LayerId[]).filter(
      (id) => settings.layers[id]?.enabled,
    );
    if (enabled.length === 0) return null;
    const ring = shape.kind === 'rectangle' ? null : selectionRingLonLat(shape);
    return planOsmTiles(
      selectionBBox(shape),
      ring ? (tile) => boxIntersectsRing(tile, ring) : undefined,
    );
  }, [shape, settings.layers]);

  const area_km2 = useMemo(
    () => (shape ? selectionArea_km2(shape, bboxCentre(selectionBBox(shape))) : 0),
    [shape],
  );

  const onGenerate = useCallback(async () => {
    if (!shape) {
      setError({
      level: 'notice',
      text: 'Draw an area on the map first — use the shape tools, or upload a GPX and the area is drawn for you.',
    });
      return;
    }
    setError(null);
    setProgress({ stage: 'resolving', percent: 0, detail: 'Starting' });
    builtSlug.current = slugify(routes.length > 0 ? routes[0].name : areaLabel);

    try {
      // A rectangle IS its bounding box, so it needs no clipping pass. Anything
      // else has to be clipped or the model exports as the bbox rectangle.
      const ring = !shape || shape.kind === 'rectangle' ? null : selectionRingLonLat(shape);
      const result = await generate(
        { config, routes: toSerialisable(routes), selectionRing: ring },
        (p) => setProgress(p),
      );
      setBundle(result);
      // Dev-only handle on the built mesh. Stripped from production by the
      // bundler, and the only way to interrogate real geometry from the page
      // when a fault is visible on screen but has no numeric signature yet.
      if (import.meta.env.DEV) {
        (window as unknown as { __mesh?: MeshBundle }).__mesh = result;
      }
      if (import.meta.env.DEV) {
        // Same dev-only escape hatch as the map handle: lets the mesh be
        // inspected from the console without a separate build path.
        (window as unknown as { __bundle?: MeshBundle }).__bundle = result;
      }
      setDirty(false);
      setView('3d');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError({ level: 'notice', text: 'Generation cancelled. Nothing was changed.' });
      } else {
        const userMessage =
          err && typeof err === 'object' && 'userMessage' in err
            ? String((err as { userMessage: unknown }).userMessage)
            : null;
        // A raw JS message ("Cannot read properties of undefined") tells the
        // user nothing they can act on, so it is labelled as the bug it is.
        setError({
          level: 'fail',
          text:
            userMessage ??
            `The build failed unexpectedly: ${err instanceof Error ? err.message : String(err)}. ` +
              `That is a bug — please report it with the area and settings you used.`,
        });
      }
    } finally {
      setProgress(null);
    }
  }, [config, routes, shape, areaLabel]);

  /**
   * Fetch the map features for this selection so they can be shown before the
   * build. This is the same query and the same IndexedDB cache the worker uses,
   * so previewing warms the cache rather than costing an extra round trip.
   *
   * Explicit, never automatic: pan and settings changes must not fire network
   * work (CLAUDE.md, Performance).
   */
  const onPreviewFeatures = useCallback(async () => {
    if (!shape) {
      setPreviewError('Draw an area on the map first.');
      return;
    }
    const layers = enabledLineLayers(config);
    if (layers.length === 0) {
      setPreviewError('No line layers are switched on.');
      return;
    }
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const response = await fetchOsm(config.bbox, layers);
      setPreviewLines(normalise(response).lines);
      setPreviewBBox(JSON.stringify(config.bbox));
    } catch (err) {
      setPreviewLines(null);
      setPreviewError(
        err instanceof OverpassError
          ? err.userMessage
          : `Could not load map features: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPreviewBusy(false);
    }
  }, [config, shape]);

  // The preview belongs to the selection it was fetched for. Moving the
  // selection must clear it rather than leave roads highlighted somewhere else.
  // Print millimetres per real-world metre, so the layer panel can show class
  // widths in both units. Elevation only drives exaggeration, not this.
  const previewScale_mm_per_m = useMemo(() => resolveScale(config, 0, 0).scale, [config]);

  const selectionKey = JSON.stringify(config.bbox);
  const previewStale = previewLines !== null && previewBBox !== selectionKey;

  const preview = useMemo(
    () => (previewLines && !previewStale ? buildFeaturePreview(previewLines, config) : null),
    [previewLines, previewStale, config],
  );

  const onCancel = useCallback(() => {
    cancelGeneration();
    terminateWorker();
    setProgress(null);
    setError({ level: 'notice', text: 'Generation cancelled. Nothing was changed.' });
  }, []);

  const blocked = bundle ? bundle.warnings.some((w) => w.level === 'fail') : true;

  const save = useCallback((data: ArrayBuffer, filename: string, type: string) => {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  // --- project save / load / share ----------------------------------------
  //
  // The hash tracks the current state so the address bar is always a working
  // link, without the user having to remember to copy one.
  //
  // replaceState, not pushState. The spec calls the hash "undo-by-history",
  // but a slider drag would push a hundred entries and bury whatever the user
  // was actually doing before they opened the app. A shareable URL is the part
  // that earns its keep; browser-level undo of a slider is not worth that.
  // (Deviation noted in docs/02-feature-spec.md F7.3.)
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const hash = encodeHash({ areaLabel, shape, settings });
        window.history.replaceState(null, '', `#${hash}`);
      } catch {
        // An unshareable URL must never break the app it describes.
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [areaLabel, shape, settings]);

  const onSaveProject = useCallback(() => {
    const text = serialiseProject({ areaLabel, shape, settings, routes });
    save(new TextEncoder().encode(text).buffer as ArrayBuffer, `${slugify(areaLabel)}.mzt`, 'application/json');
  }, [areaLabel, shape, settings, routes, save]);

  const onLoadProject = useCallback(async (file: File) => {
    setError(null);
    try {
      const project = parseProject(await file.text());
      setSettings(project.settings);
      setShape(project.shape);
      setAreaLabel(project.areaLabel);
      setRoutes(project.routes);
      // The loaded settings describe a model that has not been built yet.
      setBundle(null);
      setDirty(true);
      if (project.shape) setFitNonce((n) => n + 1);
    } catch (err) {
      setError({
        level: 'fail',
        text:
          err instanceof ProjectError
            ? err.userMessage
            : `Could not open that project: ${String(err)}`,
      });
    }
  }, []);

  const onCopyLink = useCallback(async () => {
    const url = `${window.location.origin}${window.location.pathname}#${encodeHash({
      areaLabel,
      shape,
      settings,
    })}`;
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      // Clipboard access is refused outside a secure context and in some
      // browsers without a user gesture. Put the link where it can be copied
      // by hand rather than failing silently.
      window.prompt('Copy this link:', url);
      return false;
    }
  }, [areaLabel, shape, settings]);

  const onApplyPreset = useCallback((preset: Settings) => {
    setSettings(preset);
    setDirty(true);
  }, []);

  const onDownload = useCallback(() => {
    if (!bundle || blocked) return;
    save(
      // Laid out, not assembled. An insert sits INSIDE the body's channel,
      // which is right on screen and wrong in a file going to a slicer: nested
      // solids give internal perimeters along the whole route, and an insert
      // buried in a cavity cannot be printed at all.
      writeBinarySTL(layOutForPrint(bundle.parts), stlHeader()),
      stlFilename(builtSlug.current, config.modelWidth_mm),
      'model/stl',
    );
  }, [bundle, blocked, config.modelWidth_mm, save]);

  /**
   * The inlay insert is printed separately, in another filament, and pressed in
   * afterwards — so it has to arrive as its own file rather than merged into
   * the terrain. A ZIP of one STL per part plus a reassembly note is the shape
   * that matches a single-extruder workflow.
   */
  const onDownloadParts = useCallback(() => {
    if (!bundle || blocked) return;
    save(
      // Each part is its own file here, so no sideways move — but the insert
      // still has to come down onto the bed, or it loads floating.
      writePartBundle(dropSeparateToPlate(bundle.parts), {
        slug: builtSlug.current,
        modelWidth_mm: config.modelWidth_mm,
        clearance_mm: config.cutout.clearance_mm,
      }),
      bundleFilename(builtSlug.current, config.modelWidth_mm),
      'application/zip',
    );
  }, [bundle, blocked, config.modelWidth_mm, config.cutout.clearance_mm, save]);

  /** Two bodies that have to be printed apart, so the ZIP is the useful export. */
  /**
   * Whether anything prints as its own physical piece.
   *
   * Asked of the layout module rather than counted here: "more than one part"
   * was true of every multicolour model, which are all one piece, and false of
   * nothing that mattered. A cut-out insert and a bed-split tile are pieces; a
   * roads layer is not.
   */
  const separateParts = bundle ? hasSeparateParts(bundle.parts) : false;

  /**
   * 3MF keeps each layer as its own object with its own material, so a slicer
   * opens the model with filaments already assigned. STL cannot: it has no
   * concept of parts, so a multicolour model exported as STL is one grey blob.
   */
  const onDownload3mf = useCallback(() => {
    if (!bundle || blocked) return;
    save(
      // Same reason as the STL: a 3MF's objects land on the plate where they
      // are put, so a nested insert is just as unprintable there.
      writeThreeMF(layOutForPrint(bundle.parts)),
      threeMFFilename(builtSlug.current, config.modelWidth_mm),
      'model/3mf',
    );
  }, [bundle, blocked, config.modelWidth_mm, save]);

  const dataset = DEM_DATASETS[config.dataset];

  return (
    <div className="layout">
      {/*
        Q13 resolved to desktop-only. That is a decision about what to BUILD,
        not a licence to serve a phone the desktop layout and let it work the
        rest out — a 1400 px sidebar beside a map, on a 390 px screen, reads as
        a broken site rather than a deliberate scope. Purely CSS-driven, so it
        cannot disagree with the layout it is covering for.
      */}
      <div className="smallscreen" role="alert">
        <div className="smallscreen__card">
          <h2>Peakora needs a bigger screen</h2>
          <p>
            Choosing an area and setting up a print means drawing on a map and working
            through a column of settings. Both are genuinely bad on a phone, so rather
            than shipping a version that fights you, there is not one yet.
          </p>
          <p className="smallscreen__note">Open this on a laptop or desktop.</p>
        </div>
      </div>

      <header className="topbar">
        <h1>
          <button
            type="button"
            className="btn btn--icon"
            onClick={toggleRail}
            title={railed ? 'Show settings' : 'Collapse settings'}
            aria-label={railed ? 'Show settings panel' : 'Collapse settings panel'}
            aria-expanded={!railed}
          >
            <PanelIcon />
          </button>
          Peakora <span className="topbar__phase">Phase 2</span>
        </h1>

        <div className="viewtoggle" role="tablist">
          <button
            role="tab"
            aria-selected={view === 'map'}
            className={view === 'map' ? 'viewtoggle__on' : ''}
            onClick={() => setView('map')}
          >
            Map
          </button>
          <button
            role="tab"
            aria-selected={view === '3d'}
            className={view === '3d' ? 'viewtoggle__on' : ''}
            onClick={() => setView('3d')}
          >
            3D Model
          </button>
        </div>

        <div className="topbar__actions">
          {bundle && !dirty ? <span className="badge badge--ok">Up to date</span> : null}
          <button
            className={`btn${dirty && shape ? ' btn--accent' : ''}`}
            onClick={onGenerate}
            disabled={busy || !shape}
            title={shape ? undefined : 'Draw an area on the map first'}
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
          <ExportMenu
            disabled={!bundle || blocked || busy}
            separateParts={separateParts}
            onDownloadStl={onDownload}
            onDownload3mf={onDownload3mf}
            onDownloadParts={onDownloadParts}
          />
        </div>
      </header>

      <div className="body">
        {railed ? (
          <Rail
            openGroup={openGroup}
            onPick={(id) => {
              setRailed(false);
              try {
                localStorage.setItem('mazeterrain.rail', '0');
              } catch {
                // Session-only is fine.
              }
              setOpenGroup(id);
              writeOpenGroup(id);
            }}
          />
        ) : (
        <aside className="panel">
          <div className="panel__scroll">
            <Section
              id="place"
              title="Place"
              hint={areaLabel}
              badge={formatArea(area_km2, unit)}
              icon={ICONS.place}
              open={openGroup === 'place'}
              onToggle={() => toggleGroup('place')}
            >
            <section>
              <p className="note">
                Current area: <strong>{areaLabel}</strong> · {formatArea(area_km2, unit)}
              </p>
              <label className="field__label" htmlFor="preset">
                Jump to
              </label>
              <select
                id="preset"
                className="select"
                onChange={(e) => onPreset(e.target.value)}
                disabled={busy}
                value=""
              >
                <option value="" disabled>
                  Pick an area…
                </option>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>

              <label className="field__label" htmlFor="basemap">
                Basemap
              </label>
              <select
                id="basemap"
                className="select"
                value={basemapId}
                onChange={(e) => setBasemapId(e.target.value)}
              >
                {BASEMAPS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={terrain3d}
                  onChange={(e) => setTerrain3d(e.target.checked)}
                />
                Live 3D terrain on the map
              </label>

              <label className="field__label" htmlFor="dataset">
                Elevation dataset
              </label>
              <select
                id="dataset"
                className="select"
                value={config.dataset}
                onChange={(e) => update({ dataset: e.target.value })}
                disabled={busy}
              >
                {Object.values(DEM_DATASETS).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </section>

            </Section>

            <Section
              id="route"
              title="Route"
              hint={routes.length === 0 ? 'No route yet' : routes[0].name}
              badge={routes.length || undefined}
              icon={ICONS.route}
              open={openGroup === 'route'}
              onToggle={() => toggleGroup('route')}
            >
            <RoutePanel
              unit={unit}
              colorMode={config.colorMode}
              cutoutSubMode={config.cutout.subMode}
              insertProud_mm={config.cutout.insertProud_mm}
              onInsertProudChange={(v) => update({ cutout: { ...config.cutout, insertProud_mm: v } })}
              routes={routes}
              busy={busy}
              drawing={tool === 'route'}
              onDraw={() => {
                setEditingRouteId(null);
                setTool(tool === 'route' ? null : 'route');
              }}
              onSmoothing={onSmoothing}
              onReverse={onReverse}
              editingRouteId={editingRouteId}
              onEditPoints={setEditingRouteId}
              onUpload={onUpload}
              onUpdate={updateRoute}
              onRemove={removeRoute}
              onFit={() => fitToRoutes(routes)}
            />

            </Section>

            <Section
              id="layers"
              title="Map layers"
              hint={enabledLayerCount === 0 ? 'None on' : undefined}
              badge={enabledLayerCount || undefined}
              icon={ICONS.layers}
              open={openGroup === 'layers'}
              onToggle={() => toggleGroup('layers')}
            >
            <LayersPanel
              unit={unit}
              layers={config.layers}
              busy={busy}
              nozzleDiameter_mm={config.nozzleDiameter_mm}
              scale_mm_per_m={previewScale_mm_per_m}
              summaries={bundle?.layers ?? []}
              preview={preview?.summary ?? null}
              previewBusy={previewBusy}
              previewError={previewError}
              previewStale={previewStale}
              onPreview={onPreviewFeatures}
              onChange={updateLayer}
            />

            </Section>

            <Section
              id="model"
              title="Model"
              hint={`${config.modelWidth_mm} mm wide`}
              icon={ICONS.model}
              open={openGroup === 'model'}
              onToggle={() => toggleGroup('model')}
            >
            <section>
              <NumberField
                label="Model width"
                unit="mm"
                value={config.modelWidth_mm}
                min={20}
                max={400}
                step={1}
                disabled={busy}
                onChange={(v) => update({ modelWidth_mm: v })}
                hint="Longest edge of the printed model."
              />
              <div className="field">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={config.profile.enabled}
                    disabled={busy || routes.length === 0}
                    onChange={(e) =>
                      update({ profile: { ...config.profile, enabled: e.target.checked } })
                    }
                  />
                  Elevation profile
                </label>
                <p className="field__hint">
                  {routes.length === 0
                    ? 'Needs a route — the profile charts the climb along one.'
                    : 'A bar below the model showing the route’s climb: distance left to right, height up. Heights come from the same terrain the model is built on. It makes the print taller.'}
                </p>
              </div>

              {config.profile.enabled && routes.length > 0 ? (
                <>
                  <NumberField
                    label="Profile depth"
                    unit="mm"
                    value={config.profile.depth_mm}
                    min={6}
                    max={40}
                    step={1}
                    disabled={busy}
                    onChange={(v) => update({ profile: { ...config.profile, depth_mm: v } })}
                    hint={`How tall the chart is. The print grows to about ${(config.modelWidth_mm + config.profile.depth_mm - 3).toFixed(0)} mm front to back.`}
                  />
                  <NumberField
                    label="Profile relief"
                    unit="mm"
                    value={config.profile.height_mm}
                    min={0.4}
                    max={5}
                    step={0.1}
                    disabled={busy}
                    onChange={(v) => update({ profile: { ...config.profile, height_mm: v } })}
                    hint="How far the climb stands off the bar."
                  />
                </>
              ) : null}

              <div className="field">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={config.frame.enabled}
                    disabled={busy}
                    onChange={(e) => update({ frame: { ...config.frame, enabled: e.target.checked } })}
                  />
                  Frame
                </label>
                <p className="field__hint">
                  A flat-topped rim round the inside of the edge. Narrow reads as a lip;
                  wide gives a picture frame with room for a plaque.
                </p>
              </div>

              {config.frame.enabled ? (
                <>
                  <NumberField
                    label="Frame width"
                    unit="mm"
                    value={config.frame.width_mm}
                    min={2}
                    max={30}
                    step={0.5}
                    disabled={busy}
                    onChange={(v) => update({ frame: { ...config.frame, width_mm: v } })}
                    hint={`Added outside the map, so the print comes out ${(config.modelWidth_mm + config.frame.width_mm * 2).toFixed(0)} mm across. The map keeps its full ${config.modelWidth_mm} mm.`}
                  />
                  <NumberField
                    label="Frame height"
                    unit="mm"
                    value={config.frame.height_mm}
                    min={1}
                    max={15}
                    step={0.5}
                    disabled={busy}
                    onChange={(v) => update({ frame: { ...config.frame, height_mm: v } })}
                    hint="Above the lowest ground. Terrain higher than this stands over the rim."
                  />

                  <div className="field">
                    <label className="field__label" htmlFor="label-text">
                      Engraved label
                    </label>
                    <input
                      id="label-text"
                      className="textInput textInput--wide"
                      placeholder="MARGALLA TRAIL 5"
                      value={config.label.text}
                      disabled={busy}
                      maxLength={64}
                      onChange={(e) => update({ label: { ...config.label, text: e.target.value } })}
                    />
                    <p className="field__hint">
                      Cut into the frame&rsquo;s top face, following the frame round the bottom
                      of the model. A single-stroke engraving font: capitals, digits and common
                      punctuation, so lowercase is set as capitals.
                    </p>
                  </div>

                  {config.label.text.trim().length > 0 ? (
                    <>
                      <NumberField
                        label="Label size"
                        unit="mm"
                        value={config.label.capHeight_mm}
                        min={1.5}
                        max={20}
                        step={0.5}
                        disabled={busy}
                        onChange={(v) => update({ label: { ...config.label, capHeight_mm: v } })}
                        hint="Cap height. Capped at just over half the frame width."
                      />
                      <NumberField
                        label="Label depth"
                        unit="mm"
                        value={config.label.depth_mm}
                        min={0.2}
                        max={3}
                        step={0.1}
                        disabled={busy}
                        onChange={(v) => update({ label: { ...config.label, depth_mm: v } })}
                        hint="At least two or three layers, or the groove will not read."
                      />

                      <div className="field">
                        <label className="field__label">
                          Stroke weight<span className="field__unit">mm</span>
                        </label>
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={config.label.strokeWidth_mm === 'auto'}
                            disabled={busy}
                            onChange={(e) =>
                              update({
                                label: {
                                  ...config.label,
                                  strokeWidth_mm: e.target.checked
                                    ? 'auto'
                                    : Number((config.label.capHeight_mm / 7).toFixed(2)),
                                },
                              })
                            }
                          />
                          Auto (bold — a seventh of the label size)
                        </label>
                      </div>
                      {config.label.strokeWidth_mm === 'auto' ? null : (
                        <NumberField
                          label="Stroke width"
                          unit="mm"
                          value={config.label.strokeWidth_mm}
                          min={0.1}
                          max={4}
                          step={0.05}
                          disabled={busy}
                          onChange={(v) => update({ label: { ...config.label, strokeWidth_mm: v } })}
                          hint={`Never thinner than the ${config.nozzleDiameter_mm} mm nozzle, and capped so the letters do not weld shut.`}
                        />
                      )}
                    </>
                  ) : null}
                </>
              ) : null}

              <NumberField
                label="Base thickness"
                unit="mm"
                value={config.baseThickness_mm}
                min={0.6}
                max={20}
                step={0.1}
                disabled={busy}
                onChange={(v) => update({ baseThickness_mm: v })}
              />
              <NumberField
                label="Layer height"
                unit="mm"
                value={config.layerHeight_mm}
                min={0.05}
                max={0.4}
                step={0.05}
                disabled={busy}
                onChange={(v) => update({ layerHeight_mm: v })}
              />
              <div className="field">
                <label className="field__label" htmlFor="nozzle">
                  Printer nozzle<span className="field__unit">mm</span>
                </label>
                <select
                  id="nozzle"
                  className="select"
                  value={config.nozzleDiameter_mm}
                  onChange={(e) => update({ nozzleDiameter_mm: Number(e.target.value) })}
                  disabled={busy}
                >
                  <option value={0.2}>0.2 mm — Fine</option>
                  <option value={0.4}>0.4 mm — Standard</option>
                  <option value={0.6}>0.6 mm — Fast</option>
                  <option value={0.8}>0.8 mm — Draft</option>
                </select>
                <p className="field__hint">Sets the floor on terrain detail.</p>
              </div>


              <div className="field">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={config.contours.enabled}
                    disabled={busy}
                    onChange={(e) =>
                      update({ contours: { ...config.contours, enabled: e.target.checked } })
                    }
                  />
                  Contours
                </label>
                <p className="field__hint">
                  Reads relief at a glance. Most useful in the single-colour modes, where
                  otherwise only the silhouette shows it.
                </p>
              </div>

              {config.contours.enabled ? (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor="contour-style">
                      Contour style
                    </label>
                    <select
                      id="contour-style"
                      className="select"
                      value={config.contours.style}
                      disabled={busy}
                      onChange={(e) =>
                        update({
                          contours: {
                            ...config.contours,
                            style: e.target.value === 'lines' ? 'lines' : 'terraced',
                          },
                        })
                      }
                    >
                      <option value="terraced">Terraced — stepped shelves</option>
                      <option value="lines">Lines — raised rings</option>
                    </select>
                    <p className="field__hint">
                      {config.contours.style === 'terraced'
                        ? 'The terrain itself becomes flat shelves with a step between each, the way a laser-cut plywood relief map is built. The step edge is the contour, so there is nothing thin to print.'
                        : 'Traces the contours and raises them as thin rings on the smooth terrain. Technically correct, but at a nozzle wide they read as roads wandering across the slope.'}
                    </p>
                  </div>

                  <div className="field">
                    <label className="field__label">
                      {config.contours.style === 'terraced' ? 'Step height' : 'Contour interval'}
                      <span className="field__unit">m</span>
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={config.contours.interval_m === 'auto'}
                        disabled={busy}
                        onChange={(e) =>
                          update({
                            contours: {
                              ...config.contours,
                              interval_m: e.target.checked ? 'auto' : 100,
                            },
                          })
                        }
                      />
                      Auto (sized so the rings stay apart on this terrain)
                    </label>
                  </div>
                  {config.contours.interval_m === 'auto' ? null : (
                    <NumberField
                      label="Metres between rings"
                      unit="m"
                      value={config.contours.interval_m}
                      min={5}
                      max={500}
                      step={5}
                      disabled={busy}
                      onChange={(v) => update({ contours: { ...config.contours, interval_m: v } })}
                      hint={
                        bundle
                          ? `This area spans ${formatElevation(
                              bundle.stats.elevationRange_m[1] - bundle.stats.elevationRange_m[0],
                              unit,
                            )}.`
                          : 'Real metres of elevation between rings.'
                      }
                    />
                  )}
                  <NumberField
                    label="Contour height"
                    unit="mm"
                    value={config.contours.lineHeight_mm}
                    min={0.2}
                    max={3}
                    step={0.1}
                    disabled={busy}
                    onChange={(v) => update({ contours: { ...config.contours, lineHeight_mm: v } })}
                    hint="How far each ring stands above the terrain."
                  />
                </>
              ) : null}

              <div className="field">
                <label className="field__label" htmlFor="colormode">
                  Colour mode
                </label>
                <select
                  id="colormode"
                  className="select"
                  value={config.colorMode}
                  onChange={(e) => update({ colorMode: e.target.value as ColorMode })}
                  disabled={busy}
                >
                  <option value="multicolor">Multicolour — one object per layer</option>
                  <option value="single-raised">Single colour, raised route</option>
                  <option value="single-cutout">Single colour, route cut out</option>
                </select>
                <p className="field__hint">
                  {config.colorMode === 'multicolor'
                    ? 'Every layer stays a separate object. Export 3MF and the slicer assigns a filament to each.'
                    : config.colorMode === 'single-raised'
                      ? 'Everything merges into one body, with the route standing proud. Legible by relief alone — raise the route height for a stronger read.'
                      : 'The route is cut out of the terrain, leaving a channel to paint or fill.'}
                </p>
              </div>

              {config.colorMode === 'single-cutout' ? (
                <>
                  <div className="field">
                    <label className="field__label" htmlFor="submode">
                      Cutout style
                    </label>
                    <select
                      id="submode"
                      className="select"
                      value={config.cutout.subMode}
                      onChange={(e) =>
                        update({
                          cutout: { ...config.cutout, subMode: e.target.value as CutoutSubMode },
                        })
                      }
                      disabled={busy}
                    >
                      <option value="groove">Groove — channel only, to paint or fill</option>
                      <option value="inlay">Inlay — plus a separate insert to press in</option>
                    </select>
                    <p className="field__hint">
                      {config.cutout.subMode === 'groove'
                        ? 'One body with a recessed channel.'
                        : 'Two bodies: the terrain with a cavity, and the route insert to print in a second colour.'}
                    </p>
                  </div>

                  <NumberField
                    label="Channel depth"
                    unit="mm"
                    value={config.cutout.insetDepth_mm}
                    min={0.3}
                    max={4}
                    step={0.1}
                    disabled={busy}
                    onChange={(v) => update({ cutout: { ...config.cutout, insetDepth_mm: v } })}
                    hint="Measured below the lowest ground the route crosses — the floor is flat so the insert seats without supports."
                  />

                  {config.cutout.subMode === 'inlay' ? (
                    <>
                      <NumberField
                        label="Clearance"
                        unit="mm"
                        value={config.cutout.clearance_mm}
                        min={0.05}
                        max={0.5}
                        step={0.05}
                        disabled={busy}
                        onChange={(v) => update({ cutout: { ...config.cutout, clearance_mm: v } })}
                        hint="Gap per side. Too tight and the insert will not seat; too loose and it rattles. 0.15 mm is the usual FDM press fit."
                      />
                      <p className="field__hint">
                        How far the insert stands out of the channel is the route&rsquo;s
                        <strong> Height</strong>, under Routes. Zero seats it flush.
                      </p>
                    </>
                  ) : null}

                  <div className="field">
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={config.cutout.water}
                        disabled={busy || !config.layers['water']?.enabled}
                        onChange={(e) =>
                          update({ cutout: { ...config.cutout, water: e.target.checked } })
                        }
                      />
                      Cut the water out too
                    </label>
                    <p className="field__hint">
                      {!config.layers['water']?.enabled
                        ? 'Turn the Water layer on under Layers, and lakes and rivers can be cut out as well.'
                        : config.cutout.subMode === 'inlay'
                          ? 'Lakes and rivers become a basin plus a second insert, to print in blue and press in. Its top is flat — water is level, whatever the ground under it does.'
                          : 'Lakes and rivers become a recessed basin to paint or fill. Switch Cutout style to Inlay to get a piece to press in instead.'}
                    </p>
                  </div>
                </>
              ) : null}

              <div className="field">
                <label className="field__label" htmlFor="bed">
                  Printer bed
                </label>
                <select
                  id="bed"
                  className="select"
                  value={printerId ?? 'none'}
                  onChange={(e) =>
                    update({
                      bedSize_mm: BED_PRESETS.find((b) => b.id === e.target.value)?.size ?? null,
                    })
                  }
                  disabled={busy}
                >
                  {BED_PRESETS.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <p className="field__hint">
                  Warns when the model will not fit. Never blocks — printing in sections is a
                  perfectly good plan.
                </p>
              </div>

              <div className="field">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={config.tiling.enabled}
                    disabled={busy || !config.bedSize_mm}
                    onChange={(e) => update({ tiling: { enabled: e.target.checked } })}
                  />
                  Split to fit the bed
                </label>
                <p className="field__hint">
                  {!config.bedSize_mm
                    ? 'Pick a printer bed above, and this can cut an oversized model into pieces that fit it.'
                    : 'Cuts an oversized model into a grid of bed-sized pieces, each exported ready to print. A model that already fits is left alone. Seams are flat butt joints — glue them; there are no alignment pins yet.'}
                </p>
              </div>
            </section>

            </Section>

            <Section
              id="terrain"
              title="Terrain"
              hint={`${config.verticalExaggeration.toFixed(1)}x relief`}
              icon={ICONS.terrain}
              open={openGroup === 'terrain'}
              onToggle={() => toggleGroup('terrain')}
            >
            <SunControl
              sun={sun}
              onChange={setSun}
              enabled={terrain3d}
              onEnabledChange={setTerrain3d}
            />

            <section>
              <NumberField
                label="Vertical exaggeration"
                unit="×"
                value={config.verticalExaggeration}
                min={0.5}
                max={5}
                step={0.1}
                disabled={busy}
                onChange={(v) => update({ verticalExaggeration: v })}
                hint="Flat city 2.5–4×, rolling hills 1.5–2×, alpine 1.0–1.5×."
              />
              <NumberField
                label="Max height"
                unit="mm"
                value={config.maxHeight_mm}
                min={2}
                max={100}
                step={1}
                disabled={busy}
                onChange={(v) => update({ maxHeight_mm: v })}
                hint="Clamps the tallest peak. Exaggeration is reduced to fit."
              />
              <div className="field">
                <label className="field__label">
                  Sampling step<span className="field__unit">m</span>
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={autoResolution}
                    disabled={busy}
                    onChange={(e) => {
                      setAutoResolution(e.target.checked);
                      update({
                        resolution_m: e.target.checked ? 'auto' : (gridPreview?.resolution_m ?? 30),
                      });
                    }}
                  />
                  Auto
                </label>
              </div>
              {!autoResolution ? (
                <NumberField
                  label="Resolution"
                  unit="m/px"
                  value={typeof config.resolution_m === 'number' ? config.resolution_m : 30}
                  min={5}
                  max={500}
                  step={1}
                  disabled={busy}
                  onChange={(v) => update({ resolution_m: v })}
                />
              ) : null}
              <NumberField
                label="Smoothing"
                value={config.smoothing}
                min={0}
                max={5}
                step={1}
                disabled={busy}
                onChange={(v) => update({ smoothing: v })}
                hint="Laplacian passes. Flattens genuine features — default 0."
              />
            </section>

            </Section>

            <Section
              id="export"
              title="Print & export"
              hint={bundle ? 'Ready' : 'Nothing built yet'}
              icon={ICONS.export}
              open={openGroup === 'export'}
              onToggle={() => toggleGroup('export')}
            >
              <EstimatePanel
                printerLabel={
                  BED_PRESETS.find((b) => b.id === printerId)?.label.replace(/ \(.*/, '') ?? null
                }
                measures={bundle?.measures ?? null}
                settings={filament}
                onChange={(patch) => setFilament((c) => ({ ...c, ...patch }))}
                layerHeight_mm={config.layerHeight_mm}
                nozzleDiameter_mm={config.nozzleDiameter_mm}
                stale={dirty}
              />

            <ProjectPanel
              busy={busy}
              settings={settings}
              routeCount={routes.length}
              onSave={onSaveProject}
              onLoad={(file) => void onLoadProject(file)}
              onCopyLink={onCopyLink}
              onApplyPreset={onApplyPreset}
            />

            </Section>

          </div>

          <div className="panel__pinned">
            {gridPreview ? (
              <section>
                <h2>Before you generate</h2>
                <dl className="stats">
                  <dt>Real extent</dt>
                  <dd>
                    {formatExtent(gridPreview.extentX_m / 1000, gridPreview.extentY_m / 1000, unit)}
                  </dd>
                  <dt>Sampling step</dt>
                  <dd>
                    {formatGroundLength(gridPreview.resolution_m, unit)}
                    {gridPreview.resolutionNozzleLimited ? (
                      <span className="badge">nozzle-limited</span>
                    ) : null}
                  </dd>
                  <dt>Grid</dt>
                  <dd>
                    {gridPreview.cols} × {gridPreview.rows}
                  </dd>
                  {osmPlan ? (
                    <>
                      <dt>Map data</dt>
                      <dd>
                        {osmPlan.single
                          ? '1 request'
                          : `${osmPlan.tiles} requests · about ${fetchTimeLabel(osmPlan.seconds)}, longer if OpenStreetMap is busy`}
                        {osmPlan.tiles >= HUGE_FETCH_TILES ? (
                          <span className="badge badge--huge">too many</span>
                        ) : osmPlan.seconds >= SLOW_FETCH_S ? (
                          <span className="badge badge--slow">slow</span>
                        ) : null}
                      </dd>
                    </>
                  ) : null}
                </dl>
                {/* The indicator, not a refusal. A 100 km route genuinely needs
                    this many requests and OpenStreetMap will only take them at
                    its own pace; someone told that up front waits, while someone
                    told nothing assumes it has hung and cancels. Two tiers,
                    because "leave it running" stops being true somewhere. */}
                {osmPlan && osmPlan.tiles >= HUGE_FETCH_TILES ? (
                  <p className="note note--warn">
                    More than OpenStreetMap will serve in one run. The terrain builds
                    regardless — untick layers or shrink the selection for the map features.
                  </p>
                ) : osmPlan && osmPlan.seconds >= SLOW_FETCH_S ? (
                  <p className="note">
                    Fetched in {osmPlan.tiles} pieces, paced so OpenStreetMap keeps
                    answering. It will finish — leave it running.
                  </p>
                ) : null}
              </section>
            ) : null}

            {bundle ? <Results bundle={bundle} dirty={dirty} unit={unit} /> : null}
            {error ? (
              <section>
                <div className={`alert alert--${error.level}`}>{error.text}</div>
              </section>
            ) : null}
          </div>
        </aside>
        )}

        <main className="viewport">
          <div className={view === 'map' ? 'stage' : 'stage stage--hidden'}>
            <MapView
            unit={unit}
              basemapId={basemapId}
              fitNonce={fitNonce}
              datasetId={config.dataset}
              terrain3d={terrain3d}
              sun={sun}
              shape={shape}
              tool={tool}
              routes={routes}
              featurePreview={preview?.geojson ?? null}
              onShapeChange={(next) => applyShape(next, 'Custom selection')}
              onRouteDrawn={onRouteDrawn}
              editingRouteId={tool ? null : editingRouteId}
              onRouteEdited={onRouteEdited}
              onNotice={(text) => setError({ level: 'notice', text })}
              flyTo={flyTo}
              onToolFinished={() => setTool(null)}
              onCursor={setCursor}
            />

            <div className="shapetools" role="group" aria-label="Selection shape">
              <span className="shapetools__title">Draw area</span>
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={`shapetool${tool === t.id ? ' shapetool--on' : ''}`}
                  onClick={() => {
                    setEditingRouteId(null);
                    setTool(tool === t.id ? null : t.id);
                  }}
                  title={t.id === 'polygon' ? 'Click points, double-click to finish' : undefined}
                >
                  <span aria-hidden>{t.glyph}</span> {t.label}
                </button>
              ))}
              <button className="shapetool" onClick={() => fitToRoutes(routes)} disabled={routes.length === 0}>
                <span aria-hidden>⤢</span> Fit to routes
              </button>
              <button
                className="shapetool"
                onClick={goToMyLocation}
                disabled={locating}
                title="Centre the map near you"
              >
                <span aria-hidden>◎</span> {locating ? 'Locating…' : 'My location'}
              </button>
              <button
                className="shapetool shapetool--danger"
                onClick={clearShape}
                disabled={!shape}
                title="Remove the selected area"
              >
                <span aria-hidden>✕</span> Clear area
              </button>
            </div>

            {tool ? (
              <div className="drawhint">
                {tool === 'route'
                  ? 'Drawing a route: click to place points, Backspace undoes, double-click or Enter finishes. Esc cancels.'
                  : tool === 'polygon'
                    ? 'Click to add points, double-click to finish. Backspace undoes, Esc cancels.'
                    : 'Drag on the map to draw. Esc cancels.'}
              </div>
            ) : null}

            <div className="statusstrip">
              {cursor ? `${cursor[1].toFixed(4)}, ${cursor[0].toFixed(4)}` : '—'} ·{' '}
              {shape
                ? `area: ${formatArea(area_km2, unit, 2)} · ${shape.kind}`
                : 'no area selected — draw one to generate'}
            </div>
          </div>

          <div className={view === '3d' ? 'stage' : 'stage stage--hidden'}>
            <Viewer bundle={bundle} shading={shading} autoSpin={autoSpin} />
            {bundle ? null : (
              <div className="stageempty">
                <p>
                  {busy
                    ? 'Building the model…'
                    : shape
                      ? 'Nothing built yet. Press Generate and the model appears here.'
                      : 'Nothing built yet. Draw an area on the Map tab first, or upload a GPX and the area is drawn for you.'}
                </p>
              </div>
            )}
            <div className="shadingtools" role="group" aria-label="Shading mode">
              {SHADING.map((s) => (
                <button
                  key={s.id}
                  className={`shapetool${shading === s.id ? ' shapetool--on' : ''}`}
                  onClick={() => setShading(s.id)}
                >
                  {s.label}
                </button>
              ))}
              <button
                className={`shapetool${autoSpin ? ' shapetool--on' : ''}`}
                onClick={() => setAutoSpin(!autoSpin)}
              >
                Auto-spin
              </button>
            </div>
            {bundle ? (
              <div className="statsoverlay">
                <strong>{bundle.stats.triangles.toLocaleString()}</strong> triangles ·{' '}
                {bundle.stats.dimensions_mm.map((v) => v.toFixed(1)).join(' × ')} mm ·{' '}
                {formatExtent(bundle.stats.extent_km[0], bundle.stats.extent_km[1], unit)} ·{' '}
                {formatElevationRange(
                  bundle.stats.elevationRange_m[0],
                  bundle.stats.elevationRange_m[1],
                  unit,
                  '–',
                )}{' '}
                · exag{' '}
                {bundle.stats.verticalExaggeration.toFixed(2)}× ·{' '}
                <span className={bundle.validation.watertight ? 'ok' : 'bad'}>
                  Watertight: {bundle.validation.watertight ? 'Yes' : 'No'}
                </span>
              </div>
            ) : null}
          </div>

          {progress ? <ProgressPanel progress={progress} onCancel={onCancel} /> : null}
        </main>
      </div>

      <footer className="attribution">
        {/* Attribution is a licence condition, not decoration, so it keeps the
            left of the footer to itself and the additions sit apart from it. */}
        <span className="attribution__credit">
          {BASEMAPS.find((b) => b.id === basemapId)?.attribution} · Elevation:{' '}
          {dataset?.attribution ?? ''}
        </span>
        <span className="attribution__actions">
          <button
            type="button"
            className="btn btn--link"
            title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
            aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? <MoonIcon /> : <SunIcon />}
          </button>
          <button
            type="button"
            className="btn btn--link"
            title="Units for distances and elevations. Print sizes are always millimetres."
            onClick={() => {
              const next: DistanceUnit = unit === 'metric' ? 'imperial' : 'metric';
              setUnit(next);
              writeUnit(next);
            }}
          >
            {UNIT_LABEL[unit]}
          </button>
          {SUPPORT_URL ? (
            <a
              className="btn btn--link"
              href={SUPPORT_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              {SUPPORT_LABEL}
            </a>
          ) : null}
        </span>
      </footer>
    </div>
  );
}

/** The sidebar collapse glyph: a panel with its left column marked. */
function PanelIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6.2 3v10" />
    </svg>
  );
}

/** Theme switch glyphs. Two shapes, drawn to the same 14px grid as the rest. */
function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.5 9.5A5.8 5.8 0 016.5 2.5a5.8 5.8 0 100 11 5.8 5.8 0 007-4z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
    </svg>
  );
}

function ProgressPanel({ progress, onCancel }: { progress: Progress; onCancel: () => void }) {
  const current = STAGE_ORDER.indexOf(progress.stage);

  return (
    <div className="progressoverlay">
      <div className="progress">
        <h2>Generating your model…</h2>
        <ol className="progress__stages">
          {STAGE_LABELS.map((item) => {
            const first = STAGE_ORDER.indexOf(item.stages[0]);
            const last = STAGE_ORDER.indexOf(item.stages[item.stages.length - 1]);
            const state = current > last ? 'done' : current >= first ? 'active' : 'pending';
            return (
              <li key={item.label} className={`progress__stage progress__stage--${state}`}>
                <span className="progress__marker">
                  {state === 'done' ? '✓' : state === 'active' ? '◐' : '○'}
                </span>
                {item.label}
              </li>
            );
          })}
        </ol>
        <div className="progress__bar">
          <div className="progress__fill" style={{ width: `${progress.percent.toFixed(1)}%` }} />
        </div>
        <p className="progress__detail">
          {progress.detail} — {progress.percent.toFixed(0)} %
        </p>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Results({
  bundle,
  dirty,
  unit,
}: {
  bundle: MeshBundle;
  dirty: boolean;
  unit: DistanceUnit;
}) {
  const { stats, validation, warnings } = bundle;

  return (
    <section>
      <h2>Model</h2>
      {dirty ? <div className="alert alert--dirty">Settings changed — regenerate to update.</div> : null}
      <dl className="stats">
        <dt>Triangles</dt>
        <dd>{stats.triangles.toLocaleString()}</dd>
        <dt>Dimensions</dt>
        <dd>{stats.dimensions_mm.map((v) => v.toFixed(1)).join(' × ')} mm</dd>
        <dt>Elevation</dt>
        <dd>{formatElevationRange(stats.elevationRange_m[0], stats.elevationRange_m[1], unit)}</dd>
        <dt>Watertight</dt>
        <dd className={validation.watertight ? 'ok' : 'bad'}>
          {validation.watertight ? '✓ Yes' : '✗ No'}
        </dd>
        <dt>Manifold</dt>
        <dd className={validation.manifold ? 'ok' : 'bad'}>
          {validation.manifold ? '✓ Yes' : '✗ No'}
        </dd>
        <dt>Build time</dt>
        <dd>{(stats.buildTime_ms / 1000).toFixed(1)} s</dd>
      </dl>

      {warnings.length > 0 ? (
        <ul className="warnings">
          {warnings.map((w, i) => (
            <li key={`${w.code}-${i}`} className={`warning warning--${w.level}`}>
              <strong>{w.level === 'fail' ? '✗' : '⚠'}</strong> {w.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="ok">✓ No issues found.</p>
      )}
    </section>
  );
}
