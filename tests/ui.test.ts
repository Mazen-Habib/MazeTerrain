/**
 * The UI's persisted preferences.
 *
 * Theme and open-group are small, but they are read on mount before anything
 * renders, and every one of them has to survive a browser that refuses
 * storage — a private window, a full quota, a profile with site data blocked.
 * A preference that throws there takes the whole app down before first paint,
 * which is the worst possible failure for the least important state.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readTheme, applyTheme, DEFAULT_THEME } from '../src/config/theme';
import { DEFAULT_GROUPS, readOpenGroups, writeOpenGroups } from '../src/app/Section';

const store = new Map<string, string>();

function stubStorage() {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
}

function stubDeniedStorage() {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  });
}

beforeEach(() => {
  store.clear();
  stubStorage();
  vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string> } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme', () => {
  /**
   * Dark, and not from `prefers-color-scheme`.
   *
   * The viewport is dark whatever the chrome does, so a bright panel beside it
   * all day is tiring. An OS setting made months ago for unrelated reasons is
   * a poor proxy for that decision.
   */
  it('defaults to dark', () => {
    expect(readTheme()).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe('dark');
  });

  /**
   * The boot script in index.html stamps the theme before React runs, to avoid
   * a white flash on every load. It hardcodes the default, so if these two ever
   * disagree the flash comes back silently.
   */
  it('matches the default hardcoded in the boot script', async () => {
    const html = await readFile('index.html', 'utf8');
    expect(html).toContain("dataset.theme = t === 'light' ? 'light' : 'dark'");
  });

  it('round-trips a choice', () => {
    applyTheme('dark');
    expect(readTheme()).toBe('dark');
    applyTheme('light');
    expect(readTheme()).toBe('light');
  });

  it('stamps the document so the token layer flips', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('ignores a stored value that is not a theme', () => {
    store.set('mazeterrain.theme', 'solarized');
    expect(readTheme()).toBe(DEFAULT_THEME);
  });

  it('survives storage throwing', () => {
    stubDeniedStorage();
    expect(readTheme()).toBe(DEFAULT_THEME);
    expect(() => applyTheme('light')).not.toThrow();
  });
});

describe('the open sidebar groups', () => {
  it('starts at the first step of the workflow', () => {
    expect(readOpenGroups()).toEqual([...DEFAULT_GROUPS]);
  });

  it('round-trips a group', () => {
    writeOpenGroups(['terrain']);
    expect(readOpenGroups()).toEqual(['terrain']);
  });

  /** Groups open independently now, so more than one at a time is the point. */
  it('round-trips several groups', () => {
    writeOpenGroups(['place', 'model', 'export']);
    expect(readOpenGroups()).toEqual(['place', 'model', 'export']);
  });

  /** Everything closed is a real state, and distinct from "never chosen". */
  it('remembers that everything is closed', () => {
    writeOpenGroups([]);
    expect(readOpenGroups()).toEqual([]);
  });

  /**
   * The storage key predates groups opening independently, so anyone who has
   * used the app has a bare group name sitting in it. That has to keep working,
   * or the change quietly resets the panel for every existing user.
   */
  it('reads a single id written by the old one-open-at-a-time version', () => {
    store.set('mazeterrain.openGroup', 'terrain');
    expect(readOpenGroups()).toEqual(['terrain']);
  });

  it('ignores group names that no longer exist', () => {
    store.set('mazeterrain.openGroup', 'filaments');
    expect(readOpenGroups()).toEqual([...DEFAULT_GROUPS]);
  });

  it('keeps the real groups out of a partly corrupt list', () => {
    store.set('mazeterrain.openGroup', 'filaments,model,,terrain');
    expect(readOpenGroups()).toEqual(['model', 'terrain']);
  });

  it('does not open the same group twice', () => {
    store.set('mazeterrain.openGroup', 'model,model');
    expect(readOpenGroups()).toEqual(['model']);
  });

  it('survives storage throwing', () => {
    stubDeniedStorage();
    expect(readOpenGroups()).toEqual([...DEFAULT_GROUPS]);
    expect(() => writeOpenGroups(['model'])).not.toThrow();
  });
});
