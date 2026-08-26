/**
 * Picture frame (docs/02-feature-spec.md F5).
 *
 * A flat-topped rim running round the inside of the model's own boundary. It
 * gives the print a clean edge, and its top face is the flat area a label is
 * engraved into (F5.1).
 *
 * Inside the boundary, not outside it: `modelWidth_mm` is documented as the
 * longest edge of the printed model, and a frame added on the outside would
 * quietly make a "100 mm" model 116 mm and fail a bed check for a reason the
 * user could not see. Covering the outermost band of terrain costs the least
 * interesting part of the map and keeps that promise honest.
 *
 * The band is traced as a distance-field level set of the boundary, clipped to
 * the boundary — the same machinery roads and contours use. That is what makes
 * it work for a hand-drawn polygon and a circle, not just a rectangle. Inner
 * corners come out rounded by the band's own width, which is what a routed
 * wooden frame looks like anyway.
 *
 * OPEN-QUESTIONS Q15 (resolved 2026-08-27): there is no separate "brim". A brim
 * is a bed-adhesion setting and belongs to the slicer; a narrow frame is the
 * decorative lip the spec called one.
 */
import { buildRibbonField } from './ribbonField';
import { clipMultiPolygonToRing } from './clip';
import { extrudeDraped, type SolidMesh } from './extrude';
import type { Ring } from './polygons';
import type { ResolvedScale } from './coords';

/** Cells across half the band. Six is what the feature layers use. */
const CELLS_PER_HALF_WIDTH = 6;

const EMPTY: SolidMesh = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangles: 0,
};

export interface FrameOptions {
  /** Band width, print mm. */
  width_mm: number;
  /** How far the top face stands above the lowest ground, print mm. */
  height_mm: number;
  baseThickness_mm: number;
  scale: ResolvedScale;
}

export interface FrameResult {
  mesh: SolidMesh;
  /** Absolute Z of the frame's top face, print mm. */
  top_mm: number;
}

/**
 * @param ring the model's outer boundary, in world metres
 */
export function buildFrame(ring: Ring, options: FrameOptions): FrameResult {
  // The lowest terrain sits on top of the base slab, so that is what a frame
  // height is measured from — not the build plate, and not the highest peak.
  const top_mm = options.baseThickness_mm + options.height_mm;

  if (ring.length < 3 || !(options.width_mm > 0) || !(options.height_mm > 0)) {
    return { mesh: EMPTY, top_mm };
  }

  const width_m = options.width_mm / options.scale.scale;
  if (!Number.isFinite(width_m) || width_m <= 0) return { mesh: EMPTY, top_mm };

  // Closed explicitly: an open polyline would leave the band unmitred at the
  // point where the boundary meets itself.
  const closed: Ring = ring[0] === ring[ring.length - 1] ? ring : [...ring, ring[0]];

  // Traced at twice the width, straddling the boundary, then cut back to the
  // boundary EXACTLY. Not with the ribbon field's own selection clip: that one
  // drops whole cells, and its cell here is a sixth of the frame width — 1.3 mm
  // on an 8 mm frame, which on an outside edge is plainly visible. It is well
  // under a nozzle for a road, which is the case it was written for.
  //
  // The inner edge needs none of this. It is a level set between two finite
  // distances, so marching squares interpolates it smoothly.
  const band = buildRibbonField([closed], width_m * 2, null, CELLS_PER_HALF_WIDTH);
  const polygons = clipMultiPolygonToRing(band.polygons, ring);
  if (polygons.length === 0) return { mesh: EMPTY, top_mm };

  const mesh = extrudeDraped(
    polygons,
    // Never consulted: both faces are flat, so nothing drapes.
    () => top_mm,
    (x_m, y_m) => [x_m * options.scale.scale, y_m * options.scale.scale],
    {
      height_mm: options.height_mm,
      penetration_mm: 0,
      minBottom_mm: 0,
      // No refinement. Every other draped feature needs a bounded edge length
      // so the terrain cannot punch through it
      // (docs/08-pitfalls.md#undraped-features-let-terrain-through); a prism
      // with two flat faces has no drape to follow, and subdividing it would
      // only multiply triangles across a face that is exactly planar.
      maxEdge_m: Infinity,
      // Down to the build plate: the frame is part of the base, not something
      // resting on it.
      flatBottom_mm: 0,
      flatTop_mm: top_mm,
    },
  );

  return { mesh, top_mm };
}

/**
 * How much of the boundary band the terrain stands above.
 *
 * A frame lower than the ground it runs through is not a frame — the terrain
 * simply pokes over it. Reported as a fraction so `assemble` can say whether
 * that is a peak touching the edge or the whole rim being buried.
 *
 * @returns the share of sampled boundary points whose ground is above the
 *          frame's top face, and the worst overshoot in print mm
 */
export function frameSubmersion(
  ring: Ring,
  groundZ: (x_m: number, y_m: number) => number,
  top_mm: number,
  step_m: number,
): { fraction: number; worst_mm: number } {
  if (ring.length < 2 || !(step_m > 0)) return { fraction: 0, worst_mm: 0 };

  let over = 0;
  let total = 0;
  let worst = 0;

  // ALONG each edge, not just at its ends. A rectangular selection is a ring of
  // four points: sampling only those tests the corners of the model and calls
  // an entire buried edge clear.
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    const length = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(length / step_m));

    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const above = groundZ(ax + (bx - ax) * t, ay + (by - ay) * t) - top_mm;
      total++;
      if (above > 0) {
        over++;
        if (above > worst) worst = above;
      }
    }
  }

  return total === 0 ? { fraction: 0, worst_mm: 0 } : { fraction: over / total, worst_mm: worst };
}
