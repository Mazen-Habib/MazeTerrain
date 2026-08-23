/**
 * Turn a 2D polygon into a closed solid that follows the terrain.
 *
 * Shared by the route ribbon now and by roads, water and greenery in Phase 2 —
 * every one of them is "a footprint, draped, given thickness, and closed".
 *
 * Two rules earn their keep here:
 *
 *  - The walls are derived from the triangulated surface's OWN boundary edges,
 *    never from the input rings. earcut silently discards exactly-collinear
 *    vertices, so a wall built from the ring can reference edges the surface
 *    never made. That mismatch is invisible until export and cost 282 open
 *    edges on a lap route. See docs/08-pitfalls.md#triangulator-drops-vertices.
 *  - Densification happens by subdividing TRIANGLES, not ring edges, for the
 *    same reason: points added along a straight ring edge are exactly collinear
 *    and get dropped, taking the drape resolution with them.
 */
import earcut from 'earcut';
import type { MultiPolygon } from './polygons';
import { normaliseWinding, openRing } from './ribbon';

export interface ExtrudeOptions {
  /** Height of the top surface above the terrain, print mm. */
  height_mm: number;
  /**
   * How far the bottom digs in below the terrain, print mm.
   * Features must penetrate the terrain, not kiss it: coincident coplanar faces
   * are the number one source of non-manifold exports (CLAUDE.md, Geometry).
   */
  penetration_mm: number;
  /** The bottom is never allowed below this, so nothing pokes through the base. */
  minBottom_mm: number;
  /** Triangles are subdivided until no edge exceeds this, so the drape follows terrain. */
  maxEdge_m: number;
  /**
   * Put the underside at this absolute Z instead of following the terrain.
   *
   * For the inlay insert and the channel it seats into. Both have to share one
   * flat floor or the insert cannot sit flush, and a floor that follows the
   * terrain is not flat by definition. The top still drapes, so the piece looks
   * right from above and only its thickness varies.
   */
  flatBottom_mm?: number;
}

export interface SolidMesh {
  positions: Float32Array;
  indices: Uint32Array;
  triangles: number;
}

/** Terrain surface height in print mm at a point in world metres. */
export type TerrainZSampler = (x_m: number, y_m: number) => number;

const EMPTY: SolidMesh = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangles: 0,
};

/** Cap on uniform subdivision levels, so a pathological footprint cannot explode. */
const MAX_SUBDIVISION_LEVELS = 4;

const EDGE_SHIFT = 2097152;

function edgeKey(a: number, b: number): number {
  return a < b ? a * EDGE_SHIFT + b : b * EDGE_SHIFT + a;
}

/**
 * Uniform 1-to-4 subdivision until every edge is short enough.
 *
 * All triangles split at every level, so shared edges always receive the same
 * midpoint and the mesh stays conforming — no T-junctions, which would reopen
 * the very seams this module exists to close.
 */
function subdivide(xy: number[], tris: number[], maxEdge: number): number[] {
  let current = tris;

  for (let level = 0; level < MAX_SUBDIVISION_LEVELS; level++) {
    let longest = 0;
    for (let i = 0; i < current.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = current[i + e];
        const b = current[i + ((e + 1) % 3)];
        const d = Math.hypot(xy[a * 2] - xy[b * 2], xy[a * 2 + 1] - xy[b * 2 + 1]);
        if (d > longest) longest = d;
      }
    }
    if (longest <= maxEdge) break;

    const midpoints = new Map<number, number>();
    const midpoint = (a: number, b: number): number => {
      const key = edgeKey(a, b);
      const existing = midpoints.get(key);
      if (existing !== undefined) return existing;
      const index = xy.length / 2;
      xy.push((xy[a * 2] + xy[b * 2]) / 2, (xy[a * 2 + 1] + xy[b * 2 + 1]) / 2);
      midpoints.set(key, index);
      return index;
    };

    const next: number[] = [];
    for (let i = 0; i < current.length; i += 3) {
      const a = current[i];
      const b = current[i + 1];
      const c = current[i + 2];
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    current = next;
  }

  return current;
}

/**
 * Split vertices where the surface pinches, so it stops being a bowtie.
 *
 * A contour can touch itself at a single point — a road network against the
 * selection mask does it readily, because masked cells are Infinity and the
 * interpolation snaps those crossings onto grid corners where two branches meet.
 * The triangles around such a vertex form two separate fans joined only at the
 * point. Top, bottom and walls all inherit it, and the vertical wall edge ends
 * up with four adjacent faces: non-manifold, export blocked.
 *
 * Giving each fan its own copy of the vertex costs one duplicated position and
 * makes the surface a clean 2-manifold. The copies sit at the same coordinates,
 * so nothing moves.
 * See docs/08-pitfalls.md#bowtie-vertices-from-touching-contours.
 */
function splitBowtieVertices(xy: number[], tris: number[]): void {
  const vertexCount = xy.length / 2;

  // Triangles incident to each vertex.
  const incident: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const v = tris[t + e];
      if (v < vertexCount) incident[v].push(t);
    }
  }

  for (let v = 0; v < vertexCount; v++) {
    const fan = incident[v];
    if (fan.length < 2) continue;

    // Two triangles belong to the same fan if they share an edge through v.
    const partner = new Map<number, number[]>();
    for (const t of fan) {
      for (let e = 0; e < 3; e++) {
        const a = tris[t + e];
        const b = tris[t + ((e + 1) % 3)];
        if (a !== v && b !== v) continue;
        const other = a === v ? b : a;
        const list = partner.get(other);
        if (list) list.push(t);
        else partner.set(other, [t]);
      }
    }

    const seen = new Set<number>();
    let component = 0;

    for (const seed of fan) {
      if (seen.has(seed)) continue;

      const stack = [seed];
      const group: number[] = [];
      seen.add(seed);

      while (stack.length > 0) {
        const t = stack.pop() as number;
        group.push(t);
        for (let e = 0; e < 3; e++) {
          const a = tris[t + e];
          const b = tris[t + ((e + 1) % 3)];
          if (a !== v && b !== v) continue;
          for (const neighbour of partner.get(a === v ? b : a) ?? []) {
            if (!seen.has(neighbour)) {
              seen.add(neighbour);
              stack.push(neighbour);
            }
          }
        }
      }

      // The first fan keeps the original vertex; the rest get copies.
      if (component > 0) {
        const copy = xy.length / 2;
        xy.push(xy[v * 2], xy[v * 2 + 1]);
        for (const t of group) {
          for (let e = 0; e < 3; e++) if (tris[t + e] === v) tris[t + e] = copy;
        }
      }
      component++;
    }
  }
}

/**
 * Directed boundary edges of a triangulated surface: those belonging to exactly
 * one triangle. Their direction keeps the interior on the left, so outer
 * boundaries come out counter-clockwise and holes clockwise, which is exactly
 * what the wall winding below needs.
 */
function boundaryEdges(tris: number[]): Array<[number, number]> {
  const counts = new Map<number, number>();
  for (let i = 0; i < tris.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const key = edgeKey(tris[i + e], tris[i + ((e + 1) % 3)]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const out: Array<[number, number]> = [];
  for (let i = 0; i < tris.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[i + e];
      const b = tris[i + ((e + 1) % 3)];
      if (counts.get(edgeKey(a, b)) === 1) out.push([a, b]);
    }
  }
  return out;
}

/**
 * @param footprint  polygons in world metres
 * @param toPrintXY  world metres -> print millimetres, XY only
 */
export function extrudeDraped(
  footprint: MultiPolygon,
  sampleTerrainZ: TerrainZSampler,
  toPrintXY: (x_m: number, y_m: number) => [number, number],
  options: ExtrudeOptions,
): SolidMesh {
  if (footprint.length === 0) return EMPTY;

  const positions: number[] = [];
  const indices: number[] = [];

  for (const polygon of normaliseWinding(footprint)) {
    const rings = polygon.map(openRing).filter((r) => r.length >= 3);
    if (rings.length === 0) continue;

    // Flatten for earcut: [x0,y0,x1,y1,...] plus the start index of each hole.
    const xy: number[] = [];
    const holeIndices: number[] = [];
    for (let r = 0; r < rings.length; r++) {
      if (r > 0) holeIndices.push(xy.length / 2);
      for (const [x, y] of rings[r]) xy.push(x, y);
    }

    const base = earcut(xy, holeIndices, 2);
    if (base.length === 0) continue;

    // `xy` grows as subdivision adds midpoints, and again if a pinch is split.
    const surface = subdivide(xy, base, options.maxEdge_m);
    splitBowtieVertices(xy, surface);
    const vertexCount = xy.length / 2;
    const offset = positions.length / 3;

    for (let v = 0; v < vertexCount; v++) {
      const x_m = xy[v * 2];
      const y_m = xy[v * 2 + 1];
      const [x_mm, y_mm] = toPrintXY(x_m, y_m);
      const terrainZ = sampleTerrainZ(x_m, y_m);

      const top = terrainZ + options.height_mm;
      const bottom =
        options.flatBottom_mm !== undefined
          ? options.flatBottom_mm
          : Math.max(options.minBottom_mm, terrainZ - options.penetration_mm);

      positions.push(x_mm, y_mm, top);
      positions.push(x_mm, y_mm, bottom);
    }

    const topIndex = (v: number) => offset + v * 2;
    const bottomIndex = (v: number) => offset + v * 2 + 1;

    // Top: earcut's winding follows the input, which normaliseWinding made CCW.
    for (let i = 0; i < surface.length; i += 3) {
      indices.push(topIndex(surface[i]), topIndex(surface[i + 1]), topIndex(surface[i + 2]));
    }
    // Bottom: the same triangles reversed, so the normals point down.
    for (let i = 0; i < surface.length; i += 3) {
      indices.push(
        bottomIndex(surface[i]),
        bottomIndex(surface[i + 2]),
        bottomIndex(surface[i + 1]),
      );
    }

    // Walls, from the surface's own boundary.
    for (const [a, b] of boundaryEdges(surface)) {
      indices.push(topIndex(a), bottomIndex(a), bottomIndex(b));
      indices.push(topIndex(a), bottomIndex(b), topIndex(b));
    }
  }

  if (indices.length === 0) return EMPTY;

  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangles: indices.length / 3,
  };
}
