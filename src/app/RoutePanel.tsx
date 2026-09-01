/**
 * Route tab (docs/07-ui-spec.md, Tab 2).
 *
 * "The route list is the emotional centre of the app. Show distance, elevation
 * gain and a tiny sparkline profile per route, not just point counts."
 */
import { useRef, useState } from 'react';
import type { ColorMode, CutoutSubMode } from '../geometry/types';
import type { Route } from '../data/gpx/types';
import { canEditVertices } from '../map/editPath';
import { ROUTE_FILE_ACCEPT } from '../data/gpx/parse';
import { formatDistance, formatElevation, type DistanceUnit } from '../config/units';
import { NumberField } from './NumberField';

interface RoutePanelProps {
  routes: Route[];
  busy: boolean;
  /**
   * The colour mode in force.
   *
   * In a cut-out model the route is a channel, not a ridge, so Height means
   * something different: how far the insert stands out of that channel once
   * seated. The control stays live and keeps driving the shape of the printed
   * route — it just drives `insertProud_mm` instead of `style.height_mm`.
   */
  colorMode: ColorMode;
  /** Cut-out sub-mode, so an insert-less groove hides the control entirely. */
  cutoutSubMode: CutoutSubMode;
  /** How far the insert stands proud, shared by every route. */
  insertProud_mm: number;
  onInsertProudChange: (value: number) => void;
  onUpload: (files: FileList | null) => void;
  /** Whether the map is currently in route-drawing mode. */
  drawing: boolean;
  onDraw: () => void;
  /** Chaikin rounding for a drawn route, 0-1. */
  onSmoothing: (id: string, value: number) => void;
  /** Flip the direction of travel. */
  onReverse: (id: string) => void;
  /** The route whose vertices the map is editing, or null (F1.3). */
  editingRouteId: string | null;
  onEditPoints: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<Route['style']>) => void;
  onRemove: (id: string) => void;
  onFit: () => void;
  /** Display units for ground distances. Print mm are never affected (Q14). */
  unit: DistanceUnit;
}

/** A route's points as bare pairs, for the editability check. */
function pointsOf(route: Route): [number, number][] {
  return route.points.map((p) => [p.lon, p.lat]);
}

export function RoutePanel({
  routes,
  busy,
  colorMode,
  cutoutSubMode,
  insertProud_mm,
  onInsertProudChange,
  onUpload,
  drawing,
  onDraw,
  onSmoothing,
  onReverse,
  editingRouteId,
  onEditPoints,
  onUpdate,
  onRemove,
  onFit,
  unit,
}: RoutePanelProps) {
  const cutout = colorMode === 'single-cutout';
  const inlay = cutout && cutoutSubMode === 'inlay';
  const input = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const selected = routes.find((r) => r.id === selectedId) ?? routes[0] ?? null;

  return (
    <section>
      <h2>Routes</h2>

      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) onUpload(e.dataTransfer.files);
        }}
      >
        <button className="btn" disabled={busy} onClick={() => input.current?.click()}>
          Upload route file(s)
        </button>
        {/* Naming the formats here rather than only in the file dialog: a user
            with a .fit from their watch has no reason to guess that it is
            accepted, and the whole point of accepting it is that they stop
            converting files first. */}
        <p className="field__hint">or drag them here — GPX, TCX or FIT</p>
        <input
          ref={input}
          type="file"
          accept={ROUTE_FILE_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            onUpload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <button
        type="button"
        className={drawing ? 'btn btn--wide btn--accent' : 'btn btn--wide'}
        disabled={busy}
        onClick={onDraw}
      >
        {drawing ? 'Drawing — double-click to finish' : 'Draw a route on the map'}
      </button>
      <p className="field__hint">
        {drawing
          ? 'Click to place points. Backspace takes the last one back, Enter or a double-click finishes, Escape cancels.'
          : 'For a route with no GPX — one you remember, or a course off a printed map. It builds exactly like a recorded one.'}
      </p>

      {routes.length === 0 ? (
        <p className="note">
          No route yet. Upload a GPX or draw one and the map will frame it for you — or
          skip routes entirely and just print an area, using the shape tools on the map.
        </p>
      ) : (
        <>
          <ul className="routes">
            {routes.map((route) => (
              <li
                key={route.id}
                className={`route${selected?.id === route.id ? ' route--selected' : ''}`}
                onClick={() => {
                  setSelectedId(route.id);
                  // Editing follows the list: handles left on a route you are
                  // no longer looking at is how you drag the wrong line.
                  if (editingRouteId && editingRouteId !== route.id) onEditPoints(null);
                }}
              >
                <span
                  className="route__swatch"
                  style={{ background: route.style.color }}
                  aria-hidden
                />
                <span className="route__body">
                  <span className="route__name">{route.name}</span>
                  <span className="route__meta">
                    {formatDistance(route.distance_m, unit)}
                    {route.elevationGain_m !== null
                      ? ` · ${formatElevation(route.elevationGain_m, unit)} gain`
                      : ' · no elevation'}
                    {` · ${route.points.length.toLocaleString()} pts`}
                  </span>
                </span>
                <button
                  className="route__toggle"
                  title={route.style.visible ? 'Hide' : 'Show'}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdate(route.id, { visible: !route.style.visible });
                  }}
                >
                  {route.style.visible ? '◉' : '○'}
                </button>
                <button
                  className="route__remove"
                  title="Remove"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(route.id);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <button className="btn btn--wide" disabled={busy} onClick={onFit}>
            Fit selection to routes
          </button>

          {selected ? (
            <div className="route__editor">
              <h3 className="route__editorTitle">{selected.name}</h3>

              <div className="field">
                <label className="field__label" htmlFor="route-color">
                  Colour
                </label>
                <input
                  id="route-color"
                  type="color"
                  className="colorInput"
                  value={selected.style.color}
                  disabled={busy}
                  onChange={(e) => onUpdate(selected.id, { color: e.target.value })}
                />
              </div>

              <NumberField
                label="Width"
                unit="mm"
                value={selected.style.width_mm}
                min={0.4}
                max={8}
                step={0.1}
                disabled={busy}
                onChange={(v) => onUpdate(selected.id, { width_mm: v })}
                hint="Print millimetres, not real-world metres."
              />
              {inlay ? (
                <NumberField
                  label="Height"
                  unit="mm"
                  value={insertProud_mm}
                  min={0}
                  max={6}
                  step={0.1}
                  disabled={busy}
                  onChange={onInsertProudChange}
                  hint={
                    insertProud_mm === 0
                      ? 'Zero sits the insert flush with the terrain. Raise it and the route ' +
                        'stands out of the model, which reads far better in one colour. ' +
                        'Applies to every insert.'
                      : `The insert stands ${insertProud_mm.toFixed(1)} mm out of the channel. ` +
                        'Set it to 0 for a flush fit. Applies to every insert.'
                  }
                />
              ) : cutout ? (
                <NumberField
                  label="Height"
                  unit="mm"
                  value={selected.style.height_mm}
                  min={0.2}
                  max={6}
                  step={0.1}
                  disabled
                  onChange={(v) => onUpdate(selected.id, { height_mm: v })}
                  hint={
                    'A groove has nothing to stand proud — it is a channel to paint or fill. ' +
                    'Switch Cutout style to Inlay to print a route that rises out of the model.'
                  }
                />
              ) : (
                <NumberField
                  label="Height"
                  unit="mm"
                  value={selected.style.height_mm}
                  min={0.2}
                  max={6}
                  step={0.1}
                  disabled={busy}
                  onChange={(v) => onUpdate(selected.id, { height_mm: v })}
                />
              )}

              {selected.source === 'drawn' && canEditVertices(pointsOf(selected)) ? (
                <>
                  <button
                    type="button"
                    className={`btn btn--wide${editingRouteId === selected.id ? ' btn--accent' : ''}`}
                    disabled={busy}
                    onClick={() =>
                      onEditPoints(editingRouteId === selected.id ? null : selected.id)
                    }
                  >
                    {editingRouteId === selected.id ? 'Done editing points' : 'Edit points'}
                  </button>
                  {editingRouteId === selected.id ? (
                    <p className="note">
                      Drag a point to move it. Click a hollow point between two others to add
                      one. Right-click (or Alt-click) a point to delete it.
                    </p>
                  ) : null}
                </>
              ) : null}

              {selected.source === 'drawn' ? (
                <NumberField
                  label="Corner rounding"
                  value={selected.smoothing}
                  min={0}
                  max={1}
                  step={0.1}
                  disabled={busy}
                  onChange={(v) => onSmoothing(selected.id, v)}
                  hint="Rounds the corners of a clicked line. Zero builds it exactly as drawn. Not the terrain smoothing under Topography."
                />
              ) : null}

              <button
                type="button"
                className="btn btn--wide"
                disabled={busy}
                onClick={() => onReverse(selected.id)}
              >
                Reverse direction
              </button>

              <div className="field">
                <label className="field__label" htmlFor="route-elev">
                  Elevation from
                </label>
                <select
                  id="route-elev"
                  className="select"
                  value={selected.style.elevationSource}
                  disabled={busy}
                  onChange={(e) =>
                    onUpdate(selected.id, {
                      elevationSource: e.target.value as Route['style']['elevationSource'],
                    })
                  }
                >
                  <option value="dem">Terrain (DEM)</option>
                  <option value="flat">Flat</option>
                </select>
                <p className="field__hint">
                  Draping on the DEM keeps the route welded to the printed terrain. Using the
                  GPX&apos;s own elevation is pending a decision (OPEN-QUESTIONS Q11).
                </p>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
