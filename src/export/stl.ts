/**
 * Binary STL writer (docs/06-export-formats.md).
 *
 * ASCII STL is 5x larger for no benefit, so binary only.
 * Units are millimetres — slicers assume mm for STL, so we must not scale.
 */
import type { MeshPart } from '../geometry/types';

const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

/** The 80-byte header is the attribution slot. Use it. */
export function stlHeader(version = '0.1.0'): string {
  return `Peakora ${version} | (c) OpenStreetMap contributors | Copernicus DEM`;
}

/**
 * Write parts as a single binary STL body.
 *
 * STL has no concept of parts, so everything is merged. For multi-material
 * output use 3MF instead (Phase 2).
 */
export function writeBinarySTL(parts: MeshPart[], header = stlHeader()): ArrayBuffer {
  let triangleCount = 0;
  for (const part of parts) triangleCount += part.indices.length / 3;

  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + triangleCount * TRIANGLE_BYTES);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Header: ASCII, truncated at 80 bytes, zero-padded.
  for (let i = 0; i < Math.min(header.length, HEADER_BYTES); i++) {
    const code = header.charCodeAt(i);
    bytes[i] = code < 128 ? code : 0x3f; // '?' for anything non-ASCII
  }

  view.setUint32(HEADER_BYTES, triangleCount, true);

  let offset = HEADER_BYTES + 4;

  for (const part of parts) {
    const { positions, indices } = part;

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

      // Face normal from the winding. Do not emit zeros and hope.
      const abx = bx - ax;
      const aby = by - ay;
      const abz = bz - az;
      const acx = cx - ax;
      const acy = cy - ay;
      const acz = cz - az;

      let nx = aby * acz - abz * acy;
      let ny = abz * acx - abx * acz;
      let nz = abx * acy - aby * acx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) {
        nx /= len;
        ny /= len;
        nz /= len;
      }

      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);

      view.setFloat32(offset + 12, ax, true);
      view.setFloat32(offset + 16, ay, true);
      view.setFloat32(offset + 20, az, true);

      view.setFloat32(offset + 24, bx, true);
      view.setFloat32(offset + 28, by, true);
      view.setFloat32(offset + 32, bz, true);

      view.setFloat32(offset + 36, cx, true);
      view.setFloat32(offset + 40, cy, true);
      view.setFloat32(offset + 44, cz, true);

      view.setUint16(offset + 48, 0, true);
      offset += TRIANGLE_BYTES;
    }
  }

  return buffer;
}

/** Read back a binary STL's triangle count. Used by the round-trip test. */
export function readTriangleCount(buffer: ArrayBuffer): number {
  return new DataView(buffer).getUint32(HEADER_BYTES, true);
}

/** docs/06-export-formats.md filename convention. */
export function stlFilename(placeSlug: string, modelWidth_mm: number, date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const size = Number.isInteger(modelWidth_mm) ? modelWidth_mm : modelWidth_mm.toFixed(1);
  return `peakora_${placeSlug}_${size}mm_${y}${m}${d}.stl`;
}
