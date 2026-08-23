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
import { useCallback, useMemo, useRef, useState } from 'react';
import { DEM_DATASETS } from '../data/dem/datasets';
import { BED_PRESETS, defaultConfig, PRESETS } from '../config/presets';
import { GpxParseError, parseGpxText } from '../data/gpx/parse';
import type { Route } from '../data/gpx/types';
import { stlFilename, stlHeader, writeBinarySTL } from '../export/stl';
import { writeThreeMF, threeMFFilename } from '../export/threemf';
import { bboxCentre, resolveGrid } from '../geometry/coords';
import {
  fitSelectionToRoutes,
  selectionArea_km2,
  selectionBBox,
  selectionRingLonLat,
  type SelectionShape,
} from '../geometry/selection';
import type { GenerateConfig, MeshBundle, Progress, ProgressStage, SerialisableRoute } from '../geometry/types';
import type { LineFeature } from '../data/osm/normalise';
import { normalise } from '../data/osm/normalise';
import { fetchOsm, OverpassError } from '../data/osm/overpass';
import { buildFeaturePreview, enabledLineLayers } from '../map/featurePreview';
import { resolveScale } from '../geometry/coords';
import { BASEMAPS } from '../map/basemaps';
import type { DrawTool, LonLat } from '../map/draw';
import { MapView } from '../map/MapView';
import { Viewer, type ShadingMode } from '../preview/Viewer';
import { cancelGeneration, generate, terminateWorker } from '../workers/client';
import { NumberField } from './NumberField';
import { RoutePanel } from './RoutePanel';
import { LayersPanel } from './LayersPanel';
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

function toSerialisable(routes: Route[]): SerialisableRoute[] {
  return routes.map((r) => ({
    id: r.id,
    name: r.name,
    points: r.points,
    style: { ...r.style },
  }));
}

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
  const [shape, setShape] = useState<SelectionShape | null>(() => ({
    kind: 'rectangle',
    bbox: PRESETS[0].bbox,
  }));
  const [areaLabel, setAreaLabel] = useState(PRESETS[0].label);
  const [tool, setTool] = useState<DrawTool | null>(null);
  const [basemapId, setBasemapId] = useState(BASEMAPS[0].id);
  const [terrain3d, setTerrain3d] = useState(false);
  const [view, setView] = useState<'map' | '3d'>('map');
  const [shading, setShading] = useState<ShadingMode>('natural');
  const [autoSpin, setAutoSpin] = useState(false);
  const [cursor, setCursor] = useState<LonLat | null>(null);
  const [fitNonce, setFitNonce] = useState(0);

  const [settings, setSettings] = useState<Omit<GenerateConfig, 'bbox'>>(() => {
    const { bbox: _bbox, ...rest } = defaultConfig(PRESETS[0].bbox);
    return rest;
  });
  const [autoResolution, setAutoResolution] = useState(true);
  const [routes, setRoutes] = useState<Route[]>([]);

  const [progress, setProgress] = useState<Progress | null>(null);
  const [bundle, setBundle] = useState<MeshBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    (list: Route[]) => {
      const fitted = fitSelectionToRoutes(list);
      if (fitted) {
        applyShape(fitted, list.length === 1 ? list[0].name : `${list.length} routes`, true);
      }
    },
    [applyShape],
  );

  const onUpload = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);

      const parsed: Route[] = [];
      const failures: string[] = [];
      for (const file of Array.from(files)) {
        try {
          parsed.push(...parseGpxText(await file.text(), file.name));
        } catch (err) {
          failures.push(err instanceof GpxParseError ? err.userMessage : String(err));
        }
      }

      if (failures.length > 0) setError(failures.join(' '));
      if (parsed.length === 0) return;

      setRoutes((current) => {
        const next = [...current, ...parsed];
        if (current.length === 0) fitToRoutes(next);
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
    setDirty(true);
  }, []);

  const gridPreview = useMemo(() => {
    try {
      return resolveGrid(config);
    } catch {
      return null;
    }
  }, [config]);

  const area_km2 = useMemo(
    () => (shape ? selectionArea_km2(shape, bboxCentre(selectionBBox(shape))) : 0),
    [shape],
  );

  const onGenerate = useCallback(async () => {
    if (!shape) {
      setError('Draw an area on the map first — there is nothing to generate.');
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
      setDirty(false);
      setView('3d');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError('Generation cancelled.');
      } else {
        const userMessage =
          err && typeof err === 'object' && 'userMessage' in err
            ? String((err as { userMessage: unknown }).userMessage)
            : null;
        setError(userMessage ?? (err instanceof Error ? err.message : String(err)));
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
    setError('Generation cancelled.');
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

  const onDownload = useCallback(() => {
    if (!bundle || blocked) return;
    save(
      writeBinarySTL(bundle.parts, stlHeader()),
      stlFilename(builtSlug.current, config.modelWidth_mm),
      'model/stl',
    );
  }, [bundle, blocked, config.modelWidth_mm, save]);

  /**
   * 3MF keeps each layer as its own object with its own material, so a slicer
   * opens the model with filaments already assigned. STL cannot: it has no
   * concept of parts, so a multicolour model exported as STL is one grey blob.
   */
  const onDownload3mf = useCallback(() => {
    if (!bundle || blocked) return;
    save(
      writeThreeMF(bundle.parts),
      threeMFFilename(builtSlug.current, config.modelWidth_mm),
      'model/3mf',
    );
  }, [bundle, blocked, config.modelWidth_mm, save]);

  const dataset = DEM_DATASETS[config.dataset];

  return (
    <div className="layout">
      <header className="topbar">
        <h1>
          MazeTerrain <span className="topbar__phase">Phase 2</span>
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
            disabled={!bundle}
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
          <button
            className="btn"
            onClick={onDownload3mf}
            disabled={!bundle || blocked || busy}
            title="Every layer as its own object and material — colours survive into the slicer"
          >
            Download 3MF
          </button>
          <button className="btn" onClick={onDownload} disabled={!bundle || blocked || busy}>
            Download STL
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="panel">
          <RoutePanel
            routes={routes}
            busy={busy}
            onUpload={onUpload}
            onUpdate={updateRoute}
            onRemove={removeRoute}
            onFit={() => fitToRoutes(routes)}
          />

          <LayersPanel
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

          <section>
            <h2>Selection</h2>
            <p className="note">
              Current area: <strong>{areaLabel}</strong> · {area_km2.toFixed(1)} km²
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

          <section>
            <h2>Model size</h2>
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
              <label className="field__label" htmlFor="bed">
                Printer bed
              </label>
              <select
                id="bed"
                className="select"
                value={
                  config.bedSize_mm
                    ? (BED_PRESETS.find(
                        (b) =>
                          b.size &&
                          b.size[0] === config.bedSize_mm![0] &&
                          b.size[1] === config.bedSize_mm![1],
                      )?.id ?? 'none')
                    : 'none'
                }
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
          </section>

          <section>
            <h2>Topography</h2>
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

          {gridPreview ? (
            <section>
              <h2>Before you generate</h2>
              <dl className="stats">
                <dt>Real extent</dt>
                <dd>
                  {(gridPreview.extentX_m / 1000).toFixed(1)} ×{' '}
                  {(gridPreview.extentY_m / 1000).toFixed(1)} km
                </dd>
                <dt>Sampling step</dt>
                <dd>
                  {gridPreview.resolution_m.toFixed(1)} m
                  {gridPreview.resolutionNozzleLimited ? (
                    <span className="badge">nozzle-limited</span>
                  ) : null}
                </dd>
                <dt>Grid</dt>
                <dd>
                  {gridPreview.cols} × {gridPreview.rows}
                </dd>
              </dl>
            </section>
          ) : null}

          {bundle ? <Results bundle={bundle} dirty={dirty} /> : null}
          {error ? (
            <section>
              <div className="alert alert--fail">{error}</div>
            </section>
          ) : null}
        </aside>

        <main className="viewport">
          <div className={view === 'map' ? 'stage' : 'stage stage--hidden'}>
            <MapView
              basemapId={basemapId}
              fitNonce={fitNonce}
              datasetId={config.dataset}
              terrain3d={terrain3d}
              shape={shape}
              tool={tool}
              routes={routes}
              featurePreview={preview?.geojson ?? null}
              onShapeChange={(next) => applyShape(next, 'Custom selection')}
              onToolFinished={() => setTool(null)}
              onCursor={setCursor}
            />

            <div className="shapetools" role="group" aria-label="Selection shape">
              <span className="shapetools__title">Draw area</span>
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={`shapetool${tool === t.id ? ' shapetool--on' : ''}`}
                  onClick={() => setTool(tool === t.id ? null : t.id)}
                  title={t.id === 'polygon' ? 'Click points, double-click to finish' : undefined}
                >
                  <span aria-hidden>{t.glyph}</span> {t.label}
                </button>
              ))}
              <button className="shapetool" onClick={() => fitToRoutes(routes)} disabled={routes.length === 0}>
                <span aria-hidden>⤢</span> Fit to routes
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
                {tool === 'polygon'
                  ? 'Click to add points, double-click to finish. Esc cancels.'
                  : 'Drag on the map to draw. Esc cancels.'}
              </div>
            ) : null}

            <div className="statusstrip">
              {cursor ? `${cursor[1].toFixed(4)}, ${cursor[0].toFixed(4)}` : '—'} ·{' '}
              {shape
                ? `area: ${area_km2.toFixed(2)} km² · ${shape.kind}`
                : 'no area selected — draw one to generate'}
            </div>
          </div>

          <div className={view === '3d' ? 'stage' : 'stage stage--hidden'}>
            <Viewer bundle={bundle} shading={shading} autoSpin={autoSpin} />
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
                {bundle.stats.extent_km.map((v) => v.toFixed(1)).join(' × ')} km ·{' '}
                {bundle.stats.elevationRange_m.map((v) => v.toFixed(0)).join('–')} m · exag{' '}
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
        {BASEMAPS.find((b) => b.id === basemapId)?.attribution} · Elevation:{' '}
        {dataset?.attribution ?? ''}
      </footer>
    </div>
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

function Results({ bundle, dirty }: { bundle: MeshBundle; dirty: boolean }) {
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
        <dd>{stats.elevationRange_m.map((v) => v.toFixed(0)).join(' – ')} m</dd>
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
