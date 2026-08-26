/**
 * Project persistence (docs/02-feature-spec.md F7.3).
 *
 * Three things, one shape between them:
 *
 *  - a `.mzt` file: everything, routes included, downloaded and re-opened;
 *  - a URL hash: everything except routes, because a 20 000-point GPX does not
 *    belong in a link;
 *  - named presets in `localStorage`: settings only, no place and no route.
 *
 * All three read back through `restoreSettings`, which merges onto the current
 * defaults rather than trusting what it is given. A project file is
 * user-supplied JSON — it can be hand-edited, truncated, or written by an older
 * build — so every field is checked and anything missing falls back. That is
 * also what makes old files keep working when a new setting is added: it simply
 * takes its default.
 */
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { defaultConfig, defaultLayers } from './presets';
import type { GenerateConfig } from '../geometry/types';
import type { SelectionShape } from '../geometry/selection';
import type { Route } from '../data/gpx/types';
import type { LayerSettings } from '../geometry/features';

/** Settings without the bbox, which is derived from the selection. */
export type Settings = Omit<GenerateConfig, 'bbox'>;

/**
 * Bumped only for a change old files cannot survive.
 *
 * Adding a setting is not one of those: `restoreSettings` fills a missing field
 * from the defaults, so a v1 file opens correctly in a build that has since
 * grown new controls.
 */
export const PROJECT_FORMAT = 1;

export interface ProjectFile {
  app: 'mazeterrain';
  format: number;
  savedAt: string;
  /** What the area is called in the UI. Cosmetic, but it is what the user named it. */
  areaLabel: string;
  shape: SelectionShape | null;
  settings: Settings;
  routes: Route[];
}

/** A project that could not be read, with something the user can act on. */
export class ProjectError extends Error {
  constructor(public userMessage: string) {
    super(userMessage);
    this.name = 'ProjectError';
  }
}

// --- reading untrusted values ---------------------------------------------

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** A number, or the literal 'auto' where the setting allows it. */
function numOrAuto(value: unknown, fallback: number | 'auto'): number | 'auto' {
  if (value === 'auto') return 'auto';
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- settings --------------------------------------------------------------

function restoreLayers(raw: unknown): Record<string, LayerSettings> {
  const defaults = defaultLayers();
  if (!isObject(raw)) return defaults;

  const out: Record<string, LayerSettings> = {};
  // Iterate the DEFAULTS, never the file: a layer the build no longer has is
  // dropped, and a layer the file never heard of takes its current default.
  for (const [id, base] of Object.entries(defaults)) {
    const saved = raw[id];
    if (!isObject(saved)) {
      out[id] = base;
      continue;
    }
    const subtypes = saved.subtypes;
    const widths = saved.subtypeWidth_mm;
    out[id] = {
      ...base,
      enabled: bool(saved.enabled, base.enabled),
      color: str(saved.color, base.color),
      height_mm: num(saved.height_mm, base.height_mm),
      heightScale: num(saved.heightScale, base.heightScale),
      widthScale: num(saved.widthScale, base.widthScale),
      minWidth_mm: numOrAuto(saved.minWidth_mm, base.minWidth_mm),
      legibilityFilter: bool(saved.legibilityFilter, base.legibilityFilter),
      // Only classes this build still knows about: an OSM class dropped from
      // the tag table would otherwise be silently carried forward and quietly
      // build nothing.
      subtypes: Array.isArray(subtypes)
        ? subtypes.filter((c): c is string => typeof c === 'string' && base.subtypes.includes(c))
        : base.subtypes,
      subtypeWidth_mm: isObject(widths)
        ? Object.fromEntries(
            Object.entries(widths).filter(
              (e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]),
            ),
          )
        : base.subtypeWidth_mm,
    };
  }
  return out;
}

/**
 * Rebuild a settings object from anything, falling back field by field.
 *
 * Never throws. A file that is complete nonsense yields the defaults, which is
 * a usable app rather than a blank screen.
 */
export function restoreSettings(raw: unknown): Settings {
  const { bbox: _bbox, ...base } = defaultConfig({ west: 0, south: 0, east: 1, north: 1 });
  if (!isObject(raw)) return base;

  const cutout = isObject(raw.cutout) ? raw.cutout : {};
  const contours = isObject(raw.contours) ? raw.contours : {};
  const frame = isObject(raw.frame) ? raw.frame : {};
  const bed = raw.bedSize_mm;

  return {
    ...base,
    dataset: str(raw.dataset, base.dataset),
    modelWidth_mm: num(raw.modelWidth_mm, base.modelWidth_mm),
    baseThickness_mm: num(raw.baseThickness_mm, base.baseThickness_mm),
    verticalExaggeration: num(raw.verticalExaggeration, base.verticalExaggeration),
    maxHeight_mm: num(raw.maxHeight_mm, base.maxHeight_mm),
    seaLevelOffset_m: num(raw.seaLevelOffset_m, base.seaLevelOffset_m),
    resolution_m: numOrAuto(raw.resolution_m, base.resolution_m),
    smoothing: num(raw.smoothing, base.smoothing),
    layerHeight_mm: num(raw.layerHeight_mm, base.layerHeight_mm),
    nozzleDiameter_mm: num(raw.nozzleDiameter_mm, base.nozzleDiameter_mm),
    bedSize_mm:
      Array.isArray(bed) && bed.length === 2 && bed.every((v) => typeof v === 'number')
        ? [bed[0] as number, bed[1] as number]
        : null,
    colorMode: oneOf(raw.colorMode, ['multicolor', 'single-raised', 'single-cutout'], base.colorMode),
    cutout: {
      subMode: oneOf(cutout.subMode, ['groove', 'inlay'], base.cutout.subMode),
      clearance_mm: num(cutout.clearance_mm, base.cutout.clearance_mm),
      insetDepth_mm: num(cutout.insetDepth_mm, base.cutout.insetDepth_mm),
      insertProud_mm: num(cutout.insertProud_mm, base.cutout.insertProud_mm),
    },
    contours: {
      enabled: bool(contours.enabled, base.contours.enabled),
      interval_m: numOrAuto(contours.interval_m, base.contours.interval_m),
      lineHeight_mm: num(contours.lineHeight_mm, base.contours.lineHeight_mm),
    },
    frame: {
      enabled: bool(frame.enabled, base.frame.enabled),
      width_mm: num(frame.width_mm, base.frame.width_mm),
      height_mm: num(frame.height_mm, base.frame.height_mm),
    },
    layers: restoreLayers(raw.layers),
  };
}

// --- selection -------------------------------------------------------------

/** A selection shape, or null if it is not one. Never throws. */
export function restoreShape(raw: unknown): SelectionShape | null {
  if (!isObject(raw)) return null;

  if (raw.kind === 'rectangle' && isObject(raw.bbox)) {
    const b = raw.bbox;
    if (['west', 'south', 'east', 'north'].every((k) => typeof b[k] === 'number')) {
      return {
        kind: 'rectangle',
        bbox: {
          west: b.west as number,
          south: b.south as number,
          east: b.east as number,
          north: b.north as number,
        },
      };
    }
    return null;
  }

  if (raw.kind === 'circle') {
    if (['lon', 'lat', 'radius_m'].every((k) => typeof raw[k] === 'number')) {
      return {
        kind: 'circle',
        lon: raw.lon as number,
        lat: raw.lat as number,
        radius_m: raw.radius_m as number,
      };
    }
    return null;
  }

  if (raw.kind === 'polygon' && Array.isArray(raw.ring)) {
    const ring = raw.ring.filter(
      (p): p is [number, number] =>
        Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number',
    );
    // Fewer than three points is not an area.
    return ring.length >= 3 ? { kind: 'polygon', ring } : null;
  }

  return null;
}

// --- routes ----------------------------------------------------------------

function restoreRoutes(raw: unknown): Route[] {
  if (!Array.isArray(raw)) return [];

  const out: Route[] = [];
  for (const item of raw) {
    if (!isObject(item) || !Array.isArray(item.points)) continue;

    const points = item.points
      .filter(isObject)
      .filter((p) => typeof p.lon === 'number' && typeof p.lat === 'number')
      .map((p) => ({
        lon: p.lon as number,
        lat: p.lat as number,
        ...(typeof p.ele === 'number' ? { ele: p.ele } : {}),
        ...(typeof p.t === 'number' ? { t: p.t } : {}),
      }));
    // A route with one point has no line to draw and no length to report.
    if (points.length < 2) continue;

    const style = isObject(item.style) ? item.style : {};
    const b = isObject(item.bbox) ? item.bbox : {};
    const has = ['west', 'south', 'east', 'north'].every((k) => typeof b[k] === 'number');

    out.push({
      id: str(item.id, `route-${out.length}`),
      name: str(item.name, 'Route'),
      points,
      distance_m: num(item.distance_m, 0),
      elevationGain_m: typeof item.elevationGain_m === 'number' ? item.elevationGain_m : null,
      bbox: has
        ? {
            west: b.west as number,
            south: b.south as number,
            east: b.east as number,
            north: b.north as number,
          }
        : bboxOf(points),
      style: {
        color: str(style.color, '#FF0D00'),
        width_mm: num(style.width_mm, 1.5),
        height_mm: num(style.height_mm, 1.2),
        profile: oneOf(style.profile, ['raised', 'engraved', 'separate'], 'raised'),
        elevationSource: oneOf(style.elevationSource, ['dem', 'gpx', 'flat'], 'dem'),
        demBlend: num(style.demBlend, 0),
        visible: bool(style.visible, true),
      },
    });
  }
  return out;
}

function bboxOf(points: Array<{ lon: number; lat: number }>) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return { west, south, east, north };
}

// --- the .mzt file ---------------------------------------------------------

export function serialiseProject(input: {
  areaLabel: string;
  shape: SelectionShape | null;
  settings: Settings;
  routes: Route[];
}): string {
  const file: ProjectFile = {
    app: 'mazeterrain',
    format: PROJECT_FORMAT,
    savedAt: new Date().toISOString(),
    areaLabel: input.areaLabel,
    shape: input.shape,
    settings: input.settings,
    routes: input.routes,
  };
  // Indented: a project file is small next to the GPX it carries, and being
  // able to read and hand-edit one has already paid for itself in diagnostics.
  return JSON.stringify(file, null, 2);
}

export function parseProject(text: string): ProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectError('That is not a MazeTerrain project — the file is not valid JSON.');
  }

  if (!isObject(raw) || raw.app !== 'mazeterrain') {
    throw new ProjectError(
      'That file is not a MazeTerrain project. Look for one saved with "Save project".',
    );
  }

  const format = num(raw.format, 0);
  if (format > PROJECT_FORMAT) {
    throw new ProjectError(
      `This project was saved by a newer version of MazeTerrain (format ${format}, ` +
        `this build reads ${PROJECT_FORMAT}). Update, or re-save it from the version that wrote it.`,
    );
  }

  return {
    app: 'mazeterrain',
    format,
    savedAt: str(raw.savedAt, ''),
    areaLabel: str(raw.areaLabel, 'Saved project'),
    shape: restoreShape(raw.shape),
    settings: restoreSettings(raw.settings),
    routes: restoreRoutes(raw.routes),
  };
}

// --- the URL hash ----------------------------------------------------------

/**
 * What a link carries: the place and every setting, but never the routes.
 *
 * A GPX is tens of thousands of coordinates. Even compressed it would produce a
 * link nothing will send intact, so a shared link restores the model and asks
 * for the track back (docs/02-feature-spec.md F7.3).
 */
export interface HashState {
  areaLabel: string;
  shape: SelectionShape | null;
  settings: Settings;
}

/** URL-safe base64, without the padding that has to be escaped in a fragment. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeHash(state: HashState): string {
  const json = JSON.stringify({
    v: PROJECT_FORMAT,
    areaLabel: state.areaLabel,
    shape: state.shape,
    settings: state.settings,
  });
  // Deflated before encoding. The settings carry ten layers with per-class
  // width maps; raw JSON runs to several kilobytes and makes an unusable link.
  return toBase64Url(deflateSync(strToU8(json), { level: 9 }));
}

/** Null rather than throwing: a mangled link should load the app, not break it. */
export function decodeHash(hash: string): HashState | null {
  const trimmed = hash.replace(/^#/, '');
  if (trimmed.length === 0) return null;

  try {
    const raw: unknown = JSON.parse(strFromU8(inflateSync(fromBase64Url(trimmed))));
    if (!isObject(raw)) return null;
    return {
      areaLabel: str(raw.areaLabel, 'Shared model'),
      shape: restoreShape(raw.shape),
      settings: restoreSettings(raw.settings),
    };
  } catch {
    return null;
  }
}

// --- named presets ---------------------------------------------------------

const PRESET_KEY = 'mazeterrain.presets.v1';

export interface NamedPreset {
  name: string;
  settings: Settings;
  /** Shipped with the app: shown first, and not editable or deletable. */
  builtIn?: boolean;
}

/**
 * Curated presets (OPEN-QUESTIONS Q16, resolved 2026-08-27: yes).
 *
 * An empty dropdown teaches nobody what presets are for. Each of these is a
 * plausible finished intent rather than a demonstration of a slider — a size,
 * an exaggeration and a nozzle that go together — so picking one gets a usable
 * model rather than a starting point to fix.
 *
 * Settings only. A preset carries no area and no route, so it survives being
 * applied anywhere.
 */
function curatedPresets(): NamedPreset[] {
  const { bbox: _bbox, ...base } = defaultConfig({ west: 0, south: 0, east: 1, north: 1 });

  const make = (name: string, patch: Partial<Settings>): NamedPreset => ({
    name,
    builtIn: true,
    settings: { ...base, ...patch },
  });

  return [
    make('Gift — 100 mm', {
      modelWidth_mm: 100,
      baseThickness_mm: 3,
      verticalExaggeration: 1.5,
    }),
    make('Wall piece — 300 mm', {
      modelWidth_mm: 300,
      baseThickness_mm: 4,
      verticalExaggeration: 1.25,
      // Wide enough to carry a plaque at this size.
      frame: { enabled: true, width_mm: 12, height_mm: 4 },
    }),
    make('Alpine climb', {
      modelWidth_mm: 150,
      // Real alpine relief needs no help; past this it reads as a spike field.
      verticalExaggeration: 1.25,
      contours: { enabled: true, interval_m: 'auto', lineHeight_mm: 0.6 },
    }),
    make('Flat city map', {
      modelWidth_mm: 150,
      // Nothing to see in the relief, so the streets carry the model.
      verticalExaggeration: 3,
      baseThickness_mm: 2.5,
      contours: { enabled: false, interval_m: 'auto', lineHeight_mm: 0.7 },
    }),
    make('Single colour, route inlaid', {
      modelWidth_mm: 120,
      colorMode: 'single-cutout',
      cutout: { subMode: 'inlay', clearance_mm: 0.15, insetDepth_mm: 1, insertProud_mm: 0.6 },
      // Relief is otherwise only readable from the silhouette in one colour.
      contours: { enabled: true, interval_m: 'auto', lineHeight_mm: 0.6 },
    }),
  ];
}

/**
 * Settings only — no place, no route.
 *
 * "Gift 100 mm" is a statement about size and print parameters, and it has to
 * survive being applied to a different mountain. Storing the bbox with it would
 * make every preset teleport the user somewhere else.
 */
export function listPresets(): NamedPreset[] {
  const built = curatedPresets();
  const mine = readOwnPresets();
  // A saved preset under a built-in's name shadows it, rather than appearing
  // twice with no way to tell which one is about to be applied.
  const shadowed = new Set(mine.map((p) => p.name));
  return [...built.filter((p) => !shadowed.has(p.name)), ...mine];
}

/** Only the user's own, which are the only ones that can be written. */
function readOwnPresets(): NamedPreset[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PRESET_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(isObject)
      .filter((p) => typeof p.name === 'string' && p.name.length > 0)
      .map((p) => ({ name: p.name as string, settings: restoreSettings(p.settings) }));
  } catch {
    // A full or disabled localStorage must not take the app down with it.
    return [];
  }
}

export function savePreset(name: string, settings: Settings): NamedPreset[] {
  const trimmed = name.trim();
  if (trimmed.length === 0) return listPresets();

  // Same name replaces, so saving twice is an update rather than a duplicate.
  const next = [...readOwnPresets().filter((p) => p.name !== trimmed), { name: trimmed, settings }];
  next.sort((a, b) => a.name.localeCompare(b.name));
  writePresets(next);
  return listPresets();
}

/**
 * Deleting a built-in restores it rather than removing it: what is actually
 * stored is the user's own copy, and dropping that uncovers the original.
 */
export function deletePreset(name: string): NamedPreset[] {
  writePresets(readOwnPresets().filter((p) => p.name !== name));
  return listPresets();
}

function writePresets(presets: NamedPreset[]): void {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  } catch {
    // Quota, or storage denied. The presets in memory still work for this
    // session; nothing else in the app depends on them persisting.
  }
}
