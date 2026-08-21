/**
 * Ribbon construction by distance field (replaces the 2D boolean union).
 *
 * WHY NOT THE BOOLEAN UNION docs/05-geometry-pipeline.md §6.3 specifies:
 * it does not survive real input. Unioning per-segment quads with
 * `polygon-clipping` throws "Unable to find segment in SweepLine tree" on both
 * an out-and-back and an exact retrace — the two commonest shapes an athlete
 * records. Its maintained successor `polyclip-ts` survives those but throws
 * "Unable to complete output ring" on a 400-point and an 800-point course,
 * erratically by batch size. Both are floating-point robustness failures in the
 * sweep line, not something callers can tune around.
 *
 * The level set of a distance field cannot self-intersect — that is a property
 * of the construction, not of the arithmetic. So:
 *
 *   1. stamp distance-to-centreline into a narrow band on a fine grid
 *   2. extract the halfWidth isoline with marching squares
 *   3. chain the segments into rings, nest holes inside outers
 *
 * Out-and-backs, laps and figure-eights all merge for free, because a distance
 * field has no notion of how many times the route passed through a cell.
 *
 * See docs/08-pitfalls.md#boolean-ribbon-union-unreliable.
 */
import type { MultiPolygon, Polygon, Ring } from './polygons';
import { pointToSegment, type Pt } from '../data/gpx/simplify';
import { ringArea } from './ribbon';

/**
 * Cells per half-width. The isoline is linearly interpolated, so the boundary
 * is smooth rather than stepped; this only controls how finely curvature is
 * followed. 6 puts the sampling error well under a nozzle at any sane width.
 */
const CELLS_PER_HALF_WIDTH = 6;

/**
 * Coarser sampling for OSM line layers.
 *
 * The route is the subject of the product and gets the fine default. A city's
 * worth of roads does not: at the fine setting, roads in a 1.6 km circle of
 * Islamabad came to 1.23 M triangles on their own, which is ten times the whole
 * terrain and produces an STL no slicer will enjoy. Halving the sampling
 * quarters the contour work, and a road is a 6 m ribbon nobody inspects for
 * curvature fidelity.
 */
export const FEATURE_CELLS_PER_HALF_WIDTH = 3;

/** Never build a grid larger than this, whatever the route length. */
const MAX_FIELD_CELLS = 6_000_000;

interface Field {
  data: Float32Array;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  cell: number;
}

/**
 * Distance to the centreline, computed only near it.
 *
 * Cells further than the band are left at Infinity, which reads as "outside"
 * everywhere it matters and costs nothing.
 */
function distanceField(
  centrelines: Pt[][],
  halfWidth_m: number,
  cell_m: number,
  selection: Ring | null,
): Field {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of centrelines) {
    for (const [x, y] of line) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // Two cells of padding so every contour closes inside the grid.
  const pad = halfWidth_m + cell_m * 3;
  const x0 = minX - pad;
  const y0 = minY - pad;
  const nx = Math.ceil((maxX + pad - x0) / cell_m) + 1;
  const ny = Math.ceil((maxY + pad - y0) / cell_m) + 1;

  const data = new Float32Array(nx * ny).fill(Infinity);
  const band = halfWidth_m + cell_m * 2;

  for (const line of centrelines) {
   for (let s = 1; s < line.length; s++) {
    const a = line[s - 1];
    const b = line[s];

    const loI = Math.max(0, Math.floor((Math.min(a[0], b[0]) - band - x0) / cell_m));
    const hiI = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0]) + band - x0) / cell_m));
    const loJ = Math.max(0, Math.floor((Math.min(a[1], b[1]) - band - y0) / cell_m));
    const hiJ = Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1]) + band - y0) / cell_m));

    for (let j = loJ; j <= hiJ; j++) {
      const y = y0 + j * cell_m;
      const row = j * nx;
      for (let i = loI; i <= hiI; i++) {
        const x = x0 + i * cell_m;
        const d = pointToSegment([x, y], a, b);
        if (d < data[row + i]) data[row + i] = d;
      }
    }
   }
  }

  // Clip to the selection by pushing everything outside it out of the level set.
  // Doing it here rather than with a 2D boolean keeps the whole pipeline free of
  // the sweep-line failures this module exists to avoid, and guarantees no
  // geometry survives outside the boundary
  // (docs/08-pitfalls.md#geometry-outside-boundary). The cut edge is stepped at
  // cell resolution — a sixth of the half-width, well under a nozzle.
  if (selection) {
    // By scanline, not per cell. Testing every cell against every ring segment
    // is cells x segments; intersecting one horizontal line per row is
    // rows x segments, which is the difference between usable and not on a
    // large selection.
    const crossings: number[] = [];
    for (let j = 0; j < ny; j++) {
      const y = y0 + j * cell_m;
      const row = j * nx;
      crossings.length = 0;

      for (let k = 0, n = selection.length; k < n; k++) {
        const ax = selection[k][0];
        const ay = selection[k][1];
        const bx = selection[(k + 1) % n][0];
        const by = selection[(k + 1) % n][1];
        if (ay > y === by > y) continue;
        crossings.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }

      if (crossings.length < 2) {
        data.fill(Infinity, row, row + nx);
        continue;
      }
      crossings.sort((p, q) => p - q);

      // Everything outside the inside-spans is out of the level set.
      let cursor = 0;
      for (let c = 0; c + 1 < crossings.length; c += 2) {
        const from = Math.max(0, Math.ceil((crossings[c] - x0) / cell_m));
        const to = Math.min(nx - 1, Math.floor((crossings[c + 1] - x0) / cell_m));
        if (from > cursor) data.fill(Infinity, row + cursor, row + Math.min(from, nx));
        cursor = Math.max(cursor, to + 1);
      }
      if (cursor < nx) data.fill(Infinity, row + cursor, row + nx);
    }
  }

  return { data, nx, ny, x0, y0, cell: cell_m };
}

/** Linear crossing between two corner samples. */
function lerp(iso: number, va: number, vb: number): number {
  if (!Number.isFinite(va) && !Number.isFinite(vb)) return 0.5;
  if (!Number.isFinite(va)) return 0;
  if (!Number.isFinite(vb)) return 1;
  const denom = vb - va;
  if (denom === 0) return 0.5;
  const t = (iso - va) / denom;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

type Seg = { from: Pt; to: Pt };

/**
 * Marching squares, oriented so the inside (distance < iso) is on the left of
 * every directed segment. That makes outer rings come out counter-clockwise and
 * holes clockwise with no post-hoc orientation fixing.
 */
function marchingSquares(field: Field, iso: number): Seg[] {
  const { data, nx, ny, x0, y0, cell } = field;
  const segments: Seg[] = [];

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const va = data[j * nx + i]; // bottom-left
      const vb = data[j * nx + i + 1]; // bottom-right
      const vc = data[(j + 1) * nx + i + 1]; // top-right
      const vd = data[(j + 1) * nx + i]; // top-left

      const code =
        (va < iso ? 1 : 0) | (vb < iso ? 2 : 0) | (vc < iso ? 4 : 0) | (vd < iso ? 8 : 0);
      if (code === 0 || code === 15) continue;

      const px = x0 + i * cell;
      const py = y0 + j * cell;

      // Crossing points on the four cell edges.
      const e0: Pt = [px + lerp(iso, va, vb) * cell, py]; // bottom
      const e1: Pt = [px + cell, py + lerp(iso, vb, vc) * cell]; // right
      const e2: Pt = [px + lerp(iso, vd, vc) * cell, py + cell]; // top
      const e3: Pt = [px, py + lerp(iso, va, vd) * cell]; // left

      switch (code) {
        case 1: segments.push({ from: e0, to: e3 }); break;
        case 2: segments.push({ from: e1, to: e0 }); break;
        case 3: segments.push({ from: e1, to: e3 }); break;
        case 4: segments.push({ from: e2, to: e1 }); break;
        case 6: segments.push({ from: e2, to: e0 }); break;
        case 7: segments.push({ from: e2, to: e3 }); break;
        case 8: segments.push({ from: e3, to: e2 }); break;
        case 9: segments.push({ from: e0, to: e2 }); break;
        case 11: segments.push({ from: e1, to: e2 }); break;
        case 12: segments.push({ from: e3, to: e1 }); break;
        case 13: segments.push({ from: e0, to: e1 }); break;
        case 14: segments.push({ from: e3, to: e0 }); break;

        // Saddles. Resolve with the cell centre so the two lobes join exactly
        // when the middle of the cell is inside — an inconsistent choice here
        // is what produces rings that never close.
        case 5: {
          const centreInside = (va + vb + vc + vd) / 4 < iso;
          if (centreInside) {
            segments.push({ from: e0, to: e1 });
            segments.push({ from: e2, to: e3 });
          } else {
            segments.push({ from: e0, to: e3 });
            segments.push({ from: e2, to: e1 });
          }
          break;
        }
        case 10: {
          const centreInside = (va + vb + vc + vd) / 4 < iso;
          if (centreInside) {
            segments.push({ from: e3, to: e0 });
            segments.push({ from: e1, to: e2 });
          } else {
            segments.push({ from: e1, to: e0 });
            segments.push({ from: e3, to: e2 });
          }
          break;
        }
      }
    }
  }

  return segments;
}

/** Chain directed segments head-to-tail into closed rings. */
function chainRings(segments: Seg[], cell: number): Ring[] {
  const quantum = cell * 1e-6;
  const key = (p: Pt) => `${Math.round(p[0] / quantum)},${Math.round(p[1] / quantum)}`;

  const outgoing = new Map<string, Seg[]>();
  for (const s of segments) {
    const k = key(s.from);
    const list = outgoing.get(k);
    if (list) list.push(s);
    else outgoing.set(k, [s]);
  }

  const used = new Set<Seg>();
  const rings: Ring[] = [];

  for (const seed of segments) {
    if (used.has(seed)) continue;

    const ring: Ring = [];
    let current: Seg | undefined = seed;
    const startKey = key(seed.from);
    let closed = false;

    while (current && !used.has(current)) {
      used.add(current);
      ring.push([current.from[0], current.from[1]]);

      const nextKey = key(current.to);
      if (nextKey === startKey) {
        closed = true;
        break;
      }

      const candidates = outgoing.get(nextKey);
      current = candidates?.find((s) => !used.has(s));
    }

    // Only a chain that returned to its start is a ring. The loop can also end
    // because it ran out of continuations, or walked into a segment another
    // chain already took — both leave a PARTIAL chain, and pushing that as a
    // ring gives it an implicit closing edge straight from its last point back
    // to its first, across the whole feature. Extruded, that edge becomes a long
    // thin blade standing out of the model.
    // See docs/08-pitfalls.md#unclosed-contour-chains.
    if (closed && ring.length >= 3) rings.push(ring);
  }

  return rings;
}

/**
 * Clean a raw marching-squares contour.
 *
 * Wherever the isoline passes close to a grid node, the two cells sharing that
 * node emit points a fraction of a cell apart. earcut turns those into sliver
 * triangles — on a lap contour, two thirds of its output came back degenerate,
 * which tears holes in the surface and leaves the solid non-manifold. Dropping
 * near-coincident and near-collinear vertices fixes it at the source, and cuts
 * the vertex count by an order of magnitude for free.
 *
 * Both tolerances are fractions of a cell, and a cell is a sixth of the
 * half-width, so the shape error stays around a hundredth of the ribbon width —
 * far below a nozzle at any print scale.
 */
function cleanRing(ring: Ring, cell: number): Ring {
  const dupEps = cell * 0.25;
  // Deliberately tight. Relaxing this to cell * 0.3 to save vertices collapses
  // narrow contours and loses whole rings on a figure-eight, so the ribbon
  // carries more triangles than it strictly needs to print. Reducing that is a
  // triangulation-density problem, not a tolerance one.
  const flatEps = cell * 0.05;

  const deduped: Ring = [];
  for (const p of ring) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= dupEps) deduped.push(p);
  }
  while (deduped.length > 2) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < dupEps) deduped.pop();
    else break;
  }
  if (deduped.length < 3) return [];

  const out: Ring = [];
  for (let i = 0; i < deduped.length; i++) {
    const prev = out.length > 0 ? out[out.length - 1] : deduped[deduped.length - 1];
    const next = deduped[(i + 1) % deduped.length];
    if (pointToSegment(deduped[i], prev, next) >= flatEps) out.push(deduped[i]);
  }

  return out.length >= 3 ? out : deduped;
}

/**
 * Smallest ring worth keeping, in cells of area.
 *
 * Where the contour pinches against itself — which a route doing repeated laps
 * does constantly — marching squares emits 3- and 4-vertex loops enclosing
 * essentially nothing. A real 10 km lap route produced eight of them, with areas
 * of 0, 0, 0, -1, -3, -1, 0 and 0 square metres alongside genuine holes of
 * 36 774 and 2 235. Passed to earcut as holes they wreck the triangulation and
 * the route comes back non-manifold, with a stray blade where the sliver was
 * extruded. A hole smaller than a few cells could not be resolved by a field
 * sampled at cell resolution anyway, so it is noise by construction.
 */
const MIN_RING_AREA_CELLS = 4;

/** Nest clockwise rings (holes) inside the smallest counter-clockwise ring containing them. */
function nestRings(rings: Ring[]): MultiPolygon {
  const outers: Array<{ ring: Ring; area: number }> = [];
  const holes: Ring[] = [];

  for (const ring of rings) {
    const area = ringArea(ring);
    if (area > 0) outers.push({ ring, area });
    else if (area < 0) holes.push(ring);
  }

  if (outers.length === 0) return [];

  // Largest first, so "smallest containing outer" is the last match.
  outers.sort((a, b) => b.area - a.area);
  const polygons: Polygon[] = outers.map((o) => [o.ring]);

  for (const hole of holes) {
    const probe = hole[0];
    let target = -1;
    for (let i = 0; i < outers.length; i++) {
      if (pointInRingLocal(probe[0], probe[1], outers[i].ring)) target = i;
    }
    if (target >= 0) polygons[target].push(hole);
  }

  return polygons;
}

function pointInRingLocal(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface RibbonFieldStats {
  cell_m: number;
  gridCells: number;
  rings: number;
  /** True when the grid cap forced a coarser cell than requested. */
  coarsened: boolean;
}

export interface RibbonFieldResult {
  polygons: MultiPolygon;
  stats: RibbonFieldStats;
}

/**
 * Build the ribbon footprint for a centreline.
 *
 * `width_m` is the full band width in world metres; the caller converts from
 * the style's print millimetres.
 */
/**
 * Build the ribbon footprint for one centreline, or for a whole network of them.
 *
 * Passing the entire network at once is what makes a city affordable. Every way
 * stamped into ONE field merges for free — no end caps where OSM happened to
 * split a street, no duplicated contour where ways abut. In a 3 km sample of
 * Islamabad, 67.5% of road ways were shorter than their own printed width and
 * end caps accounted for 56.4% of all contour length. One field per network
 * removes all of it. See docs/08-pitfalls.md#per-way-ribbon-explosion.
 */
export function buildRibbonField(
  centrelines: Pt[] | Pt[][],
  width_m: number,
  selection: Ring | null = null,
  cellsPerHalfWidth: number = CELLS_PER_HALF_WIDTH,
): RibbonFieldResult {
  const empty: RibbonFieldResult = {
    polygons: [],
    stats: { cell_m: 0, gridCells: 0, rings: 0, coarsened: false },
  };

  const lines: Pt[][] =
    centrelines.length > 0 && typeof (centrelines[0] as Pt)[0] === 'number'
      ? [centrelines as Pt[]]
      : (centrelines as Pt[][]);

  const usable = lines.filter((line) => line.length >= 2);
  if (usable.length === 0 || width_m <= 0) return empty;

  const halfWidth = width_m / 2;
  let cell = halfWidth / Math.max(1, cellsPerHalfWidth);
  let coarsened = false;

  // Guard the grid size the same way the terrain grid is guarded.
  for (;;) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const line of usable) {
      for (const [x, y] of line) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const pad = halfWidth + cell * 3;
    const cells =
      (Math.ceil((maxX - minX + pad * 2) / cell) + 1) * (Math.ceil((maxY - minY + pad * 2) / cell) + 1);
    if (cells <= MAX_FIELD_CELLS) break;
    cell *= Math.sqrt(cells / MAX_FIELD_CELLS);
    coarsened = true;
  }

  const field = distanceField(usable, halfWidth, cell, selection);
  const segments = marchingSquares(field, halfWidth);
  const minArea = MIN_RING_AREA_CELLS * cell * cell;
  const rings = chainRings(segments, cell)
    .map((ring) => cleanRing(ring, cell))
    .filter((ring) => ring.length >= 3 && Math.abs(ringArea(ring)) >= minArea);
  const polygons = nestRings(rings);

  return {
    polygons,
    stats: {
      cell_m: cell,
      gridCells: field.nx * field.ny,
      rings: rings.length,
      coarsened,
    },
  };
}
