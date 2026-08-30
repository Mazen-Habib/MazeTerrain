/**
 * Splitting a model into bed-sized tiles (docs/02-feature-spec.md F12).
 *
 * The print legibility validator has warned "larger than your bed — print it in
 * sections" since Phase 2, pointing at a feature that did not exist. This is
 * that feature.
 *
 * The planning is here, pure and free of WASM, because the grid is arithmetic
 * and worth testing on its own: how many tiles, how big, and which cells are
 * empty. The cutting itself is a boolean and lives in `splitForBed`.
 *
 * Tiles are cut with FLAT vertical seams. Registration features — dowel pins,
 * puzzle edges — are not in this pass; the seams are deterministic and glue
 * cleanly, but nothing holds the halves in alignment while the glue sets. That
 * is the next step, and `docs/09-roadmap.md` says so rather than this pretending
 * to be finished.
 */
import { intersectPart } from './boolean';
import type { MeshPart } from './types';

/** One cell of the grid, in model millimetres. */
export interface TileCell {
  row: number;
  col: number;
  /** Half-open in x and y: [x0, x1) x [y0, y1). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface TilePlan {
  cols: number;
  rows: number;
  tileWidth_mm: number;
  tileDepth_mm: number;
  cells: TileCell[];
  /** True when the bed had to be used turned 90 degrees to need fewer tiles. */
  bedTurned: boolean;
}

/**
 * A margin held back from the bed's stated size, mm per axis.
 *
 * A bed's nominal size is not all printable: clips, the purge line, and the
 * slicer's own exclusion zones eat into it, and a tile sized to the last
 * millimetre is the one that fails at layer 200. Five millimetres is the
 * smallest amount that has ever felt like enough.
 */
export const BED_MARGIN_MM = 5;

/**
 * Work out the grid needed to fit a model on a bed.
 *
 * Returns null when the model already fits — in either orientation, because a
 * 300 x 100 model goes on a 250 x 210 bed turned, and cutting it up would be
 * gratuitous.
 */
export function planTiles(
  width_mm: number,
  depth_mm: number,
  bed_mm: readonly [number, number],
  margin_mm = BED_MARGIN_MM,
): TilePlan | null {
  if (!(width_mm > 0) || !(depth_mm > 0)) return null;

  const bedW = bed_mm[0] - margin_mm;
  const bedD = bed_mm[1] - margin_mm;
  if (!(bedW > 0) || !(bedD > 0)) return null;

  const fits = (w: number, d: number) => width_mm <= w && depth_mm <= d;
  if (fits(bedW, bedD) || fits(bedD, bedW)) return null;

  // Both bed orientations, then whichever needs fewer tiles. A tie goes to the
  // unturned bed, which is what the user pictures.
  const straight = { cols: Math.ceil(width_mm / bedW), rows: Math.ceil(depth_mm / bedD) };
  const turned = { cols: Math.ceil(width_mm / bedD), rows: Math.ceil(depth_mm / bedW) };
  const bedTurned = turned.cols * turned.rows < straight.cols * straight.rows;
  const { cols, rows } = bedTurned ? turned : straight;

  // Equal tiles rather than full-bed tiles with a sliver left over: a 1 mm
  // strip is unprintable, and three equal thirds are easier to reassemble than
  // two full ones and a remainder.
  const tileWidth_mm = width_mm / cols;
  const tileDepth_mm = depth_mm / rows;

  const cells: TileCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        row,
        col,
        x0: -width_mm / 2 + col * tileWidth_mm,
        x1: -width_mm / 2 + (col + 1) * tileWidth_mm,
        y0: -depth_mm / 2 + row * tileDepth_mm,
        y1: -depth_mm / 2 + (row + 1) * tileDepth_mm,
      });
    }
  }

  return { cols, rows, tileWidth_mm, tileDepth_mm, cells, bedTurned };
}

/** `A1`, `B2` — column letter, row number, the way a map grid reads. */
export function tileLabel(cell: TileCell): string {
  return `${String.fromCharCode(65 + cell.col)}${cell.row + 1}`;
}

/**
 * A closed box covering one cell, tall enough to swallow the model whole.
 *
 * The intersection of the model with this is the tile. Z runs well past the
 * model in both directions so the cut is purely vertical — a box that stopped
 * at the model's own height would shave the peaks off.
 */
export function cellBox(cell: TileCell, minZ_mm: number, maxZ_mm: number): MeshPart {
  const { x0, x1, y0, y1 } = cell;
  const z0 = minZ_mm;
  const z1 = maxZ_mm;

  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);

  // Outward-facing everywhere: a box wound inside out would intersect to
  // nothing and the tile would silently vanish.
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);

  return { name: `cell:${tileLabel(cell)}`, color: '#888888', positions, indices, manifold: true };
}

/** Z extent across every part, print mm, or null when there is no geometry. */
export function zExtent(parts: readonly MeshPart[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const part of parts) {
    for (let i = 2; i < part.positions.length; i += 3) {
      const z = part.positions[i];
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}

/** XY extent across every part, print mm, or null when there is no geometry. */
export function xyExtent(
  parts: readonly MeshPart[],
): { width_mm: number; depth_mm: number; centreX_mm: number; centreY_mm: number } | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const part of parts) {
    for (let i = 0; i < part.positions.length; i += 3) {
      const x = part.positions[i];
      const y = part.positions[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  return {
    width_mm: x1 - x0,
    depth_mm: y1 - y0,
    centreX_mm: (x0 + x1) / 2,
    centreY_mm: (y0 + y1) / 2,
  };
}

/** How far the cutting box reaches past the model in Z, print mm. */
const BOX_HEADROOM_MM = 10;

export interface SplitResult {
  parts: MeshPart[];
  plan: TilePlan;
  /** Cells that came back empty — a corner of the grid a round model never reaches. */
  emptyCells: number;
}

/**
 * Cut every part into bed-sized tiles.
 *
 * Each layer is cut separately and keeps its own colour, so a multicolour model
 * survives tiling as a multicolour model. Names carry the grid reference —
 * `tile:A1:terrain` — which is what groups a tile's layers together for layout
 * and for the reassembly note.
 *
 * Returns null when the model already fits the bed. Nothing to do is not a
 * failure, and the caller should not have to ask twice.
 */
export async function splitForBed(
  parts: MeshPart[],
  bed_mm: readonly [number, number],
  margin_mm = BED_MARGIN_MM,
): Promise<SplitResult | null> {
  const extent = xyExtent(parts);
  const z = zExtent(parts);
  if (!extent || !z) return null;

  const plan = planTiles(extent.width_mm, extent.depth_mm, bed_mm, margin_mm);
  if (!plan) return null;

  const out: MeshPart[] = [];
  let emptyCells = 0;

  for (const cell of plan.cells) {
    // The plan is drawn about the origin; the model may not be centred there,
    // so the cell is moved onto it rather than the other way round.
    const placed: TileCell = {
      ...cell,
      x0: cell.x0 + extent.centreX_mm,
      x1: cell.x1 + extent.centreX_mm,
      y0: cell.y0 + extent.centreY_mm,
      y1: cell.y1 + extent.centreY_mm,
    };
    const box = cellBox(placed, z[0] - BOX_HEADROOM_MM, z[1] + BOX_HEADROOM_MM);
    const label = tileLabel(cell);

    let got = 0;
    for (const part of parts) {
      const piece = await intersectPart(part, box, {
        name: `tile:${label}:${part.name}`,
        color: part.color,
      });
      if (piece) {
        out.push(piece);
        got++;
      }
    }
    if (got === 0) emptyCells++;
  }

  if (out.length === 0) return null;
  return { parts: out, plan, emptyCells };
}
