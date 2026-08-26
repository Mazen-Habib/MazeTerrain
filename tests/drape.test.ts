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
import { findFloatingVertices, validateMesh } from '../src/geometry/validate';
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
   * past V8's Map limit inside validation. Cost has to follow the ribbon's
   * LENGTH, so halving the target edge should roughly double the triangles,
   * not quadruple them.
   */
  it('pays for refinement in proportion to length, not area', () => {
    const at = (maxEdge_m: number) =>
      extrudeDraped(ribbon.polygons, drapeZ, toPrintXY, {
        height_mm: HEIGHT_MM,
        penetration_mm: 1.0,
        minBottom_mm: 0.2,
        maxEdge_m,
      }).triangles;

    const coarse = at(terrainStep_m * 4);
    const fine = at(terrainStep_m * 2);
    // Quartering would put this at 4x. Bisection along the length is near 2x.
    expect(fine / coarse).toBeLessThan(3);
    expect(fine).toBeGreaterThan(coarse);
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

/**
 * The check that would have caught the cones without a screenshot.
 *
 * Every existing check passed while the model was visibly wrong: an undraped
 * road is perfectly watertight and manifold, it just is not where the ground
 * is. So this looks for the symptom directly.
 */
describe('findFloatingVertices', () => {
  /** A flat terrain patch as a bare vertex soup, which is all the check needs. */
  const terrain = new Float32Array(
    Array.from({ length: 40 * 40 }, (_, k) => {
      const i = k % 40;
      const j = Math.floor(k / 40);
      return [i * 0.4, j * 0.4, 5];
    }).flat(),
  );

  it('says nothing about geometry sitting on the ground', () => {
    const onGround = new Float32Array([2, 2, 5.5, 3, 2, 5.6, 4, 4, 5.4]);
    const r = findFloatingVertices(terrain, onGround, 2);
    expect(r.count).toBe(0);
    expect(r.at).toBeNull();
  });

  it('finds a spike and says where it is', () => {
    const spike = new Float32Array([2, 2, 5.5, 6.4, 7.2, 11.5, 4, 4, 5.4]);
    const r = findFloatingVertices(terrain, spike, 2);
    expect(r.count).toBe(1);
    expect(r.worst_mm).toBeCloseTo(6.5, 3);
    expect(r.at?.[0]).toBeCloseTo(6.4, 3);
    expect(r.at?.[1]).toBeCloseTo(7.2, 3);
  });

  it('does not report geometry that merely sits past the terrain edge', () => {
    // Just outside the patch: it should take the nearest ground, not treat the
    // absence of a bin as a spike.
    const justOutside = new Float32Array([16.2, 16.2, 5.5]);
    expect(findFloatingVertices(terrain, justOutside, 2).count).toBe(0);
  });

  it('handles empty input', () => {
    expect(findFloatingVertices(new Float32Array(0), new Float32Array(0), 2).count).toBe(0);
  });
});


/**
 * Triangle shape.
 *
 * `earcut` optimises for speed, not shape, and on a long thin ribbon it emits
 * slivers — triangles with an aspect ratio in the hundreds, which read on a
 * model as fans of stray geometry. Refinement cannot repair them: bisecting a
 * sliver gives two slivers, and every level multiplies them.
 */
describe('triangle quality', () => {
  /** Longest edge over shortest altitude. A fat triangle is near 1. */
  function sliverFraction(mesh: { positions: Float32Array; indices: Uint32Array }): number {
    const { positions: P, indices: I } = mesh;
    let slivers = 0;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3;
      const b = I[k + 1] * 3;
      const c = I[k + 2] * 3;
      const longest = Math.max(
        Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1]),
        Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1]),
        Math.hypot(P[a] - P[c], P[a + 1] - P[c + 1]),
      );
      const area2 = Math.abs(
        (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]),
      );
      const altitude = area2 / Math.max(longest, 1e-12);
      if (altitude > 1e-12 && longest / altitude > 200) slivers++;
    }
    return slivers / (I.length / 3);
  }

  const line: Pt[] = [
    [-4000, -1500],
    [4000, 1500],
  ];
  const ribbon = buildRibbonField([line], 0.57 / scale.scale, null, FEATURE_CELLS_PER_HALF_WIDTH);

  it('keeps slivers rare in a refined ribbon', () => {
    const mesh = extrudeDraped(ribbon.polygons, drapeZ, toPrintXY, {
      height_mm: HEIGHT_MM,
      penetration_mm: 1.0,
      minBottom_mm: 0.2,
      maxEdge_m: terrainStep_m,
    });
    // Ear clipping alone left a third of a real route's triangles as slivers.
    expect(sliverFraction(mesh)).toBeLessThan(0.2);
  });

  it('stays watertight and manifold after flipping', () => {
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

  /** Flipping must not fold the surface: every triangle keeps its winding. */
  it('leaves the footprint area unchanged', () => {
    const area = (mesh: { positions: Float32Array; indices: Uint32Array }) => {
      const { positions: P, indices: I } = mesh;
      let sum = 0;
      for (let k = 0; k < I.length; k += 3) {
        const a = I[k] * 3;
        const b = I[k + 1] * 3;
        const c = I[k + 2] * 3;
        // Signed, and only the top surface, which all sits above the terrain.
        if (P[a + 2] < 1 || P[b + 2] < 1 || P[c + 2] < 1) continue;
        sum +=
          (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]);
      }
      return sum / 2;
    };

    const bare = extrudeDraped(ribbon.polygons, drapeZ, toPrintXY, {
      height_mm: HEIGHT_MM, penetration_mm: 1.0, minBottom_mm: 0.2, maxEdge_m: Infinity,
    });
    const refined = extrudeDraped(ribbon.polygons, drapeZ, toPrintXY, {
      height_mm: HEIGHT_MM, penetration_mm: 1.0, minBottom_mm: 0.2, maxEdge_m: terrainStep_m,
    });
    // Same footprint however it is cut up, and the sign is unchanged so no
    // triangle was flipped inside out.
    expect(area(refined)).toBeCloseTo(area(bare), 1);
  });
});
