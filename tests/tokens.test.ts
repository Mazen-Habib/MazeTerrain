/**
 * The colour tokens, measured rather than eyeballed.
 *
 * This is the second contrast regression to reach a user, and both times the
 * failure was invisible to me and obvious to them: the palette is edited as hex
 * strings in a comment-heavy stylesheet, and nothing checked the arithmetic. The
 * light theme in particular rots quietly, because dark is the default and is the
 * only one anybody looks at while working.
 *
 * What shipped and got reported on 2026-09-06:
 *   - --line was 1.27:1 on a white panel and 1.08:1 on the sunken block, so
 *     every border in the light theme had effectively vanished.
 *   - --warn on --warn-soft was 4.04:1 and --ok on --ok-soft was 4.47:1: two
 *     of the three status colours were under the body-text minimum, on exactly
 *     the chips whose whole job is to be read.
 *   - --faint was 2.53:1, under the 3:1 that non-text UI needs, while its own
 *     comment stated the 3:1 rule.
 *   - The top-bar chips were dL* 2 against the bar they sit on.
 *
 * Every threshold below is set so that each of those would have failed here.
 * They are deliberately not tightened past that: the pairs asserted are pairs
 * that actually occur in the UI, and a cross product of every token against
 * every ground fails on combinations nothing renders.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Comments come out first.
 *
 * The stylesheet documents its own measurements, so its prose is full of things
 * like "sitting directly ON --bg: the phase chip" — which a property regex
 * reads as a declaration of --bg. Stripping first is cheaper than trying to
 * write a regex that can tell code from English.
 */
const css = readFileSync('src/app/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 2.x contrast ratio, 1..21. */
function contrast(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * CIE L*, 0..100.
 *
 * Used for the *edges* rather than the ratio. Near white the WCAG ratio
 * compresses hard — #e7e4e0 on #ffffff scores 1.27, which sounds like a real
 * difference and is not one — so a hairline that reads on black can score the
 * same as one that has disappeared on white. L* is uniform enough to compare
 * the two themes against a single number.
 */
function lightness(c: Rgb): number {
  const y = relativeLuminance(c);
  return y <= 216 / 24389 ? (y * 24389) / 27 : Math.cbrt(y) * 116 - 16;
}

function deltaL(a: Rgb, b: Rgb): number {
  return Math.abs(lightness(a) - lightness(b));
}

/**
 * Pull one `:root`-ish block's custom properties out of the stylesheet.
 *
 * Brace-counting rather than a lazy regex: the blocks contain `color-mix(...)`
 * and comments full of prose, and `[\s\S]*?}` stops at the first `}` it meets.
 */
function tokenBlock(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block in app.css`);
  let i = css.indexOf('{', start);
  let depth = 0;
  const from = i + 1;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) break;
  }
  const body = css.slice(from, i);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

const lightTokens = tokenBlock(':root {');
/** Dark overrides light rather than replacing it, exactly as the cascade does. */
const darkTokens = { ...lightTokens, ...tokenBlock(":root[data-theme='dark']") };

const themes: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['light', lightTokens],
  ['dark', darkTokens],
];

function color(tokens: Record<string, string>, name: string): Rgb {
  const v = tokens[name];
  if (!v) throw new Error(`token ${name} is not defined`);
  if (!v.startsWith('#')) throw new Error(`token ${name} is ${v}, not a hex colour`);
  return hexToRgb(v);
}

/** The four grounds that panel text is actually painted on. */
const GROUNDS = ['--surface', '--bg', '--surface-2', '--surface-sunken'] as const;

describe.each(themes)('%s theme', (_name, tokens) => {
  describe('body text', () => {
    /**
     * 4.5:1 is the AA minimum for text under 18.66px, and nothing in this app
     * is bigger than that outside the wordmark.
     */
    it.each(['--text', '--text-2', '--muted'])('%s is readable on every ground', (ink) => {
      for (const ground of GROUNDS) {
        expect(contrast(color(tokens, ink), color(tokens, ground)), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  describe('status colours on their own chips', () => {
    /**
     * The regression that prompted this file. These are always rendered as
     * words on their matching soft ground, so the pair is fixed and there is no
     * excuse for not checking it.
     */
    it.each([
      ['--ok', '--ok-soft'],
      ['--bad', '--bad-soft'],
      ['--warn', '--warn-soft'],
      ['--accent-strong', '--accent-soft'],
    ])('%s reads on %s', (ink, ground) => {
      expect(contrast(color(tokens, ink), color(tokens, ground))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(['--ok', '--bad', '--warn', '--accent-strong'])('%s reads on a plain panel', (ink) => {
      expect(contrast(color(tokens, ink), color(tokens, '--surface'))).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe('non-text UI', () => {
    /**
     * 3:1, per WCAG 1.4.11. --faint draws chevrons and the icon buttons on a
     * route row; --accent draws swatches, focus rings and the slider thumb.
     * Neither is ever a text colour, which is why the bar is 3 and not 4.5.
     */
    it.each(['--faint', '--accent'])('%s is a visible shape on a panel', (ink) => {
      expect(contrast(color(tokens, ink), color(tokens, '--surface'))).toBeGreaterThanOrEqual(3);
    });
  });

  describe('edges', () => {
    /**
     * dL* 8 is about where a 1px hairline stops reading as an edge and starts
     * reading as a smudge. Both themes clear it on the two grounds a border is
     * most often drawn against; the light theme was at 7.6 on --bg when this
     * was reported, and the eye agreed with the number.
     */
    it.each(['--surface', '--bg'])('--line is a visible hairline on %s', (ground) => {
      expect(deltaL(color(tokens, '--line'), color(tokens, ground))).toBeGreaterThanOrEqual(8);
    });

    it('--line-strong is heavier than --line', () => {
      const surface = color(tokens, '--surface');
      expect(deltaL(color(tokens, '--line-strong'), surface)).toBeGreaterThan(
        deltaL(color(tokens, '--line'), surface),
      );
    });

    /**
     * The chips that sit directly on the top bar. The direction of "not the
     * bar" flips between themes — dark lifts, light sinks — so only the size of
     * the step is asserted, not its sign.
     */
    it('--chip separates from the bar it sits on', () => {
      expect(deltaL(color(tokens, '--chip'), color(tokens, '--bg'))).toBeGreaterThanOrEqual(3);
    });

    /** A white panel that does not separate from the page is not a panel. */
    it('--surface separates from --bg', () => {
      expect(deltaL(color(tokens, '--surface'), color(tokens, '--bg'))).toBeGreaterThanOrEqual(3);
    });
  });
});

/**
 * The viewport is dark in both themes on purpose, so the ink drawn on it cannot
 * follow the theme. This is the one pair where the light theme borrowing a
 * light-theme colour would be silently invisible.
 */
describe('text drawn on the canvas', () => {
  it.each(themes)('%s: --on-viewport is light', (_name, tokens) => {
    const v = tokens['--on-viewport'];
    expect(v).toMatch(/^rgba\(255,\s*255,\s*255/);
  });
});
