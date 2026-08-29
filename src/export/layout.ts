/**
 * Laying parts out for a printer.
 *
 * The inlay sub-mode produces two solids that are DESIGNED to occupy the same
 * space: a body with a channel, and an insert sitting in it. That is the right
 * thing on screen — it is what the finished model looks like — and exactly the
 * wrong thing in a file going to a slicer. Nested solids there give internal
 * perimeters along the whole route, and an insert buried inside a cavity cannot
 * be printed at all.
 *
 * STL has no concept of parts, and a 3MF's objects still land on the plate
 * where they are put, so both need the pieces moved apart. The ZIP bundle does
 * not: it writes each part as its own file.
 */
import type { MeshPart } from '../geometry/types';

/** Gap between the body and a part set beside it, print mm. */
const GAP_MM = 8;

/** Parts printed separately rather than assembled. */
function isSeparate(part: MeshPart): boolean {
  return part.name.startsWith('insert');
}

function boundsOf(part: MeshPart): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < part.positions.length; i += 3) {
    if (part.positions[i] < minX) minX = part.positions[i];
    if (part.positions[i] > maxX) maxX = part.positions[i];
    if (part.positions[i + 1] < minY) minY = part.positions[i + 1];
    if (part.positions[i + 1] > maxY) maxY = part.positions[i + 1];
  }
  return { minX, maxX, minY, maxY };
}

function translated(part: MeshPart, dx: number, dy: number): MeshPart {
  const positions = new Float32Array(part.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += dx;
    positions[i + 1] += dy;
  }
  return { ...part, positions };
}

/**
 * Move every separately-printed part clear of the ones that stay assembled.
 *
 * Inserts are placed in a row to the east of the body, in the order they were
 * built, each clear of the last. Z is untouched: an insert already sits with
 * its flat underside at the channel floor, and that face is what it prints on.
 *
 * Returns the input array unchanged when there is nothing to move, so the
 * common case allocates nothing.
 */
export function layOutForPrint(parts: MeshPart[]): MeshPart[] {
  const separate = parts.filter(isSeparate);
  if (separate.length === 0) return parts;

  const assembled = parts.filter((p) => !isSeparate(p));
  if (assembled.length === 0) return parts;

  let edge = -Infinity;
  for (const part of assembled) edge = Math.max(edge, boundsOf(part).maxX);
  if (!Number.isFinite(edge)) return parts;

  const moved = new Map<MeshPart, MeshPart>();
  let cursor = edge + GAP_MM;
  for (const part of separate) {
    const b = boundsOf(part);
    if (!Number.isFinite(b.minX)) continue;
    moved.set(part, translated(part, cursor - b.minX, 0));
    cursor += b.maxX - b.minX + GAP_MM;
  }

  return parts.map((p) => moved.get(p) ?? p);
}

/** Whether laying out would move anything — for the UI to say so. */
export function hasSeparateParts(parts: MeshPart[]): boolean {
  return parts.some(isSeparate) && parts.some((p) => !isSeparate(p));
}
