/** 3MF at real model size: does it hold up, and how big is the file? */
import { unzipSync } from 'fflate';
import { writeThreeMF } from '../src/export/threemf';
import { writeBinarySTL, stlHeader } from '../src/export/stl';
import type { MeshPart } from '../src/geometry/types';

function part(name: string, color: string, triangles: number): MeshPart {
  const positions = new Float32Array(triangles * 9);
  const indices = new Uint32Array(triangles * 3);
  for (let i = 0; i < triangles; i++) {
    for (let v = 0; v < 3; v++) {
      positions[i * 9 + v * 3] = (i % 400) * 0.25 + v * 0.1;
      positions[i * 9 + v * 3 + 1] = Math.floor(i / 400) * 0.25 + (v % 2) * 0.1;
      positions[i * 9 + v * 3 + 2] = (i % 17) * 0.05;
      indices[i * 3 + v] = i * 3 + v;
    }
  }
  return { name, color, positions, indices, manifold: true };
}

// Roughly the 21.4 km Islamabad build: terrain plus four feature layers.
const parts = [
  part('terrain', '#A0907A', 320_000),
  part('roads', '#4A4A4A', 331_744),
  part('trails', '#8A7B5C', 78_456),
  part('water', '#3B7EA1', 16_156),
  part('railways', '#6B6B6B', 1_796),
];
const total = parts.reduce((s, p) => s + p.indices.length / 3, 0);

let t = Date.now();
const mf = writeThreeMF(parts);
const mf_s = (Date.now() - t) / 1000;

t = Date.now();
const stl = writeBinarySTL(parts, stlHeader());
const stl_s = (Date.now() - t) / 1000;

console.log(`\n${total.toLocaleString()} triangles across ${parts.length} parts`);
console.log(`  STL  ${(stl.byteLength / 1e6).toFixed(1)} MB  ${stl_s.toFixed(1)}s`);
console.log(`  3MF  ${(mf.byteLength / 1e6).toFixed(1)} MB  ${mf_s.toFixed(1)}s`);

// The file has to survive a round trip, not merely be produced.
const files = unzipSync(new Uint8Array(mf));
const xml = new TextDecoder().decode(files['3D/3dmodel.model']);
console.log(`  model XML uncompressed ${(xml.length / 1e6).toFixed(1)} MB`);
console.log(`  objects ${(xml.match(/<object /g) ?? []).length}, items ${(xml.match(/<item /g) ?? []).length}`);
console.log(`  triangles in XML ${((xml.match(/<triangle /g) ?? []).length).toLocaleString()}`);
