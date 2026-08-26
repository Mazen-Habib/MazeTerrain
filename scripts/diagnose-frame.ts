/**
 * A framed model, built and unioned the way single-colour mode does it.
 *
 * The question a unit test cannot answer: does the frame actually fuse with the
 * terrain into one solid, or does it sit against it as a separate shell that
 * prints as a loose ring?
 */
import { buildFrame } from '../src/geometry/frame';
import { buildClippedTerrainMesh } from '../src/geometry/terrainClip';
import { buildTerrainMesh } from '../src/geometry/terrain';
import { selectionRingWorld, bboxRingWorld } from '../src/geometry/selection';
import { unionParts } from '../src/geometry/boolean';
import { validateMesh } from '../src/geometry/validate';
import { unprojectENU } from '../src/geometry/coords';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { MeshPart } from '../src/geometry/types';
import type { SelectionShape } from '../src/geometry/selection';

const bbox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };
const cells = 200;
const hf = makeHeightfield(
  cells,
  cells,
  (i, j) => 500 + 260 * Math.sin(i / 26) + 180 * Math.cos(j / 21),
  60,
);
const scale = scaleFor(hf, { bbox });

console.log(`\nmodel ${(( cells - 1) * hf.spacingX_m * scale.scale).toFixed(1)} mm across`);
console.log(`relief ${hf.min_m.toFixed(0)}..${hf.max_m.toFixed(0)} m, base 3 mm`);

/** Connected components over welded positions. */
function componentSizes(positions: Float32Array, indices: Uint32Array): number[] {
  const n = positions.length / 3;
  const weld = new Map<string, number>();
  const canon = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    const k =
      positions[v * 3].toFixed(3) + ',' + positions[v * 3 + 1].toFixed(3) + ',' + positions[v * 3 + 2].toFixed(3);
    const seen = weld.get(k);
    if (seen === undefined) {
      weld.set(k, v);
      canon[v] = v;
    } else canon[v] = seen;
  }
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const uni = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let v = 0; v < n; v++) uni(v, canon[v]);
  for (let k = 0; k < indices.length; k += 3) {
    uni(indices[k], indices[k + 1]);
    uni(indices[k + 1], indices[k + 2]);
  }
  const sizes = new Map<number, number>();
  for (let k = 0; k < indices.length; k += 3) {
    const r = find(indices[k]);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  return [...sizes.values()].sort((a, b) => b - a);
}

const half = ((cells - 1) * hf.spacingX_m) / 2;
const shapes: Array<[string, SelectionShape | null]> = [
  ['rectangle', null],
  [
    'circle',
    {
      kind: 'polygon',
      ring: Array.from({ length: 96 }, (_, i) => {
        const t = (i / 96) * Math.PI * 2;
        return unprojectENU(half * 0.9 * Math.cos(t), half * 0.9 * Math.sin(t), scale.origin);
      }),
    },
  ],
];

console.log('\nshape      width  frame tris  union tris  parts  largest%  open  nonMan');
for (const [label, shape] of shapes) {
  const ring = shape ? selectionRingWorld(shape, scale.origin) : bboxRingWorld(bbox, scale.origin);
  const terrain = shape ? buildClippedTerrainMesh(hf, scale, ring) : buildTerrainMesh(hf, scale);

  for (const width_mm of [3, 8, 16]) {
    const frame = buildFrame(ring, { width_mm, height_mm: 3, baseThickness_mm: 3, scale });
    if (frame.mesh.triangles === 0) {
      console.log(`${label.padEnd(10)} ${String(width_mm).padStart(4)}   nothing built`);
      continue;
    }

    const parts: MeshPart[] = [
      { name: 'terrain', color: '#ccc', positions: terrain.positions, indices: terrain.indices, manifold: true },
      { name: 'frame', color: '#ccc', positions: frame.mesh.positions, indices: frame.mesh.indices, manifold: true },
    ];
    const merged = await unionParts(parts, { name: 'model', color: '#ccc' });
    const v = validateMesh(merged.positions, merged.indices);
    const comps = componentSizes(merged.positions, merged.indices);
    const total = merged.indices.length / 3;

    console.log(
      `${label.padEnd(10)} ${String(width_mm).padStart(4)}  ${String(frame.mesh.triangles).padStart(10)}` +
        `  ${String(total).padStart(10)}  ${String(comps.length).padStart(5)}` +
        `  ${((comps[0] / total) * 100).toFixed(1).padStart(7)}%` +
        `  ${String(v.openEdges).padStart(4)}  ${String(v.nonManifoldEdges).padStart(6)}`,
    );
  }
}
