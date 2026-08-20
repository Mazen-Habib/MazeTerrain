/**
 * Terrain clipped to an arbitrary selection shape.
 *
 * The rectangle path in terrain.ts triangulates the whole grid and walks its
 * perimeter. For a circle, hexagon or freehand polygon the surface has to stop
 * at the boundary, and — critically — the base and walls must stop at the SAME
 * boundary. Clipping the top surface but building walls from the original
 * rectangle is docs/08-pitfalls.md#geometry-outside-boundary, and it leaves a
 * rectangular fringe hanging off a circular model.
 *
 * The method mirrors the ribbon builder: classify grid vertices inside/outside,
 * find where the boundary crosses each grid EDGE (never each cell, so the two
 * cells sharing an edge always agree on the crossing point), emit the inside
 * part of every cell, then derive the walls from the surface's own boundary
 * edges rather than from anything we assumed.
 */
import earcut from 'earcut';
import { worldToPrint, type ResolvedScale } from './coords';
import type { Heightfield } from './heightfield';
import type { Ring } from './polygons';
import type { TerrainMesh } from './terrain';

/** No crossing recorded for this grid edge. */
const NONE = -1;

/**
 * Keep crossings off the grid vertices.
 *
 * A boundary passing exactly through a grid vertex would emit a crossing vertex
 * coincident with it, which the weld later merges — and merging two vertices a
 * closed mesh was relying on being distinct can reopen its edges. A thousandth
 * of a cell is far below a nozzle and removes the case entirely.
 */
const CROSSING_EPSILON = 1e-3;

function clampT(t: number): number {
  return t < CROSSING_EPSILON
    ? CROSSING_EPSILON
    : t > 1 - CROSSING_EPSILON
      ? 1 - CROSSING_EPSILON
      : t;
}

const EDGE_SHIFT = 4194304;

function edgeKey(a: number, b: number): number {
  return a < b ? a * EDGE_SHIFT + b : b * EDGE_SHIFT + a;
}

/**
 * Inside/outside for every grid vertex, by scanline.
 *
 * Testing each vertex against each boundary segment would be rows*cols*segments;
 * intersecting one horizontal line per row is rows*segments, which is four
 * orders of magnitude less work on a real grid.
 */
function insideMask(
  cols: number,
  rows: number,
  x0_m: number,
  y0_m: number,
  spacingX_m: number,
  spacingY_m: number,
  ring: Ring,
): Uint8Array {
  const inside = new Uint8Array(cols * rows);
  const crossings: number[] = [];

  for (let j = 0; j < rows; j++) {
    const y = y0_m + j * spacingY_m;
    crossings.length = 0;

    for (let k = 0, n = ring.length; k < n; k++) {
      const ax = ring[k][0];
      const ay = ring[k][1];
      const bx = ring[(k + 1) % n][0];
      const by = ring[(k + 1) % n][1];
      if (ay > y === by > y) continue;
      crossings.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    if (crossings.length < 2) continue;

    crossings.sort((p, q) => p - q);
    const row = j * cols;
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      const from = Math.ceil((crossings[c] - x0_m) / spacingX_m);
      const to = Math.floor((crossings[c + 1] - x0_m) / spacingX_m);
      for (let i = Math.max(0, from); i <= Math.min(cols - 1, to); i++) inside[row + i] = 1;
    }
  }

  return inside;
}

/**
 * Parameter along a grid edge where the boundary crosses it, or -1.
 * Computed per grid edge so both adjacent cells receive the identical point.
 */
function crossingT(ax: number, ay: number, bx: number, by: number, ring: Ring): number {
  const dx = bx - ax;
  const dy = by - ay;

  let best = -1;
  for (let k = 0, n = ring.length; k < n; k++) {
    const px = ring[k][0];
    const py = ring[k][1];
    const rx = ring[(k + 1) % n][0] - px;
    const ry = ring[(k + 1) % n][1] - py;

    const denom = dx * ry - dy * rx;
    if (denom === 0) continue;

    const t = ((px - ax) * ry - (py - ay) * rx) / denom;
    const u = ((px - ax) * dy - (py - ay) * dx) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      // Keep the first crossing along the edge; the boundary is coarsened to at
      // least one cell, so a second one would be sub-grid detail we cannot hold.
      if (best < 0 || t < best) best = t;
    }
  }
  return best;
}

/**
 * Drop boundary vertices closer together than one cell.
 *
 * Cell-wise clipping assumes at most one boundary crossing per grid edge. A
 * freehand polygon with detail finer than the grid breaks that assumption, and
 * the detail could not survive the sampling anyway.
 */
export function coarsenRing(ring: Ring, minSegment_m: number): Ring {
  if (ring.length < 4) return ring;

  const out: Ring = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(ring[i][0] - last[0], ring[i][1] - last[1]) >= minSegment_m) out.push(ring[i]);
  }
  while (out.length > 3) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < minSegment_m) out.pop();
    else break;
  }
  return out.length >= 3 ? out : ring;
}

/** Chain directed boundary edges into closed rings of vertex indices. */
function chainBoundary(edges: Array<[number, number]>): number[][] {
  const outgoing = new Map<number, number[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge[0]);
    if (list) list.push(edge[1]);
    else outgoing.set(edge[0], [edge[1]]);
  }

  const rings: number[][] = [];
  const limit = edges.length + 2;

  for (const entry of outgoing) {
    const start = entry[0];
    const targets = entry[1];

    while (targets.length > 0) {
      const ring: number[] = [start];
      let current = targets.pop() as number;
      let ok = true;

      while (current !== start) {
        ring.push(current);
        const next = outgoing.get(current);
        if (!next || next.length === 0 || ring.length > limit) {
          ok = false;
          break;
        }
        current = next.pop() as number;
      }

      if (ok && ring.length >= 3) rings.push(ring);
    }
  }

  return rings;
}

export function buildClippedTerrainMesh(
  hf: Heightfield,
  s: ResolvedScale,
  boundary: Ring,
): TerrainMesh {
  const { cols, rows, data, spacingX_m, spacingY_m } = hf;
  if (cols < 2 || rows < 2) throw new Error(`Grid too small to triangulate: ${cols} x ${rows}`);

  const x0_m = -((cols - 1) * spacingX_m) / 2;
  const y0_m = -((rows - 1) * spacingY_m) / 2;

  const ring = coarsenRing(boundary, Math.min(spacingX_m, spacingY_m));
  const inside = insideMask(cols, rows, x0_m, y0_m, spacingX_m, spacingY_m, ring);

  const positions: number[] = [];
  const gridIndex = new Int32Array(cols * rows).fill(NONE);
  const hEdge = new Int32Array((cols - 1) * rows).fill(NONE);
  const vEdge = new Int32Array(cols * (rows - 1)).fill(NONE);

  const pushVertex = (x_m: number, y_m: number, h_m: number): number => {
    const p = worldToPrint(x_m, y_m, h_m, s);
    positions.push(p[0], p[1], p[2]);
    return positions.length / 3 - 1;
  };

  const gridVertex = (i: number, j: number): number => {
    const g = j * cols + i;
    let index = gridIndex[g];
    if (index === NONE) {
      index = pushVertex(x0_m + i * spacingX_m, y0_m + j * spacingY_m, data[g]);
      gridIndex[g] = index;
    }
    return index;
  };

  const horizontalCrossing = (i: number, j: number): number => {
    const id = j * (cols - 1) + i;
    let index = hEdge[id];
    if (index === NONE) {
      const ax = x0_m + i * spacingX_m;
      const y = y0_m + j * spacingY_m;
      const raw = crossingT(ax, y, ax + spacingX_m, y, ring);
      const t = clampT(raw < 0 ? 0.5 : raw);
      const g = j * cols + i;
      index = pushVertex(ax + t * spacingX_m, y, data[g] + t * (data[g + 1] - data[g]));
      hEdge[id] = index;
    }
    return index;
  };

  const verticalCrossing = (i: number, j: number): number => {
    const id = j * cols + i;
    let index = vEdge[id];
    if (index === NONE) {
      const x = x0_m + i * spacingX_m;
      const ay = y0_m + j * spacingY_m;
      const raw = crossingT(x, ay, x, ay + spacingY_m, ring);
      const t = clampT(raw < 0 ? 0.5 : raw);
      const g = j * cols + i;
      index = pushVertex(x, ay + t * spacingY_m, data[g] + t * (data[g + cols] - data[g]));
      vEdge[id] = index;
    }
    return index;
  };

  const indices: number[] = [];

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const ga = j * cols + i;
      const ia = inside[ga];
      const ib = inside[ga + 1];
      const ic = inside[ga + cols + 1];
      const id = inside[ga + cols];
      const count = ia + ib + ic + id;
      if (count === 0) continue;

      if (count === 4) {
        const va = gridVertex(i, j);
        const vb = gridVertex(i + 1, j);
        const vc = gridVertex(i + 1, j + 1);
        const vd = gridVertex(i, j + 1);
        indices.push(va, vb, vc, va, vc, vd);
        continue;
      }

      // Walk the cell boundary counter-clockwise, keeping inside corners and
      // adding the crossing wherever insideness flips.
      const poly: number[] = [];
      const corners = [ia, ib, ic, id];

      for (let k = 0; k < 4; k++) {
        if (corners[k]) {
          poly.push(
            k === 0
              ? gridVertex(i, j)
              : k === 1
                ? gridVertex(i + 1, j)
                : k === 2
                  ? gridVertex(i + 1, j + 1)
                  : gridVertex(i, j + 1),
          );
        }
        if (corners[k] !== corners[(k + 1) % 4]) {
          poly.push(
            k === 0
              ? horizontalCrossing(i, j)
              : k === 1
                ? verticalCrossing(i + 1, j)
                : k === 2
                  ? horizontalCrossing(i, j + 1)
                  : verticalCrossing(i, j),
          );
        }
      }
      if (poly.length < 3) continue;

      // earcut rather than a fan: a concave boundary can make the clipped cell
      // non-convex, and these polygons are at most six vertices.
      const flat: number[] = [];
      for (const v of poly) flat.push(positions[v * 3], positions[v * 3 + 1]);
      const tri = earcut(flat, [], 2);
      for (let t = 0; t < tri.length; t += 3) {
        indices.push(poly[tri[t]], poly[tri[t + 1]], poly[tri[t + 2]]);
      }
    }
  }

  if (indices.length === 0) {
    throw new Error('Selection shape does not cover any of the terrain grid');
  }

  // The boundary of whatever the surface actually became — never an assumption
  // about what it should have been.
  const counts = new Map<number, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const key = edgeKey(indices[t + e], indices[t + ((e + 1) % 3)]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const boundaryEdges: Array<[number, number]> = [];
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e];
      const b = indices[t + ((e + 1) % 3)];
      if (counts.get(edgeKey(a, b)) === 1) boundaryEdges.push([a, b]);
    }
  }

  const rings = chainBoundary(boundaryEdges);

  let perimeter = 0;
  for (const r of rings) {
    perimeter += r.length;

    const bottom = r.map((v) => {
      positions.push(positions[v * 3], positions[v * 3 + 1], 0);
      return positions.length / 3 - 1;
    });

    for (let k = 0; k < r.length; k++) {
      const kNext = (k + 1) % r.length;
      indices.push(r[k], bottom[k], bottom[kNext]);
      indices.push(r[k], bottom[kNext], r[kNext]);
    }

    let cx = 0;
    let cy = 0;
    for (const v of bottom) {
      cx += positions[v * 3];
      cy += positions[v * 3 + 1];
    }
    positions.push(cx / bottom.length, cy / bottom.length, 0);
    const centroid = positions.length / 3 - 1;

    for (let k = 0; k < bottom.length; k++) {
      indices.push(centroid, bottom[(k + 1) % bottom.length], bottom[k]);
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let p = 0; p < positions.length; p += 3) {
    if (positions[p] < minX) minX = positions[p];
    if (positions[p] > maxX) maxX = positions[p];
    if (positions[p + 1] < minY) minY = positions[p + 1];
    if (positions[p + 1] > maxY) maxY = positions[p + 1];
    if (positions[p + 2] > maxZ) maxZ = positions[p + 2];
  }

  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    perimeter,
    dimensions_mm: [maxX - minX, maxY - minY, maxZ],
  };
}
