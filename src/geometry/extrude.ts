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

/**
 * Safety cap on refinement levels, so a pathological footprint cannot explode.
 *
 * Sized for BISECTION, which roughly doubles the triangle count per level —
 * four was right when a level quartered (256x) and silently starved the
 * refinement once it became longest-edge bisection, leaving a 4 km lake at 96
 * triangles however fine the target. Each level here is worth about half a
 * level of the old scheme, so the number is correspondingly larger. The loop
 * exits as soon as no edge exceeds the target, so this only bites on geometry
 * that cannot converge.
 */
const MAX_SUBDIVISION_LEVELS = 16;

const EDGE_SHIFT = 2097152;

function edgeKey(a: number, b: number): number {
  return a < b ? a * EDGE_SHIFT + b : b * EDGE_SHIFT + a;
}

/**
 * Improve triangle shape by flipping edges toward a Delaunay triangulation.
 *
 * `earcut` is a fast ear-clipping triangulator, and ear clipping optimises for
 * speed, not shape: on a long thin ribbon it happily emits slivers. Measured on
 * a real marathon GPX, its raw output carried 9% slivers past 200:1, and
 * refinement can only preserve that — longest-edge bisection bounds how much
 * WORSE quality can get, it cannot make a bad triangulation good.
 *
 * Flipping fixes the input instead. For a fixed set of points, the Delaunay
 * triangulation maximises the minimum angle over every possible triangulation,
 * and Lawson's flip algorithm reaches it by repeatedly replacing the shared
 * diagonal of two triangles whenever the opposite vertex falls inside their
 * circumcircle. Vertices, boundary and topology are untouched — only which
 * diagonal splits each quad changes — so the surface stays exactly the shape
 * the contour described and the walls, which come from the boundary edges,
 * are unaffected.
 *
 * Only convex quads are flipped. Flipping a reflex one would fold the surface
 * over itself, which is how a well-meant quality pass turns into a
 * self-intersecting mesh.
 */
function improveByFlips(xy: number[], tris: number[], maxPasses = 8): number[] {
  const out = tris.slice();

  const px = (v: number) => xy[v * 2];
  const py = (v: number) => xy[v * 2 + 1];

  /** > 0 when c is left of a->b. */
  const cross = (a: number, b: number, c: number) =>
    (px(b) - px(a)) * (py(c) - py(a)) - (py(b) - py(a)) * (px(c) - px(a));

  /**
   * Is `d` inside the circumcircle of the counter-clockwise triangle a,b,c?
   * The standard determinant, which is what the Delaunay condition reduces to.
   */
  const inCircle = (a: number, b: number, c: number, d: number): boolean => {
    const adx = px(a) - px(d);
    const ady = py(a) - py(d);
    const bdx = px(b) - px(d);
    const bdy = py(b) - py(d);
    const cdx = px(c) - px(d);
    const cdy = py(c) - py(d);
    const det =
      (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) -
      (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) +
      (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
    return det > 0;
  };

  for (let pass = 0; pass < maxPasses; pass++) {
    // Which two triangles share each edge, and which corner each contributes.
    const edges = new Map<number, Array<{ tri: number; opposite: number }>>();
    for (let t = 0; t < out.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = out[t + e];
        const b = out[t + ((e + 1) % 3)];
        const opposite = out[t + ((e + 2) % 3)];
        const key = edgeKey(a, b);
        const list = edges.get(key);
        if (list) list.push({ tri: t, opposite });
        else edges.set(key, [{ tri: t, opposite }]);
      }
    }

    let flips = 0;
    const touched = new Set<number>();

    for (const [key, list] of edges) {
      if (list.length !== 2) continue; // boundary, or a non-manifold edge
      const [first, second] = list;
      if (touched.has(first.tri) || touched.has(second.tri)) continue;

      // Recover the shared edge's two endpoints from the first triangle.
      const t = first.tri;
      let a = -1;
      let b = -1;
      for (let e = 0; e < 3; e++) {
        const u = out[t + e];
        const v = out[t + ((e + 1) % 3)];
        if (edgeKey(u, v) === key) {
          a = u;
          b = v;
          break;
        }
      }
      if (a < 0) continue;

      const c = first.opposite;
      const d = second.opposite;
      if (c === d) continue;

      // Convexity: c and d must lie on opposite sides of a->b, and the new
      // diagonal c->d must separate a from b. Otherwise the quad is reflex and
      // flipping it folds the surface.
      const s1 = cross(a, b, c);
      const s2 = cross(a, b, d);
      if (s1 === 0 || s2 === 0 || s1 > 0 === s2 > 0) continue;
      const s3 = cross(c, d, a);
      const s4 = cross(c, d, b);
      if (s3 === 0 || s4 === 0 || s3 > 0 === s4 > 0) continue;

      // Delaunay test, with the triangle put in counter-clockwise order first.
      const ccw = s1 > 0 ? [a, b, c] : [b, a, c];
      if (!inCircle(ccw[0], ccw[1], ccw[2], d)) continue;

      // Replace the pair, keeping each new triangle wound the same way as the
      // one it came from.
      out[t] = a;
      out[t + 1] = d;
      out[t + 2] = c;
      if (cross(a, d, c) < 0) {
        out[t + 1] = c;
        out[t + 2] = d;
      }
      const u = second.tri;
      out[u] = b;
      out[u + 1] = c;
      out[u + 2] = d;
      if (cross(b, c, d) < 0) {
        out[u + 1] = d;
        out[u + 2] = c;
      }

      touched.add(first.tri);
      touched.add(second.tri);
      flips++;
    }

    if (flips === 0) break;
  }

  return out;
}

/**
 * Refine until no edge is longer than `maxEdge`, by longest-edge bisection.
 *
 * Two constraints pull against each other here, and both have drawn blood.
 *
 * Quartering every triangle per level is unaffordable: a road ribbon is half a
 * millimetre across and kilometres long, so its triangles carry one enormous
 * edge and two tiny ones, and quartering refines the tiny edges as hard as the
 * long one. A single city's roads went past V8's 16 777 216-entry `Map` limit
 * and died inside validation.
 *
 * But refining only the long edges, and closing the resulting T-junctions by
 * cutting the leftover polygon any old way, degrades the triangles instead.
 * Measured on a real 21 323-point marathon GPX, that turned a mesh with 9%
 * sliver triangles into one with 46%, aspect ratios past 21 000:1 — the fans of
 * stray geometry visible on the model. Promoting those cases to a full
 * four-way split does not help either: 65 816 triangles became 104 004 with the
 * sliver fraction unchanged.
 *
 * Longest-edge bisection is the resolution, and it is the one with a proof
 * behind it: bisecting a triangle at its LONGEST edge cannot drive the smallest
 * angle below half the smallest angle of the mesh you started from (Rivara).
 * Quality is therefore bounded no matter how many levels run. Marking is
 * propagated to a fixed point so that a triangle only ever has its longest edge
 * bisected, and midpoints are shared between the two triangles that use an
 * edge, which is what keeps the mesh conforming — a T-junction here would
 * reopen the seams this module exists to close.
 */
function subdivide(xy: number[], tris: number[], maxEdge: number): number[] {
  if (!Number.isFinite(maxEdge) || maxEdge <= 0) return tris;

  let current = tris;
  const lengthOf = (a: number, b: number) =>
    Math.hypot(xy[a * 2] - xy[b * 2], xy[a * 2 + 1] - xy[b * 2 + 1]);

  /** The longest of a triangle's three edges, as [a, b, length]. */
  const longestEdge = (a: number, b: number, c: number): [number, number, number] => {
    const ab = lengthOf(a, b);
    const bc = lengthOf(b, c);
    const ca = lengthOf(c, a);
    if (ab >= bc && ab >= ca) return [a, b, ab];
    if (bc >= ca) return [b, c, bc];
    return [c, a, ca];
  };

  for (let level = 0; level < MAX_SUBDIVISION_LEVELS; level++) {
    const marked = new Set<number>();
    for (let i = 0; i < current.length; i += 3) {
      const [a, b, len] = longestEdge(current[i], current[i + 1], current[i + 2]);
      if (len > maxEdge) marked.add(edgeKey(a, b));
    }
    if (marked.size === 0) break;

    // A triangle with any marked edge must also have its LONGEST edge marked,
    // or the bisection would not be a longest-edge one and the angle bound is
    // lost. Marking a longest edge can mark a neighbour's non-longest edge in
    // turn, hence the fixed point.
    for (let pass = 0; pass < MAX_SUBDIVISION_LEVELS * 8; pass++) {
      let changed = false;
      for (let i = 0; i < current.length; i += 3) {
        const a = current[i];
        const b = current[i + 1];
        const c = current[i + 2];
        const any =
          marked.has(edgeKey(a, b)) || marked.has(edgeKey(b, c)) || marked.has(edgeKey(c, a));
        if (!any) continue;
        const [la, lb] = longestEdge(a, b, c);
        const key = edgeKey(la, lb);
        if (!marked.has(key)) {
          marked.add(key);
          changed = true;
        }
      }
      if (!changed) break;
    }

    const midpoints = new Map<number, number>();
    const midpoint = (a: number, b: number): number | undefined => {
      const key = edgeKey(a, b);
      if (!marked.has(key)) return undefined;
      const existing = midpoints.get(key);
      if (existing !== undefined) return existing;
      const index = xy.length / 2;
      xy.push((xy[a * 2] + xy[b * 2]) / 2, (xy[a * 2 + 1] + xy[b * 2 + 1]) / 2);
      midpoints.set(key, index);
      return index;
    };

    /**
     * Bisect at the longest marked edge, then recurse on the halves.
     *
     * This terminates: bisecting edge (a,b) at m replaces it with (a,m) and
     * (m,b), and neither is in the marked set — only whole original edges are —
     * so every step strictly reduces the marked edges a triangle carries.
     */
    const emit = (a: number, b: number, c: number, out: number[]): void => {
      const candidates: Array<[number, number, number, number]> = [];
      for (const [x, y, z] of [
        [a, b, c],
        [b, c, a],
        [c, a, b],
      ] as const) {
        const m = midpoint(x, y);
        if (m !== undefined) candidates.push([x, y, z, m]);
      }
      if (candidates.length === 0) {
        out.push(a, b, c);
        return;
      }

      let best = candidates[0];
      let bestLen = lengthOf(best[0], best[1]);
      for (const cand of candidates.slice(1)) {
        const len = lengthOf(cand[0], cand[1]);
        if (len > bestLen) {
          best = cand;
          bestLen = len;
        }
      }

      const [x, y, z, m] = best;
      emit(x, m, z, out);
      emit(m, y, z, out);
    };

    const next: number[] = [];
    for (let i = 0; i < current.length; i += 3) {
      emit(current[i], current[i + 1], current[i + 2], next);
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
 * makes the surface a clean 2-manifold. The copy retreats a fraction of an edge
 * into its own fan, because an index-only split is undone by the first thing
 * downstream that merges vertices by position.
 * See docs/08-pitfalls.md#bowtie-vertices-from-touching-contours.
 */
const BOWTIE_NUDGE = 0.01;

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
        // The copy has to MOVE, not just get a new index. Anything downstream
        // that merges vertices by position — the weld in validate.ts, a boolean
        // kernel, a slicer — fuses two copies at identical coordinates straight
        // back together and restores the pinch this split just removed.
        //
        // Retreating a fraction of the shortest edge running into the pinch,
        // towards the fan's own centroid, keeps the copy well inside the fan it
        // belongs to. The step is proportional, so it stays sub-micron on the
        // print at every scale while staying far above any weld tolerance.
        let cx = 0;
        let cy = 0;
        let n = 0;
        let shortest = Infinity;
        for (const t of group) {
          for (let e = 0; e < 3; e++) {
            const w = tris[t + e];
            if (w === v) continue;
            cx += xy[w * 2];
            cy += xy[w * 2 + 1];
            n++;
            const d = Math.hypot(xy[w * 2] - xy[v * 2], xy[w * 2 + 1] - xy[v * 2 + 1]);
            if (d > 0 && d < shortest) shortest = d;
          }
        }

        let px = xy[v * 2];
        let py = xy[v * 2 + 1];
        if (n > 0 && Number.isFinite(shortest)) {
          const dx = cx / n - px;
          const dy = cy / n - py;
          const len = Math.hypot(dx, dy);
          if (len > 0) {
            const step = (shortest * BOWTIE_NUDGE) / len;
            px += dx * step;
            py += dy * step;
          }
        }

        const copy = xy.length / 2;
        xy.push(px, py);
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

    // Fix the triangulation's shape BEFORE refining it. Refinement bounds how
    // much worse quality can get; it cannot repair slivers it is handed, and
    // every one of them is then multiplied by the levels that follow.
    const flat = improveByFlips(xy, base);

    // `xy` grows as subdivision adds midpoints, and again if a pinch is split.
    const surface = subdivide(xy, flat, options.maxEdge_m);
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
