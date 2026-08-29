/**
 * The radial line running from the rim towards the centre of a circular model.
 *
 * It shows in the viewer AND in the slicer, so it is geometry, not shading. The
 * bottom face is a flat fan at z = 0 and cannot crease, so the suspicion is the
 * SKIRT: `buildClippedTerrainMesh` chains the open edges of the clipped top
 * surface into rings and drops a wall down from each. If the clipped surface
 * has a slit — a cut reaching inward that is zero cells wide — the chain walks
 * in along one side and back out along the other, and the wall follows it,
 * leaving a vertical fin buried inside the model.
 *
 * This measures how far each wall segment sits from the boundary it is supposed
 * to be on.
 */
import { buildClippedTerrainMesh } from '../src/geometry/terrainClip';
import { selectionRingWorld } from '../src/geometry/selection';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { SelectionShape } from '../src/geometry/selection';

const LAT = 33.7;
const LON = 73.06;
const extent_km = Number(process.argv[2] ?? 9.3);
const cells = Number(process.argv[3] ?? 600);

const half = extent_km / 2;
const bbox = {
  west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - half / 110.574,
  north: LAT + half / 110.574,
};

// Rough but realistic relief, so the clip meets the grid at many angles.
const hf = makeHeightfield(
  cells,
  cells,
  (i, j) => 500 + 180 * Math.sin(i / 40) + 140 * Math.cos(j / 33) + 40 * Math.sin(i / 9 + j / 7),
  (extent_km * 1000) / (cells - 1),
);
const scale = scaleFor(hf, { bbox });

const radius_m = ((cells - 1) * hf.spacingX_m) / 2;
const shape: SelectionShape = { kind: 'circle', lon: LON, lat: LAT, radius_m: radius_m * 0.98 };
const ring = selectionRingWorld(shape, scale.origin);

console.log(`\n${extent_km} km, ${cells} cells, circle radius ${(radius_m * 0.98).toFixed(0)} m`);

const mesh = buildClippedTerrainMesh(hf, scale, ring);
console.log(`terrain: ${mesh.indices.length / 3} triangles, ${mesh.positions.length / 3} vertices`);

const { positions: P, indices: I } = mesh;

/**
 * Wall triangles: those spanning from the surface down to z = 0.
 *
 * Every one should stand on the boundary. Distance is measured from the model
 * centre and compared with the boundary radius at that bearing, so a wall
 * buried inside shows up as a large shortfall.
 */
const ringRadius_mm: number[] = [];
for (const [x_m, y_m] of ring) ringRadius_mm.push(Math.hypot(x_m, y_m) * scale.scale);
const boundary_mm = ringRadius_mm.reduce((a, b) => a + b, 0) / ringRadius_mm.length;
console.log(`boundary sits at ${boundary_mm.toFixed(1)} mm from the centre`);

let walls = 0;
let interior = 0;
let worstInset_mm = 0;
let worstAt: [number, number] | null = null;
const histogram = new Map<number, number>();

for (let t = 0; t < I.length; t += 3) {
  const a = I[t] * 3;
  const b = I[t + 1] * 3;
  const c = I[t + 2] * 3;
  const zs = [P[a + 2], P[b + 2], P[c + 2]];
  // A wall reaches the build plate and rises well above it.
  if (Math.min(...zs) > 1e-6 || Math.max(...zs) < 0.5) continue;
  walls++;

  // Nearest approach of this triangle to the centre.
  const r = Math.min(
    Math.hypot(P[a], P[a + 1]),
    Math.hypot(P[b], P[b + 1]),
    Math.hypot(P[c], P[c + 1]),
  );
  const inset = boundary_mm - r;
  const bucket = Math.floor(inset / 5) * 5;
  histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);

  // More than a couple of grid cells inside the boundary is not a boundary wall.
  if (inset > hf.spacingX_m * scale.scale * 3) {
    interior++;
    if (inset > worstInset_mm) {
      worstInset_mm = inset;
      worstAt = [P[a], P[a + 1]];
    }
  }
}

console.log(`\nwall triangles: ${walls}`);
console.log(`  buried inside the boundary: ${interior}`);
if (worstAt) {
  console.log(
    `  worst is ${worstInset_mm.toFixed(1)} mm in from the edge, at ` +
      `${worstAt[0].toFixed(1)}, ${worstAt[1].toFixed(1)} mm`,
  );
}

console.log('\nhow far wall triangles sit inside the boundary, in 5 mm bands:');
for (const bucket of [...histogram.keys()].sort((a, b) => a - b)) {
  const n = histogram.get(bucket) ?? 0;
  console.log(`  ${String(bucket).padStart(4)}..${String(bucket + 5).padStart(3)} mm  ${'#'.repeat(Math.min(60, Math.ceil(n / 20)))} ${n}`);
}
