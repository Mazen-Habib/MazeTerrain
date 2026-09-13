/**
 * Keychain models (docs/02-feature-spec.md F13).
 *
 * A keychain is not a new pipeline. It is the ordinary terrain model at a small
 * size, with three things done to the finished body:
 *
 *   1. its outline is a circle or a round-cornered square,
 *   2. every outer edge is filleted, and
 *   3. a hole is drilled for the split ring.
 *
 * (1) needs almost no code here — it is the selection outline, and the terrain
 * clipper, the feature clipper and the wall builder already take an arbitrary
 * ring. Handing them a round-cornered *ring* (see `modelRingLonLat` in
 * selection.ts) rather than rounding corners in 3D afterwards is the whole
 * trick: by the time the body exists its corners are already round, and
 * nothing downstream needed to learn a new case.
 *
 * (2) and (3) are here, and both are booleans against the finished body rather
 * than changes to how it is built. A fillet on an arbitrary terrain mesh is not
 * something you compute by moving vertices — the top edge of the wall follows
 * the terrain up and down, so the "edge" is a space curve, not a silhouette.
 * Intersecting with an envelope whose own profile is rounded gets it exactly
 * right, and gets it right for free at the corners and at the base.
 *
 * **Why it is worth doing at all.** The owner's reason: "the edges shouldn't be
 * very sharp in keychain models to prevent the keychains from ripping in
 * pockets". A printed terrain tile has a 90 degree arris all the way round its
 * base, in a material harder than most fabric, riding against a pocket lining
 * every time its owner sits down.
 */
import earcut from 'earcut';
import type { Pair, Ring } from './polygons';
import type { MeshPart } from './types';

/** Segments around the split-ring hole. 32 is a smooth 3-4 mm circle. */
export const HOLE_SEGMENTS = 32;

/** Quarter-circle steps in each fillet. Six reads as round and costs little. */
export const FILLET_STEPS = 6;

/**
 * How far up the local rim a fillet is allowed to eat.
 *
 * Below 0.5 the top and bottom fillets would meet and the vertical run between
 * them would collapse to nothing, which makes degenerate quads. Staying under
 * half leaves a real, if thin, straight section at every point of the rim.
 */
const MAX_FILLET_FRACTION = 0.45;

export type KeychainShape = 'circle' | 'square';

/* ------------------------------------------------------------------ outlines */

/**
 * A square with rounded corners, as a closed ring in whatever units `size` is.
 *
 * Used for the SELECTION, so the model is born with round corners. A sharp
 * square corner is the worst thing on a keychain: it is the one feature that
 * concentrates the whole edge into a point.
 */
export function roundedSquareRing(
  size: number,
  cornerRadius: number,
  stepsPerCorner = 8,
): Ring {
  return roundedRectRing(size, size, cornerRadius, stepsPerCorner);
}

/**
 * A rectangle with rounded corners, centred on the origin.
 *
 * A drawn rectangle, or a route fitted with one, is rarely exactly square, and
 * its corners catch a pocket just the same.
 */
export function roundedRectRing(
  width: number,
  height: number,
  cornerRadius: number,
  stepsPerCorner = 8,
): Ring {
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.max(0, Math.min(cornerRadius, hw, hh));
  if (r === 0) {
    return [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
  }

  const ring: Ring = [];
  // Corner arc centres, counter-clockwise from the bottom-right.
  const corners: Array<{ cx: number; cy: number; from: number }> = [
    { cx: hw - r, cy: -(hh - r), from: -Math.PI / 2 },
    { cx: hw - r, cy: hh - r, from: 0 },
    { cx: -(hw - r), cy: hh - r, from: Math.PI / 2 },
    { cx: -(hw - r), cy: -(hh - r), from: Math.PI },
  ];
  for (const { cx, cy, from } of corners) {
    for (let i = 0; i <= stepsPerCorner; i++) {
      const a = from + (i / stepsPerCorner) * (Math.PI / 2);
      ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return ring;
}

/** A circle as a closed ring. */
export function circleRing(diameter: number, segments = 128): Ring {
  const r = diameter / 2;
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return ring;
}

/* ---------------------------------------------------------------- hole place */

export interface HolePlacement {
  centre: Pair;
  /** Radius actually used, after any shrink needed to make it fit. */
  radius: number;
  /** True when the hole had to be moved or shrunk to keep its wall. */
  adjusted: boolean;
}

/** Where on the outline the hole starts looking from. */
export type HoleAnchor = 'north' | 'corner';

/** Samples along the walk inward. Refined by bisection, so this only needs to find the crossing. */
const HOLE_WALK_STEPS = 512;

/**
 * Where the split-ring hole goes, and whether it fits.
 *
 * `margin` is the material left between the hole and the outside of the model —
 * a wall, not a gap. Below about four perimeters it tears off the first time
 * the keys are dropped, so this is the number that decides whether the keychain
 * survives, and it is defended ahead of the hole's own size.
 *
 * North: top-centre, because a disc has no distinguished point and north is the
 * one the map has already agreed on. Corner: the north-east corner, which is
 * where a rectangular tag has hung since tags existed, and which on a terrain
 * tile is usually the quietest ground.
 *
 * **Measured against the real outline**, not derived from the settings. An
 * earlier version took "square, 40 mm, 5 mm corner" and computed the answer —
 * which was exact for that square and wrong for everything else: a circle
 * selection with the setting on Square put the hole in a corner the disc does
 * not have, and the drill cut air. Now the hole walks inward from the anchor —
 * toward the middle from north, down the 45 degree bisector from a corner — and
 * stops at the first place its wall is at least `margin` thick,
 * so it is right for any outline the model was actually built with. A hole too
 * big for the corner moves inward rather than shrinking; it only shrinks when
 * the whole model is too small to hold it.
 */
export function placeHole(
  boundary: Ring,
  anchor: HoleAnchor,
  holeDiameter: number,
  margin: number,
): HolePlacement {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of boundary) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const hw = (maxX - minX) / 2 || 1;
  const hh = (maxY - minY) / 2 || 1;

  // A corner walk starts from the corner of the bounds, not from an outline
  // vertex: its bisector runs through the middle of any rounded corner however
  // wide the rectangle, and on a shape with no corner there (a disc) the first
  // samples are simply outside and the walk carries on in.
  const start: Pair = anchor === 'corner' ? [maxX, maxY] : [cx, maxY];

  // From a corner, down the bisector rather than straight at the centre: on a
  // wide rectangle the centre is at a shallow angle, and walking toward it
  // slides the hole along the long edge instead of tucking it into the corner.
  const reach = Math.min(hw, hh);
  const [tx, ty]: Pair = anchor === 'corner' ? [start[0] - reach, start[1] - reach] : [cx, cy];
  const at = (t: number): Pair => [start[0] + (tx - start[0]) * t, start[1] + (ty - start[1]) * t];
  const radius = holeDiameter / 2;
  const need = radius + margin;

  let bestT = 1;
  let bestClearance = -Infinity;
  let prevT = 0;
  for (let i = 0; i <= HOLE_WALK_STEPS; i++) {
    const t = i / HOLE_WALK_STEPS;
    const c = clearance(boundary, at(t));
    if (c >= need) {
      // Bisect back toward the edge: the hole should hug the outline, not sit
      // wherever the coarse step happened to land.
      let lo = i === 0 ? t : prevT;
      let hi = t;
      for (let k = 0; k < 40 && i > 0; k++) {
        const mid = (lo + hi) / 2;
        if (clearance(boundary, at(mid)) >= need) hi = mid;
        else lo = mid;
      }
      return { centre: at(hi), radius, adjusted: false };
    }
    if (c > bestClearance) {
      bestClearance = c;
      bestT = t;
    }
    prevT = t;
  }

  // Nowhere on the walk fits: keep the wall, shrink the hole to what the
  // roomiest point can hold.
  return {
    centre: at(bestT),
    radius: Math.max(0.25, bestClearance - margin),
    adjusted: true,
  };
}

/** Distance from a point to the outline, or -Infinity when the point is outside it. */
function clearance(ring: Ring, [px, py]: Pair): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;

    const dx = xi - xj;
    const dy = yi - yj;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - xj) * dx + (py - yj) * dy) / len2)) : 0;
    const d = Math.hypot(px - (xj + dx * u), py - (yj + dy * u));
    if (d < best) best = d;
  }
  return inside ? best : -Infinity;
}

/* ------------------------------------------------------------------ envelope */

/** One step of the envelope's vertical profile: how far in, and how high. */
interface ProfilePoint {
  inset: number;
  z: number;
}

/**
 * The vertical profile at one point of the rim.
 *
 * Read bottom to top: round out from under the base, run straight up the wall,
 * round over where the wall meets the terrain, then continue straight up at the
 * filleted inset so the cap closes above everything.
 *
 * The last run is what makes the top fillet work on real terrain. Ground that
 * rises steeply just inside the boundary would otherwise poke back out through
 * the rounded corner; holding the inset all the way to the cap trims it to the
 * same curve.
 */
function profileAt(rimZ: number, edgeRadius: number, capZ: number): ProfilePoint[] {
  // Clamped per rim point, not globally: one low saddle on the boundary must
  // not flatten the fillet everywhere else.
  const r = Math.min(edgeRadius, rimZ * MAX_FILLET_FRACTION);
  const points: ProfilePoint[] = [];

  for (let i = 0; i <= FILLET_STEPS; i++) {
    const a = (i / FILLET_STEPS) * (Math.PI / 2);
    points.push({ inset: r - r * Math.sin(a), z: r - r * Math.cos(a) });
  }
  for (let i = FILLET_STEPS; i >= 0; i--) {
    const a = (i / FILLET_STEPS) * (Math.PI / 2);
    points.push({ inset: r - r * Math.sin(a), z: rimZ - r + r * Math.cos(a) });
  }
  points.push({ inset: r, z: Math.max(capZ, rimZ + edgeRadius) });
  return points;
}

/**
 * Inward normals for a closed ring, mitred at the corners.
 *
 * Averaging the two adjacent edge normals and normalising is not enough: at a
 * corner that gives a direction but the wrong LENGTH, so an offset of r along
 * it lands short of r from both edges and the fillet pinches. Dividing by the
 * cosine of the half-angle is the standard mitre, and the clamp stops a near
 * spike from throwing the offset to infinity.
 */
function inwardNormals(ring: Ring): Pair[] {
  const n = ring.length;
  const edge: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % n]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    // Counter-clockwise ring: interior is to the left, so rotate +90 degrees.
    edge.push([-dy / len, dx / len]);
  }

  const out: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const a = edge[(i - 1 + n) % n]!;
    const b = edge[i]!;
    let mx = a[0] + b[0];
    let my = a[1] + b[1];
    const len = Math.hypot(mx, my);
    if (len < 1e-9) {
      out.push([b[0], b[1]]);
      continue;
    }
    mx /= len;
    my /= len;
    const cos = Math.max(0.25, mx * b[0] + my * b[1]);
    out.push([mx / cos, my / cos]);
  }
  return out;
}

/** True when the ring winds counter-clockwise (positive shoelace area). */
export function isCounterClockwise(ring: Ring): boolean {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    sum += x0 * y1 - x1 * y0;
  }
  return sum > 0;
}

export interface EnvelopeParams {
  /** The model's own outline, print mm, one point per rim sample. */
  boundary_mm: Ring;
  /** Terrain top at each boundary point, print mm. Same length as `boundary_mm`. */
  rimZ_mm: number[];
  edgeRadius_mm: number;
  /** Flat cap height — must clear the model's highest point. */
  capZ_mm: number;
}

/**
 * The solid the finished model is intersected with.
 *
 * Closed and manifold by construction: one quad strip per profile step, welded
 * around the ring, capped top and bottom by an earcut of the same offset ring.
 */
export function buildEnvelope(params: EnvelopeParams): MeshPart {
  const { boundary_mm, rimZ_mm, edgeRadius_mm, capZ_mm } = params;
  if (boundary_mm.length < 3) {
    throw new Error('Keychain envelope needs a boundary of at least three points');
  }
  if (rimZ_mm.length !== boundary_mm.length) {
    throw new Error('Keychain envelope needs one rim height per boundary point');
  }

  // earcut and the strip winding below both assume counter-clockwise.
  const ring = isCounterClockwise(boundary_mm) ? boundary_mm : [...boundary_mm].reverse();
  const rim = isCounterClockwise(boundary_mm) ? rimZ_mm : [...rimZ_mm].reverse();

  const n = ring.length;
  const normals = inwardNormals(ring);
  const profiles = rim.map((z) => profileAt(z, edgeRadius_mm, capZ_mm));
  const steps = profiles[0]!.length;

  const positions: number[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = ring[i]!;
    const [nx, ny] = normals[i]!;
    for (let s = 0; s < steps; s++) {
      const p = profiles[i]![s]!;
      positions.push(x + nx * p.inset, y + ny * p.inset, p.z);
    }
  }

  const indices: number[] = [];
  const at = (i: number, s: number) => (i % n) * steps + s;

  // Side: outward-facing, so the solid's normals point away from its interior.
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < steps - 1; s++) {
      const a = at(i, s);
      const b = at(i + 1, s);
      const c = at(i + 1, s + 1);
      const d = at(i, s + 1);
      indices.push(a, b, c, a, c, d);
    }
  }

  // Caps, from the ring at the fillet inset — the same loop the strips start
  // and end on, so no seam and no extra vertices.
  const flatBottom: number[] = [];
  const flatTop: number[] = [];
  for (let i = 0; i < n; i++) {
    flatBottom.push(positions[at(i, 0) * 3]!, positions[at(i, 0) * 3 + 1]!);
    flatTop.push(positions[at(i, steps - 1) * 3]!, positions[at(i, steps - 1) * 3 + 1]!);
  }
  for (const tri of chunk3(earcut(flatBottom))) {
    // Bottom faces down: reverse the winding earcut gives for a CCW ring.
    indices.push(at(tri[2]!, 0), at(tri[1]!, 0), at(tri[0]!, 0));
  }
  for (const tri of chunk3(earcut(flatTop))) {
    indices.push(at(tri[0]!, steps - 1), at(tri[1]!, steps - 1), at(tri[2]!, steps - 1));
  }

  return {
    name: 'keychain:envelope',
    color: '#ffffff',
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    manifold: true,
  };
}

function chunk3(list: number[] | Uint32Array): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 2 < list.length; i += 3) out.push([list[i]!, list[i + 1]!, list[i + 2]!]);
  return out;
}

/* ---------------------------------------------------------------- hole tool */

/**
 * A cylinder to drill the split-ring hole.
 *
 * Deliberately overshoots the model top and bottom. A cutting tool that stops
 * exactly on the surface it is cutting leaves coplanar faces, which is the
 * classic way to hand a boolean kernel a decision it has no right answer for.
 */
export function buildHoleTool(
  centre: Pair,
  radius: number,
  z0: number,
  z1: number,
  segments = HOLE_SEGMENTS,
): MeshPart {
  const positions: number[] = [];
  const indices: number[] = [];
  const [cx, cy] = centre;

  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    positions.push(x, y, z0, x, y, z1);
  }

  for (let i = 0; i < segments; i++) {
    const a0 = i * 2;
    const a1 = a0 + 1;
    const b0 = ((i + 1) % segments) * 2;
    const b1 = b0 + 1;
    indices.push(a0, b0, b1, a0, b1, a1);
  }

  // Caps as fans on the first vertex of each loop.
  for (let i = 1; i < segments - 1; i++) {
    indices.push(0, (i + 1) * 2, i * 2); // bottom, facing down
    indices.push(1, i * 2 + 1, (i + 1) * 2 + 1); // top, facing up
  }

  return {
    name: 'keychain:hole',
    color: '#ffffff',
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    manifold: true,
  };
}
