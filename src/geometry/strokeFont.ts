/**
 * A single-stroke font, for engraving (docs/02-feature-spec.md F5.1).
 *
 * Engraved text on an FDM print is a groove, not a filled shape. At the size a
 * plaque actually prints — 3 mm cap height is generous — the counters of a
 * normal typeface are narrower than a 0.4 mm nozzle, so a filled face either
 * closes up into a blob or has to be printed so large it stops being a caption.
 * A font drawn as centrelines sidesteps that completely: every stroke is
 * exactly one nozzle wide by construction, which is the narrowest legible line
 * the machine can make.
 *
 * That is also why this is uppercase only. Lowercase at 3 mm puts the x-height
 * around 2 mm, where the bowls of a, e and o are back under a nozzle; and a
 * single-stroke lowercase is the weakest part of every stroke font ever drawn.
 * Text is upper-cased on the way in, and the UI says so rather than quietly
 * changing what was typed.
 *
 * Coordinates are in font units on a 14-unit cap height with the baseline at
 * y = 0 and y running up. Each glyph is a list of polylines — pen down, follow
 * the points, pen up.
 */

export interface Glyph {
  /** How far the pen moves on for the next character, font units. */
  advance: number;
  /** Polylines, each a flat [x0, y0, x1, y1, ...]. */
  strokes: number[][];
}

/** Cap height in font units. Everything scales from this. */
export const CAP_HEIGHT = 14;

/** Gap between characters, font units, on top of each glyph's advance. */
const TRACKING = 3;

/** An n-point circle, for the few glyphs that need one. */
function circle(cx: number, cy: number, r: number, n = 12): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

/** A dot: too short to be a line, so it is drawn as a tiny closed loop. */
function dot(cx: number, cy: number): number[] {
  return circle(cx, cy, 0.5, 6);
}

const GLYPHS: Record<string, Glyph> = {
  ' ': { advance: 6, strokes: [] },

  A: { advance: 11, strokes: [[0, 0, 5.5, 14, 11, 0], [2.2, 5.6, 8.8, 5.6]] },
  B: {
    advance: 10,
    strokes: [
      [0, 0, 0, 14],
      [0, 14, 6, 14, 9, 12.5, 9.5, 10.5, 9, 8.5, 6, 7, 0, 7],
      [0, 7, 7, 7, 10, 5.5, 10.5, 3.5, 10, 1.5, 7, 0, 0, 0],
    ],
  },
  C: {
    advance: 11,
    strokes: [[11, 11, 9, 13.2, 6, 14, 3.5, 13.2, 1.3, 11, 0, 7.8, 0, 6.2, 1.3, 3, 3.5, 0.8, 6, 0, 9, 0.8, 11, 3]],
  },
  D: { advance: 11, strokes: [[0, 0, 0, 14], [0, 14, 5.5, 14, 8.8, 12.5, 10.5, 9.5, 10.5, 4.5, 8.8, 1.5, 5.5, 0, 0, 0]] },
  E: { advance: 9, strokes: [[0, 0, 0, 14], [0, 14, 9, 14], [0, 7, 6.8, 7], [0, 0, 9, 0]] },
  F: { advance: 9, strokes: [[0, 0, 0, 14], [0, 14, 9, 14], [0, 7, 6.8, 7]] },
  G: {
    advance: 11,
    strokes: [
      [11, 11, 9, 13.2, 6, 14, 3.5, 13.2, 1.3, 11, 0, 7.8, 0, 6.2, 1.3, 3, 3.5, 0.8, 6, 0, 9, 0.8, 11, 3, 11, 6, 6.5, 6],
    ],
  },
  H: { advance: 11, strokes: [[0, 0, 0, 14], [11, 0, 11, 14], [0, 7, 11, 7]] },
  I: { advance: 4, strokes: [[2, 0, 2, 14]] },
  J: { advance: 9, strokes: [[7, 14, 7, 4, 6, 1.3, 4, 0, 2, 0.3, 0.4, 1.8, 0, 3.5]] },
  K: { advance: 10, strokes: [[0, 0, 0, 14], [10, 14, 0, 5.5], [3.6, 8.6, 10, 0]] },
  L: { advance: 9, strokes: [[0, 14, 0, 0, 9, 0]] },
  M: { advance: 13, strokes: [[0, 0, 0, 14, 6.5, 2.5, 13, 14, 13, 0]] },
  N: { advance: 11, strokes: [[0, 0, 0, 14, 11, 0, 11, 14]] },
  O: {
    advance: 12,
    strokes: [[6, 14, 3.3, 13.2, 1.2, 11, 0, 7.8, 0, 6.2, 1.2, 3, 3.3, 0.8, 6, 0, 8.7, 0.8, 10.8, 3, 12, 6.2, 12, 7.8, 10.8, 11, 8.7, 13.2, 6, 14]],
  },
  P: { advance: 10, strokes: [[0, 0, 0, 14], [0, 14, 6.2, 14, 9.3, 12.6, 10, 10.4, 9.3, 8.2, 6.2, 6.8, 0, 6.8]] },
  Q: {
    advance: 12,
    strokes: [
      [6, 14, 3.3, 13.2, 1.2, 11, 0, 7.8, 0, 6.2, 1.2, 3, 3.3, 0.8, 6, 0, 8.7, 0.8, 10.8, 3, 12, 6.2, 12, 7.8, 10.8, 11, 8.7, 13.2, 6, 14],
      [7.5, 3.2, 12, -1.6],
    ],
  },
  R: {
    advance: 10,
    strokes: [[0, 0, 0, 14], [0, 14, 6.2, 14, 9.3, 12.6, 10, 10.4, 9.3, 8.2, 6.2, 6.8, 0, 6.8], [5.4, 6.8, 10, 0]],
  },
  S: {
    advance: 10,
    strokes: [[10, 11.6, 8, 13.4, 5.2, 14, 2.6, 13.4, 1, 12, 0.8, 10.2, 1.8, 8.6, 4, 7.6, 6.6, 6.6, 8.8, 5.4, 9.8, 3.8, 9.6, 2, 8, 0.6, 5.2, 0, 2.4, 0.6, 0.4, 2.2, 0, 3.6]],
  },
  T: { advance: 10, strokes: [[5, 0, 5, 14], [0, 14, 10, 14]] },
  U: { advance: 11, strokes: [[0, 14, 0, 4, 1.2, 1.4, 3.5, 0, 7.5, 0, 9.8, 1.4, 11, 4, 11, 14]] },
  V: { advance: 11, strokes: [[0, 14, 5.5, 0, 11, 14]] },
  W: { advance: 15, strokes: [[0, 14, 3.2, 0, 7.5, 9.8, 11.8, 0, 15, 14]] },
  X: { advance: 10, strokes: [[0, 0, 10, 14], [0, 14, 10, 0]] },
  Y: { advance: 10, strokes: [[0, 14, 5, 7, 10, 14], [5, 7, 5, 0]] },
  Z: { advance: 10, strokes: [[0, 14, 10, 14, 0, 0, 10, 0]] },

  '0': {
    advance: 10,
    strokes: [[5, 14, 2.6, 13, 1, 10.6, 0.4, 7, 1, 3.4, 2.6, 1, 5, 0, 7.4, 1, 9, 3.4, 9.6, 7, 9, 10.6, 7.4, 13, 5, 14]],
  },
  '1': { advance: 8, strokes: [[1, 11.4, 4, 14, 4, 0], [1, 0, 7, 0]] },
  '2': { advance: 10, strokes: [[0, 11, 0.8, 13, 3, 14, 6.4, 14, 8.8, 12.8, 9.6, 10.6, 9, 8.4, 7, 6.4, 0, 0, 10, 0]] },
  '3': {
    advance: 10,
    strokes: [[1, 14, 9.4, 14, 5, 8.6], [5, 8.6, 7.2, 8.6, 9.2, 7.6, 10, 5.4, 10, 3.4, 9, 1.4, 6.8, 0.2, 4, 0, 1.6, 0.8, 0, 2.4]],
  },
  '4': { advance: 10, strokes: [[7.2, 14, 0, 4.2, 10, 4.2], [7.2, 14, 7.2, 0]] },
  '5': {
    advance: 10,
    strokes: [[9, 14, 1.2, 14, 0.4, 7.6, 1.8, 8.8, 4, 9.2, 6.6, 9, 8.8, 7.8, 10, 5.6, 10, 3.6, 9, 1.6, 6.8, 0.2, 4, 0, 1.6, 0.8, 0, 2.4]],
  },
  '6': {
    advance: 10,
    strokes: [[9, 12.2, 7, 13.8, 4.4, 14, 2.2, 12.6, 0.8, 10, 0.2, 6, 0.8, 3, 2.4, 1, 4.8, 0, 6.4, 0.2, 8.6, 1.4, 9.8, 3.4, 9.8, 5, 8.6, 7, 6.4, 8.2, 4.6, 8.2, 2.2, 7, 0.8, 4.8]],
  },
  '7': { advance: 10, strokes: [[0, 14, 10, 14, 4, 0]] },
  '8': {
    advance: 10,
    strokes: [
      [5, 7.4, 2.4, 8.4, 1, 10, 1, 11.8, 2.4, 13.4, 5, 14, 7.6, 13.4, 9, 11.8, 9, 10, 7.6, 8.4, 5, 7.4],
      [5, 7.4, 2, 6.2, 0.4, 4.2, 0.4, 2.2, 2, 0.5, 5, 0, 8, 0.5, 9.6, 2.2, 9.6, 4.2, 8, 6.2, 5, 7.4],
    ],
  },
  '9': {
    advance: 10,
    strokes: [[1, 1.8, 3, 0.2, 5.6, 0, 7.8, 1.4, 9.2, 4, 9.8, 8, 9.2, 11, 7.6, 13, 5.2, 14, 3.6, 13.8, 1.4, 12.6, 0.2, 10.6, 0.2, 9, 1.4, 7, 3.6, 5.8, 5.4, 5.8, 7.8, 7, 9.2, 9.2]],
  },

  '.': { advance: 5, strokes: [dot(2.2, 0.6)] },
  ',': { advance: 5, strokes: [[2.6, 1.2, 2, 0, 1, -2.2]] },
  '-': { advance: 8, strokes: [[1, 6.6, 7, 6.6]] },
  '–': { advance: 10, strokes: [[0.5, 6.6, 9.5, 6.6]] },
  "'": { advance: 4, strokes: [[2, 14, 2, 10.4]] },
  '"': { advance: 7, strokes: [[1.6, 14, 1.6, 10.4], [5, 14, 5, 10.4]] },
  '°': { advance: 7, strokes: [circle(3, 12, 1.6, 10)] },
  '/': { advance: 8, strokes: [[0, 0, 8, 14]] },
  '(': { advance: 6, strokes: [[4.4, 14, 2, 11, 1, 7, 2, 3, 4.4, 0]] },
  ')': { advance: 6, strokes: [[1, 14, 3.4, 11, 4.4, 7, 3.4, 3, 1, 0]] },
  ':': { advance: 5, strokes: [dot(2.2, 0.6), dot(2.2, 8)] },
  '×': { advance: 9, strokes: [[1.6, 10, 7.4, 4.2], [1.6, 4.2, 7.4, 10]] },
  '+': { advance: 10, strokes: [[1, 7, 9, 7], [5, 3, 5, 11]] },
  '=': { advance: 10, strokes: [[1, 5, 9, 5], [1, 9, 9, 9]] },
  '!': { advance: 4, strokes: [[2, 14, 2, 4], dot(2, 0.6)] },
  '?': {
    advance: 9,
    strokes: [[0, 11, 0.8, 13, 2.8, 14, 5.6, 14, 7.8, 13, 8.6, 11, 8, 9, 6, 7.6, 4.5, 6.4, 4.5, 4.4], dot(4.5, 0.6)],
  },
  '&': {
    advance: 12,
    strokes: [[12, 0, 4, 12.2, 4.4, 13.6, 6, 14, 7.4, 13.4, 7.6, 12, 6.8, 10.4, 1.6, 6.2, 0.4, 4, 0.6, 2, 2.2, 0.4, 4.6, 0, 7, 0.6, 9.4, 2.4, 11, 5]],
  },
  '#': { advance: 11, strokes: [[3, 0, 4.6, 14], [7, 0, 8.6, 14], [0.6, 4.6, 10, 4.6], [1.4, 9.4, 10.8, 9.4]] },
  '_': { advance: 10, strokes: [[0, -2, 10, -2]] },
  '·': { advance: 5, strokes: [dot(2.2, 6.6)] },
};

/** A polyline in print millimetres. */
export type StrokePath = Array<[number, number]>;

/** One character, laid out with its own origin on the baseline at x = 0. */
export interface LaidGlyph {
  char: string;
  /** Where the glyph's pen origin sits along the run, print mm. */
  x_mm: number;
  /** The glyph's own advance, print mm. */
  advance_mm: number;
  /** Strokes in glyph-local coordinates: x from the pen origin, y from the baseline. */
  paths: StrokePath[];
}

export interface TextLayout {
  paths: StrokePath[];
  /** The same strokes, kept per character, for setting text along a curve. */
  glyphs: LaidGlyph[];
  /** Total advance, print mm. */
  width_mm: number;
  /** Cap height as laid out, print mm. */
  height_mm: number;
  /** Characters this font has no glyph for. Rendered as nothing. */
  missing: string[];
}

/**
 * Lay text out with its baseline on y = 0 and its left edge on x = 0.
 *
 * @param capHeight_mm height of a capital letter in the finished print
 */
export function layoutText(text: string, capHeight_mm: number): TextLayout {
  const scale = capHeight_mm / CAP_HEIGHT;
  const paths: StrokePath[] = [];
  const glyphs: LaidGlyph[] = [];
  const missing: string[] = [];
  let cursor = 0;

  // Upper-cased here, not by the caller, so every entry point agrees.
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS[char];
    if (!glyph) {
      if (char.trim().length > 0 && !missing.includes(char)) missing.push(char);
      // Still advance, so an unknown character leaves a gap rather than
      // silently closing up the words on either side of it.
      cursor += GLYPHS[' '].advance + TRACKING;
      continue;
    }

    const local: StrokePath[] = [];
    for (const stroke of glyph.strokes) {
      const run: StrokePath = [];
      const path: StrokePath = [];
      for (let i = 0; i < stroke.length; i += 2) {
        run.push([stroke[i] * scale, stroke[i + 1] * scale]);
        path.push([(cursor + stroke[i]) * scale, stroke[i + 1] * scale]);
      }
      if (path.length >= 2) {
        paths.push(path);
        local.push(run);
      }
    }
    glyphs.push({
      char,
      x_mm: cursor * scale,
      advance_mm: glyph.advance * scale,
      paths: local,
    });
    cursor += glyph.advance + TRACKING;
  }

  // The trailing tracking is not part of the text's width.
  const width = Math.max(0, cursor - TRACKING) * scale;
  return { paths, glyphs, width_mm: width, height_mm: capHeight_mm, missing };
}

/** Characters this font can draw, for the UI to say what it accepts. */
export function supportedCharacters(): string {
  return Object.keys(GLYPHS).filter((c) => c !== ' ').join('');
}
