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

/**
 * Which physical piece a part belongs to.
 *
 * Not one part per piece: a tile of a multicolour model is several parts — one
 * per layer — that have to travel together, and moving them independently would
 * scatter a tile's roads away from its terrain. Everything that is not called
 * out here is part of the one assembled body.
 *
 * - `insert:0`          -> its own piece, seated by hand after printing
 * - `tile:A1:terrain`   -> piece `tile:A1`, along with every other `tile:A1:*`
 */
export function printUnit(part: MeshPart): string {
  if (part.name.startsWith('insert')) return part.name;
  if (part.name.startsWith('tile:')) {
    const [, label] = part.name.split(':');
    return `tile:${label}`;
  }
  return BODY;
}

/** The unit that stays where it is. */
const BODY = 'body';

/** Parts printed separately rather than as part of the assembled body. */
function isSeparate(part: MeshPart): boolean {
  return printUnit(part) !== BODY;
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

  // By UNIT, not by part: a tile's layers share an underside, and dropping each
  // of them by its own lowest point would leave the roads floating above the
  // terrain they belong to.
  const floor = new Map<string, number>();
  for (const part of parts) {
    if (!isSeparate(part)) continue;
    const unit = printUnit(part);
    const { minZ } = boundsOf(part);
    if (!Number.isFinite(minZ)) continue;
    floor.set(unit, Math.min(floor.get(unit) ?? Infinity, minZ));
  }

  return parts.map((part) => {
    if (!isSeparate(part)) return part;
    const dz = floor.get(printUnit(part));
    return dz === undefined ? part : translated(part, 0, 0, -dz);
  });
}

/** Kept clear of the bed edge, so a piece is never right on the boundary. */
const BED_MARGIN_MM = 5;

/**
 * Arrange every piece so the whole model fits the bed.
 *
 * Pieces used to go in a single row east of the body, which works for one small
 * insert and fails for everything else. A 100 mm model with a route insert and
 * a water insert is three pieces roughly 100 mm wide: in a row that is over
 * 320 mm, so on a 220 mm Creality bed two of them hang off the side and the
 * user has to arrange the plate by hand — which is the job this function
 * exists to do.
 *
 * They are now shelf-packed into a grid: fill a row left to right, and when the
 * next piece would cross the bed's usable width, start a new row below. Three
 * ~100 mm pieces become a 2 x 2 arrangement that fits 220 mm with room to
 * spare.
 *
 * **The body is packed with everything else** rather than staying at the
 * origin. Leaving it centred is what forced the inserts out to the side in the
 * first place: it occupies the middle of the bed and leaves only half the width
 * on either flank, which nothing model-sized fits into.
 *
 * With no bed selected the width is unbounded and this degrades to the old
 * single row, which is the correct answer when we do not know what it has to
 * fit on.
 *
 * Every piece is also dropped so its own underside rests on z = 0. The drop is
 * not optional: an insert's flat underside sits at the channel floor,
 * millimetres above the bed, which is right in the assembled model and leaves
 * the part floating as soon as it is printed alone. A slicer will not place it
 * for you — it prints it in mid-air, or refuses.
 *
 * Returns the input array unchanged when nothing needs to move, so the common
 * single-piece case allocates nothing.
 */
export function layOutForPrint(
  parts: MeshPart[],
  bed_mm?: readonly [number, number] | null,
): MeshPart[] {
  // Group into pieces, keeping the order they were built in.
  const units = new Map<string, MeshPart[]>();
  for (const part of parts) {
    const unit = printUnit(part);
    const list = units.get(unit);
    if (list) list.push(part);
    else units.set(unit, [part]);
  }
  if (units.size < 2) return parts;

  // The body first, so the arrangement is predictable and the main model reads
  // top-left rather than wherever the build order happened to put it.
  const order = [...units.keys()].sort((a, b) =>
    a === BODY ? -1 : b === BODY ? 1 : 0,
  );

  const sized = order
    .map((unit) => ({ unit, members: units.get(unit) ?? [], bounds: groupBounds(units.get(unit) ?? []) }))
    .filter((p): p is { unit: string; members: MeshPart[]; bounds: Bounds } => p.bounds !== null);
  if (sized.length === 0) return parts;

  const usableWidth = bed_mm ? Math.max(0, bed_mm[0] - BED_MARGIN_MM * 2) : Infinity;

  // Shelf-pack. `placed` records the target minX/minY for each piece.
  const placed: Array<{ members: MeshPart[]; bounds: Bounds; x: number; y: number }> = [];
  let cursorX = 0;
  let shelfY = 0;
  let shelfDepth = 0;
  let widest = 0;

  for (const piece of sized) {
    const w = piece.bounds.maxX - piece.bounds.minX;
    const d = piece.bounds.maxY - piece.bounds.minY;

    // Wrap when this piece would cross the bed edge — but never wrap a row that
    // is still empty, or a piece wider than the whole bed would loop forever.
    if (cursorX > 0 && cursorX + w > usableWidth) {
      shelfY -= shelfDepth + GAP_MM;
      cursorX = 0;
      shelfDepth = 0;
    }

    placed.push({ members: piece.members, bounds: piece.bounds, x: cursorX, y: shelfY - d });
    cursorX += w + GAP_MM;
    widest = Math.max(widest, cursorX - GAP_MM);
    shelfDepth = Math.max(shelfDepth, d);
  }

  // Centre the whole arrangement on the origin, which is where the bed centre
  // is. Packing from a corner and leaving it there would put a small model in
  // the top-left of the plate for no reason.
  const totalDepth = -(shelfY - shelfDepth);
  const offsetX = -widest / 2;
  const offsetY = totalDepth / 2;

  const moved = new Map<MeshPart, MeshPart>();
  for (const piece of placed) {
    const dx = piece.x + offsetX - piece.bounds.minX;
    const dy = piece.y + offsetY - piece.bounds.minY;
    const dz = -piece.bounds.minZ;
    if (dx === 0 && dy === 0 && dz === 0) continue;
    for (const part of piece.members) moved.set(part, translated(part, dx, dy, dz));
  }

  if (moved.size === 0) return parts;
  return parts.map((p) => moved.get(p) ?? p);
}

/** Bounds across a whole piece, so its parts move as one. */
function groupBounds(members: readonly MeshPart[]): Bounds | null {
  let out: Bounds | null = null;
  for (const part of members) {
    const b = boundsOf(part);
    if (!Number.isFinite(b.minX)) continue;
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          maxX: Math.max(out.maxX, b.maxX),
          minY: Math.min(out.minY, b.minY),
          maxY: Math.max(out.maxY, b.maxY),
          minZ: Math.min(out.minZ, b.minZ),
        }
      : b;
  }
  return out;
}

/**
 * Whether the model prints as more than one physical piece.
 *
 * Counts PIECES, not parts. It used to require both a separate part and a body,
 * which is right for a cut-out insert and wrong for a model split for the bed:
 * every part of that is a tile, there is no body, and the UI concluded there
 * was nothing to hand out as separate files — exactly when separate files
 * matter most.
 *
 * Equivalently: whether `layOutForPrint` would move anything.
 */
export function hasSeparateParts(parts: MeshPart[]): boolean {
  const units = new Set<string>();
  for (const part of parts) units.add(printUnit(part));
  return units.size > 1;
}
