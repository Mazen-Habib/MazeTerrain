/**
 * Filament, cost and time estimate (docs/02-feature-spec.md F9).
 *
 * Sits with the printer settings rather than beside the export buttons: every
 * control here is a slicer setting, and reading the number next to the layer
 * height that drives it is how you learn which setting is costing you.
 *
 * Nothing in this panel marks the model dirty. Infill does not move a vertex,
 * so changing it must not ask for a rebuild.
 */
import { useMemo } from 'react';
import {
  defaultFilamentProfile,
  estimateFilament,
  formatDuration,
  type FilamentProfile,
  type PartMeasure,
} from '../export/estimate';
import { NumberField } from './NumberField';

/** The part of the profile the user sets here. The rest comes from the model config. */
export type FilamentSettings = Omit<FilamentProfile, 'layerHeight_mm' | 'nozzleDiameter_mm'>;

export function defaultFilamentSettings(): FilamentSettings {
  const { layerHeight_mm: _lh, nozzleDiameter_mm: _nd, ...rest } = defaultFilamentProfile(0.2, 0.4);
  return rest;
}

/** g/cm³ for the three filaments most people own. */
const MATERIALS: Array<{ id: string; label: string; density_g_cm3: number }> = [
  { id: 'pla', label: 'PLA', density_g_cm3: 1.24 },
  { id: 'petg', label: 'PETG', density_g_cm3: 1.27 },
  { id: 'abs', label: 'ABS', density_g_cm3: 1.04 },
];

interface EstimatePanelProps {
  /**
   * The printer whose stock slicer settings are in force, or null for the
   * generic fallback. Shown so the numbers are attributable — an estimate with
   * no stated assumptions is a number people either over-trust or ignore.
   */
  printerLabel: string | null;
  /** Per-part volume and area from the last build, or null before one. */
  measures: PartMeasure[] | null;
  settings: FilamentSettings;
  onChange: (patch: Partial<FilamentSettings>) => void;
  layerHeight_mm: number;
  nozzleDiameter_mm: number;
  /** True when settings changed since the build — the estimate describes the OLD mesh. */
  stale: boolean;
}

export function EstimatePanel({
  printerLabel,
  measures,
  settings,
  onChange,
  layerHeight_mm,
  nozzleDiameter_mm,
  stale,
}: EstimatePanelProps) {
  const estimate = useMemo(
    () =>
      measures ? estimateFilament(measures, { ...settings, layerHeight_mm, nozzleDiameter_mm }) : null,
    [measures, settings, layerHeight_mm, nozzleDiameter_mm],
  );

  if (!estimate) {
    return (
      <div className="field">
        <label className="field__label">Filament estimate</label>
        <p className="note">
          Generate a model and this will show what it costs in plastic, before you open a
          slicer.
        </p>
      </div>
    );
  }

  const material = MATERIALS.find((m) => m.density_g_cm3 === settings.density_g_cm3);

  return (
    <div className="field">
      <label className="field__label">Filament estimate</label>
      <p className="field__hint">
        {printerLabel
          ? `${printerLabel} stock profile — ${(settings.infill * 100).toFixed(0)}% infill, ${settings.wallLoops} walls, ${layerHeight_mm} mm layers.`
          : `Generic profile — ${(settings.infill * 100).toFixed(0)}% infill, ${settings.wallLoops} walls, ${layerHeight_mm} mm layers. Pick a printer above to use its defaults.`}
      </p>

      <dl className="estimate">
        <div className="estimate__row estimate__row--lead">
          <dt>Filament</dt>
          <dd>
            {estimate.mass_g.toFixed(0)} g
            <span className="estimate__sub">{estimate.length_m.toFixed(1)} m</span>
          </dd>
        </div>
        <div className="estimate__row">
          <dt>Cost</dt>
          <dd>{estimate.cost.toFixed(2)}</dd>
        </div>
        <div className="estimate__row">
          <dt>Print time</dt>
          <dd>
            {formatDuration(estimate.hours)}
            <span className="estimate__sub">rough</span>
          </dd>
        </div>
        <div className="estimate__row">
          <dt>Solid volume</dt>
          <dd>
            {(estimate.volume_mm3 / 1000).toFixed(1)} cm³
            <span className="estimate__sub">{(estimate.fill * 100).toFixed(0)}% filled</span>
          </dd>
        </div>
      </dl>

      {stale ? (
        <p className="field__hint">
          Settings changed since this model was built — the estimate describes the model on
          screen, not the one you would get now.
        </p>
      ) : null}

      <p className="field__hint">
        Arithmetic over the mesh, not a slicer run. Filament is the firm number and reads a
        little low, because supports and a brim are not counted. Treat the time as a rough
        guide only.
      </p>

      <NumberField
        label="Infill"
        unit="%"
        value={Math.round(settings.infill * 100)}
        min={0}
        max={100}
        step={5}
        onChange={(v) => onChange({ infill: v / 100 })}
        hint="The setting that moves the number most. A terrain model is mostly interior."
      />
      <NumberField
        label="Walls"
        unit="loops"
        value={settings.wallLoops}
        min={1}
        max={6}
        step={1}
        onChange={(v) => onChange({ wallLoops: Math.round(v) })}
      />
      <NumberField
        label="Solid layers"
        value={settings.solidLayers}
        min={1}
        max={12}
        step={1}
        onChange={(v) => onChange({ solidLayers: Math.round(v) })}
        hint="Top and bottom each. Terrain is nearly all up-facing surface, so this costs more here than on a typical print."
      />

      <div className="field">
        <label className="field__label" htmlFor="material">
          Material
        </label>
        <select
          id="material"
          className="select"
          value={material?.id ?? 'pla'}
          onChange={(e) => {
            const next = MATERIALS.find((m) => m.id === e.target.value);
            if (next) onChange({ density_g_cm3: next.density_g_cm3 });
          }}
        >
          {MATERIALS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.density_g_cm3.toFixed(2)} g/cm³
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="price-per-kg">
          Price per kg
        </label>
        {/*
          A plain box, not a slider. A price has no sensible ceiling — the same
          spool is 20 in one currency and 5000 in another — and this shipped
          with a slider capped at 500, which simply refused the real number.
        */}
        <input
          id="price-per-kg"
          type="number"
          className="field__number field__number--wide"
          min={0}
          step="any"
          value={settings.pricePerKg}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 0) onChange({ pricePerKg: v });
          }}
        />
        <p className="field__hint">
          In whatever currency you buy filament in — the cost above comes back in the same
          one. No currency is assumed and there is no upper limit.
        </p>
      </div>
      <NumberField
        label="Print speed"
        unit="mm/s"
        value={settings.speed_mm_s}
        min={10}
        max={500}
        step={5}
        onChange={(v) => onChange({ speed_mm_s: v })}
        hint="Only affects the time estimate."
      />
    </div>
  );
}
