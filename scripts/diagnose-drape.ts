/**
 * Does the road actually follow the terrain?
 *
 * Feature layers are extruded with `maxEdge_m: Infinity` — no subdivision. That
 * was justified on the ribbon's WIDTH: the solid digs 1 mm into the terrain,
 * which swamps the chord error across a ribbon a couple of millimetres wide.
 *
 * It says nothing about the ribbon's LENGTH. A straight road's contour is two
 * long edges with almost no vertices between their ends, so one triangle can
 * span hundreds of metres of terrain. This measures the gap that opens up.
 */
import { buildRibbonField, FEATURE_CELLS_PER_HALF_WIDTH } from '../src/geometry/ribbonField';
import { extrudeDraped } from '../src/geometry/extrude';
import { sampleHeightfieldAt } from '../src/geometry/heightfield';
import { worldToPrint } from '../src/geometry/coords';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { Pt } from '../src/data/gpx/simplify';

/** Rolling ground: ~90 m of relief over a few kilometres, like a city fringe. */
const hf = makeHeightfield(200, 200, (i, j) => 500 + 45 * Math.sin(i / 14) + 40 * Math.cos(j / 17), 47);
const scale = scaleFor(hf);
const drapeZ = (x: number, y: number) =>
  worldToPrint(x, y, sampleHeightfieldAt(hf, x, y), scale)[2];
const toPrintXY = (x: number, y: number): [number, number] => [x * scale.scale, y * scale.scale];

const width_m = 0.57 / scale.scale; // a residential road on the ladder
const line: Pt[] = [
  [-4000, -1500],
  [4000, 1500],
];

const ribbon = buildRibbonField([line], width_m, null, FEATURE_CELLS_PER_HALF_WIDTH);
let contourPts = 0;
for (const poly of ribbon.polygons) for (const ring of poly) contourPts += ring.length;

const terrainStep_m = hf.spacingX_m;
console.log(`\nroad ${width_m.toFixed(0)} m wide, 8.5 km long`);
console.log(`contour points: ${contourPts}  (one triangle can span ~${(8500 / Math.max(1, contourPts / 2)).toFixed(0)} m)`);
console.log(`terrain step ${terrainStep_m} m = ${(terrainStep_m * scale.scale).toFixed(3)} mm\n`);

/**
 * How far the built top surface strays from terrain + height.
 *
 * Evaluated by interpolating the actual triangle that covers each sample point,
 * not by looking at the nearest vertex. Vertices are draped exactly by
 * construction, so sampling at vertices measures nothing — the error lives in
 * the middle of a triangle that spans terrain it never sampled.
 */
function drapeError(maxEdge_m: number) {
  const mesh = extrudeDraped(ribbon.polygons, drapeZ, toPrintXY, {
    height_mm: 1.0,
    penetration_mm: 1.0,
    minBottom_mm: 0.2,
    maxEdge_m,
  });

  const { positions: P, indices: I } = mesh;
  let worstBelow = 0;
  let worstAbove = 0;
  let samples = 0;

  const n = 1500;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = line[0][0] + (line[1][0] - line[0][0]) * t;
    const y = line[0][1] + (line[1][1] - line[0][1]) * t;
    const [px, py] = toPrintXY(x, y);
    const want = drapeZ(x, y) + 1.0;

    // Highest triangle covering this point: that is the top surface.
    let top = -Infinity;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3;
      const b = I[k + 1] * 3;
      const c = I[k + 2] * 3;
      const ax = P[a], ay = P[a + 1];
      const bx = P[b], by = P[b + 1];
      const cx = P[c], cy = P[c + 1];

      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
      const v = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
      const w = 1 - u - v;
      if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;

      const z = u * P[a + 2] + v * P[b + 2] + w * P[c + 2];
      if (z > top) top = z;
    }
    if (top === -Infinity) continue;

    samples++;
    const gap = top - want;
    if (gap < worstBelow) worstBelow = gap;
    if (gap > worstAbove) worstAbove = gap;
  }
  return { triangles: mesh.triangles, worstBelow, worstAbove, samples };
}

for (const [label, maxEdge] of [
  ['no subdivision', Infinity],
  ['4 x terrain step', terrainStep_m * 4],
  ['3 x terrain step', terrainStep_m * 3],
  ['2 x terrain step', terrainStep_m * 2],
  ['1 x terrain step', terrainStep_m],
] as const) {
  const r = drapeError(maxEdge as number);
  console.log(
    `${label.padEnd(28)} tris ${String(r.triangles).padStart(7)}  ` +
      `road top ${r.worstBelow.toFixed(2)} mm below .. ${r.worstAbove.toFixed(2)} mm above the terrain it drapes` +
      `  (${r.samples} samples)`,
  );
}
