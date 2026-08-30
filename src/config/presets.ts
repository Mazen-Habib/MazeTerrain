/**
 * Hardcoded selections for Phase 0.
 *
 * The roadmap's Phase 0 is deliberately not user-facing: a fixed bbox is enough
 * to prove the DEM -> watertight mesh path. The map-drawn selection replaces
 * these in Phase 1; the shape of GenerateConfig does not change when it does.
 */
import type { BBox, GenerateConfig } from '../geometry/types';
import { DEFAULT_DATASET } from '../data/dem/datasets';
import { LAYERS } from '../data/osm/tags';
import type { LayerSettings } from '../geometry/features';

export interface Preset {
  id: string;
  label: string;
  /** Used for the export filename until reverse geocoding lands. */
  slug: string;
  bbox: BBox;
  note: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'matterhorn',
    label: 'Matterhorn, Zermatt',
    slug: 'matterhorn',
    bbox: { west: 7.62, south: 45.94, east: 7.74, north: 46.02 },
    note: 'High alpine relief, ~2 700 m range. The stress case for vertical exaggeration clamping.',
  },
  {
    id: 'margalla',
    label: 'Margalla Hills, Islamabad',
    slug: 'islamabad-margalla',
    bbox: { west: 72.96, south: 33.68, east: 73.12, north: 33.78 },
    note: 'Moderate relief against a flat city plain. The worked example throughout the docs.',
  },
  {
    id: 'grand-canyon',
    label: 'Grand Canyon, South Rim',
    slug: 'grand-canyon',
    bbox: { west: -112.2, south: 36.03, east: -112.02, north: 36.14 },
    note: 'Inverted relief — the interesting geometry cuts down, not up.',
  },
  {
    id: 'fuji',
    label: 'Mount Fuji',
    slug: 'mount-fuji',
    bbox: { west: 138.66, south: 35.3, east: 138.83, north: 35.42 },
    note: 'A near-symmetric cone. Any mirroring bug is invisible here — use Margalla to check handedness.',
  },
  {
    id: 'tromso',
    label: 'Tromso, Norway (69 N)',
    slug: 'tromso',
    bbox: { west: 18.85, south: 69.6, east: 19.15, north: 69.72 },
    note: 'High latitude. A square selection here prints square only if the ENU projection is right.',
  },
  {
    id: 'flat-nl',
    label: 'Flevoland, Netherlands (near-flat)',
    slug: 'flevoland',
    bbox: { west: 5.4, south: 52.44, east: 5.6, north: 52.54 },
    note: 'Almost no relief. Exercises the low-contrast path and the exaggeration guidance.',
  },
];

/** Common bed sizes, so the setting is a pick rather than two numbers to type. */
export const BED_PRESETS: Array<{ id: string; label: string; size: [number, number] | null }> = [
  { id: 'bambu-x1', label: 'Bambu X1 / P1 (256 × 256)', size: [256, 256] },
  { id: 'bambu-a1', label: 'Bambu A1 (256 × 256)', size: [256, 256] },
  { id: 'prusa-mk4', label: 'Prusa MK4 (250 × 210)', size: [250, 210] },
  { id: 'prusa-mini', label: 'Prusa Mini (180 × 180)', size: [180, 180] },
  { id: 'ender-3', label: 'Creality Ender 3 (220 × 220)', size: [220, 220] },
  { id: 'large', label: 'Large format (350 × 350)', size: [350, 350] },
  { id: 'none', label: "Don't check", size: null },
];

export function getPreset(id: string): Preset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown preset: ${id}`);
  return p;
}

/**
 * Defaults chosen per docs/02-feature-spec.md F3/F5, so that a user who touches
 * nothing gets a printable model at 100 mm on a 0.4 mm nozzle.
 */
export function defaultConfig(bbox: BBox): GenerateConfig {
  return {
    bbox,
    dataset: DEFAULT_DATASET,
    modelWidth_mm: 100,
    baseThickness_mm: 3,
    verticalExaggeration: 1.5,
    maxHeight_mm: 30,
    seaLevelOffset_m: 0,
    resolution_m: 'auto',
    smoothing: 0,
    layerHeight_mm: 0.2,
    nozzleDiameter_mm: 0.4,
    // 256 mm square: the Bambu X1/P1 bed, and close enough to a Prusa MK4 that
    // it is a useful default rather than an arbitrary one.
    bedSize_mm: [256, 256],
    colorMode: 'multicolor',
    contours: { enabled: false, interval_m: 'auto', lineHeight_mm: 0.7 },
    frame: { enabled: false, width_mm: 8, height_mm: 3 },
    profile: { enabled: false, depth_mm: 14, height_mm: 1.2 },
    tiling: { enabled: false },
    label: { text: '', capHeight_mm: 4, depth_mm: 0.6, strokeWidth_mm: 'auto' },
    cutout: {
      subMode: 'groove',
      // 0.15 mm per side is the standard FDM press-fit starting point.
      clearance_mm: 0.15,
      insetDepth_mm: 1.0,
      // Flush by default: the insert drops in and the surface reads as one
      // piece. Raising it is the route's Height control, under Routes.
      insertProud_mm: 0,
      // Off by default: cutting water out is a big change to what comes out of
      // the printer, and most models want it left as a raised layer.
      water: false,
    },
    layers: defaultLayers(),
  };
}

/** F4 defaults, one entry per layer. */
export function defaultLayers(): Record<string, LayerSettings> {
  const out: Record<string, LayerSettings> = {};
  for (const layer of LAYERS) {
    out[layer.id] = {
      enabled: layer.enabled,
      color: layer.color,
      height_mm: layer.height_mm,
      heightScale: 1.0,
      widthScale: 1.0,
      minWidth_mm: 'auto',
      subtypeWidth_mm: {},
      subtypes: [...layer.subtypes],
      legibilityFilter: false,
    };
  }
  return out;
}
