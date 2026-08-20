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
function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceField(
  centreline: Pt[],
  halfWidth_m: number,
  cell_m: number,
  selection: Ring | null,
): Field {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of centreline) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // Two cells of padding so every contour closes inside the grid.
  const pad = halfWidth_m + cell_m * 3;
  const x0 = minX - pad;
  const y0 = minY - pad;
  const nx = Math.ceil((maxX + pad - x0) / cell_m) + 1;
  const ny = Math.ceil((maxY + pad - y0) / cell_m) + 1;

  const data = new Float32Array(nx * ny).fill(Infinity);
  const band = halfWidth_m + cell_m * 2;

  for (let s = 1; s < centreline.length; s++) {
    const a = centreline[s - 1];
    const b = centreline[s];

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

  // Clip to the selection by pushing everything outside it out of the level set.
  // Doing it here rather than with a 2D boolean keeps the whole pipeline free of
  // the sweep-line failures this module exists to avoid, and guarantees no
  // geometry survives outside the boundary
  // (docs/08-pitfalls.md#geometry-outside-boundary). The cut edge is stepped at
  // cell resolution — a sixth of the half-width, well under a nozzle.
  if (selection) {
    for (let j = 0; j < ny; j++) {
      const y = y0 + j * cell_m;
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        if (!pointInRing(x0 + i * cell_m, y, selection)) data[row + i] = Infinity;
      }
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

    while (current && !used.has(current)) {
      used.add(current);
      ring.push([current.from[0], current.from[1]]);

      const nextKey = key(current.to);
      if (nextKey === startKey) break;

      const candidates = outgoing.get(nextKey);
      current = candidates?.find((s) => !used.has(s));
    }

    // Rings shorter than a triangle are numerical dust.
    if (ring.length >= 3) rings.push(ring);
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
export function buildRibbonField(
  centreline: Pt[],
  width_m: number,
  selection: Ring | null = null,
): RibbonFieldResult {
  const empty: RibbonFieldResult = {
    polygons: [],
    stats: { cell_m: 0, gridCells: 0, rings: 0, coarsened: false },
  };
  if (centreline.length < 2 || width_m <= 0) return empty;

  const halfWidth = width_m / 2;
  let cell = halfWidth / CELLS_PER_HALF_WIDTH;
  let coarsened = false;

  // Guard the grid size the same way the terrain grid is guarded.
  for (;;) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of centreline) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = halfWidth + cell * 3;
    const cells =
      (Math.ceil((maxX - minX + pad * 2) / cell) + 1) * (Math.ceil((maxY - minY + pad * 2) / cell) + 1);
    if (cells <= MAX_FIELD_CELLS) break;
    cell *= Math.sqrt(cells / MAX_FIELD_CELLS);
    coarsened = true;
  }

  const field = distanceField(centreline, halfWidth, cell, selection);
  const segments = marchingSquares(field, halfWidth);
  const rings = chainRings(segments, cell)
    .map((ring) => cleanRing(ring, cell))
    .filter((ring) => ring.length >= 3);
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
