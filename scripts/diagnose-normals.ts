/**
 * Why the viewer shows melted geometry while the STL is crisp.
 *
 * An STL stores one normal per FACET, so every face is flat and every edge
 * sharp. The viewer calls computeVertexNormals(), which averages the normals of
 * every face meeting at a vertex. extrudeDraped deliberately shares vertices
 * between a solid's top face and its vertical walls, so at every rim vertex a
 * horizontal normal is averaged with a vertical one and the 90-degree edge is
 * shaded as though it were a fillet.
 *
 * This counts how many vertices have faces disagreeing by more than a right
 * angle — the ones that cannot be smoothed without lying about the shape.
 */
import { buildFrame } from '../src/geometry/frame';
import { buildBaseline, buildLabelTool } from '../src/geometry/label';
import { buildTerrainMesh } from '../src/geometry/terrain';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { Ring } from '../src/geometry/polygons';

const bbox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };
const cells = 120;
const hf = makeHeightfield(cells, cells, (i, j) => 500 + 90 * Math.sin(i / 12) + 60 * Math.cos(j / 9), 60);
const scale = scaleFor(hf, { bbox });
const half_m = ((cells - 1) * hf.spacingX_m) / 2;

const ring: Ring = Array.from({ length: 180 }, (_, i) => {
  const a = (i / 180) * Math.PI * 2;
  return [Math.cos(a) * half_m, Math.sin(a) * half_m] as [number, number];
});

const frame = buildFrame(ring, { width_mm: 12.5, height_mm: 4.5, baseThickness_mm: 3, scale });
const ringPrint: Ring = ring.map(([x, y]) => [x * scale.scale, y * scale.scale] as [number, number]);
const baseline = buildBaseline(ringPrint, (12.5 + 6.5) / 2)!;
const label = buildLabelTool('MARGALLA TRAIL 3', {
  capHeight_mm: 6.5, depth_mm: 1, strokeWidth_mm: 'auto', minStrokeWidth_mm: 0.4,
  surfaceZ_mm: frame.top_mm,
}, baseline);
const terrain = buildTerrainMesh(hf, scale);

/**
 * Worst disagreement between faces meeting at each vertex, in degrees.
 *
 * @returns share of vertices where the disagreement exceeds `limit`
 */
function creaseStats(positions: Float32Array, indices: Uint32Array, limit = 60) {
  const n = positions.length / 3;
  const normals: Array<Array<[number, number, number]>> = Array.from({ length: n }, () => []);

  for (let k = 0; k < indices.length; k += 3) {
    const a = indices[k] * 3;
    const b = indices[k + 1] * 3;
    const c = indices[k + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len; ny /= len; nz /= len;
    for (let e = 0; e < 3; e++) normals[indices[k + e]].push([nx, ny, nz]);
  }

  let over = 0;
  let counted = 0;
  let worst = 0;
  for (const fan of normals) {
    if (fan.length < 2) continue;
    counted++;
    let maxAngle = 0;
    for (let i = 0; i < fan.length; i++) {
      for (let j = i + 1; j < fan.length; j++) {
        const dot = Math.max(-1, Math.min(1, fan[i][0] * fan[j][0] + fan[i][1] * fan[j][1] + fan[i][2] * fan[j][2]));
        maxAngle = Math.max(maxAngle, (Math.acos(dot) * 180) / Math.PI);
      }
    }
    if (maxAngle > worst) worst = maxAngle;
    if (maxAngle > limit) over++;
  }
  return { over, counted, worst, share: counted === 0 ? 0 : over / counted };
}

console.log('\nvertices whose faces disagree by more than 60 degrees');
console.log('part       vertices   creased   share   worst');
for (const [name, mesh] of [
  ['frame', frame.mesh],
  ['label', label.mesh],
  ['terrain', terrain],
] as const) {
  const s = creaseStats(mesh.positions, mesh.indices);
  console.log(
    `${name.padEnd(10)} ${String(s.counted).padStart(8)}  ${String(s.over).padStart(8)}` +
      `  ${(s.share * 100).toFixed(1).padStart(5)}%  ${s.worst.toFixed(0).padStart(4)}°`,
  );
}

console.log(
  '\nEvery creased vertex is one the viewer currently averages into a fillet,\n' +
    'and the STL renders as the hard edge it is.',
);
