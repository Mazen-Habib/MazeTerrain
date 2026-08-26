/**
 * Contour lines (docs/02-feature-spec.md F3.1).
 *
 * Raised rings at fixed elevation steps. The spec calls them
 * "disproportionately effective on single-colour prints", and that is exactly
 * right: a monochrome terrain has only its silhouette to read relief by, and
 * contours give it the classic relief-map look back.
 *
 * These are traced here as centrelines only. Everything downstream — the
 * ribbon, the drape, the extrusion — is the machinery roads already use, so a
 * contour is built by the same code that builds a street and inherits every
 * fix made to it.
 */
import type { Pt } from '../data/gpx/simplify';
import type { Heightfield } from './heightfield';

/**
 * Elevation levels at a fixed interval, covering a heightfield's range.
 *
 * Levels sit at multiples of the interval rather than at offsets from the
 * lowest point, so 50 m contours land on 500, 550, 600 — the numbers a map
 * would use — rather than wherever the terrain happens to start.
 */
export function contourLevels(min_m: number, max_m: number, interval_m: number): number[] {
  if (!(interval_m > 0) || !(max_m > min_m)) return [];

  const first = Math.ceil(min_m / interval_m) * interval_m;
  const levels: number[] = [];
  // Guard against an interval so fine it would trace thousands of rings.
  const maxLevels = 2000;
  for (let v = first; v < max_m && levels.length < maxLevels; v += interval_m) {
    // Skip a level sitting exactly on the floor or ceiling: its contour is
    // either the whole grid or nothing, and neither is a line.
    if (v > min_m && v < max_m) levels.push(v);
  }
  return levels;
}

/** Where a value crosses `iso` between two samples, as a fraction. */
function crossing(a: number, b: number, iso: number): number {
  const d = b - a;
  if (Math.abs(d) < 1e-12) return 0.5;
  const t = (iso - a) / d;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

type Seg = [Pt, Pt];

/**
 * Marching squares over the heightfield for one elevation.
 *
 * Ambiguous saddle cases (opposite corners above, the other two below) are
 * resolved by the cell's average, which is the standard tie-break and keeps
 * neighbouring cells agreeing with each other — resolve them inconsistently and
 * the contour tears into disconnected fragments.
 */
function traceLevel(hf: Heightfield, iso: number): Seg[] {
  const { cols, rows, data, spacingX_m, spacingY_m } = hf;
  const x0 = -((cols - 1) * spacingX_m) / 2;
  const y0 = -((rows - 1) * spacingY_m) / 2;
  const segments: Seg[] = [];

  const px = (i: number) => x0 + i * spacingX_m;
  const py = (j: number) => y0 + j * spacingY_m;

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const bl = data[j * cols + i];
      const br = data[j * cols + i + 1];
      const tr = data[(j + 1) * cols + i + 1];
      const tl = data[(j + 1) * cols + i];

      const code =
        (bl > iso ? 1 : 0) | (br > iso ? 2 : 0) | (tr > iso ? 4 : 0) | (tl > iso ? 8 : 0);
      if (code === 0 || code === 15) continue;

      // Crossings on each edge, named by the side they sit on.
      const bottom: Pt = [px(i) + crossing(bl, br, iso) * spacingX_m, py(j)];
      const right: Pt = [px(i + 1), py(j) + crossing(br, tr, iso) * spacingY_m];
      const top: Pt = [px(i) + crossing(tl, tr, iso) * spacingX_m, py(j + 1)];
      const left: Pt = [px(i), py(j) + crossing(bl, tl, iso) * spacingY_m];

      switch (code) {
        case 1: case 14: segments.push([left, bottom]); break;
        case 2: case 13: segments.push([bottom, right]); break;
        case 3: case 12: segments.push([left, right]); break;
        case 4: case 11: segments.push([right, top]); break;
        case 6: case 9: segments.push([bottom, top]); break;
        case 7: case 8: segments.push([left, top]); break;
        case 5:
        case 10: {
          const average = (bl + br + tr + tl) / 4;
          const joined = code === 5 ? average > iso : average <= iso;
          if (joined) {
            segments.push([left, top], [bottom, right]);
          } else {
            segments.push([left, bottom], [right, top]);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return segments;
}

/** Round to a grid fine enough to join segments but coarse enough to tolerate float noise. */
function key(p: Pt, eps: number): string {
  return `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`;
}

/**
 * Join segments end to end into polylines.
 *
 * Contours come out as closed rings inside the grid and as open lines where
 * they meet its edge, and both are wanted: an open contour is a real contour
 * that simply leaves the model.
 */
function chain(segments: Seg[], eps: number): Pt[][] {
  const starts = new Map<string, number[]>();
  const used = new Array<boolean>(segments.length).fill(false);

  const index = (k: string, i: number) => {
    const list = starts.get(k);
    if (list) list.push(i);
    else starts.set(k, [i]);
  };
  for (let i = 0; i < segments.length; i++) {
    index(key(segments[i][0], eps), i);
    index(key(segments[i][1], eps), i);
  }

  const take = (from: string, exclude: number): number => {
    const list = starts.get(from);
    if (!list) return -1;
    for (const i of list) {
      if (i !== exclude && !used[i]) return i;
    }
    return -1;
  };

  const lines: Pt[][] = [];
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = true;

    const line: Pt[] = [segments[s][0], segments[s][1]];

    // Walk forward, then backward from the original start.
    for (let guard = 0; guard < segments.length; guard++) {
      const tail = line[line.length - 1];
      const next = take(key(tail, eps), -1);
      if (next < 0) break;
      used[next] = true;
      const [a, b] = segments[next];
      line.push(key(a, eps) === key(tail, eps) ? b : a);
    }
    for (let guard = 0; guard < segments.length; guard++) {
      const head = line[0];
      const prev = take(key(head, eps), -1);
      if (prev < 0) break;
      used[prev] = true;
      const [a, b] = segments[prev];
      line.unshift(key(a, eps) === key(head, eps) ? b : a);
    }

    if (line.length >= 2) lines.push(line);
  }

  return lines;
}

export interface ContourResult {
  /** Centrelines in world metres, ready for the ribbon builder. */
  lines: Pt[][];
  levels: number[];
}

/**
 * Trace contour centrelines across a heightfield.
 *
 * @param interval_m elevation step between rings
 */
export function traceContours(hf: Heightfield, interval_m: number): ContourResult {
  const levels = contourLevels(hf.min_m, hf.max_m, interval_m);
  if (levels.length === 0) return { lines: [], levels };

  // A quarter of a cell: fine enough that two crossings on the same grid edge
  // are never merged, coarse enough to absorb floating-point noise.
  const eps = Math.min(hf.spacingX_m, hf.spacingY_m) * 0.25;

  const lines: Pt[][] = [];
  for (const level of levels) {
    for (const line of chain(traceLevel(hf, level), eps)) {
      // A two-point stub is a single cell crossing and carries no shape.
      if (line.length >= 3) lines.push(line);
    }
  }

  return { lines, levels };
}
