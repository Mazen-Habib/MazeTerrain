/**
 * Engrave a label into a real frame, with the real boolean, and draw the top
 * face so it can be looked at.
 *
 * The test suite can prove the tool is a closed solid at the right depth and
 * that its strokes stay inside the band. It cannot prove the subtract leaves
 * READABLE letters — that needs the kernel and an image.
 *
 * Usage: diagnose-label.ts [text] [out.png] [square|circle] [zoom]
 */
import { writeFileSync } from 'node:fs';
import { encodePng } from './lib/png';
import { buildFrame } from '../src/geometry/frame';
import { buildBaseline, buildLabelTool, labelCoverage, resolveStrokeWidth_mm } from '../src/geometry/label';
import { subtractParts } from '../src/geometry/boolean';
import { validateMesh } from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { MeshPart } from '../src/geometry/types';
import type { Ring } from '../src/geometry/polygons';

const text = process.argv[2] ?? 'MARGALLA TRAIL 3';
const shape = process.argv[4] ?? 'square';
const zoom = process.argv[5] === 'zoom';

const bbox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };
const cells = 120;
const hf = makeHeightfield(cells, cells, () => 500, 60);
const scale = scaleFor(hf, { bbox });
const half_m = ((cells - 1) * hf.spacingX_m) / 2;

const ring: Ring =
  shape === 'circle'
    ? Array.from({ length: 180 }, (_, i) => {
        const a = (i / 180) * Math.PI * 2;
        return [Math.cos(a) * half_m, Math.sin(a) * half_m] as [number, number];
      })
    : [
        [-half_m, -half_m],
        [half_m, -half_m],
        [half_m, half_m],
        [-half_m, half_m],
      ];

const frameWidth_mm = 12.5;
const frame = buildFrame(ring, { width_mm: frameWidth_mm, height_mm: 4.5, baseThickness_mm: 3, scale });
const modelSize_mm = half_m * 2 * scale.scale;
console.log(`\n${shape} model ${modelSize_mm.toFixed(1)} mm, frame ${frameWidth_mm} mm OUTSIDE it`);
console.log(`frame: ${frame.mesh.triangles} triangles, top at ${frame.top_mm.toFixed(2)} mm`);

let far = 0;
for (let i = 0; i < frame.mesh.positions.length; i += 3) {
  far = Math.max(far, Math.abs(frame.mesh.positions[i]), Math.abs(frame.mesh.positions[i + 1]));
}
console.log(`frame reaches ${(far * 2).toFixed(1)} mm across — the map keeps its ${modelSize_mm.toFixed(0)} mm`);

const capHeight_mm = 6.5;
const options = {
  capHeight_mm,
  depth_mm: 1,
  strokeWidth_mm: 'auto' as number | 'auto',
  minStrokeWidth_mm: 0.4,
  surfaceZ_mm: frame.top_mm,
};

const ringPrint: Ring = ring.map(([x, y]) => [x * scale.scale, y * scale.scale] as [number, number]);
const baseline = buildBaseline(ringPrint, (frameWidth_mm + capHeight_mm) / 2)!;
console.log(`rim is ${baseline.total_mm.toFixed(0)} mm round`);

const label = buildLabelTool(text, options, baseline);
console.log(
  `label: ${label.mesh.triangles} triangles, ${label.width_mm.toFixed(1)} mm wide, ` +
    `stroke ${label.strokeWidth_mm.toFixed(2)} mm (was ${options.minStrokeWidth_mm.toFixed(2)})`,
);
console.log(`coverage on the plaque: ${(labelCoverage(text, options, baseline, frame.footprint_mm) * 100).toFixed(1)}%`);
console.log(`auto weight resolves to ${resolveStrokeWidth_mm(options).toFixed(2)} mm`);

const framePart: MeshPart = {
  name: 'frame', color: '#cccccc',
  positions: frame.mesh.positions, indices: frame.mesh.indices, manifold: true,
};
const toolPart: MeshPart = {
  name: 'label', color: '#cccccc',
  positions: label.mesh.positions, indices: label.mesh.indices, manifold: true,
};

const started = Date.now();
const engraved = await subtractParts(framePart, [toolPart], { name: 'frame', color: '#cccccc' });
const v = validateMesh(engraved.positions, engraved.indices);
console.log(
  `engraved: ${engraved.indices.length / 3} triangles in ${Date.now() - started} ms, ` +
    `open ${v.openEdges}, nonManifold ${v.nonManifoldEdges}`,
);

// --- draw the rim from above ----------------------------------------------
const outer = modelSize_mm / 2 + frameWidth_mm;
const viewLeft = zoom ? -40 : -outer - 2;
const viewRight = zoom ? -10 : outer + 2;
const viewBottom = zoom ? -outer - 2 : -outer - 2;
const viewTop = zoom ? -outer + frameWidth_mm + 6 : outer + 2;
const px = zoom ? 30 : 6;
const width = Math.round((viewRight - viewLeft) * px);
const height = Math.round((viewTop - viewBottom) * px);
const rgba = new Uint8Array(width * height * 4).fill(255);

const { positions: P, indices: I } = engraved;
for (let k = 0; k < I.length; k += 3) {
  const a = I[k] * 3;
  const b = I[k + 1] * 3;
  const c = I[k + 2] * 3;
  const zs = [P[a + 2], P[b + 2], P[c + 2]];
  if (Math.max(...zs) - Math.min(...zs) > 1e-4) continue;
  const z = zs[0];
  if (z < frame.top_mm - options.depth_mm - 1e-3) continue;

  const shade = z > frame.top_mm - 1e-3 ? 205 : 40;
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
      if (w0 < -1e-6 || w1 < -1e-6 || 1 - w0 - w1 < -1e-6) continue;
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
