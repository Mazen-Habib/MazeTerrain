/**
 * Project persistence (docs/02-feature-spec.md F7.3).
 *
 * The interesting cases are not the round trip — that is arithmetic. They are
 * the ones where the input is wrong: a file from an older build missing a
 * setting that has since been added, a truncated link, a hand-edited number
 * that is now a string. None of those may take the app down, and none may
 * silently produce a config that builds something other than what it says.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  PROJECT_FORMAT,
  ProjectError,
  decodeHash,
  deletePreset,
  encodeHash,
  listPresets,
  parseProject,
  restoreSettings,
  restoreShape,
  savePreset,
  serialiseProject,
  type Settings,
} from '../src/config/project';
import { defaultConfig } from '../src/config/presets';
import type { Route } from '../src/data/gpx/types';
import type { SelectionShape } from '../src/geometry/selection';

/**
 * A minimal localStorage. Node has none, and pulling in a whole DOM to test
 * four functions that read and write one string would be a poor trade — what
 * is under test is the encode/decode and the merge, not the browser's storage.
 */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

const bbox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };

function settings(): Settings {
  const { bbox: _b, ...rest } = defaultConfig(bbox);
  return rest;
}

function route(): Route {
  return {
    id: 'r1',
    name: 'Matterhorn loop',
    points: [
      { lon: 7.65, lat: 45.96, ele: 2100 },
      { lon: 7.66, lat: 45.97 },
      { lon: 7.67, lat: 45.98, t: 1700000000000 },
    ],
    distance_m: 4200,
    elevationGain_m: 310,
    bbox,
    style: {
      color: '#FF0D00',
      width_mm: 1.5,
      height_mm: 1.2,
      profile: 'raised',
      elevationSource: 'dem',
      demBlend: 0,
      visible: true,
    },
  };
}

const shape: SelectionShape = { kind: 'rectangle', bbox };

describe('.mzt round trip', () => {
  it('brings back everything it was given', () => {
    const text = serialiseProject({ areaLabel: 'Matterhorn', shape, settings: settings(), routes: [route()] });
    const back = parseProject(text);

    expect(back.areaLabel).toBe('Matterhorn');
    expect(back.shape).toEqual(shape);
    expect(back.settings).toEqual(settings());
    expect(back.routes).toEqual([route()]);
    expect(back.format).toBe(PROJECT_FORMAT);
  });

  it('carries a circle and a polygon selection, not just a box', () => {
    for (const s of [
      { kind: 'circle', lon: 7.6, lat: 45.9, radius_m: 3000 },
      { kind: 'polygon', ring: [[0, 0], [1, 0], [1, 1]] },
    ] as SelectionShape[]) {
      const back = parseProject(
        serialiseProject({ areaLabel: 'x', shape: s, settings: settings(), routes: [] }),
      );
      expect(back.shape).toEqual(s);
    }
  });

  it('keeps a project with no selection and no route', () => {
    const back = parseProject(
      serialiseProject({ areaLabel: 'empty', shape: null, settings: settings(), routes: [] }),
    );
    expect(back.shape).toBeNull();
    expect(back.routes).toEqual([]);
  });

  it('preserves per-class width overrides, which are the fiddliest thing to re-set', () => {
    const s = settings();
    s.layers.roads = { ...s.layers.roads, subtypeWidth_mm: { motorway: 0.9, residential: 0.22 } };

    const back = parseProject(serialiseProject({ areaLabel: 'x', shape, settings: s, routes: [] }));
    expect(back.settings.layers.roads.subtypeWidth_mm).toEqual({ motorway: 0.9, residential: 0.22 });
  });
});

describe('reading a project that is wrong', () => {
  it('says so when the file is not JSON', () => {
    expect(() => parseProject('not json at all')).toThrow(ProjectError);
  });

  it('says so when the JSON is some other application', () => {
    expect(() => parseProject('{"app":"something-else"}')).toThrow(ProjectError);
  });

  it('refuses a format from the future rather than guessing at it', () => {
    const text = JSON.stringify({ app: 'mazeterrain', format: PROJECT_FORMAT + 1 });
    expect(() => parseProject(text)).toThrow(/newer version/i);
  });

  /**
   * The compatibility case that matters: a file written before a setting
   * existed. It must open, with the new setting at its default — not throw, and
   * not leave the field undefined for the builder to trip over.
   */
  it('fills in a setting the file predates', () => {
    const s = settings() as Record<string, unknown>;
    delete s.contours;
    delete s.cutout;

    const back = parseProject(
      JSON.stringify({ app: 'mazeterrain', format: 1, settings: s, shape, routes: [] }),
    );
    expect(back.settings.contours).toEqual(settings().contours);
    expect(back.settings.cutout).toEqual(settings().cutout);
  });

  it('replaces a value of the wrong type with the default', () => {
    const restored = restoreSettings({
      modelWidth_mm: 'wide',
      baseThickness_mm: null,
      verticalExaggeration: NaN,
      colorMode: 'chartreuse',
      layers: 'all of them',
    });
    expect(restored.modelWidth_mm).toBe(settings().modelWidth_mm);
    expect(restored.baseThickness_mm).toBe(settings().baseThickness_mm);
    expect(restored.verticalExaggeration).toBe(settings().verticalExaggeration);
    expect(restored.colorMode).toBe(settings().colorMode);
    expect(restored.layers).toEqual(settings().layers);
  });

  it("keeps 'auto' where a setting allows it, and rejects it where one does not", () => {
    expect(restoreSettings({ resolution_m: 'auto' }).resolution_m).toBe('auto');
    expect(restoreSettings({ contours: { interval_m: 'auto' } }).contours.interval_m).toBe('auto');
    expect(restoreSettings({ modelWidth_mm: 'auto' }).modelWidth_mm).toBe(settings().modelWidth_mm);
  });

  it('drops a class this build no longer has', () => {
    const restored = restoreSettings({
      layers: { roads: { subtypes: ['motorway', 'teleporter'] } },
    });
    expect(restored.layers.roads.subtypes).toContain('motorway');
    expect(restored.layers.roads.subtypes).not.toContain('teleporter');
  });

  it('rejects a selection that is not one', () => {
    expect(restoreShape({ kind: 'rectangle' })).toBeNull();
    expect(restoreShape({ kind: 'circle', lon: 1 })).toBeNull();
    // Two points is a line, not an area.
    expect(restoreShape({ kind: 'polygon', ring: [[0, 0], [1, 1]] })).toBeNull();
    expect(restoreShape('somewhere nice')).toBeNull();
  });

  it('skips a route with nothing to draw, and keeps the rest', () => {
    const back = parseProject(
      JSON.stringify({
        app: 'mazeterrain',
        format: 1,
        routes: [{ points: [{ lon: 0, lat: 0 }] }, route(), { name: 'no points at all' }],
      }),
    );
    expect(back.routes).toHaveLength(1);
    expect(back.routes[0].name).toBe('Matterhorn loop');
  });

  it('works out a missing route bbox from the points', () => {
    const r = route() as unknown as Record<string, unknown>;
    delete r.bbox;

    const back = parseProject(JSON.stringify({ app: 'mazeterrain', format: 1, routes: [r] }));
    expect(back.routes[0].bbox).toEqual({ west: 7.65, south: 45.96, east: 7.67, north: 45.98 });
  });
});

describe('share link', () => {
  it('round trips the place and every setting', () => {
    const state = { areaLabel: 'Matterhorn', shape, settings: settings() };
    const back = decodeHash(encodeHash(state));

    expect(back).not.toBeNull();
    expect(back?.areaLabel).toBe('Matterhorn');
    expect(back?.shape).toEqual(shape);
    expect(back?.settings).toEqual(settings());
  });

  it('stays short enough to send', () => {
    const hash = encodeHash({ areaLabel: 'Matterhorn, Zermatt', shape, settings: settings() });
    // Well under the ~2 000 characters that survives every mail client and chat app.
    expect(hash.length).toBeLessThan(2000);
    // And URL-safe, so nothing has to escape it.
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns null for a mangled link instead of throwing', () => {
    expect(decodeHash('')).toBeNull();
    expect(decodeHash('#')).toBeNull();
    expect(decodeHash('#not-real-base64!!')).toBeNull();
    // Valid base64, but not a deflate stream.
    expect(decodeHash('#aGVsbG8gd29ybGQ')).toBeNull();
  });

  it('reads a hash with or without its leading #', () => {
    const hash = encodeHash({ areaLabel: 'x', shape, settings: settings() });
    expect(decodeHash(hash)?.shape).toEqual(shape);
    expect(decodeHash('#' + hash)?.shape).toEqual(shape);
  });
});

describe('named presets', () => {
  beforeEach(() => localStorage.clear());

  it('saves, lists and deletes', () => {
    savePreset('Gift 100 mm', { ...settings(), modelWidth_mm: 100 });
    savePreset('Wall piece', { ...settings(), modelWidth_mm: 300 });

    const all = listPresets();
    expect(all.map((p) => p.name)).toEqual(['Gift 100 mm', 'Wall piece']);
    expect(all[1].settings.modelWidth_mm).toBe(300);

    expect(deletePreset('Wall piece').map((p) => p.name)).toEqual(['Gift 100 mm']);
  });

  it('updates rather than duplicating when the name is reused', () => {
    savePreset('Gift', { ...settings(), modelWidth_mm: 100 });
    const after = savePreset('Gift', { ...settings(), modelWidth_mm: 120 });

    expect(after).toHaveLength(1);
    expect(after[0].settings.modelWidth_mm).toBe(120);
  });

  it('ignores a blank name', () => {
    expect(savePreset('   ', settings())).toHaveLength(0);
  });

  /** A preset must survive being applied to a different place. */
  it('carries no selection with it', () => {
    savePreset('Gift', settings());
    expect(listPresets()[0].settings).not.toHaveProperty('bbox');
  });

  it('survives junk in storage rather than taking the app down', () => {
    localStorage.setItem('mazeterrain.presets.v1', '{ not json');
    expect(listPresets()).toEqual([]);
  });
});
