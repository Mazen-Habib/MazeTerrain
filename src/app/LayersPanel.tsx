/**
 * Layers tab (docs/07-ui-spec.md, Tab 3).
 *
 * One row per layer, expandable, with the toggle and colour swatch inline on the
 * collapsed row — the pattern Map2Model and TerraPrinter both converged on.
 */
import { useState } from 'react';
import { LAYERS, type LayerId } from '../data/osm/tags';
import type { LayerSettings } from '../geometry/features';
import type { LayerBuildSummary } from '../geometry/types';
import type { PreviewSummary } from '../map/featurePreview';
import { NumberField } from './NumberField';

interface LayersPanelProps {
  layers: Record<string, LayerSettings>;
  busy: boolean;
  /** Drives the "auto" min-width hint, so the panel shows the number in force. */
  nozzleDiameter_mm: number;
  /** What the last build actually did, so ticked-but-absent classes are visible. */
  summaries: LayerBuildSummary[];
  /** What the on-map preview currently shows, or null when none is loaded. */
  preview: PreviewSummary | null;
  previewBusy: boolean;
  previewError: string | null;
  /** True when the selection moved after the preview was fetched. */
  previewStale: boolean;
  onPreview: () => void;
  onChange: (id: LayerId, patch: Partial<LayerSettings>) => void;
}

const GLYPH: Record<LayerId, string> = {
  roads: '🛣',
  trails: '🥾',
  railways: '🚂',
  water: '💧',
  buildings: '🏢',
  greenery: '🌿',
  sand: '🏖',
  aeroways: '✈',
  piers: '⚓',
  skiruns: '⛷',
};

/** Layers whose geometry is not built yet, so the toggle cannot mislead. */
const NOT_YET_BUILT = new Set<LayerId>(['water', 'buildings', 'greenery', 'sand']);

export function LayersPanel({
  layers,
  busy,
  nozzleDiameter_mm,
  summaries,
  preview,
  previewBusy,
  previewError,
  previewStale,
  onPreview,
  onChange,
}: LayersPanelProps) {
  const [expanded, setExpanded] = useState<LayerId | null>(null);

  return (
    <section>
      <h2>Layers</h2>
      <p className="note">
        Map features come from OpenStreetMap and are fetched on Generate, never on pan.
      </p>

      <div className="preview">
        <button className="btn btn--wide" onClick={onPreview} disabled={previewBusy}>
          {previewBusy ? 'Loading features…' : 'Show on map'}
        </button>
        {previewError ? (
          <p className="field__hint field__hint--bad">{previewError}</p>
        ) : previewStale ? (
          <p className="field__hint">
            The selection moved. Press “Show on map” again for the new area.
          </p>
        ) : preview ? (
          <p className="field__hint">
            {preview.included.toLocaleString()} of {preview.drawn.toLocaleString()} lines will be
            built. Dashed lines are in your Include list but will be cut at this size — they are
            not in the model.
          </p>
        ) : (
          <p className="field__hint">
            Draws the exact features this model will contain, so you can check before generating.
          </p>
        )}
      </div>

      <ul className="layers">
        {LAYERS.map((definition) => {
          const settings = layers[definition.id];
          if (!settings) return null;
          const pending = NOT_YET_BUILT.has(definition.id);
          const open = expanded === definition.id;
          const built = summaries.find((x) => x.layer === definition.id);
          // Prefer the live preview: it reflects the settings as they stand,
          // where the build summary reflects whatever was last generated.
          const previewDropped = preview?.droppedByLayer[definition.id];
          const dropped = previewDropped ?? built?.dropped ?? [];
          const suggested =
            (previewDropped ? preview?.suggestedMinWidth_mm[definition.id] : undefined) ??
            built?.suggestedMinWidth_mm ??
            0;
          const droppedSet = new Set(dropped);

          return (
            <li key={definition.id} className={`layer${open ? ' layer--open' : ''}`}>
              <div className="layer__row">
                <button
                  className="layer__disclosure"
                  aria-expanded={open}
                  disabled={pending}
                  onClick={() => setExpanded(open ? null : definition.id)}
                >
                  <span aria-hidden>{open ? '▾' : '▸'}</span>
                  <span aria-hidden>{GLYPH[definition.id]}</span> {definition.label}
                </button>

                {pending ? (
                  <span className="badge" title="Polygon layers arrive with the next slice">
                    soon
                  </span>
                ) : (
                  <>
                    <input
                      type="color"
                      className="layer__swatch"
                      aria-label={`${definition.label} colour`}
                      value={settings.color}
                      disabled={busy}
                      onChange={(e) => onChange(definition.id, { color: e.target.value })}
                    />
                    <label className="layer__toggle">
                      <input
                        type="checkbox"
                        checked={settings.enabled}
                        disabled={busy}
                        onChange={(e) => onChange(definition.id, { enabled: e.target.checked })}
                      />
                      <span className="visually-hidden">Enable {definition.label}</span>
                    </label>
                  </>
                )}
              </div>

              {open && !pending ? (
                <div className="layer__body">
                  <NumberField
                    label="Height"
                    unit="mm"
                    value={settings.height_mm}
                    min={0.1}
                    max={5}
                    step={0.1}
                    disabled={busy}
                    onChange={(v) => onChange(definition.id, { height_mm: v })}
                  />
                  <NumberField
                    label="Width scale"
                    unit="×"
                    value={settings.widthScale}
                    min={0.1}
                    max={5}
                    step={0.1}
                    disabled={busy}
                    onChange={(v) => onChange(definition.id, { widthScale: v })}
                    hint="Real-world widths come from the road class, not the sparse width tag."
                  />

                  <div className="field">
                    <label className="field__label">
                      Min width<span className="field__unit">mm</span>
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={settings.minWidth_mm === 'auto'}
                        disabled={busy}
                        onChange={(e) =>
                          onChange(definition.id, {
                            minWidth_mm: e.target.checked ? 'auto' : nozzleDiameter_mm,
                          })
                        }
                      />
                      Auto ({nozzleDiameter_mm.toFixed(2)} mm, one nozzle)
                    </label>
                  </div>
                  {settings.minWidth_mm === 'auto' ? null : (
                    <NumberField
                      label="Narrowest line"
                      unit="mm"
                      value={settings.minWidth_mm}
                      min={0.05}
                      max={3}
                      step={0.05}
                      disabled={busy}
                      onChange={(v) => onChange(definition.id, { minWidth_mm: v })}
                      hint={
                        settings.minWidth_mm < nozzleDiameter_mm
                          ? `Below your ${nozzleDiameter_mm} mm nozzle. Finer detail, but an FDM ` +
                            `slicer will drop these lines — fine for resin or for a render.`
                          : 'The narrowest class prints at this width; wider classes scale up from it.'
                      }
                    />
                  )}

                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.legibilityFilter}
                      disabled={busy}
                      onChange={(e) =>
                        onChange(definition.id, { legibilityFilter: e.target.checked })
                      }
                    />
                    Only classes the model can carry
                  </label>
                  <p className="field__hint">
                    On by default. Takes classes in importance order until roads would cover a
                    quarter of the model, which is where a street grid stops reading as a map.
                  </p>

                  <fieldset className="subtypes">
                    <legend className="field__label">Include</legend>
                    <div className="subtypes__bulk">
                      <button
                        className="btn btn--link"
                        disabled={busy}
                        onClick={() =>
                          onChange(definition.id, { subtypes: [...definition.subtypes] })
                        }
                      >
                        All
                      </button>
                      <button
                        className="btn btn--link"
                        disabled={busy}
                        onClick={() => onChange(definition.id, { subtypes: [] })}
                      >
                        None
                      </button>
                    </div>
                    {definition.subtypes.map((subtype) => {
                      const ticked = settings.subtypes.includes(subtype);
                      // Ticked but absent from the last build: the legibility
                      // filter cut it. Without this the panel claims the model
                      // has streets it does not have.
                      const cut = ticked && droppedSet.has(subtype);
                      return (
                        <label
                          key={subtype}
                          className={`checkbox${cut ? ' checkbox--cut' : ''}`}
                          title={
                            cut
                              ? 'Will not be built — the model cannot carry this class at ' +
                                'this size. Lower Min width to fit it in.'
                              : undefined
                          }
                        >
                          <input
                            type="checkbox"
                            checked={ticked}
                            disabled={busy}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...settings.subtypes, subtype]
                                : settings.subtypes.filter((s) => s !== subtype);
                              onChange(definition.id, { subtypes: next });
                            }}
                          />
                          {subtype}
                          {cut ? <span className="subtypes__cut">not built</span> : null}
                        </label>
                      );
                    })}
                  </fieldset>

                  {dropped.length > 0 && suggested > 0 ? (
                    <p className="field__hint field__hint--action">
                      {dropped.length} class(es) will not be built at this size.{' '}
                      <button
                        className="btn btn--link"
                        disabled={busy}
                        onClick={() => onChange(definition.id, { minWidth_mm: suggested })}
                      >
                        Set Min width to {suggested.toFixed(2)} mm
                      </button>{' '}
                      to keep them all — the same streets, drawn thinner.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
