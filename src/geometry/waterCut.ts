/**
 * Water as a cut-out (docs/02-feature-spec.md F6.4).
 *
 * The same idea as the route cut-out — carve the shape out of the model and
 * print a separate piece that drops into the hole — applied to lakes and rivers
 * so they can be pressed in in blue on a single-extruder printer.
 *
 * It cannot reuse `buildRouteSolid`, and the reason is worth stating because it
 * is the whole design. A route is a RIBBON: it comes from a centreline plus a
 * width, so the insert is made by shrinking that width before the distance
 * field is built, and the clearance falls out for free. Water is a SHEET —
 * arbitrary rings, often with holes for islands — and there is no width to
 * shrink. The clearance has to come from a genuine inward offset of a polygon.
 *
 * That offset is done by subtracting a COLLAR: a band of `2 x clearance`
 * straddling the water's own boundary, built by the same distance-field level
 * set the feature layers use, extruded tall and taken out of the insert with a
 * boolean. Removing a band centred on the boundary leaves the inside pulled in
 * by exactly one clearance, and it behaves correctly around holes and where two
 * lakes nearly touch — which a naive mitre inset does not.
 */
import { extrudeDraped, type SolidMesh } from './extrude';
import { buildRibbonField } from './ribbonField';
import { pointInRing } from './route';
import type { MultiPolygon, Ring } from './polygons';
import type { ResolvedScale } from './coords';

const EMPTY: SolidMesh = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangles: 0,
};

export interface WaterCutOptions {
  /** How far below the lowest water the basin floor sits, print mm. */
  depth_mm: number;
  /** How far the insert stands out of the basin once seated, print mm. */
  proud_mm: number;
  /** Absolute Z for the top of the cutting tool, print mm. */
  toolTop_mm: number;
  baseThickness_mm: number;
  scale: ResolvedScale;
  /** Terrain sample spacing, so a draped face carries enough vertices. */
  terrainStep_m: number;
  /**
   * World position of the heightfield's first grid node.
   *
   * So the interior search can land ON the DEM's own nodes. The terrain is
   * bilinear between them, and a bilinear patch takes its minimum at a corner,
   * so sampling the nodes finds the true lowest ground exactly. A grid of the
   * right spacing but the wrong phase does not: it steps straight over the low
   * point and reports a floor that leaves ground standing in the basin.
   */
  gridOrigin_m: [number, number];
  /** Height of the ground at a point, print mm. */
  drapeZ: (x_m: number, y_m: number) => number;
}

export interface WaterCutResult {
  /** The tool that carves the basin. Enclose everything it passes through. */
  tool: SolidMesh;
  /** The piece that seats in it, BEFORE clearance is taken off. */
  insert: SolidMesh;
  /** A band straddling the boundary; subtract it from the insert for clearance. */
  collar: SolidMesh;
  /** The flat floor both share, print mm. */
  floor_mm: number;
}

/** Whether a point is inside the sheet: in an outer ring and in no hole. */
function insideFootprint(footprint: MultiPolygon, x: number, y: number): boolean {
  for (const polygon of footprint) {
    const [outer, ...holes] = polygon;
    if (!outer || !pointInRing(x, y, outer)) continue;
    let inHole = false;
    for (const hole of holes) {
      if (pointInRing(x, y, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * Lowest ground ANYWHERE under a footprint, print mm.
 *
 * The interior matters, not just the outline. A route can be sampled along its
 * centreline because a ribbon is narrow; a lake is an area, and on ground that
 * dishes towards the middle the lowest point is nowhere near the edge.
 *
 * Sampling the boundary alone put the basin floor ABOVE the terrain in the
 * middle of a bowl — the cutting tool then left a lump of ground standing
 * inside the basin, and the flat-bottomed insert sat on it instead of seating.
 * Found by a test on a dished heightfield; the boundary walk is kept as well,
 * because a narrow inlet can slip between grid samples entirely.
 */
function lowestGround_mm(
  footprint: MultiPolygon,
  drapeZ: (x_m: number, y_m: number) => number,
  step_m: number,
  gridOrigin_m: [number, number],
): number {
  let lowest = Infinity;
  const step = Math.max(step_m, 1e-6);

  // The outline, densely.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const polygon of footprint) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (a[0] < minX) minX = a[0];
        if (a[0] > maxX) maxX = a[0];
        if (a[1] < minY) minY = a[1];
        if (a[1] > maxY) maxY = a[1];

        const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(1, Math.ceil(span / step));
        for (let k = 0; k < steps; k++) {
          const t = k / steps;
          const z = drapeZ(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
          if (z < lowest) lowest = z;
        }
      }
    }
  }
  if (!Number.isFinite(minX)) return lowest;

  // The interior, on the terrain's own grid — snapped to its NODES, not merely
  // spaced like them. The ground between nodes is interpolated from them, so
  // the nodes are where the true minimum is.
  const snap = (v: number, origin: number) => origin + Math.floor((v - origin) / step) * step;

  for (let y = snap(minY, gridOrigin_m[1]); y <= maxY + step; y += step) {
    for (let x = snap(minX, gridOrigin_m[0]); x <= maxX + step; x += step) {
      if (!insideFootprint(footprint, x, y)) continue;
      const z = drapeZ(x, y);
      if (z < lowest) lowest = z;
    }
  }

  return lowest;
}

/** Every ring of the footprint as a closed polyline, for the collar. */
function boundaryLines(footprint: MultiPolygon): Ring[] {
  const lines: Ring[] = [];
  for (const polygon of footprint) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      // Closed explicitly: an open outline leaves the collar with a gap at the
      // seam, and the clearance disappears exactly there.
      const closed: Ring = ring[0] === ring[ring.length - 1] ? ring : [...ring, ring[0]];
      lines.push(closed);
    }
  }
  return lines;
}

/**
 * Build the basin cutter, the insert, and the clearance collar.
 *
 * All three share one floor. That is not tidiness: an insert whose underside
 * sits at a different height from the basin it drops into either floats or
 * bottoms out, and a floor computed twice from two samplings of the same
 * terrain is two different numbers (OPEN-QUESTIONS Q10, resolved the same way
 * for the route).
 *
 * @param footprint the water sheet in WORLD METRES, as `buildPolygonLayer` made it
 * @param clearance_mm gap per side between insert and basin
 */
export function buildWaterCut(
  footprint: MultiPolygon,
  clearance_mm: number,
  options: WaterCutOptions,
): WaterCutResult | null {
  if (footprint.length === 0) return null;

  const { scale, drapeZ, terrainStep_m } = options;
  const toPrintXY = (x_m: number, y_m: number): [number, number] => [
    x_m * scale.scale,
    y_m * scale.scale,
  ];

  const lowest = lowestGround_mm(footprint, drapeZ, terrainStep_m, options.gridOrigin_m);
  if (!Number.isFinite(lowest)) return null;

  // The floor may go below the build plate on a thin base. That is the same
  // trade the route channel makes, and the base-thickness check already warns
  // about it; clamping here instead would silently give a shallower basin than
  // asked for, which is worse because nothing says so.
  const floor_mm = lowest - options.depth_mm;

  const flat = (bottom: number, top: number) => ({
    height_mm: 0,
    penetration_mm: 0,
    // A cutting tool is exempt from the base floor: it is removed, not printed.
    minBottom_mm: -Infinity,
    maxEdge_m: terrainStep_m,
    flatBottom_mm: bottom,
    flatTop_mm: top,
  });

  // The tool reaches from the floor to above everything built, so the basin is
  // carved through the terrain and through anything standing on it.
  const tool = extrudeDraped(footprint, drapeZ, toPrintXY, flat(floor_mm, options.toolTop_mm));

  // The insert fills the basin and stands `proud_mm` out of it. Its top is
  // FLAT, not draped: a lake surface is level, which is the one place in this
  // model where following the terrain would be wrong.
  const insert = extrudeDraped(
    footprint,
    drapeZ,
    toPrintXY,
    flat(floor_mm, lowest + options.proud_mm),
  );

  const collar = buildCollar(footprint, clearance_mm, options, floor_mm);

  return { tool, insert, collar, floor_mm };
}

/**
 * A band of `2 x clearance` straddling the water's boundary, extruded tall.
 *
 * Subtracted from the insert it pulls the insert in by exactly one clearance
 * everywhere — around the outside, around every island hole, and between two
 * lakes that nearly touch. Extruded well past the insert in both directions so
 * the subtraction is a clean vertical cut with no coincident faces.
 */
function buildCollar(
  footprint: MultiPolygon,
  clearance_mm: number,
  options: WaterCutOptions,
  floor_mm: number,
): SolidMesh {
  if (!(clearance_mm > 0)) return EMPTY;

  const { scale, drapeZ, terrainStep_m } = options;
  const lines = boundaryLines(footprint);
  if (lines.length === 0) return EMPTY;

  const width_m = (2 * clearance_mm) / scale.scale;
  if (!(width_m > 0)) return EMPTY;

  const band = buildRibbonField(lines, width_m, null);
  if (band.polygons.length === 0) return EMPTY;

  const toPrintXY = (x_m: number, y_m: number): [number, number] => [
    x_m * scale.scale,
    y_m * scale.scale,
  ];

  return extrudeDraped(band.polygons, drapeZ, toPrintXY, {
    height_mm: 0,
    penetration_mm: 0,
    minBottom_mm: -Infinity,
    maxEdge_m: terrainStep_m,
    // Past the insert at both ends, so nothing is coincident with its faces.
    flatBottom_mm: floor_mm - 5,
    flatTop_mm: options.toolTop_mm,
  });
}
