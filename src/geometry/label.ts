/**
 * Engraved label (docs/02-feature-spec.md F5.1).
 *
 * The spec says "recessed, not raised, and readable from the top", and that
 * pins down where it goes: into the **frame's** top face. The other candidate
 * surface, the base, is the underside of the model — text there is read from
 * below and has to be mirrored, which is the trap documented at
 * `08-pitfalls.md#engraved-text-mirrored`. Requiring the frame sidesteps it
 * entirely and guarantees a flat surface to cut into, which the terrain is not.
 *
 * The text is set **along the frame**, not across a straight line drawn under
 * it. A circular model has no straight bottom edge, so straight-line text ran
 * off the band at both ends and read as if the model were a rectangle. Each
 * character is placed rigidly on the band's centreline — rotated to the local
 * tangent, upright with its top toward the model — which is the same layout on
 * a rectangle's straight bottom edge and follows the curve on anything else.
 *
 * Everything here is in print millimetres. The rest of the codebase works in
 * world metres and converts on the way out, but a label is specified in
 * millimetres of cap height on a millimetre-high frame; routing that through a
 * world-metre scale and back would only add a place to get the conversion
 * wrong.
 */
import { buildRibbonField } from './ribbonField';
import { extrudeDraped, type SolidMesh } from './extrude';
import { CAP_HEIGHT, layoutText } from './strokeFont';
import type { MultiPolygon, Ring } from './polygons';

const EMPTY: SolidMesh = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangles: 0,
};

/** Cells across half a stroke. Matches the feature layers. */
const CELLS_PER_HALF_WIDTH = 6;

/** How far the tool stands above the surface, so the subtract breaks through it. */
const BREAKTHROUGH_MM = 1;

/**
 * Default stroke weight as a fraction of cap height.
 *
 * A hairline is what a single-stroke font gives you if you let it: 0.4 mm of
 * groove on a 100 mm model is 0.4% of the width, invisible on screen and barely
 * there in the print. A seventh of the cap height is a normal bold text weight
 * and is what the eye expects a letter to look like.
 */
const AUTO_WEIGHT = 1 / 7;

/**
 * Heaviest a stroke may be relative to cap height. Past this the counters of B,
 * R and 8 close up and the letters weld into each other.
 */
const MAX_WEIGHT = 1 / 4.5;

/** Resample step along the frame, print mm. Fine enough that a curve reads as one. */
const PATH_STEP_MM = 0.25;

export interface LabelOptions {
  /** Height of a capital letter, print mm. */
  capHeight_mm: number;
  /** How deep the groove cuts below the surface, print mm. */
  depth_mm: number;
  /** Groove width, or 'auto' for a weight proportional to the cap height. */
  strokeWidth_mm: number | 'auto';
  /** Never thinner than this, whatever is asked for. One nozzle. */
  minStrokeWidth_mm: number;
  /** Absolute Z of the surface being cut into, print mm. */
  surfaceZ_mm: number;
}

/**
 * The curve the text is set on: the centreline of the frame band, starting at
 * the bottom of the model and running left to right.
 */
export interface Baseline {
  points: Array<[number, number]>;
  /** Unit tangent at each point, in reading direction. */
  tangents: Array<[number, number]>;
  /** Unit normal at each point, pointing "up" for the text (towards the model). */
  normals: Array<[number, number]>;
  /** Cumulative arc length at each point, print mm. */
  lengths: number[];
  /** Arc length of the bottom-centre point, where the text is centred. */
  centre_mm: number;
  /** Total length of the curve, print mm. */
  total_mm: number;
}

/**
 * Resolve the stroke width actually used.
 *
 * Exported because the UI shows it: a control that says 'auto' has to be able
 * to say what auto came out as.
 */
export function resolveStrokeWidth_mm(options: LabelOptions): number {
  const wanted =
    options.strokeWidth_mm === 'auto'
      ? options.capHeight_mm * AUTO_WEIGHT
      : options.strokeWidth_mm;

  return Math.max(
    options.minStrokeWidth_mm,
    Math.min(wanted, options.capHeight_mm * MAX_WEIGHT),
  );
}

/**
 * Build the baseline from the model's boundary.
 *
 * @param ring     the model boundary in PRINT mm
 * @param offset_mm how far outside the boundary the baseline sits
 */
export function buildBaseline(ring: Ring, offset_mm: number): Baseline | null {
  if (ring.length < 3) return null;

  // Resample so a curve is followed rather than cut across, and so arc length
  // means something on a boundary whose vertices are unevenly spaced.
  const dense: Array<[number, number]> = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.round(span / PATH_STEP_MM));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  if (dense.length < 3) return null;

  let cx = 0;
  let cy = 0;
  for (const [x, y] of dense) {
    cx += x;
    cy += y;
  }
  cx /= dense.length;
  cy /= dense.length;

  // Where the text is centred: the bottom of the model. Among the points at the
  // bottom, the one nearest the centre line — on a rectangle that is the middle
  // of the bottom edge, on a circle the lowest point.
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of dense) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const band = Math.max(PATH_STEP_MM, (maxY - minY) * 0.001);
  let start = 0;
  let bestDx = Infinity;
  for (let i = 0; i < dense.length; i++) {
    if (dense[i][1] > minY + band) continue;
    const dx = Math.abs(dense[i][0] - cx);
    if (dx < bestDx) {
      bestDx = dx;
      start = i;
    }
  }

  // Reading direction is left to right at that point. The boundary's winding is
  // whatever the selection happened to produce, so check and reverse if needed.
  const ahead = dense[(start + 1) % dense.length];
  if (ahead[0] - dense[start][0] < 0) {
    dense.reverse();
    start = dense.length - 1 - start;
  }

  const n = dense.length;
  const points: Array<[number, number]> = [];
  const tangents: Array<[number, number]> = [];
  const normals: Array<[number, number]> = [];

  for (let i = 0; i < n; i++) {
    const prev = dense[(i - 1 + n) % n];
    const next = dense[(i + 1) % n];
    let tx = next[0] - prev[0];
    let ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;

    // Two perpendiculars; the one pointing at the centre is "up" for the text,
    // which is what makes bottom-of-a-circle text read the right way up.
    let nx = -ty;
    let ny = tx;
    if ((cx - dense[i][0]) * nx + (cy - dense[i][1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }

    // The baseline sits OUTSIDE the boundary, so it steps against the normal.
    points.push([dense[i][0] - nx * offset_mm, dense[i][1] - ny * offset_mm]);
    tangents.push([tx, ty]);
    normals.push([nx, ny]);
  }

  const lengths: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(
      lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]),
    );
  }
  const closing = Math.hypot(
    points[0][0] - points[points.length - 1][0],
    points[0][1] - points[points.length - 1][1],
  );

  return {
    points,
    tangents,
    normals,
    lengths,
    centre_mm: lengths[start],
    total_mm: lengths[lengths.length - 1] + closing,
  };
}

/** Position, tangent and normal at an arc length, wrapping round the loop. */
function frameAt(baseline: Baseline, s_mm: number) {
  const total = baseline.total_mm;
  let s = s_mm % total;
  if (s < 0) s += total;

  // Linear scan from a proportional guess: the samples are evenly spaced by
  // construction, so the guess lands within a point or two.
  const n = baseline.points.length;
  let i = Math.min(n - 1, Math.max(0, Math.floor((s / total) * n)));
  while (i > 0 && baseline.lengths[i] > s) i--;
  while (i < n - 1 && baseline.lengths[i + 1] <= s) i++;

  return {
    point: baseline.points[i],
    tangent: baseline.tangents[i],
    normal: baseline.normals[i],
  };
}

export interface LabelResult {
  /** A cutting tool, to subtract from whatever it is engraved into. */
  mesh: SolidMesh;
  /** Laid-out width, print mm. */
  width_mm: number;
  /** The stroke width actually used, print mm. */
  strokeWidth_mm: number;
  /** Characters the font has no glyph for. */
  missing: string[];
}

/** The text's strokes, placed along the baseline, in print mm. */
export function placeText(
  text: string,
  options: LabelOptions,
  baseline: Baseline,
): { paths: Array<Array<[number, number]>>; width_mm: number; missing: string[] } {
  const laid = layoutText(text.trim(), options.capHeight_mm);
  const half = laid.width_mm / 2;
  const paths: Array<Array<[number, number]>> = [];

  for (const glyph of laid.glyphs) {
    // Each character is placed RIGIDLY at its own midpoint on the curve. Mapping
    // every stroke point to its own arc length would shear the letter, which on
    // a tight radius makes an O lean.
    const mid = glyph.x_mm + glyph.advance_mm / 2;
    const { point, tangent, normal } = frameAt(baseline, baseline.centre_mm + mid - half);

    for (const stroke of glyph.paths) {
      const out: Array<[number, number]> = [];
      for (const [gx, gy] of stroke) {
        const along = gx - glyph.advance_mm / 2;
        out.push([
          point[0] + tangent[0] * along + normal[0] * gy,
          point[1] + tangent[1] * along + normal[1] * gy,
        ]);
      }
      if (out.length >= 2) paths.push(out);
    }
  }

  return { paths, width_mm: laid.width_mm, missing: laid.missing };
}

export function buildLabelTool(
  text: string,
  options: LabelOptions,
  baseline: Baseline,
): LabelResult {
  const strokeWidth_mm = resolveStrokeWidth_mm(options);
  const trimmed = text.trim();
  if (trimmed.length === 0 || !(options.capHeight_mm > 0) || !(options.depth_mm > 0)) {
    return { mesh: EMPTY, width_mm: 0, strokeWidth_mm, missing: [] };
  }

  const placed = placeText(trimmed, options, baseline);
  if (placed.paths.length === 0) {
    return { mesh: EMPTY, width_mm: placed.width_mm, strokeWidth_mm, missing: placed.missing };
  }

  const strokes = buildRibbonField(placed.paths, strokeWidth_mm, null, CELLS_PER_HALF_WIDTH);
  if (strokes.polygons.length === 0) {
    return { mesh: EMPTY, width_mm: placed.width_mm, strokeWidth_mm, missing: placed.missing };
  }

  const mesh = extrudeDraped(
    strokes.polygons,
    () => options.surfaceZ_mm,
    // Already in print millimetres: nothing to convert.
    (x, y) => [x, y],
    {
      height_mm: BREAKTHROUGH_MM,
      penetration_mm: options.depth_mm,
      minBottom_mm: -Infinity,
      // Flat top and flat bottom, so there is no drape to follow and nothing to
      // gain from subdividing a face that is exactly planar.
      maxEdge_m: Infinity,
      flatBottom_mm: options.surfaceZ_mm - options.depth_mm,
      flatTop_mm: options.surfaceZ_mm + BREAKTHROUGH_MM,
    },
  );

  return { mesh, width_mm: placed.width_mm, strokeWidth_mm, missing: placed.missing };
}

/**
 * How much of the text lands on the surface it is cut into.
 *
 * Text that overruns the plaque engraves into thin air: the subtract removes
 * nothing there, so the model comes out with half a caption and no complaint
 * from any other check.
 */
export function labelCoverage(
  text: string,
  options: LabelOptions,
  baseline: Baseline,
  surface: MultiPolygon,
): number {
  if (text.trim().length === 0) return 1;

  const placed = placeText(text, options, baseline);
  let on = 0;
  let total = 0;
  for (const path of placed.paths) {
    for (const [x, y] of path) {
      total++;
      if (inMultiPolygon(x, y, surface)) on++;
    }
  }
  return total === 0 ? 1 : on / total;
}

/** The descender depth this font uses, as a fraction of cap height. */
export const DESCENDER_SHARE = 2.2 / CAP_HEIGHT;

/** Inside the outer ring of some polygon and outside every one of its holes. */
function inMultiPolygon(x: number, y: number, multi: MultiPolygon): boolean {
  for (const polygon of multi) {
    if (polygon.length === 0 || !inRing(x, y, polygon[0])) continue;
    let inHole = false;
    for (let h = 1; h < polygon.length; h++) {
      if (inRing(x, y, polygon[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Crossing count, the standard ray test. */
function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
