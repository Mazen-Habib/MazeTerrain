/**
 * Keychain mode (docs/02-feature-spec.md F13).
 *
 * The shortest path in the app: pick a mountain, press Generate. That is the
 * whole reason the preset list exists — a keychain is a gift-shop object, and
 * somebody who wants one of Everest should not have to learn what a selection
 * shape is first.
 *
 * Switching the mode ON rewrites four model settings, which is unusual and
 * deliberate. The display defaults (100 mm wide, 3 mm base, 30 mm of relief)
 * make a keychain that is a spike on a slab: at 40 mm the base alone would be
 * most of the object's thickness. Those four are announced in the panel rather
 * than done silently, and every one of them stays editable afterwards — this
 * sets a starting point, it does not take the controls away.
 */
import { KEYCHAIN_PRESETS, KEYCHAIN_MODEL_DEFAULTS } from '../config/keychains';
import { NumberField } from './NumberField';
import type { KeychainSettings } from '../geometry/types';

interface KeychainPanelProps {
  keychain: KeychainSettings;
  modelWidth_mm: number;
  baseThickness_mm: number;
  maxHeight_mm: number;
  verticalExaggeration: number;
  /** What the build could actually give, after the max-height clamp. */
  effectiveExaggeration: number | null;
  includeRoutes: boolean;
  hasRoutes: boolean;
  busy: boolean;
  onChange: (patch: Partial<KeychainSettings>) => void;
  /** Switch outline, reshaping the selection to match. */
  onOutline: (outline: KeychainSettings['shape']) => void;
  onModelWidth: (mm: number) => void;
  onBaseThickness: (mm: number) => void;
  onMaxHeight: (mm: number) => void;
  onExaggeration: (x: number) => void;
  onIncludeRoutes: (on: boolean) => void;
  /** Enable the mode, applying the model defaults above. */
  onEnable: (on: boolean) => void;
  onPickPeak: (id: string) => void;
}

export function KeychainPanel({
  keychain,
  modelWidth_mm,
  baseThickness_mm,
  maxHeight_mm,
  verticalExaggeration,
  effectiveExaggeration,
  includeRoutes,
  hasRoutes,
  busy,
  onChange,
  onOutline,
  onModelWidth,
  onBaseThickness,
  onMaxHeight,
  onExaggeration,
  onIncludeRoutes,
  onEnable,
  onPickPeak,
}: KeychainPanelProps) {
  const off = !keychain.enabled;

  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={keychain.enabled}
          disabled={busy}
          onChange={(e) => onEnable(e.target.checked)}
        />
        Keychain mode
      </label>
      <p className="note">
        Rounds every edge so it does not catch in a pocket, and drills a hole for the ring.
        Turning this on sets the model to {KEYCHAIN_MODEL_DEFAULTS.modelWidth_mm} mm wide with a{' '}
        {KEYCHAIN_MODEL_DEFAULTS.baseThickness_mm} mm base, and switches the map layers off —
        roads do not survive being shrunk to this size. All still editable.
      </p>

      {off ? null : (
        <>
          <label className="field__label" htmlFor="keychain-peak">
            Ready-made peaks
          </label>
          <select
            id="keychain-peak"
            className="select"
            disabled={busy}
            value=""
            onChange={(e) => onPickPeak(e.target.value)}
          >
            <option value="" disabled>
              Pick a mountain…
            </option>
            {KEYCHAIN_PRESETS.map((p) => (
              <option key={p.id} value={p.id} title={p.note}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="note">
            Sets the area and the outline in one go. Or draw your own selection on the map —
            keychain mode works on anything.
          </p>

          <label className="field__label" htmlFor="keychain-shape">
            Outline
          </label>
          <div className="segmented" role="group" aria-label="Keychain outline" id="keychain-shape">
            <button
              type="button"
              className={`segmented__btn${keychain.shape === 'square' ? ' segmented__btn--on' : ''}`}
              disabled={busy}
              aria-pressed={keychain.shape === 'square'}
              onClick={() => onOutline('square')}
            >
              Square
            </button>
            <button
              type="button"
              className={`segmented__btn${keychain.shape === 'circle' ? ' segmented__btn--on' : ''}`}
              disabled={busy}
              aria-pressed={keychain.shape === 'circle'}
              onClick={() => onOutline('circle')}
            >
              Circle
            </button>
          </div>
          <p className="note">
            Follows your selection — draw a circle and you get a round tag. Picking the other one
            reshapes the selection to match.
          </p>

          <NumberField
            label="Size"
            unit="mm"
            value={modelWidth_mm}
            min={15}
            max={90}
            step={1}
            disabled={busy}
            hint="Across the widest part. 35-45 mm is the usual size for a tag."
            onChange={onModelWidth}
          />

          {keychain.shape === 'square' ? (
            <NumberField
              label="Corner rounding"
              unit="% of width"
              value={Math.round(keychain.cornerRadius_frac * 100)}
              min={0}
              max={40}
              step={1}
              disabled={busy}
              hint={`${(keychain.cornerRadius_frac * modelWidth_mm).toFixed(1)} mm at this size. A sharp corner is the part that catches.`}
              onChange={(pct) => onChange({ cornerRadius_frac: pct / 100 })}
            />
          ) : null}

          {/*
           * Relief, here rather than only under Terrain and Model.
           *
           * On a keychain these are not secondary settings — they ARE the
           * object. Total thickness is base plus relief, and a 40 mm tag that
           * is 3 mm thick and one that is 12 mm thick are different products.
           * Sending someone to two other groups to find that out, in the one
           * mode built around "pick a mountain and press Generate", is the
           * wrong trade even though it means these controls appear twice.
           */}
          <h2>Relief</h2>

          <NumberField
            label="Tallest point above the base"
            unit="mm"
            value={maxHeight_mm}
            min={1}
            max={20}
            step={0.5}
            disabled={busy}
            hint={`Total thickness will be about ${(maxHeight_mm + baseThickness_mm).toFixed(1)} mm including the base.`}
            onChange={onMaxHeight}
          />

          <NumberField
            label="Vertical exaggeration"
            unit="×"
            value={verticalExaggeration}
            min={0.5}
            max={4}
            step={0.1}
            disabled={busy}
            hint={
              effectiveExaggeration !== null &&
              Math.abs(effectiveExaggeration - verticalExaggeration) > 0.05
                ? `Built at ${effectiveExaggeration.toFixed(2)}× — the height above caps it. Raise that to get the full ${verticalExaggeration.toFixed(1)}×.`
                : 'Above 1× the relief is taller than life. Small models usually need it.'
            }
            onChange={onExaggeration}
          />

          <NumberField
            label="Base"
            unit="mm"
            value={baseThickness_mm}
            min={0.8}
            max={6}
            step={0.1}
            disabled={busy}
            hint="Solid material under the lowest ground. Thin saves plastic; thick survives being sat on."
            onChange={onBaseThickness}
          />

          <h2>Edges &amp; hole</h2>

          <NumberField
            label="Edge rounding"
            unit="mm"
            value={keychain.edgeRadius_mm}
            min={0}
            max={3}
            step={0.1}
            disabled={busy}
            hint="Fillet on the base rim and the top edge. 0 leaves them square."
            onChange={(mm) => onChange({ edgeRadius_mm: mm })}
          />

          <label className="checkbox">
            <input
              type="checkbox"
              checked={keychain.hole.enabled}
              disabled={busy}
              onChange={(e) => onChange({ hole: { ...keychain.hole, enabled: e.target.checked } })}
            />
            Hole for the ring
          </label>

          {keychain.hole.enabled ? (
            <>
              <NumberField
                label="Hole"
                unit="mm"
                value={keychain.hole.diameter_mm}
                min={2}
                max={8}
                step={0.1}
                disabled={busy}
                hint="3 mm or more passes a standard split ring."
                onChange={(mm) => onChange({ hole: { ...keychain.hole, diameter_mm: mm } })}
              />
              <NumberField
                label="Wall around it"
                unit="mm"
                value={keychain.hole.margin_mm}
                min={0.8}
                max={5}
                step={0.1}
                disabled={busy}
                hint="Material between the hole and the edge. This is where a keychain tears — 1.6 mm is four perimeters."
                onChange={(mm) => onChange({ hole: { ...keychain.hole, margin_mm: mm } })}
              />
            </>
          ) : null}
        </>
      )}

      <label className="checkbox">
        <input
          type="checkbox"
          checked={includeRoutes}
          disabled={busy}
          onChange={(e) => onIncludeRoutes(e.target.checked)}
        />
        Build routes into the model
      </label>
      <p className="note">
        {hasRoutes
          ? includeRoutes
            ? 'Your routes are part of the model.'
            : 'Terrain only — the routes stay on the map and out of the print.'
          : 'No routes loaded, so this changes nothing yet.'}
      </p>
    </>
  );
}
