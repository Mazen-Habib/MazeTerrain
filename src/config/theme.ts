/**
 * Light or dark (2026-09-02).
 *
 * **Dark is the default** (owner's call, same day). Light exists and is a
 * first-class theme — the palette was designed light-first — but the app is
 * mostly a dark 3D viewport and a dark map, and a bright panel beside them all
 * day is tiring. The palette is white, black and one orange, and the orange is
 * the only saturated thing on screen — which is what makes it mean something
 * when it appears.
 *
 * Applied by stamping `data-theme` on the document element; every colour in the
 * app is a custom property, so a theme is a set of variables rather than a
 * second stylesheet.
 *
 * **The viewport stays dark in both.** Terrain relief and satellite imagery are
 * photographic, and a photograph on white reads as washed out. That is a
 * decision about the content, not about the chrome, so it does not follow the
 * theme — see the `--viewport` tokens.
 *
 * Deliberately NOT following `prefers-color-scheme`. The default is a decision
 * about this app, whose viewport is dark whatever the chrome does; an OS
 * setting made months ago for unrelated reasons is a poor proxy for it. The
 * switch sits at the foot of the sidebar and is remembered.
 */
export type Theme = 'light' | 'dark';

export const STORAGE_KEY = 'mazeterrain.theme';

/**
 * Also written literally into the boot script in `index.html`.
 *
 * That script runs before React and before first paint, because reading the
 * theme in an effect means the light palette renders for a frame and every
 * load starts with a white flash. Two places holding one value is a real cost;
 * a flash on every single page load is a worse one.
 */
export const DEFAULT_THEME: Theme = 'dark';

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage denied or full. The default is still a correct answer.
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The choice still holds for this session.
  }
}
