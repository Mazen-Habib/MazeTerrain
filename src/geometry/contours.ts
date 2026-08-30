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

/**
 * An elevation interval whose rings will actually read as separate lines.
 *
 * A fixed interval cannot work: whether 50 m rings are legible depends entirely
 * on how steep the ground is and how large the model is. On a slope of gradient
 * `g`, successive rings at interval `I` sit `I / g` apart horizontally, so once
 * `I / g` drops below the ribbon width the rings touch and merge. Measured on
 * real mountain terrain at 34 km, a fixed 50 m interval fused 49 rings into a
 * crust covering 86% of the plate — not contour lines, a rough-textured slab.
 * See docs/08-pitfalls.md#contours-merge-into-a-crust.
 *
 * Two constraints, whichever is larger:
 *
 *  - horizontal, so neighbouring rings keep a gap of about their own width;
 *  - vertical, so a ring does not stand taller than the gap to the ring above
 *    and simply bury it.
 *
 * The horizontal one is taken at a high percentile of slope rather than the
 * maximum, because a single cliff would otherwise push the interval so coarse
 * that the rest of the model loses its contours entirely.
 *
 * @param width_m       ribbon width in world metres
 * @param zScale        print mm per real metre of elevation
 * @param lineHeight_mm how far a ring stands proud
 */
export function suggestInterval(
  hf: Heightfield,
  width_m: number,
  zScale: number,
  lineHeight_mm: number,
): number {
  const { cols, rows, data, spacingX_m, spacingY_m } = hf;

  // Slope magnitude by central differences, subsampled: this runs on every
  // build and a full pass over a large grid buys no extra accuracy.
  const step = Math.max(1, Math.floor(Math.min(cols, rows) / 128));
  const slopes: number[] = [];
  for (let j = step; j < rows - step; j += step) {
    for (let i = step; i < cols - step; i += step) {
      const dzdx = (data[j * cols + i + step] - data[j * cols + i - step]) / (2 * step * spacingX_m);
      const dzdy = (data[(j + step) * cols + i] - data[(j - step) * cols + i]) / (2 * step * spacingY_m);
      const g = Math.hypot(dzdx, dzdy);
      if (Number.isFinite(g)) slopes.push(g);
    }
  }

  let gradient = 0;
  if (slopes.length > 0) {
    slopes.sort((a, b) => a - b);
    gradient = slopes[Math.floor(slopes.length * SLOPE_PERCENTILE)];
  }

  // Ring plus a gap of the same width.
  const horizontal_m = gradient * width_m * 2;
  // A ring must not be taller than the gap to its neighbour.
  const vertical_m = zScale > 0 ? (lineHeight_mm * 2) / zScale : 0;

  const wanted = Math.max(horizontal_m, vertical_m, 1);

  // Round up to a number a map would use, so the label reads 100 m, not 87 m.
  const magnitude = 10 ** Math.floor(Math.log10(wanted));
  for (const step_ of NICE_STEPS) {
    const candidate = step_ * magnitude;
    if (candidate >= wanted) return candidate;
  }
  return 10 * magnitude;
}

/**
 * Intervals a map would actually print. Coarse enough to read as round numbers,
 * fine enough that rounding up does not double the interval it was asked for.
 */
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];

/**
 * Slope percentile the horizontal spacing is sized against. The steepest ground
 * always merges; sizing for the 75th percentile keeps three quarters of the
 * model legible without letting one cliff dictate the whole map.
 */
const SLOPE_PERCENTILE = 0.75;

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

/**
 * Quantise a heightfield into flat steps (docs/02-feature-spec.md F3.1).
 *
 * This is the OTHER way to put contours on a model, and on the evidence the one
 * people actually mean. Tracing isolines and extruding them as ribbons gives
 * technically-correct contour lines that read as a plate of spaghetti — the
 * same machinery builds them as builds roads, and on a print they look like
 * roads, wandering across the slope and climbing over each other.
 *
 * A terraced model instead does what a laser-cut plywood relief map does: it
 * rounds every elevation DOWN to the level below it, so the terrain becomes a
 * stack of flat shelves with a riser between each pair. There are no lines to
 * draw — the step edge IS the contour, and it is legible from across a room.
 *
 * The whole heightfield is quantised, before anything is meshed or draped, so
 * routes and features sit on the terraced ground rather than floating over the
 * smooth surface it used to be. One transform, and everything downstream
 * inherits it.
 *
 * Levels sit at multiples of the interval, like `contourLevels`, so bands break
 * at 500, 550, 600 — the numbers a map would use.
 *
 * The riser between two shelves is one grid cell wide rather than truly
 * vertical, because the surface is still a grid. At the resolutions this app
 * builds at, a cell is a fraction of a nozzle width, so it prints as a step.
 * Making the risers exactly vertical would mean inserting the contour polygons
 * into the triangulation as constraints, which is a different and much larger
 * piece of work for a difference no print would show.
 *
 * Mutates `hf` in place and updates its min/max, which the caller needs because
 * the terraced range is up to one interval shorter than the original and the
 * vertical scale is computed from it.
 */
export function terraceHeightfield(hf: Heightfield, interval_m: number): number {
  if (!(interval_m > 0)) return 0;

  const { data } = hf;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < data.length; i++) {
    const stepped = Math.floor(data[i] / interval_m) * interval_m;
    data[i] = stepped;
    if (stepped < min) min = stepped;
    if (stepped > max) max = stepped;
  }

  if (Number.isFinite(min) && Number.isFinite(max)) {
    hf.min_m = min;
    hf.max_m = max;
  }

  // How many distinct shelves the model ends up with — the number worth telling
  // the user, because one shelf is a plateau and forty is a corduroy texture.
  return Math.max(1, Math.round((max - min) / interval_m) + 1);
}

/**
 * How many shelves a terraced model wants.
 *
 * The reference for this look is a laser-cut plywood relief map, and those are
 * cut from eight to fifteen sheets. Fewer reads as a wedding cake; many more
 * and the steps shrink below what an FDM printer can show and it goes back to
 * looking smooth.
 */
const TARGET_SHELVES = 12;

/**
 * An elevation interval for TERRACING, which is not the one for lines.
 *
 * `suggestInterval` sizes the step so that traced rings stay a ribbon-width
 * apart horizontally — that is what keeps thin lines from fusing into a crust.
 * A terrace has no such problem: a shelf is a wide flat area, and two shelves
 * being close together horizontally is just a steep slope, which is fine and
 * true. Reusing the line interval gave three shelves on a real build where the
 * reference look has ten.
 *
 * The binding constraint is vertical instead: a step under about two layer
 * heights does not read as a step. So aim for `TARGET_SHELVES` bands and raise
 * the interval only if that would make the steps too shallow to print.
 */
export function suggestTerraceInterval(
  min_m: number,
  max_m: number,
  zScale: number,
  layerHeight_mm: number,
): number {
  const range_m = max_m - min_m;
  if (!(range_m > 0)) return 0;

  const wanted = range_m / TARGET_SHELVES;
  // Two layers is the smallest step that reads as one rather than as texture.
  const floor_m = zScale > 0 ? (2 * layerHeight_mm) / zScale : 0;

  return niceStep(Math.max(wanted, floor_m));
}

/**
 * Round up to a number a map would print.
 *
 * The same ladder `suggestInterval` uses, so a terraced model and a lined one
 * break at the same elevations and the two are directly comparable.
 */
function niceStep(raw_m: number): number {
  if (!(raw_m > 0)) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw_m)));
  for (const step of NICE_STEPS) {
    const candidate = step * magnitude;
    if (candidate >= raw_m) return candidate;
  }
  return 10 * magnitude;
}
