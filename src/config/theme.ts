/**
 * Light or dark (2026-09-02).
 *
 * Light is the default. The palette is white, black and one orange, and the
 * orange is the only saturated thing on screen — which is what makes it mean
 * something when it appears. Dark exists because this is a tool people use for
 * a long sitting, sometimes at night, and a full-bright panel next to a dark 3D
 * viewport is tiring.
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
 * Deliberately NOT following `prefers-color-scheme` on first run. The reference
 * this was designed against is light, most people never change the OS setting
 * deliberately, and a tool that opens dark for someone who expected the design
 * they were shown looks broken rather than considerate. The switch is one click
 * away and remembered.
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'mazeterrain.theme';

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage denied or full. Light is still a correct answer.
  }
  return 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The choice still holds for this session.
  }
}
