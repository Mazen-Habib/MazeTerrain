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
import { readTheme, applyTheme } from '../src/config/theme';
import { DEFAULT_GROUP, readOpenGroup, writeOpenGroup } from '../src/app/Section';

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
   * Light, not `prefers-color-scheme`.
   *
   * The design is light and most people never set the OS preference
   * deliberately; opening dark for someone who was shown the light design
   * reads as broken rather than considerate.
   */
  it('defaults to light', () => {
    expect(readTheme()).toBe('light');
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
    expect(readTheme()).toBe('light');
  });

  it('survives storage throwing', () => {
    stubDeniedStorage();
    expect(readTheme()).toBe('light');
    expect(() => applyTheme('dark')).not.toThrow();
  });
});

describe('the open sidebar group', () => {
  it('starts at the first step of the workflow', () => {
    expect(readOpenGroup()).toBe(DEFAULT_GROUP);
  });

  it('round-trips a group', () => {
    writeOpenGroup('terrain');
    expect(readOpenGroup()).toBe('terrain');
  });

  /** Everything closed is a real state, and distinct from "never chosen". */
  it('remembers that everything is closed', () => {
    writeOpenGroup(null);
    expect(readOpenGroup()).toBeNull();
  });

  it('ignores a group name that no longer exists', () => {
    store.set('mazeterrain.openGroup', 'filaments');
    expect(readOpenGroup()).toBe(DEFAULT_GROUP);
  });

  it('survives storage throwing', () => {
    stubDeniedStorage();
    expect(readOpenGroup()).toBe(DEFAULT_GROUP);
    expect(() => writeOpenGroup('model')).not.toThrow();
  });
});
