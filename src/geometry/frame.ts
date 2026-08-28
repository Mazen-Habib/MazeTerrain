/**
 * Picture frame (docs/02-feature-spec.md F5).
 *
 * A flat-topped rim running round the inside of the model's own boundary. It
 * gives the print a clean edge, and its top face is the flat area a label is
 * engraved into (F5.1).
 *
 * OUTSIDE the boundary, added to the model rather than taken out of it.
 *
 * It was built inside first, on the reasoning that `modelWidth_mm` is
 * documented as the longest edge of the print and a frame outside would make a
 * "100 mm" model 125 mm. That was the wrong trade: a 12.5 mm frame ate a
 * quarter of the map on every side, which is the part of the model people
 * actually want. The map keeps its full size and the frame surrounds it, the
 * way a frame surrounds a picture. Reported dimensions are measured across
 * every part, so the extra size shows up honestly in the stats and in the bed
 * check rather than being hidden.
 *
 * The band comes from a distance-field level set of the boundary, which for a
 * closed loop is an annulus: its outer contour is the boundary offset outward
 * by the frame width, and that is exactly the frame's outer edge. Pairing that
 * contour with the boundary itself as a hole gives the band with no polygon
 * offsetting code and no boolean, and it works for a hand-drawn polygon and a
 * circle rather than only a rectangle.
 *
 * OPEN-QUESTIONS Q15 (resolved 2026-08-27): there is no separate "brim". A brim
 * is a bed-adhesion setting and belongs to the slicer; a narrow frame is the
 * decorative lip the spec called one.
 */
import { buildRibbonField } from './ribbonField';
import { extrudeDraped, type SolidMesh } from './extrude';
import type { MultiPolygon, Ring } from './polygons';
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
  /**
   * The band's footprint in PRINT millimetres.
   *
   * Returned so the label can ask whether its strokes actually land on the
   * plaque. Converted here rather than by the caller, because this is the one
   * place that knows the band is in world metres.
   */
  footprint_mm: MultiPolygon;
}

/**
 * @param ring the model's outer boundary, in world metres
 */
export function buildFrame(ring: Ring, options: FrameOptions): FrameResult {
  // The lowest terrain sits on top of the base slab, so that is what a frame
  // height is measured from — not the build plate, and not the highest peak.
  const top_mm = options.baseThickness_mm + options.height_mm;

  if (ring.length < 3 || !(options.width_mm > 0) || !(options.height_mm > 0)) {
    return { mesh: EMPTY, top_mm, footprint_mm: [] };
  }

  const width_m = options.width_mm / options.scale.scale;
  if (!Number.isFinite(width_m) || width_m <= 0) return { mesh: EMPTY, top_mm, footprint_mm: [] };

  // Closed explicitly: an open polyline would leave the band unmitred at the
  // point where the boundary meets itself.
  const closed: Ring = ring[0] === ring[ring.length - 1] ? ring : [...ring, ring[0]];

  // The outer edge is the boundary pushed out by the frame width, MITRED.
  //
  // A distance-field level set gives a true parallel offset, which rounds every
  // convex corner by construction — a rectangular map came out with rounded
  // outer corners against square inner ones, which is not what a picture frame
  // looks like. Mitring carries the corner to a point instead. On a circle
  // sampled at 180 points every turn is barely a degree, so the two agree.
  //
  // The level set is still the fallback: a miter self-intersects on a boundary
  // that turns back on itself hard enough, and a rounded corner beats a
  // tangled one.
  let outer = mitreOutward(ring, width_m);
  if (!outer) {
    const band = buildRibbonField([closed], width_m * 2, null, CELLS_PER_HALF_WIDTH);
    outer = largestContour(band.polygons);
  }
  if (!outer) return { mesh: EMPTY, top_mm, footprint_mm: [] };

  const polygons: MultiPolygon = [[outer, ring]];

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

  const footprint_mm: MultiPolygon = polygons.map((polygon) =>
    polygon.map((ring) => ring.map(([x, y]) => [x * options.scale.scale, y * options.scale.scale] as [number, number])),
  );

  return { mesh, top_mm, footprint_mm };
}

/**
 * How far a mitred corner may run out before it is cut off, in frame widths.
 *
 * A corner sharper than about 30 degrees sends its miter point off towards
 * infinity; past this it is bevelled instead, which is what every stroke
 * renderer does and what a real mitre saw would do.
 */
const MITRE_LIMIT = 4;

/** Twice the signed area. Positive means counter-clockwise. */
function signedArea2(ring: Ring): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    total += a[0] * b[1] - b[0] * a[1];
  }
  return total;
}

/**
 * Push a ring outward by `distance`, carrying corners to a point.
 *
 * @returns the offset ring, or null if it crosses itself and cannot be used
 */
function mitreOutward(ring: Ring, distance: number): Ring | null {
  const n = ring.length;
  if (n < 3 || !(distance > 0)) return null;

  // Which side is "out" follows from the winding, not from a centroid test: a
  // centroid is outside its own polygon often enough on a hand-drawn shape.
  const sign = signedArea2(ring) > 0 ? 1 : -1;

  /** Outward unit normal of the edge leaving vertex i. */
  const edgeNormal = (i: number): [number, number] | null => {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return null;
    return [(dy / len) * sign, (-dx / len) * sign];
  };

  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const before = edgeNormal((i - 1 + n) % n);
    const after = edgeNormal(i);
    if (!before || !after) continue;

    let mx = before[0] + after[0];
    let my = before[1] + after[1];
    const len = Math.hypot(mx, my);
    if (len < 1e-9) {
      // A perfect reversal: there is no miter, only two opposed faces.
      out.push([ring[i][0] + before[0] * distance, ring[i][1] + before[1] * distance]);
      out.push([ring[i][0] + after[0] * distance, ring[i][1] + after[1] * distance]);
      continue;
    }
    mx /= len;
    my /= len;

    // The miter runs along the bisector, far enough that both offset faces meet.
    const cos = mx * before[0] + my * before[1];
    const reach = distance / Math.max(cos, 1e-6);
    if (reach > distance * MITRE_LIMIT) {
      out.push([ring[i][0] + before[0] * distance, ring[i][1] + before[1] * distance]);
      out.push([ring[i][0] + after[0] * distance, ring[i][1] + after[1] * distance]);
    } else {
      out.push([ring[i][0] + mx * reach, ring[i][1] + my * reach]);
    }
  }

  if (out.length < 3 || selfIntersects(out)) return null;
  return out;
}

/** Does any pair of non-adjacent edges cross? */
function selfIntersects(ring: Ring): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      // Skip the pair that shares the closing vertex.
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(a1, a2, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

function segmentsCross(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
): boolean {
  const d = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  // Strictly opposite sides on both tests: touching at an endpoint is not a
  // crossing, and offset rings touch at endpoints all the time.
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * The outermost contour among a set of polygons, by absolute area.
 *
 * The level set can produce more than one piece on a boundary that pinches;
 * the frame's outer edge is the largest of them.
 */
function largestContour(polygons: MultiPolygon): Ring | null {
  let best: Ring | null = null;
  let bestArea = 0;
  for (const polygon of polygons) {
    const ring = polygon[0];
    if (!ring || ring.length < 3) continue;
    let twice = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      twice += p[0] * q[1] - q[0] * p[1];
    }
    const area = Math.abs(twice / 2);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  return best;
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
