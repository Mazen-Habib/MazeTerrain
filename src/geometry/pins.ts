/**
 * Alignment pins on tile seams (docs/02-feature-spec.md F12).
 *
 * F12 shipped with flat butt joints and a note in the reassembly README saying
 * there were no pins yet. Flat seams glue fine, but nothing holds two halves
 * square while the glue sets, and on a terrain model a seam a millimetre out of
 * alignment shows as a ridge running across the landscape. This is the pin.
 *
 * A peg on one tile, a socket on the other, both straddling the seam plane.
 * Three decisions worth stating:
 *
 * **Pins live in the BASE slab, not in the terrain.** The base is the one part
 * of the model guaranteed to be solid everywhere the model exists — the terrain
 * above it can be a knife-edge ridge with no material to put a pin in. Sitting
 * at half the base thickness also keeps the pin well clear of the printed
 * surface, so it never shows.
 *
 * **The peg always goes on the lower-numbered tile** — the left one of a
 * vertical seam, the front one of a horizontal seam. Any consistent rule works;
 * what matters is that both tiles agree, and a rule beats storing the choice.
 *
 * **Pins are only placed where both tiles have material.** A round model does
 * not reach the corners of its grid, and a peg hanging in the air off the edge
 * of a tile is a snapped-off nub in the post.
 */
import type { MeshPart } from './types';
import type { Ring } from './polygons';
import { pointInRing } from './route';
import type { TilePlan } from './tiles';

/** Which way a pin points. A seam is always axis-aligned, so this is enough. */
export type PinAxis = 'x' | 'y';

export interface Pin {
  /** Centre of the pin, on the seam plane, print mm. */
  x: number;
  y: number;
  z: number;
  /** Normal of the seam the pin crosses. */
  axis: PinAxis;
  /** Grid label of the tile that gets the PEG. */
  peg: string;
  /** Grid label of the tile that gets the SOCKET. */
  socket: string;
}

/**
 * Pin radius as a share of the base thickness.
 *
 * A third: thick enough to resist snapping when the tiles are handled, thin
 * enough that a third of the base is still solid above and below it. A pin
 * wider than the base it sits in is a hole, not a pin.
 */
const RADIUS_OF_BASE = 1 / 3;

/** Never finer than this, or the pin is below what a nozzle can lay round. */
const MIN_RADIUS_MM = 0.8;
const MAX_RADIUS_MM = 2.5;

/** How far the pin reaches into each tile, print mm. */
const DEPTH_MM = 4;

/**
 * Gap between peg and socket, per side.
 *
 * The same 0.15 mm press fit the route insert uses, and for the same reason:
 * too tight and the tiles will not close, too loose and the joint does not
 * locate anything.
 */
export const PIN_CLEARANCE_MM = 0.15;

/** How many pins along one seam. */
const PINS_PER_SEAM = 3;

/** Keep pins this far from the model edge, so a peg is never half in air. */
const EDGE_MARGIN_MM = 6;

export interface PinPlanOptions {
  /** Model outline in PRINT mm — pins only go where the model actually is. */
  boundary_mm: Ring | null;
  baseThickness_mm: number;
  /** Model centre, because the plan's cells are drawn about the origin. */
  centreX_mm: number;
  centreY_mm: number;
}

export function pinRadius_mm(baseThickness_mm: number): number {
  return Math.min(MAX_RADIUS_MM, Math.max(MIN_RADIUS_MM, baseThickness_mm * RADIUS_OF_BASE));
}

/** `A1` from a row and column, matching `tileLabel`. */
function label(row: number, col: number): string {
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

/**
 * Where the pins go.
 *
 * One pass over the grid's internal seams. A seam between two cells that both
 * exist gets `PINS_PER_SEAM` pins spread along it, minus any that fall outside
 * the model.
 */
export function planPins(plan: TilePlan, options: PinPlanOptions): Pin[] {
  const { boundary_mm, baseThickness_mm, centreX_mm, centreY_mm } = options;
  if (!(baseThickness_mm > 0)) return [];

  const z = baseThickness_mm / 2;
  const pins: Pin[] = [];

  const inside = (x: number, y: number) =>
    !boundary_mm || pointInRing(x, y, boundary_mm);

  /** A pin is only useful if the model is there, and not right on its edge. */
  const usable = (x: number, y: number, axis: PinAxis) => {
    if (!inside(x, y)) return false;
    // Sample along the seam either side: near the outline the model may be
    // present at the centre and gone a few millimetres along.
    const dx = axis === 'x' ? 0 : EDGE_MARGIN_MM;
    const dy = axis === 'x' ? EDGE_MARGIN_MM : 0;
    return inside(x - dx, y - dy) && inside(x + dx, y + dy);
  };

  // Vertical seams: between column c and c + 1, running in y.
  for (let row = 0; row < plan.rows; row++) {
    for (let col = 0; col < plan.cols - 1; col++) {
      const cell = plan.cells.find((c) => c.row === row && c.col === col);
      if (!cell) continue;
      const seamX = cell.x1 + centreX_mm;
      for (let i = 1; i <= PINS_PER_SEAM; i++) {
        const t = i / (PINS_PER_SEAM + 1);
        const y = cell.y0 + (cell.y1 - cell.y0) * t + centreY_mm;
        if (!usable(seamX, y, 'x')) continue;
        pins.push({
          x: seamX,
          y,
          z,
          axis: 'x',
          peg: label(row, col),
          socket: label(row, col + 1),
        });
      }
    }
  }

  // Horizontal seams: between row r and r + 1, running in x.
  for (let row = 0; row < plan.rows - 1; row++) {
    for (let col = 0; col < plan.cols; col++) {
      const cell = plan.cells.find((c) => c.row === row && c.col === col);
      if (!cell) continue;
      const seamY = cell.y1 + centreY_mm;
      for (let i = 1; i <= PINS_PER_SEAM; i++) {
        const t = i / (PINS_PER_SEAM + 1);
        const x = cell.x0 + (cell.x1 - cell.x0) * t + centreX_mm;
        if (!usable(x, seamY, 'y')) continue;
        pins.push({
          x,
          y: seamY,
          z,
          axis: 'y',
          peg: label(row, col),
          socket: label(row + 1, col),
        });
      }
    }
  }

  return pins;
}

/** Facets round a pin. Twenty-four is smooth at 2 mm and cheap. */
const SIDES = 24;

/**
 * A closed cylinder straddling the seam, as a mesh.
 *
 * Straddling rather than sitting on one side: the same solid is unioned into
 * the peg tile and subtracted from the socket tile, so the half that matters to
 * each is the half on its own side. The other half is already inside solid
 * material, where it changes nothing.
 */
export function pinCylinder(pin: Pin, radius_mm: number, name: string): MeshPart {
  const half = DEPTH_MM;
  const positions: number[] = [];
  const indices: number[] = [];

  // Along the pin's axis, the two end-cap centres.
  const axisVec: [number, number, number] = pin.axis === 'x' ? [1, 0, 0] : [0, 1, 0];
  const capA: [number, number, number] = [
    pin.x - axisVec[0] * half,
    pin.y - axisVec[1] * half,
    pin.z,
  ];
  const capB: [number, number, number] = [
    pin.x + axisVec[0] * half,
    pin.y + axisVec[1] * half,
    pin.z,
  ];

  positions.push(...capA, ...capB);

  // Ring vertices, in the plane perpendicular to the axis. That plane is
  // spanned by Z and whichever of X/Y the axis is not.
  for (let i = 0; i < SIDES; i++) {
    const a = (i / SIDES) * Math.PI * 2;
    const across = Math.cos(a) * radius_mm;
    const up = Math.sin(a) * radius_mm;
    const ox = pin.axis === 'x' ? 0 : across;
    const oy = pin.axis === 'x' ? across : 0;
    positions.push(capA[0] + ox, capA[1] + oy, capA[2] + up);
    positions.push(capB[0] + ox, capB[1] + oy, capB[2] + up);
  }

  const ringA = (i: number) => 2 + (i % SIDES) * 2;
  const ringB = (i: number) => 3 + (i % SIDES) * 2;

  for (let i = 0; i < SIDES; i++) {
    const a0 = ringA(i);
    const a1 = ringA(i + 1);
    const b0 = ringB(i);
    const b1 = ringB(i + 1);

    // Wound so every DIRECTED edge appears exactly once across the whole
    // solid. That is a stricter condition than "every edge has two faces",
    // which is all `validateMesh` checks — a mesh can pair every undirected
    // edge and still have a cap fan running the same way round as the wall it
    // meets. manifold-3d rejects that outright with "Not manifold", and it is
    // right to: the surface has no consistent inside.
    //
    // Sides contribute the ring edges a0->a1 and b1->b0, so the caps must
    // supply a1->a0 and b0->b1 to pair with them.
    indices.push(a0, b1, b0);
    indices.push(a0, a1, b1);
    indices.push(0, a1, a0);
    indices.push(1, b0, b1);
  }

  return {
    name,
    color: '#888888',
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    manifold: true,
  };
}
