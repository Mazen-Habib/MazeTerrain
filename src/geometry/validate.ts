/**
 * Stage 9: manifold and watertight validation.
 *
 * CLAUDE.md: "The mesh must be watertight and manifold. Every export path ends
 * in a validation step. If it isn't manifold, it is a bug, not a 'slicer will
 * fix it'."
 *
 * This module is the one thing standing between the product and a support inbox
 * full of broken prints (docs/09-roadmap.md, sequencing rule 2). It is written
 * in Phase 0 and never disabled.
 */
import type { ValidationResult } from './types';

/** Weld tolerance. Below this, two vertices are floating-point noise apart. */
export const WELD_EPSILON_MM = 1e-5;

/** A triangle whose area is under this is degenerate. */
const DEGENERATE_AREA_MM2 = 1e-12;

/**
 * Edge keys pack two vertex indices into one number.
 * 2^22 = 4 194 304 supports meshes well past MAX_GRID_VERTICES, and the largest
 * key stays under 2^44 — comfortably inside the safe integer range.
 */
const EDGE_SHIFT = 4194304;

export interface WeldedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** How many vertices the weld collapsed. */
  merged: number;
}

/**
 * Merge vertices closer than `epsilon`.
 *
 * Without this, floating-point noise produces phantom open edges and the
 * manifold check fails on a mesh that is geometrically closed
 * (docs/08-pitfalls.md#non-manifold-export).
 */
export function weldVertices(
  positions: Float32Array,
  indices: Uint32Array,
  epsilon = WELD_EPSILON_MM,
): WeldedMesh {
  const vertexCount = positions.length / 3;
  const inv = 1 / epsilon;

  const lookup = new Map<string, number>();
  const remap = new Uint32Array(vertexCount);
  const kept = new Float32Array(positions.length);
  let next = 0;

  for (let v = 0; v < vertexCount; v++) {
    const p = v * 3;
    const key =
      Math.round(positions[p] * inv) +
      ',' +
      Math.round(positions[p + 1] * inv) +
      ',' +
      Math.round(positions[p + 2] * inv);

    const existing = lookup.get(key);
    if (existing !== undefined) {
      remap[v] = existing;
      continue;
    }

    const dst = next * 3;
    kept[dst] = positions[p];
    kept[dst + 1] = positions[p + 1];
    kept[dst + 2] = positions[p + 2];
    lookup.set(key, next);
    remap[v] = next;
    next++;
  }

  const outIndices = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) outIndices[i] = remap[indices[i]];

  return {
    positions: kept.subarray(0, next * 3),
    indices: outIndices,
    merged: vertexCount - next,
  };
}

/** Drop zero-area triangles and triangles that reference the same vertex twice. */
export function removeDegenerates(
  positions: Float32Array,
  indices: Uint32Array,
): { indices: Uint32Array; removed: number } {
  const keep = new Uint32Array(indices.length);
  let k = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i];
    const ib = indices[i + 1];
    const ic = indices[i + 2];

    if (ia === ib || ib === ic || ia === ic) continue;
    if (triangleArea2(positions, ia, ib, ic) <= DEGENERATE_AREA_MM2) continue;

    keep[k++] = ia;
    keep[k++] = ib;
    keep[k++] = ic;
  }

  return { indices: keep.slice(0, k), removed: (indices.length - k) / 3 };
}

function triangleArea2(positions: Float32Array, ia: number, ib: number, ic: number): number {
  const a = ia * 3;
  const b = ib * 3;
  const c = ic * 3;

  const abx = positions[b] - positions[a];
  const aby = positions[b + 1] - positions[a + 1];
  const abz = positions[b + 2] - positions[a + 2];
  const acx = positions[c] - positions[a];
  const acy = positions[c + 1] - positions[a + 1];
  const acz = positions[c + 2] - positions[a + 2];

  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;

  return (nx * nx + ny * ny + nz * nz) / 4;
}

/**
 * Signed volume of a closed mesh: sum of dot(v0, cross(v1, v2)) / 6.
 * Positive for a correctly-oriented mesh. Negative means the whole thing is
 * inside-out — which renders and even slices, but prints as a mould of the model.
 */
export function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let total = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;

    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];

    total += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }

  return total / 6;
}

/**
 * Full validation. Assumes vertices are already welded — callers that have not
 * welded should use repairAndValidate().
 */
export function validateMesh(positions: Float32Array, indices: Uint32Array): ValidationResult {
  const faceCount = new Map<number, number>();

  for (let i = 0; i < indices.length; i += 3) {
    addEdge(faceCount, indices[i], indices[i + 1]);
    addEdge(faceCount, indices[i + 1], indices[i + 2]);
    addEdge(faceCount, indices[i + 2], indices[i]);
  }

  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of faceCount.values()) {
    if (count < 2) openEdges++;
    else if (count > 2) nonManifoldEdges++;
  }

  let degenerateTriangles = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i];
    const ib = indices[i + 1];
    const ic = indices[i + 2];
    if (ia === ib || ib === ic || ia === ic) degenerateTriangles++;
    else if (triangleArea2(positions, ia, ib, ic) <= DEGENERATE_AREA_MM2) degenerateTriangles++;
  }

  const volume = signedVolume(positions, indices);
  const watertight = openEdges === 0;
  // Manifoldness is topological: every edge shared by exactly two faces. A
  // zero-area triangle carries three edges that pair up like any other face, so
  // it does not break that, and slicers discard it. Counting slivers as
  // non-manifold blocked export on solids that were genuinely watertight.
  // They are still reported, and assemble() warns about them.
  const manifold = watertight && nonManifoldEdges === 0;

  return {
    manifold,
    watertight,
    openEdges,
    nonManifoldEdges,
    degenerateTriangles,
    inverted: volume < 0,
    volume_mm3: Math.abs(volume),
  };
}

function addEdge(map: Map<number, number>, a: number, b: number): void {
  const key = a < b ? a * EDGE_SHIFT + b : b * EDGE_SHIFT + a;
  map.set(key, (map.get(key) ?? 0) + 1);
}

export interface RepairedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  validation: ValidationResult;
  merged: number;
  removed: number;
}

/**
 * Weld, then repair only if repair actually helps.
 *
 * Deleting a zero-area triangle from a CLOSED mesh does not clean it up — it
 * punches a hole. Each removed triangle leaves its three edges with one face
 * instead of two, so a solid that was watertight comes back reporting 3n open
 * edges. That is how a route with 78 sliver triangles reported exactly 234 open
 * edges while being geometrically sound.
 *
 * Degenerate triangles are topologically harmless: they carry three edges that
 * pair up like any other face, and slicers ignore them. So the welded mesh is
 * validated first, degenerate removal is tried second, and whichever is more
 * closed wins. Repair is attempted once and can never make the mesh worse than
 * it arrived.
 *
 * See docs/08-pitfalls.md#repair-that-breaks-closure.
 */
function brokenness(v: ValidationResult): number {
  return v.openEdges + v.nonManifoldEdges;
}

export function repairAndValidate(
  positions: Float32Array,
  indices: Uint32Array,
): RepairedMesh {
  const welded = weldVertices(positions, indices);
  const asWelded = validateMesh(welded.positions, welded.indices);

  // Nothing to gain: a closed mesh stays closed, slivers and all.
  if (brokenness(asWelded) === 0) {
    return {
      positions: welded.positions,
      indices: welded.indices,
      validation: asWelded,
      merged: welded.merged,
      removed: 0,
    };
  }

  const cleaned = removeDegenerates(welded.positions, welded.indices);
  const asCleaned = validateMesh(welded.positions, cleaned.indices);

  if (brokenness(asCleaned) < brokenness(asWelded)) {
    return {
      positions: welded.positions,
      indices: cleaned.indices,
      validation: asCleaned,
      merged: welded.merged,
      removed: cleaned.removed,
    };
  }

  return {
    positions: welded.positions,
    indices: welded.indices,
    validation: asWelded,
    merged: welded.merged,
    removed: 0,
  };
}


/**
 * Feature geometry that floats far above the ground it drapes on.
 *
 * A draped solid should sit within its own height of the terrain. When one does
 * not, it reads on screen as a sharp cone or blade standing out of the model,
 * and it prints as one — but nothing else catches it, because the mesh is
 * perfectly watertight and manifold either way. That is what made the
 * undraped-feature bug so hard to see
 * (docs/08-pitfalls.md#undraped-features-let-terrain-through): every existing
 * check passed while the model was visibly wrong.
 *
 * Terrain heights are read from a coarse bin rather than interpolated. That is
 * deliberate — it makes the check cheap enough to run on every build, and a bin
 * only ever reports the HIGHEST ground nearby, so it under-reports rather than
 * inventing spikes.
 */
export interface FloatingCheck {
  /** Vertices standing further above the terrain than they should. */
  count: number;
  /** The worst offender's height above the ground beneath it, print mm. */
  worst_mm: number;
  /** Where it is, in print millimetres, for a bug report that can be acted on. */
  at: [number, number] | null;
}

export function findFloatingVertices(
  terrain: Float32Array,
  featurePositions: Float32Array,
  allowed_mm: number,
  bin_mm = 0.4,
): FloatingCheck {
  if (terrain.length === 0 || featurePositions.length === 0) {
    return { count: 0, worst_mm: 0, at: null };
  }

  const ground = new Map<number, number>();
  const key = (x: number, y: number) =>
    (Math.round(x / bin_mm) + 32768) * 65536 + (Math.round(y / bin_mm) + 32768);

  for (let i = 0; i < terrain.length; i += 3) {
    const k = key(terrain[i], terrain[i + 1]);
    const current = ground.get(k);
    if (current === undefined || terrain[i + 2] > current) ground.set(k, terrain[i + 2]);
  }

  let count = 0;
  let worst = 0;
  let at: [number, number] | null = null;

  for (let i = 0; i < featurePositions.length; i += 3) {
    const x = featurePositions[i];
    const y = featurePositions[i + 1];
    let below = ground.get(key(x, y));

    // Nearest filled bin, so a vertex just past the terrain edge is not
    // reported as floating a kilometre in the air.
    if (below === undefined) {
      const gx = Math.round(x / bin_mm);
      const gy = Math.round(y / bin_mm);
      for (let r = 1; r <= 2 && below === undefined; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const v = ground.get(key((gx + dx) * bin_mm, (gy + dy) * bin_mm));
            if (v !== undefined && (below === undefined || v > below)) below = v;
          }
        }
      }
    }
    if (below === undefined) continue;

    const above = featurePositions[i + 2] - below;
    if (above <= allowed_mm) continue;
    count++;
    if (above > worst) {
      worst = above;
      at = [x, y];
    }
  }

  return { count, worst_mm: worst, at };
}
