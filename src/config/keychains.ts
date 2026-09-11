/**
 * Keychain defaults and the peaks you can print without finding one first
 * (docs/02-feature-spec.md F13).
 *
 * The owner's ask was "by default some mountains should be present to just
 * select from dropdown and send to print", and that is the whole job of this
 * file: the shortest path from opening the app to a printable object, with no
 * map panning, no GPX and no settings.
 *
 * Every entry is a centre and a radius rather than a bbox, because a keychain
 * is round or square and a bbox is neither — a bbox would have to be squared up
 * again downstream, and at these sizes the aspect error is visible.
 */
import type { KeychainSettings } from '../geometry/types';

export interface KeychainPreset {
  id: string;
  label: string;
  /** Used for the export filename. */
  slug: string;
  lon: number;
  lat: number;
  /**
   * Half-width of the selection, metres.
   *
   * Tuned per peak rather than shared, because "how much ground makes this
   * mountain legible" is a fact about the mountain. Everest needs 9 km to read
   * as Everest and not as a lumpy plateau; the Matterhorn is a spike and 4 km
   * around it is mostly the spike.
   */
  radius_m: number;
  /** Metres of relief in frame, roughly — shown so the pick is informed. */
  note: string;
}

/**
 * Ordered by recognisability, not height.
 *
 * The list is for someone who wants a keychain of a mountain they have heard
 * of, so the fourteenth-highest peak in the world is worth less here than a
 * hill with a cable car on it.
 */
export const KEYCHAIN_PRESETS: KeychainPreset[] = [
  {
    id: 'everest',
    label: 'Mount Everest',
    slug: 'everest',
    lon: 86.925,
    lat: 27.9881,
    radius_m: 9000,
    note: 'The summit pyramid with the Khumbu icefall below it. ~3 500 m of relief.',
  },
  {
    id: 'k2',
    label: 'K2',
    slug: 'k2',
    lon: 76.5133,
    lat: 35.8808,
    radius_m: 8000,
    note: 'Steeper than Everest and it shows in the print. ~3 000 m of relief.',
  },
  {
    id: 'matterhorn',
    label: 'Matterhorn',
    slug: 'matterhorn',
    lon: 7.6586,
    lat: 45.9763,
    radius_m: 4500,
    note: 'A four-sided spike — the most keychain-shaped mountain there is.',
  },
  {
    id: 'mont-blanc',
    label: 'Mont Blanc',
    slug: 'mont-blanc',
    lon: 6.8652,
    lat: 45.8326,
    radius_m: 7000,
    note: 'A broad dome with the Chamonix valley cut in beside it.',
  },
  {
    id: 'fuji',
    label: 'Mount Fuji',
    slug: 'mount-fuji',
    lon: 138.7274,
    lat: 35.3606,
    radius_m: 8000,
    note: 'A near-perfect cone. Prints cleanly at almost any size.',
  },
  {
    id: 'kilimanjaro',
    label: 'Kilimanjaro',
    slug: 'kilimanjaro',
    lon: 37.3556,
    lat: -3.0674,
    radius_m: 11000,
    note: 'A huge shallow shield — needs the wider frame to read as a mountain.',
  },
  {
    id: 'denali',
    label: 'Denali',
    slug: 'denali',
    lon: -151.007,
    lat: 63.0692,
    radius_m: 10000,
    note: 'Enormous vertical rise from the glaciers around it.',
  },
  {
    id: 'nanga-parbat',
    label: 'Nanga Parbat',
    slug: 'nanga-parbat',
    lon: 74.5892,
    lat: 35.2375,
    radius_m: 8000,
    note: 'The Rupal face is the tallest mountain wall on earth.',
  },
  {
    id: 'rainier',
    label: 'Mount Rainier',
    slug: 'mount-rainier',
    lon: -121.7603,
    lat: 46.8523,
    radius_m: 7000,
    note: 'A glaciated cone standing alone above forest.',
  },
  {
    id: 'half-dome',
    label: 'Half Dome, Yosemite',
    slug: 'half-dome',
    lon: -119.5332,
    lat: 37.7459,
    radius_m: 3500,
    note: 'Not a peak but a cliff — the sheared face is the whole point.',
  },
  {
    id: 'grand-teton',
    label: 'Grand Teton',
    slug: 'grand-teton',
    lon: -110.8024,
    lat: 43.7411,
    radius_m: 5000,
    note: 'A jagged ridge rather than a single summit.',
  },
  {
    id: 'table-mountain',
    label: 'Table Mountain',
    slug: 'table-mountain',
    lon: 18.403,
    lat: -33.9575,
    radius_m: 5000,
    note: 'A flat top with a sharp edge — the opposite of a cone.',
  },
];

export function getKeychainPreset(id: string): KeychainPreset | undefined {
  return KEYCHAIN_PRESETS.find((p) => p.id === id);
}

/**
 * Off, but ready.
 *
 * The numbers are conventional rather than computed. 40 mm is the size a
 * plastic tag has to be to survive a pocket and small enough that nobody
 * minds carrying it; 3.5 mm passes a standard 25 mm split ring; 1.6 mm of wall
 * is four perimeters at a 0.4 mm nozzle, which is the least that holds when the
 * keys are dropped. The 0.8 mm edge radius is two perimeters — enough to feel
 * round under a thumb without eating the terrain at the rim.
 */
export const DEFAULT_KEYCHAIN: KeychainSettings = {
  enabled: false,
  shape: 'square',
  // An eighth of the width. On a 40 mm tag that is a 5 mm corner, which reads
  // as "rounded" rather than as "squircle".
  cornerRadius_frac: 0.125,
  edgeRadius_mm: 0.8,
  hole: { enabled: true, diameter_mm: 3.5, margin_mm: 1.6 },
};

/**
 * What a keychain needs the rest of the config to be.
 *
 * Applied when keychain mode is switched on, and nowhere else — these are
 * starting points, not a lock. A 40 mm model with the display default of 30 mm
 * of relief would be a spike rather than a tag, and the default 3 mm base is
 * most of the thickness of the whole object.
 */
export const KEYCHAIN_MODEL_DEFAULTS = {
  modelWidth_mm: 40,
  baseThickness_mm: 1.6,
  maxHeight_mm: 7,
  verticalExaggeration: 1.5,
} as const;
