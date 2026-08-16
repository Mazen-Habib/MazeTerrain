/**
 * Phase 0 shell.
 *
 * Deliberately not the app from docs/07-ui-spec.md — there is no map and no 3D
 * preview yet, because Phase 0 exists to prove the geometry, not to look like
 * the product. What it does implement from that spec is the part that is easy to
 * get wrong later: the named-stage progress checklist, a cancel that actually
 * cancels, and the dirty state that stops settings changes triggering rebuilds.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { DEM_DATASETS } from '../data/dem/datasets';
import { defaultConfig, PRESETS } from '../config/presets';
import { stlFilename, stlHeader, writeBinarySTL } from '../export/stl';
import { resolveGrid } from '../geometry/coords';
import type { GenerateConfig, MeshBundle, Progress, ProgressStage } from '../geometry/types';
import { cancelGeneration, generate, terminateWorker } from '../workers/client';
import { NumberField } from './NumberField';

const STAGE_LABELS: Array<{ stages: ProgressStage[]; label: string }> = [
  { stages: ['resolving'], label: 'Working out the scale' },
  { stages: ['fetching-dem'], label: 'Fetching elevation data' },
  { stages: ['building-heightfield'], label: 'Building the heightfield' },
  { stages: ['building-terrain'], label: 'Building the terrain' },
  { stages: ['validating', 'done'], label: 'Finalising the mesh' },
];

const STAGE_ORDER: ProgressStage[] = [
  'resolving',
  'fetching-dem',
  'building-heightfield',
  'building-terrain',
  'validating',
  'done',
];

export function App() {
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const preset = useMemo(() => PRESETS.find((p) => p.id === presetId) ?? PRESETS[0], [presetId]);

  const [config, setConfig] = useState<GenerateConfig>(() => defaultConfig(PRESETS[0].bbox));
  const [autoResolution, setAutoResolution] = useState(true);

  const [progress, setProgress] = useState<Progress | null>(null);
  const [bundle, setBundle] = useState<MeshBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const busy = progress !== null;
  const builtSlug = useRef(preset.slug);

  /** Any settings change marks the model dirty. It never triggers a rebuild. */
  const update = useCallback((patch: Partial<GenerateConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setDirty(true);
  }, []);

  const onPreset = useCallback((id: string) => {
    const next = PRESETS.find((p) => p.id === id);
    if (!next) return;
    setPresetId(id);
    setConfig((c) => ({ ...c, bbox: next.bbox }));
    setDirty(true);
  }, []);

  const gridPreview = useMemo(() => {
    try {
      return resolveGrid(config);
    } catch {
      return null;
    }
  }, [config]);

  const onGenerate = useCallback(async () => {
    setError(null);
    setProgress({ stage: 'resolving', percent: 0, detail: 'Starting' });
    builtSlug.current = preset.slug;

    try {
      const result = await generate(config, (p) => setProgress(p));
      setBundle(result);
      setDirty(false);
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
  }, [config, preset.slug]);

  const onCancel = useCallback(() => {
    cancelGeneration();
    // The triangulation loop is synchronous and cannot observe the abort flag,
    // so guarantee the escape by tearing the worker down.
    terminateWorker();
    setProgress(null);
    setError('Generation cancelled.');
  }, []);

  const blocked = bundle ? bundle.warnings.some((w) => w.level === 'fail') : true;

  const onDownload = useCallback(() => {
    if (!bundle || blocked) return;
    const buffer = writeBinarySTL(bundle.parts, stlHeader());
    const blob = new Blob([buffer], { type: 'model/stl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = stlFilename(builtSlug.current, config.modelWidth_mm);
    // The anchor must be in the document for Firefox, and the object URL must
    // outlive the click — revoking synchronously cancels the download of a
    // 30 MB blob before the browser has finished reading it.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, [bundle, blocked, config.modelWidth_mm]);

  return (
    <div className="layout">
      <header className="topbar">
        <h1>
          MazeTerrain <span className="topbar__phase">Phase 0</span>
        </h1>
        <div className="topbar__actions">
          <button
            className={`btn${dirty || !bundle ? ' btn--accent' : ''}`}
            onClick={onGenerate}
            disabled={busy}
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
          <button className="btn" onClick={onDownload} disabled={!bundle || blocked || busy}>
            Download STL
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="panel">
          <section>
            <h2>Selection</h2>
            <label className="field__label" htmlFor="preset">
              Area
            </label>
            <select
              id="preset"
              className="select"
              value={presetId}
              onChange={(e) => onPreset(e.target.value)}
              disabled={busy}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="note">{preset.note}</p>

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
              <p className="field__hint">
                Sets the floor on terrain detail. Sampling finer than the nozzle makes ridges
                the printer cannot lay down.
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
            <NumberField
              label="Sea level offset"
              unit="m"
              value={config.seaLevelOffset_m}
              min={-500}
              max={2000}
              step={10}
              disabled={busy}
              onChange={(v) => update({ seaLevelOffset_m: v })}
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
                    update({ resolution_m: e.target.checked ? 'auto' : (gridPreview?.resolution_m ?? 30) });
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
                  {(gridPreview.extentX_m / 1000).toFixed(1)} × {(gridPreview.extentY_m / 1000).toFixed(1)} km
                </dd>
                <dt>Sampling step</dt>
                <dd>
                  {gridPreview.resolution_m.toFixed(1)} m
                  {gridPreview.resolutionNozzleLimited ? (
                    <span className="badge" title="Floored at one nozzle width">
                      nozzle-limited
                    </span>
                  ) : null}
                </dd>
                <dt>Printable detail</dt>
                <dd>{gridPreview.printableStep_m.toFixed(1)} m</dd>
                <dt>Grid</dt>
                <dd>
                  {gridPreview.cols} × {gridPreview.rows}
                </dd>
                <dt>Triangles</dt>
                <dd>{estimateTriangles(gridPreview.cols, gridPreview.rows).toLocaleString()}</dd>
              </dl>
            </section>
          ) : null}
        </aside>

        <main className="main">
          {progress ? <ProgressPanel progress={progress} onCancel={onCancel} /> : null}

          {error ? (
            <div className="alert alert--fail">
              <strong>Generation failed.</strong> {error}
            </div>
          ) : null}

          {bundle && !progress ? <Results bundle={bundle} dirty={dirty} /> : null}

          {!bundle && !progress && !error ? (
            <div className="empty">
              <h2>Nothing built yet</h2>
              <p>
                Pick an area, then press <strong>Generate</strong>. Phase 0 fetches real elevation
                tiles, builds a watertight solid, validates that it is manifold, and writes a binary
                STL.
              </p>
            </div>
          ) : null}
        </main>
      </div>

      <footer className="attribution">
        Elevation: {DEM_DATASETS[config.dataset]?.attribution ?? ''}
      </footer>
    </div>
  );
}

function estimateTriangles(cols: number, rows: number): number {
  const perimeter = 2 * (cols + rows - 2);
  return (cols - 1) * (rows - 1) * 2 + perimeter * 3;
}

function ProgressPanel({ progress, onCancel }: { progress: Progress; onCancel: () => void }) {
  const current = STAGE_ORDER.indexOf(progress.stage);

  return (
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
  );
}

function Results({ bundle, dirty }: { bundle: MeshBundle; dirty: boolean }) {
  const { stats, validation, warnings } = bundle;

  return (
    <div className="results">
      {dirty ? (
        <div className="alert alert--dirty">Settings changed — regenerate to update.</div>
      ) : null}

      <h2>Model</h2>
      <dl className="stats stats--wide">
        <dt>Triangles</dt>
        <dd>{stats.triangles.toLocaleString()}</dd>
        <dt>Vertices</dt>
        <dd>{stats.vertices.toLocaleString()}</dd>
        <dt>Dimensions</dt>
        <dd>
          {stats.dimensions_mm[0].toFixed(1)} × {stats.dimensions_mm[1].toFixed(1)} ×{' '}
          {stats.dimensions_mm[2].toFixed(1)} mm
        </dd>
        <dt>Real extent</dt>
        <dd>
          {stats.extent_km[0].toFixed(1)} × {stats.extent_km[1].toFixed(1)} km
        </dd>
        <dt>Elevation</dt>
        <dd>
          {stats.elevationRange_m[0].toFixed(0)} – {stats.elevationRange_m[1].toFixed(0)} m
        </dd>
        <dt>Vertical exaggeration</dt>
        <dd>{stats.verticalExaggeration.toFixed(2)}×</dd>
        <dt>Sampling step</dt>
        <dd>
          {stats.resolution_m.toFixed(1)} m ({stats.gridSize[0]} × {stats.gridSize[1]})
        </dd>
        <dt>Watertight</dt>
        <dd className={validation.watertight ? 'ok' : 'bad'}>
          {validation.watertight ? '✓ Yes' : '✗ No'}
        </dd>
        <dt>Manifold</dt>
        <dd className={validation.manifold ? 'ok' : 'bad'}>
          {validation.manifold ? '✓ Yes' : '✗ No'}
        </dd>
        <dt>Volume</dt>
        <dd>{(validation.volume_mm3 / 1000).toFixed(1)} cm³</dd>
        <dt>Dataset</dt>
        <dd>{stats.demDataset}</dd>
        <dt>Build time</dt>
        <dd>{(stats.buildTime_ms / 1000).toFixed(1)} s</dd>
      </dl>

      <h2>Print check</h2>
      {warnings.length === 0 ? (
        <p className="ok">✓ No issues found.</p>
      ) : (
        <ul className="warnings">
          {warnings.map((w, i) => (
            <li key={`${w.code}-${i}`} className={`warning warning--${w.level}`}>
              <strong>{w.level === 'fail' ? '✗' : '⚠'}</strong> {w.message}
            </li>
          ))}
        </ul>
      )}

      {validation.openEdges > 0 || validation.nonManifoldEdges > 0 ? (
        <p className="note">
          Open edges: {validation.openEdges} · Non-manifold edges: {validation.nonManifoldEdges} ·
          Degenerate triangles: {validation.degenerateTriangles}
        </p>
      ) : null}
    </div>
  );
}
