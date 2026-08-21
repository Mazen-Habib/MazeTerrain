/**
 * Layers tab (docs/07-ui-spec.md, Tab 3).
 *
 * One row per layer, expandable, with the toggle and colour swatch inline on the
 * collapsed row — the pattern Map2Model and TerraPrinter both converged on.
 */
import { useState } from 'react';
import { LAYERS, type LayerId } from '../data/osm/tags';
import type { LayerSettings } from '../geometry/features';
import { NumberField } from './NumberField';

interface LayersPanelProps {
  layers: Record<string, LayerSettings>;
  busy: boolean;
  /** Drives the "auto" min-width hint, so the panel shows the number in force. */
  nozzleDiameter_mm: number;
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

export function LayersPanel({ layers, busy, nozzleDiameter_mm, onChange }: LayersPanelProps) {
  const [expanded, setExpanded] = useState<LayerId | null>(null);

  return (
    <section>
      <h2>Layers</h2>
      <p className="note">
        Map features come from OpenStreetMap and are fetched on Generate, never on pan.
      </p>

      <ul className="layers">
        {LAYERS.map((definition) => {
          const settings = layers[definition.id];
          if (!settings) return null;
          const pending = NOT_YET_BUILT.has(definition.id);
          const open = expanded === definition.id;

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
                    {definition.subtypes.map((subtype) => (
                      <label key={subtype} className="checkbox">
                        <input
                          type="checkbox"
                          checked={settings.subtypes.includes(subtype)}
                          disabled={busy}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...settings.subtypes, subtype]
                              : settings.subtypes.filter((s) => s !== subtype);
                            onChange(definition.id, { subtypes: next });
                          }}
                        />
                        {subtype}
                      </label>
                    ))}
                  </fieldset>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
