/**
 * Draped features have to follow the ground they sit on.
 *
 * The failure this guards: feature layers were extruded with no subdivision, on
 * the reasoning that the solid digs 1 mm into the terrain and that swamps the
 * chord error across a ribbon a couple of millimetres wide. True of the
 * ribbon's WIDTH, and irrelevant to its LENGTH — a straight road's contour is
 * two long edges with almost no vertices between their ends, so a single
 * triangle spanned hundreds of metres of ground it never sampled. The terrain
 * then punched up through the road, which is what the scattered cones were.
 */
import { describe, expect, it } from 'vitest';
import { buildRibbonField, FEATURE_CELLS_PER_HALF_WIDTH } from '../src/geometry/ribbonField';
import { extrudeDraped } from '../src/geometry/extrude';
import { sampleHeightfieldAt } from '../src/geometry/heightfield';
import { worldToPrint } from '../src/geometry/coords';
import { validateMesh } from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from './helpers';
import type { Pt } from '../src/data/gpx/simplify';
import type { MultiPolygon } from '../src/geometry/polygons';

/** Rolling ground, ~90 m of relief over a few kilometres. */
const hf = makeHeightfield(
  200,
  200,
  (i, j) => 500 + 45 * Math.sin(i / 14) + 40 * Math.cos(j / 17),
  47,
);
const scale = scaleFor(hf);
const terrainStep_m = hf.spacingX_m;

const drapeZ = (x: number, y: number) => worldToPrint(x, y, sampleHeightfieldAt(hf, x, y), scale)[2];
const toPrintXY = (x: number, y: number): [number, number] => [x * scale.scale, y * scale.scale];

const HEIGHT_MM = 1.0;

/**
 * Worst gap between the built top surface and the terrain it drapes.
 *
 * Sampled by interpolating the triangle covering each point — sampling at
 * vertices measures nothing, because vertices are draped exactly by definition
 * and the error lives in the middle of an over-long triangle.
 */
function worstDrapeError(footprint: MultiPolygon, maxEdge_m: number, along: Pt[]): number {
  const mesh = extrudeDraped(footprint, drapeZ, toPrintXY, {
    height_mm: HEIGHT_MM,
    penetration_mm: 1.0,
    minBottom_mm: 0.2,
    maxEdge_m,
  });

  const { positions: P, indices: I } = mesh;
  let worst = 0;

  const n = 400;
  for (let s = 0; s <= n; s++) {
    const t = (s / n) * (along.length - 1);
    const i0 = Math.min(along.length - 2, Math.floor(t));
    const f = t - i0;
    const x = along[i0][0] + (along[i0 + 1][0] - along[i0][0]) * f;
    const y = along[i0][1] + (along[i0 + 1][1] - along[i0][1]) * f;
    const [px, py] = toPrintXY(x, y);
    const want = drapeZ(x, y) + HEIGHT_MM;

    let top = -Infinity;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3;
      const b = I[k + 1] * 3;
      const c = I[k + 2] * 3;
      const d = (P[b + 1] - P[c + 1]) * (P[a] - P[c]) + (P[c] - P[b]) * (P[a + 1] - P[c + 1]);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((P[b + 1] - P[c + 1]) * (px - P[c]) + (P[c] - P[b]) * (py - P[c + 1])) / d;
      const v = ((P[c + 1] - P[a + 1]) * (px - P[c]) + (P[a] - P[c]) * (py - P[c + 1])) / d;
      const w = 1 - u - v;
      if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
      const z = u * P[a + 2] + v * P[b + 2] + w * P[c + 2];
      if (z > top) top = z;
    }
    if (top === -Infinity) continue;
    worst = Math.max(worst, Math.abs(top - want));
  }
  return worst;
}

describe('draped features follow the terrain', () => {
  const line: Pt[] = [
    [-4000, -1500],
    [4000, 1500],
  ];
  const width_m = 0.57 / scale.scale;
  const ribbon = buildRibbonField([line], width_m, null, FEATURE_CELLS_PER_HALF_WIDTH);

  it('has almost no vertices along a long straight road, which is the trap', () => {
    let points = 0;
    for (const poly of ribbon.polygons) for (const ring of poly) points += ring.length;
    // Correct, and exactly why the contour alone cannot carry the drape: an
    // 8.5 km road described by a couple of dozen points.
    expect(points).toBeLessThan(40);
  });

  it('leaves the terrain poking through when it is not subdivided', () => {
    const error = worstDrapeError(ribbon.polygons, Infinity, line);
    // Bigger than the height the road stands proud, so the ground comes through.
    expect(error).toBeGreaterThan(HEIGHT_MM * 0.5);
  });

  it('follows the ground once subdivided to the terrain step', () => {
    const error = worstDrapeError(ribbon.polygons, terrainStep_m, line);
    expect(error).toBeLessThan(HEIGHT_MM * 0.25);
  });

  /**
   * The naive fix — quartering every triangle per level — refines the ribbon's
   * tiny cross edges as hard as its enormous long ones, and a single city ran
   * past V8's Map limit inside validation. Splitting only the long edges has to
   * stay far cheaper for the same accuracy.
   */
  it('pays for that in triangles proportional to length, not area', () => {
    const mesh = extrudeDraped(ribbon.polygons, drapeZ, toPrintXY, {
      height_mm: HEIGHT_MM,
      penetration_mm: 1.0,
      minBottom_mm: 0.2,
      maxEdge_m: terrainStep_m,
    });
    const bare = extrudeDraped(ribbon.polygons, drapeZ, toPrintXY, {
      height_mm: HEIGHT_MM,
      penetration_mm: 1.0,
      minBottom_mm: 0.2,
      maxEdge_m: Infinity,
    });
    // Uniform quartering at four levels would be 256x. This is far less.
    expect(mesh.triangles / bare.triangles).toBeLessThan(40);
  });

  it('stays watertight and manifold through refinement', () => {
    const mesh = extrudeDraped(ribbon.polygons, drapeZ, toPrintXY, {
      height_mm: HEIGHT_MM,
      penetration_mm: 1.0,
      minBottom_mm: 0.2,
      maxEdge_m: terrainStep_m,
    });
    const v = validateMesh(mesh.positions, mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.watertight).toBe(true);
  });

  /** A lake is a large flat footprint, and has the same problem as a long road. */
  it('drapes a wide polygon too, not just a thin ribbon', () => {
    const lake: MultiPolygon = [
      [
        [
          [-2000, -2000],
          [2000, -2000],
          [2000, 2000],
          [-2000, 2000],
        ],
      ],
    ];
    const across: Pt[] = [
      [-1900, -1900],
      [1900, 1900],
    ];
    expect(worstDrapeError(lake, Infinity, across)).toBeGreaterThan(HEIGHT_MM * 0.5);
    expect(worstDrapeError(lake, terrainStep_m, across)).toBeLessThan(HEIGHT_MM * 0.25);
  });
});
