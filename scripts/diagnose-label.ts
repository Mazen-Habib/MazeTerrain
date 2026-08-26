/**
 * Engrave a label into a real frame, with the real boolean, and draw the top
 * face so it can be looked at.
 *
 * The test suite can prove the tool is a closed solid at the right depth. It
 * cannot prove the subtract actually leaves readable letters in the plaque —
 * that needs the kernel and an image.
 */
import { writeFileSync } from 'node:fs';
import { encodePng } from './lib/png';
import { buildFrame } from '../src/geometry/frame';
import { buildLabelTool, labelCoverage } from '../src/geometry/label';
import { subtractParts } from '../src/geometry/boolean';
import { validateMesh } from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { MeshPart } from '../src/geometry/types';
import type { Ring } from '../src/geometry/polygons';

const text = process.argv[2] ?? 'MARGALLA TRAIL 5 · 42.2 KM';
const bbox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };
const cells = 120;
const hf = makeHeightfield(cells, cells, () => 500, 60);
const scale = scaleFor(hf, { bbox });

const half_m = ((cells - 1) * hf.spacingX_m) / 2;
const ring: Ring = [
  [-half_m, -half_m],
  [half_m, -half_m],
  [half_m, half_m],
  [-half_m, half_m],
];

const frameWidth_mm = 10;
const frame = buildFrame(ring, {
  width_mm: frameWidth_mm,
  height_mm: 3,
  baseThickness_mm: 3,
  scale,
});
console.log(`\nmodel ${(half_m * 2 * scale.scale).toFixed(1)} mm, frame ${frameWidth_mm} mm wide`);
console.log(`frame: ${frame.mesh.triangles} triangles, top at ${frame.top_mm.toFixed(2)} mm`);

const capHeight_mm = 5;
const options = {
  capHeight_mm,
  depth_mm: 0.6,
  strokeWidth_mm: 0.4,
  surfaceZ_mm: frame.top_mm,
  centreX_mm: 0,
  baselineY_mm: -(half_m * scale.scale) + (frameWidth_mm - capHeight_mm) / 2,
};

const label = buildLabelTool(text, options);
console.log(`label: ${label.mesh.triangles} triangles, ${label.width_mm.toFixed(1)} mm wide`);
if (label.missing.length > 0) console.log(`missing glyphs: ${label.missing.join(' ')}`);
console.log(`coverage on the plaque: ${(labelCoverage(text, options, frame.footprint_mm) * 100).toFixed(1)}%`);

const framePart: MeshPart = {
  name: 'frame',
  color: '#cccccc',
  positions: frame.mesh.positions,
  indices: frame.mesh.indices,
  manifold: true,
};
const toolPart: MeshPart = {
  name: 'label',
  color: '#cccccc',
  positions: label.mesh.positions,
  indices: label.mesh.indices,
  manifold: true,
};

const started = Date.now();
const engraved = await subtractParts(framePart, [toolPart], { name: 'frame', color: '#cccccc' });
const v = validateMesh(engraved.positions, engraved.indices);
console.log(
  `engraved: ${engraved.indices.length / 3} triangles in ${Date.now() - started} ms, ` +
    `open ${v.openEdges}, nonManifold ${v.nonManifoldEdges}`,
);

// --- draw the bottom rim, seen from above ---------------------------------
//
// Every triangle whose vertices sit at the frame's top face is plaque; anything
// lower is the floor of a groove. Shading the two differently is what makes the
// letters visible.
const viewLeft = -60;
const viewRight = 60;
const viewBottom = -(half_m * scale.scale) - 2;
const viewTop = viewBottom + frameWidth_mm + 4;
const px = 8;
const width = Math.round((viewRight - viewLeft) * px);
const height = Math.round((viewTop - viewBottom) * px);
const rgba = new Uint8Array(width * height * 4).fill(255);

const { positions: P, indices: I } = engraved;
for (let k = 0; k < I.length; k += 3) {
  const a = I[k] * 3;
  const b = I[k + 1] * 3;
  const c = I[k + 2] * 3;
  const zs = [P[a + 2], P[b + 2], P[c + 2]];
  // Only faces that look up: skip walls and the underside.
  if (Math.max(...zs) - Math.min(...zs) > 1e-4) continue;
  const z = zs[0];
  if (z < frame.top_mm - options.depth_mm - 1e-3) continue;

  const onTop = z > frame.top_mm - 1e-3;
  const shade = onTop ? 205 : 40;

  const xs = [P[a], P[b], P[c]].map((x) => (x - viewLeft) * px);
  const ys = [P[a + 1], P[b + 1], P[c + 1]].map((y) => height - (y - viewBottom) * px);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));

  const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
  if (Math.abs(area) < 1e-9) continue;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const w0 = ((xs[1] - cx) * (ys[2] - cy) - (xs[2] - cx) * (ys[1] - cy)) / area;
      const w1 = ((xs[2] - cx) * (ys[0] - cy) - (xs[0] - cx) * (ys[2] - cy)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const i = (y * width + x) * 4;
      rgba[i] = shade;
      rgba[i + 1] = shade;
      rgba[i + 2] = shade;
    }
  }
}

const out = process.argv[3] ?? 'label-proof.png';
writeFileSync(out, encodePng(width, height, rgba));
console.log(`wrote ${out}, ${width} x ${height} (light = plaque, dark = engraved groove)`);
