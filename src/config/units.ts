/**
 * Display units (OPEN-QUESTIONS Q14 — resolved "split", 2026-09-01).
 *
 * **Print dimensions are always millimetres. That is not a preference.**
 * Every printer and every slicer in this space speaks mm, a base thickness of
 * 0.118 inches is nobody's idea of a setting, and `worldToPrint()` is the one
 * conversion this codebase is allowed to have. Nothing in here touches it.
 *
 * What this module converts is the other half: how far the route ran, how high
 * the ground is, how much land the selection covers. Those are read by a person
 * who has a feel for the number, and "42.2 km" means nothing to a reader who
 * has spent their life running 26.2 miles.
 *
 * Two further limits, deliberate:
 *
 * **Readouts convert; inputs do not.** Contour interval and DEM resolution stay
 * metric sliders. Converting an input means changing its domain, its step and
 * its stored meaning, and re-parsing it on the way back — that is the cost of
 * the global-toggle option we did not take. If it turns out US users really do
 * want 40 ft contour intervals, that is a separate, deliberate change.
 *
 * **Filament length stays metric.** It is print-side, sold by the metre
 * everywhere, and belongs with the millimetres rather than with the miles.
 */

export type DistanceUnit = 'metric' | 'imperial';

/** Exact, both of them. Not approximations worth rounding. */
const METRES_PER_MILE = 1609.344;
const METRES_PER_FOOT = 0.3048;
const KM2_PER_SQ_MILE = 2.589988110336;

const STORAGE_KEY = 'mazeterrain.units';

/**
 * What to show someone who has never touched the toggle.
 *
 * Narrow on purpose: the US, and nowhere else. The UK is the tempting second
 * case — road signs and race distances are in miles — but the same person reads
 * hill heights in metres, so a single flag gets one of the two wrong either way.
 * Guessing badly is worse than defaulting to metric with a visible switch.
 */
export function defaultUnit(): DistanceUnit {
  try {
    const locales = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const tag of locales) {
      if (!tag) continue;
      const region = new Intl.Locale(tag).maximize().region;
      if (region === 'US') return 'imperial';
      // The first locale that resolves a region decides. Looking further down
      // the list finds the browser's fallbacks, not the user's preference.
      if (region) return 'metric';
    }
  } catch {
    // `Intl.Locale` is missing, or a malformed tag. Neither is a reason to
    // fail to render a number.
  }
  return 'metric';
}

export function readUnit(): DistanceUnit {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'metric' || stored === 'imperial') return stored;
  } catch {
    // Storage disabled or full. The default is still a correct answer.
  }
  return defaultUnit();
}

export function writeUnit(unit: DistanceUnit): void {
  try {
    localStorage.setItem(STORAGE_KEY, unit);
  } catch {
    // The choice still holds for this session; nothing depends on it lasting.
  }
}

/** Route length and other long ground distances: km or miles. */
export function formatDistance(metres: number, unit: DistanceUnit): string {
  if (!Number.isFinite(metres)) return '—';
  if (unit === 'imperial') return `${(metres / METRES_PER_MILE).toFixed(1)} mi`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Elevations and elevation gain: metres or feet, always whole. */
export function formatElevation(metres: number, unit: DistanceUnit): string {
  if (!Number.isFinite(metres)) return '—';
  if (unit === 'imperial') return `${Math.round(metres / METRES_PER_FOOT)} ft`;
  return `${Math.round(metres)} m`;
}

/**
 * A pair of elevations sharing one unit label, e.g. `210 – 1 840 m`.
 *
 * Repeating the unit on both ends of a range reads as two separate figures.
 */
export function formatElevationRange(
  low_m: number,
  high_m: number,
  unit: DistanceUnit,
  separator = ' – ',
): string {
  if (!Number.isFinite(low_m) || !Number.isFinite(high_m)) return '—';
  const to = (v: number) =>
    unit === 'imperial' ? Math.round(v / METRES_PER_FOOT) : Math.round(v);
  return `${to(low_m)}${separator}${to(high_m)} ${unit === 'imperial' ? 'ft' : 'm'}`;
}

/**
 * Short ground lengths — how wide a road really is, how fine the DEM grid is.
 *
 * Kept to one decimal below ten, because "3 m" and "3.4 m" are different
 * answers to "will this print", and the whole point of the readout is that
 * check.
 */
export function formatGroundLength(metres: number, unit: DistanceUnit): string {
  if (!Number.isFinite(metres)) return '—';
  const value = unit === 'imperial' ? metres / METRES_PER_FOOT : metres;
  const label = unit === 'imperial' ? 'ft' : 'm';
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${label}`;
}

/** Selection area: km² or square miles. */
export function formatArea(km2: number, unit: DistanceUnit, decimals = 1): string {
  if (!Number.isFinite(km2)) return '—';
  if (unit === 'imperial') return `${(km2 / KM2_PER_SQ_MILE).toFixed(decimals)} sq mi`;
  return `${km2.toFixed(decimals)} km²`;
}

/** A model's ground footprint, `12.4 × 8.1 km`. */
export function formatExtent(x_km: number, y_km: number, unit: DistanceUnit): string {
  if (!Number.isFinite(x_km) || !Number.isFinite(y_km)) return '—';
  const to = (v: number) => (unit === 'imperial' ? (v * 1000) / METRES_PER_MILE : v);
  return `${to(x_km).toFixed(1)} × ${to(y_km).toFixed(1)} ${unit === 'imperial' ? 'mi' : 'km'}`;
}

/** For the toggle itself. */
export const UNIT_LABEL: Record<DistanceUnit, string> = {
  metric: 'km / m',
  imperial: 'mi / ft',
};
