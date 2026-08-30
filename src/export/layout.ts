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
 * where they are put, so both need the pieces moved apart.
 *
 * They also need moving DOWN. An insert's underside sits at the channel floor,
 * several millimetres up, which is exactly right in the assembled model and
 * leaves the part hovering above the bed the moment it is on its own. Every
 * export drops each separately-printed part onto z = 0 — including the ZIP,
 * which does not need the sideways move because each part is its own file, but
 * needs the drop just as much.
 */
import type { MeshPart } from '../geometry/types';

/** Gap between the body and a part set beside it, print mm. */
const GAP_MM = 8;

/** Parts printed separately rather than assembled. */
function isSeparate(part: MeshPart): boolean {
  return part.name.startsWith('insert');
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
}

function boundsOf(part: MeshPart): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  for (let i = 0; i < part.positions.length; i += 3) {
    if (part.positions[i] < minX) minX = part.positions[i];
    if (part.positions[i] > maxX) maxX = part.positions[i];
    if (part.positions[i + 1] < minY) minY = part.positions[i + 1];
    if (part.positions[i + 1] > maxY) maxY = part.positions[i + 1];
    if (part.positions[i + 2] < minZ) minZ = part.positions[i + 2];
  }
  return { minX, maxX, minY, maxY, minZ };
}

function translated(part: MeshPart, dx: number, dy: number, dz: number): MeshPart {
  if (dx === 0 && dy === 0 && dz === 0) return part;
  const positions = new Float32Array(part.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += dx;
    positions[i + 1] += dy;
    positions[i + 2] += dz;
  }
  return { ...part, positions };
}

/**
 * Put each separately-printed part's lowest point on the bed.
 *
 * Individually, not as a group: these parts are printed on their own, so each
 * one's own underside is the face it stands on. Parts that stay assembled are
 * left exactly as they are relative to each other — shifting one of those
 * independently would take a multicolour model apart.
 *
 * For the ZIP export, where every part is already its own file and no sideways
 * move is wanted.
 */
export function dropSeparateToPlate(parts: MeshPart[]): MeshPart[] {
  if (!parts.some(isSeparate)) return parts;
  return parts.map((part) => {
    if (!isSeparate(part)) return part;
    const { minZ } = boundsOf(part);
    return Number.isFinite(minZ) ? translated(part, 0, 0, -minZ) : part;
  });
}

/**
 * Move every separately-printed part clear of the ones that stay assembled.
 *
 * Inserts are placed in a row to the east of the body, in the order they were
 * built, each clear of the last, and each dropped so its own underside rests on
 * z = 0. The drop is not optional: an insert's flat underside sits at the
 * channel floor, millimetres above the bed, which is right in the assembled
 * model and leaves the part floating as soon as it is printed alone. A slicer
 * will not place it for you — it prints it in mid-air, or refuses.
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
    moved.set(part, translated(part, cursor - b.minX, 0, -b.minZ));
    cursor += b.maxX - b.minX + GAP_MM;
  }

  return parts.map((p) => moved.get(p) ?? p);
}

/** Whether laying out would move anything — for the UI to say so. */
export function hasSeparateParts(parts: MeshPart[]): boolean {
  return parts.some(isSeparate) && parts.some((p) => !isSeparate(p));
}
