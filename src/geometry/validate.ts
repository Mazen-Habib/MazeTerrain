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
  const manifold = watertight && nonManifoldEdges === 0 && degenerateTriangles === 0;

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
 * Weld, drop degenerates, then validate.
 *
 * Repair is attempted exactly once. If the result still is not manifold we
 * report it honestly rather than exporting something broken and hoping the
 * slicer copes.
 */
export function repairAndValidate(
  positions: Float32Array,
  indices: Uint32Array,
): RepairedMesh {
  const welded = weldVertices(positions, indices);
  const cleaned = removeDegenerates(welded.positions, welded.indices);
  const validation = validateMesh(welded.positions, cleaned.indices);

  return {
    positions: welded.positions,
    indices: cleaned.indices,
    validation,
    merged: welded.merged,
    removed: cleaned.removed,
  };
}
