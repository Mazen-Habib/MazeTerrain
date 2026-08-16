/**
 * Stages 4 and 8: heightfield -> closed, watertight solid.
 *
 * The terrain surface alone is not a solid. This builds all three shells at once
 * so their shared edges are shared *by index*, which is what makes the result
 * manifold before the validator ever runs:
 *
 *   top     regular grid triangulation, outward normals +Z
 *   walls   quads from each top boundary vertex down to the base plane
 *   bottom  triangle fan over the same boundary ring, outward normal -Z
 *
 * Building the walls from the boundary ring of the *clipped* top surface — not
 * from the original rectangle — is the fix for
 * docs/08-pitfalls.md#geometry-outside-boundary. For Phase 0 the selection is a
 * rectangle, so the ring is the grid perimeter; the ring is already the seam
 * every later shape will plug into.
 */
import { worldToPrint, type ResolvedScale } from './coords';
import type { Heightfield } from './heightfield';
import type { MeshPart } from './types';

export interface TerrainMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** Grid perimeter vertex count. */
  perimeter: number;
  dimensions_mm: [number, number, number];
}

/**
 * Grid perimeter in counter-clockwise order seen from above (+Z), returned as
 * indices into the top surface vertex grid.
 *
 * CCW-from-above is the convention that makes every winding below produce
 * outward normals. Reverse it and the model ships mirrored
 * (docs/08-pitfalls.md#mirrored-models).
 */
export function perimeterRing(cols: number, rows: number): Uint32Array {
  const count = 2 * (cols + rows - 2);
  const ring = new Uint32Array(count);
  let k = 0;

  // South edge, west -> east.
  for (let i = 0; i < cols; i++) ring[k++] = i;
  // East edge, south -> north.
  for (let j = 1; j < rows; j++) ring[k++] = j * cols + (cols - 1);
  // North edge, east -> west.
  for (let i = cols - 2; i >= 0; i--) ring[k++] = (rows - 1) * cols + i;
  // West edge, north -> south, stopping before the start vertex.
  for (let j = rows - 2; j >= 1; j--) ring[k++] = j * cols;

  return ring;
}

export function buildTerrainMesh(hf: Heightfield, s: ResolvedScale): TerrainMesh {
  const { cols, rows, data, spacingX_m, spacingY_m } = hf;

  if (cols < 2 || rows < 2) {
    throw new Error(`Grid too small to triangulate: ${cols} x ${rows}`);
  }

  const ring = perimeterRing(cols, rows);
  const P = ring.length;

  const topCount = cols * rows;
  const vertexCount = topCount + P + 1;
  const centroidIndex = topCount + P;

  const topTris = (cols - 1) * (rows - 1) * 2;
  const wallTris = P * 2;
  const bottomTris = P;
  const triangleCount = topTris + wallTris + bottomTris;

  // Pre-allocated to the known final size — no push() in a loop that runs
  // millions of times (docs/05, performance techniques).
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);

  const x0_m = -((cols - 1) * spacingX_m) / 2;
  const y0_m = -((rows - 1) * spacingY_m) / 2;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  // --- top surface vertices -------------------------------------------------
  for (let j = 0; j < rows; j++) {
    const y_m = y0_m + j * spacingY_m;
    const row = j * cols;
    for (let i = 0; i < cols; i++) {
      const x_m = x0_m + i * spacingX_m;
      const [x, y, z] = worldToPrint(x_m, y_m, data[row + i], s);

      const p = (row + i) * 3;
      positions[p] = x;
      positions[p + 1] = y;
      positions[p + 2] = z;

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }

  // --- bottom ring vertices, directly below the top ring at z = 0 -----------
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < P; k++) {
    const src = ring[k] * 3;
    const dst = (topCount + k) * 3;
    positions[dst] = positions[src];
    positions[dst + 1] = positions[src + 1];
    positions[dst + 2] = 0;
    cx += positions[src];
    cy += positions[src + 1];
  }

  const cIdx = centroidIndex * 3;
  positions[cIdx] = cx / P;
  positions[cIdx + 1] = cy / P;
  positions[cIdx + 2] = 0;
  minZ = 0;

  // --- top surface triangles ------------------------------------------------
  let t = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const v00 = j * cols + i;
      const v10 = v00 + 1;
      const v01 = v00 + cols;
      const v11 = v01 + 1;

      indices[t++] = v00;
      indices[t++] = v10;
      indices[t++] = v11;

      indices[t++] = v00;
      indices[t++] = v11;
      indices[t++] = v01;
    }
  }

  // --- side walls -----------------------------------------------------------
  // For ring segment k: a -> b along the top, a' -> b' along the base.
  // (a, a', b') and (a, b', b) both face outward for a CCW-from-above ring.
  for (let k = 0; k < P; k++) {
    const kNext = k + 1 === P ? 0 : k + 1;

    const a = ring[k];
    const b = ring[kNext];
    const aB = topCount + k;
    const bB = topCount + kNext;

    indices[t++] = a;
    indices[t++] = aB;
    indices[t++] = bB;

    indices[t++] = a;
    indices[t++] = bB;
    indices[t++] = b;
  }

  // --- base ----------------------------------------------------------------
  // A fan, not two big corner triangles: the fan consumes each base ring edge
  // exactly once, which is what lets every wall edge find its second face.
  for (let k = 0; k < P; k++) {
    const kNext = k + 1 === P ? 0 : k + 1;
    indices[t++] = centroidIndex;
    indices[t++] = topCount + kNext;
    indices[t++] = topCount + k;
  }

  return {
    positions,
    indices,
    perimeter: P,
    dimensions_mm: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

/** Per-vertex normals, area-weighted from the face normals. */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;

    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    normals[a] += nx;
    normals[a + 1] += ny;
    normals[a + 2] += nz;
    normals[b] += nx;
    normals[b + 1] += ny;
    normals[b + 2] += nz;
    normals[c] += nx;
    normals[c + 1] += ny;
    normals[c + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i];
    const y = normals[i + 1];
    const z = normals[i + 2];
    const len = Math.hypot(x, y, z);
    if (len > 0) {
      normals[i] = x / len;
      normals[i + 1] = y / len;
      normals[i + 2] = z / len;
    } else {
      normals[i + 2] = 1;
    }
  }

  return normals;
}

export function toMeshPart(
  name: string,
  color: string,
  mesh: TerrainMesh,
  manifold: boolean,
): MeshPart {
  return { name, color, positions: mesh.positions, indices: mesh.indices, manifold };
}
