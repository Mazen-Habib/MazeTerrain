/**
 * Layers tab (docs/07-ui-spec.md, Tab 3).
 *
 * One row per layer, expandable, with the toggle and colour swatch inline on the
 * collapsed row — the pattern Map2Model and TerraPrinter both converged on.
 */
import { useState } from 'react';
import { LAYERS, defaultWidth_m, type LayerId } from '../data/osm/tags';
import { formatGroundLength, type DistanceUnit } from '../config/units';
import { estimatedWidths_mm, resolveMinWidth_mm, type LayerSettings } from '../geometry/features';
import type { LayerBuildSummary } from '../geometry/types';
import type { PreviewSummary } from '../map/featurePreview';
import { NumberField } from './NumberField';

interface LayersPanelProps {
  layers: Record<string, LayerSettings>;
  busy: boolean;
  /** Drives the "auto" min-width hint, so the panel shows the number in force. */
  nozzleDiameter_mm: number;
  /** Print millimetres per real-world metre, for the class width sliders. */
  scale_mm_per_m: number;
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
  /** Display units for the real-world width readout (Q14). */
  unit: DistanceUnit;
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
const NOT_YET_BUILT = new Set<LayerId>([]);

export function LayersPanel({
  layers,
  busy,
  nozzleDiameter_mm,
  scale_mm_per_m,
  summaries,
  preview,
  previewBusy,
  previewError,
  previewStale,
  onPreview,
  onChange,
  unit,
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
            {preview.included === preview.drawn
              ? `All ${preview.drawn.toLocaleString()} lines will be built.`
              : `${preview.included.toLocaleString()} of ${preview.drawn.toLocaleString()} lines ` +
                `will be built. Dashed lines are being dropped.`}
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
          const live = preview?.coverageByLayer[definition.id] !== undefined;
          const dropped = (live ? preview?.droppedByLayer[definition.id] : built?.dropped) ?? [];
          const crowded = (live ? preview?.crowdedByLayer[definition.id] : built?.crowded) ?? [];
          const suggested =
            (live ? preview?.suggestedMinWidth_mm[definition.id] : built?.suggestedMinWidth_mm) ??
            0;
          const coverage = (live ? preview?.coverageByLayer[definition.id] : built?.coverage) ?? 0;
          const droppedSet = new Set(dropped);
          const crowdedSet = new Set(crowded);

          const floor_mm = resolveMinWidth_mm(settings.minWidth_mm, nozzleDiameter_mm);
          // Real widths once a preview exists; otherwise the same ladder run
          // over the tag tables, so a slider always has a number to show.
          const measured = preview?.widthByLayer[definition.id];
          const estimated = estimatedWidths_mm(
            settings.subtypes,
            (subtype) => defaultWidth_m(definition.id, subtype),
            settings,
            floor_mm,
            scale_mm_per_m,
          );
          const widthOf = (subtype: string) =>
            settings.subtypeWidth_mm[subtype] ??
            measured?.[subtype] ??
            estimated.get(subtype) ??
            floor_mm;

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
                    {...(definition.id === 'buildings'
                      ? {
                          hint:
                            'A minimum. Real building heights rise past it; at city scale ' +
                            'most are far below it and would otherwise be invisible.',
                        }
                      : {})}
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
                    hint="Scales every class still on automatic. A class with a hand-set width below keeps that width."
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
                      Auto (one nozzle, thinner if the layer would crowd)
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
                    Drop classes that will not fit
                  </label>
                  <p className="field__hint">
                    Off by default — everything you tick gets built, and crowded classes are
                    only flagged. Turn this on to have them removed instead, in importance order,
                    once they would cover a quarter of the model.
                  </p>

                  <fieldset className="subtypes">
                    <legend className="field__label">
                      Include<span className="field__unit">width, mm</span>
                    </legend>
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
                      <button
                        className="btn btn--link"
                        disabled={busy || Object.keys(settings.subtypeWidth_mm).length === 0}
                        onClick={() => onChange(definition.id, { subtypeWidth_mm: {} })}
                      >
                        Reset widths
                      </button>
                    </div>
                    {definition.subtypes.map((subtype) => {
                      const ticked = settings.subtypes.includes(subtype);
                      // Ticked but cut from the model: only happens when the
                      // user asked the filter to enforce. Without this the
                      // panel claims streets the model does not have.
                      const cut = ticked && droppedSet.has(subtype);
                      // Built, but it will merge into a solid area at this size.
                      const dense = ticked && !cut && crowdedSet.has(subtype);
                      const width_mm = widthOf(subtype);
                      const overridden = settings.subtypeWidth_mm[subtype] !== undefined;
                      const real_m = scale_mm_per_m > 0 ? width_mm / scale_mm_per_m : 0;

                      const setWidth = (value: number | null) => {
                        const next = { ...settings.subtypeWidth_mm };
                        if (value === null) delete next[subtype];
                        else next[subtype] = value;
                        onChange(definition.id, { subtypeWidth_mm: next });
                      };

                      return (
                        <div key={subtype} className="subtype">
                          <label
                            className={`checkbox${cut ? ' checkbox--cut' : ''}`}
                            title={
                              cut
                                ? 'Not built — "Drop classes that will not fit" is on and this ' +
                                  'class is past the budget.'
                                : dense
                                  ? 'Will be built, but at this size these streets merge into ' +
                                    'solid areas. Make them narrower to keep them separate.'
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
                            {dense ? <span className="subtypes__dense">will merge</span> : null}
                          </label>

                          {ticked ? (
                            <div className="subtype__width">
                              <input
                                type="range"
                                className="subtype__slider"
                                aria-label={`${subtype} width`}
                                min={0.05}
                                max={3}
                                step={0.01}
                                value={width_mm}
                                disabled={busy}
                                onChange={(e) => setWidth(Number(e.target.value))}
                              />
                              <input
                                type="number"
                                className="subtype__value"
                                aria-label={`${subtype} width in millimetres`}
                                min={0.01}
                                max={20}
                                step={0.01}
                                value={Number(width_mm.toFixed(2))}
                                disabled={busy}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  if (Number.isFinite(v) && v > 0) setWidth(v);
                                }}
                              />
                              <span className="subtype__real" title="Real-world width at this scale">
                                {formatGroundLength(real_m, unit)}
                              </span>
                              <button
                                className="btn btn--link subtype__reset"
                                disabled={busy || !overridden}
                                title={
                                  overridden
                                    ? 'Back to the automatic width for this class'
                                    : 'Already automatic'
                                }
                                onClick={() => setWidth(null)}
                              >
                                {overridden ? 'auto' : '·'}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </fieldset>

                  {crowded.length > 0 && suggested > 0 ? (
                    <p className="field__hint field__hint--action">
                      {dropped.length > 0
                        ? `${dropped.length} class(es) are being left out.`
                        : `These lines cover ${(coverage * 100).toFixed(0)}% of the model, so ` +
                          `${crowded.length} class(es) will merge into solid areas. They are ` +
                          `still built.`}{' '}
                      <button
                        className="btn btn--link"
                        disabled={busy}
                        onClick={() => onChange(definition.id, { minWidth_mm: suggested })}
                      >
                        Set Min width to {suggested.toFixed(2)} mm
                      </button>{' '}
                      to keep them separate — the same streets, drawn thinner.
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
