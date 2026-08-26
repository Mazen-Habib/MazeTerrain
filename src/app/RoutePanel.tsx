/**
 * Route tab (docs/07-ui-spec.md, Tab 2).
 *
 * "The route list is the emotional centre of the app. Show distance, elevation
 * gain and a tiny sparkline profile per route, not just point counts."
 */
import { useRef, useState } from 'react';
import type { ColorMode } from '../geometry/types';
import type { Route } from '../data/gpx/types';
import { NumberField } from './NumberField';

interface RoutePanelProps {
  routes: Route[];
  busy: boolean;
  /**
   * The colour mode in force.
   *
   * A cut-out model has no raised route to give a height to — the route becomes
   * a channel, and how far the insert stands proud is a cutout setting. Showing
   * a live Height control there is a lie: it moves and nothing happens.
   */
  colorMode: ColorMode;
  onUpload: (files: FileList | null) => void;
  onUpdate: (id: string, patch: Partial<Route['style']>) => void;
  onRemove: (id: string) => void;
  onFit: () => void;
}

export function RoutePanel({
  routes,
  busy,
  colorMode,
  onUpload,
  onUpdate,
  onRemove,
  onFit,
}: RoutePanelProps) {
  const cutout = colorMode === 'single-cutout';
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
          Upload GPX file(s)
        </button>
        <p className="field__hint">or drag them here</p>
        <input
          ref={input}
          type="file"
          accept=".gpx,application/gpx+xml"
          multiple
          hidden
          onChange={(e) => {
            onUpload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {routes.length === 0 ? (
        <p className="note">
          No routes yet. Phase 0&apos;s terrain-only presets still work without one.
        </p>
      ) : (
        <>
          <ul className="routes">
            {routes.map((route) => (
              <li
                key={route.id}
                className={`route${selected?.id === route.id ? ' route--selected' : ''}`}
                onClick={() => setSelectedId(route.id)}
              >
                <span
                  className="route__swatch"
                  style={{ background: route.style.color }}
                  aria-hidden
                />
                <span className="route__body">
                  <span className="route__name">{route.name}</span>
                  <span className="route__meta">
                    {(route.distance_m / 1000).toFixed(1)} km
                    {route.elevationGain_m !== null
                      ? ` · ${route.elevationGain_m.toFixed(0)} m gain`
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
              <NumberField
                label="Height"
                unit="mm"
                value={selected.style.height_mm}
                min={0.2}
                max={6}
                step={0.1}
                disabled={busy || cutout}
                onChange={(v) => onUpdate(selected.id, { height_mm: v })}
                {...(cutout
                  ? {
                      hint:
                        'Not used in cut-out mode: the route is a channel, not a ridge. ' +
                        'Use "Insert proud" under Colour mode for how far the insert stands.',
                    }
                  : {})}
              />

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
