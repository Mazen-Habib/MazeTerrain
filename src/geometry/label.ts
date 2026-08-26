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
 * The tool is built entirely in print millimetres. Everything else in this
 * codebase works in world metres and converts on the way out, but a label is
 * specified in millimetres of cap height on a millimetre-high frame — routing
 * that through a world-metre scale and back would only add a place to get the
 * conversion wrong.
 */
import { buildRibbonField } from './ribbonField';
import { extrudeDraped, type SolidMesh } from './extrude';
import { layoutText } from './strokeFont';
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

export interface LabelOptions {
  /** Height of a capital letter, print mm. */
  capHeight_mm: number;
  /** How deep the groove cuts below the surface, print mm. */
  depth_mm: number;
  /** Groove width. One nozzle is the narrowest thing the printer can lay. */
  strokeWidth_mm: number;
  /** Absolute Z of the surface being cut into, print mm. */
  surfaceZ_mm: number;
  /** The text is centred on this X, print mm. */
  centreX_mm: number;
  /** Baseline sits here, print mm. */
  baselineY_mm: number;
}

export interface LabelResult {
  /** A cutting tool, to subtract from whatever it is engraved into. */
  mesh: SolidMesh;
  /** Laid-out width, print mm. */
  width_mm: number;
  /** Characters the font has no glyph for. */
  missing: string[];
}

export function buildLabelTool(text: string, options: LabelOptions): LabelResult {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !(options.capHeight_mm > 0) || !(options.depth_mm > 0)) {
    return { mesh: EMPTY, width_mm: 0, missing: [] };
  }

  const laid = layoutText(trimmed, options.capHeight_mm);
  if (laid.paths.length === 0) return { mesh: EMPTY, width_mm: laid.width_mm, missing: laid.missing };

  const left = options.centreX_mm - laid.width_mm / 2;
  const placed = laid.paths.map((path) =>
    path.map(([x, y]) => [left + x, options.baselineY_mm + y] as [number, number]),
  );

  const strokes = buildRibbonField(
    placed,
    Math.max(options.strokeWidth_mm, 1e-3),
    null,
    CELLS_PER_HALF_WIDTH,
  );
  if (strokes.polygons.length === 0) {
    return { mesh: EMPTY, width_mm: laid.width_mm, missing: laid.missing };
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

  return { mesh, width_mm: laid.width_mm, missing: laid.missing };
}

/**
 * Where the text sits, and how much of it lands on the surface it is cut into.
 *
 * Text that overruns the plaque engraves into thin air: the subtract removes
 * nothing there, so the model comes out with half a caption and no complaint
 * from any other check. This is what lets `assemble` say so.
 *
 * @returns the share of sampled stroke points that fall on the surface
 */
export function labelCoverage(
  text: string,
  options: LabelOptions,
  surface: MultiPolygon,
): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 1;

  const laid = layoutText(trimmed, options.capHeight_mm);
  if (laid.paths.length === 0) return 1;

  const left = options.centreX_mm - laid.width_mm / 2;
  let on = 0;
  let total = 0;

  for (const path of laid.paths) {
    for (const [x, y] of path) {
      total++;
      if (inMultiPolygon(left + x, options.baselineY_mm + y, surface)) on++;
    }
  }

  return total === 0 ? 1 : on / total;
}

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
