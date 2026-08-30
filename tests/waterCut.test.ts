/**
 * Water as a cut-out (docs/02-feature-spec.md F6.4).
 *
 * The interesting part is the clearance. A route insert gets it for free by
 * shrinking the ribbon width before the distance field is built; water is a
 * sheet of arbitrary rings and there is no width to shrink, so the insert is
 * pulled in by subtracting a collar straddling its own boundary. These tests
 * check the three solids agree about the floor, and that the collar is the
 * right band in the right place — the boolean itself is manifold-3d's job.
 */
import { describe, expect, it } from 'vitest';
import { buildWaterCut } from '../src/geometry/waterCut';
import { validateMesh } from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from './helpers';
import { sampleHeightfieldAt } from '../src/geometry/heightfield';
import { worldToPrint } from '../src/geometry/coords';
import type { MultiPolygon } from '../src/geometry/polygons';

const bbox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };

/** A bowl: low in the middle, so a lake there has ground rising around it. */
const hf = makeHeightfield(
  100,
  100,
  (i, j) => 500 + Math.hypot(i - 50, j - 50) * 4,
  50,
);
const scale = scaleFor(hf, { bbox, baseThickness_mm: 3 });

const drapeZ = (x_m: number, y_m: number) =>
  worldToPrint(x_m, y_m, sampleHeightfieldAt(hf, x_m, y_m), scale)[2];

/** A square lake around the middle of the bowl, in world metres. */
function lake(half_m = 600): MultiPolygon {
  return [
    [
      [
        [-half_m, -half_m],
        [half_m, -half_m],
        [half_m, half_m],
        [-half_m, half_m],
      ],
    ],
  ];
}

const options = {
  depth_mm: 1,
  proud_mm: 0.4,
  toolTop_mm: 40,
  baseThickness_mm: 3,
  scale,
  terrainStep_m: hf.spacingX_m,
  gridOrigin_m: [
    -((hf.cols - 1) * hf.spacingX_m) / 2,
    -((hf.rows - 1) * hf.spacingY_m) / 2,
  ] as [number, number],
  drapeZ,
};

describe('buildWaterCut', () => {
  const cut = buildWaterCut(lake(), 0.15, options)!;

  it('builds a tool, an insert and a collar', () => {
    expect(cut).not.toBeNull();
    expect(cut.tool.triangles).toBeGreaterThan(0);
    expect(cut.insert.triangles).toBeGreaterThan(0);
    expect(cut.collar.triangles).toBeGreaterThan(0);
  });

  /**
   * The one number that decides whether the piece seats. Computing it twice
   * from two samplings of the same terrain gives two different answers, so the
   * tool and the insert share one floor by construction.
   */
  it('gives the tool and the insert exactly the same floor', () => {
    const lowestOf = (m: { positions: Float32Array }) => {
      let lo = Infinity;
      for (let i = 2; i < m.positions.length; i += 3) lo = Math.min(lo, m.positions[i]);
      return lo;
    };
    expect(lowestOf(cut.tool)).toBeCloseTo(cut.floor_mm, 5);
    expect(lowestOf(cut.insert)).toBeCloseTo(cut.floor_mm, 5);
  });

  /**
   * The bug this test found: sampling only the lake's OUTLINE put the floor
   * above the terrain in the middle of a dished lake, so the cutting tool left
   * a lump of ground standing inside the basin and the flat-bottomed insert sat
   * on it instead of seating. The interior has to be sampled too.
   */
  it('puts the floor below the lowest ground ANYWHERE under the water', () => {
    // Sampled far finer than the build does, so this is a real reference and
    // not just the same coarse grid agreeing with itself. The build snaps to
    // the DEM's own nodes, where a bilinear surface takes its extremes, so it
    // should match a dense search rather than merely get close to it.
    let lowestGround = Infinity;
    for (let x = -600; x <= 600; x += 5) {
      for (let y = -600; y <= 600; y += 5) {
        lowestGround = Math.min(lowestGround, drapeZ(x, y));
      }
    }
    expect(cut.floor_mm).toBeCloseTo(lowestGround - options.depth_mm, 5);
  });

  /** A cutting tool has to enclose everything the basin passes through. */
  it('reaches from the floor to above everything built', () => {
    let hi = -Infinity;
    for (let i = 2; i < cut.tool.positions.length; i += 3) {
      hi = Math.max(hi, cut.tool.positions[i]);
    }
    expect(hi).toBeCloseTo(options.toolTop_mm, 5);
  });

  /**
   * A lake surface is level. It is the one place in this model where following
   * the terrain would be wrong — a draped lake top would ripple.
   */
  it('gives the insert a flat top, not a draped one', () => {
    const tops: number[] = [];
    for (let i = 2; i < cut.insert.positions.length; i += 3) {
      const z = cut.insert.positions[i];
      if (z > cut.floor_mm + 0.001) tops.push(z);
    }
    expect(tops.length).toBeGreaterThan(0);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1e-4);
  });

  it('stands the insert proud by the amount asked for', () => {
    let hi = -Infinity;
    for (let i = 2; i < cut.insert.positions.length; i += 3) {
      hi = Math.max(hi, cut.insert.positions[i]);
    }
    // Floor is depth below the lowest water; the top is proud above it.
    expect(hi - cut.floor_mm).toBeCloseTo(options.depth_mm + options.proud_mm, 1);
  });

  it('closes every solid it produces', () => {
    for (const mesh of [cut.tool, cut.insert, cut.collar]) {
      const v = validateMesh(mesh.positions, mesh.indices);
      expect(v.openEdges).toBe(0);
      expect(v.nonManifoldEdges).toBe(0);
    }
  });
});

describe('the clearance collar', () => {
  /**
   * The collar has to STRADDLE the boundary — half in, half out. A band sitting
   * wholly inside would take a full clearance off the insert and leave the
   * basin untouched, doubling the gap on one side and closing it on the other.
   */
  it('straddles the boundary rather than sitting inside it', () => {
    const half_m = 600;
    const cut = buildWaterCut(lake(half_m), 0.5, options)!;

    const edge_mm = half_m * scale.scale;
    let outermost = -Infinity;
    let innermost = Infinity;
    for (let i = 0; i < cut.collar.positions.length; i += 3) {
      const x = cut.collar.positions[i];
      if (Math.abs(cut.collar.positions[i + 1]) > edge_mm * 0.5) continue;
      if (x > outermost) outermost = x;
      if (x > 0 && x < innermost) innermost = x;
    }
    // The band reaches outside the lake edge and inside it.
    expect(outermost).toBeGreaterThan(edge_mm);
    expect(innermost).toBeLessThan(edge_mm);
  });

  it('gets wider as the clearance grows', () => {
    const widthOf = (clearance: number) => {
      const cut = buildWaterCut(lake(), clearance, options)!;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < cut.collar.positions.length; i += 3) {
        const x = cut.collar.positions[i];
        if (Math.abs(cut.collar.positions[i + 1]) > 5) continue;
        if (x > 0) {
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
      return hi - lo;
    };
    expect(widthOf(0.6)).toBeGreaterThan(widthOf(0.2));
  });

  /** No clearance asked for is a zero press fit — the user's call to make. */
  it('builds no collar when no clearance is wanted', () => {
    const cut = buildWaterCut(lake(), 0, options)!;
    expect(cut.collar.triangles).toBe(0);
    expect(cut.tool.triangles).toBeGreaterThan(0);
  });

  /**
   * Islands are why a mitre inset was not good enough: the hole's boundary has
   * to be pushed the other way, and the collar handles both because it is
   * centred on the boundary rather than offset from it.
   */
  it('collars a hole as well as an outline', () => {
    const withIsland: MultiPolygon = [
      [
        [
          [-600, -600],
          [600, -600],
          [600, 600],
          [-600, 600],
        ],
        [
          [-150, -150],
          [-150, 150],
          [150, 150],
          [150, -150],
        ],
      ],
    ];
    const cut = buildWaterCut(withIsland, 0.4, options)!;
    expect(cut.collar.triangles).toBeGreaterThan(0);

    // Collar geometry exists near the island's edge, not only near the outline.
    let nearIsland = 0;
    const island_mm = 150 * scale.scale;
    for (let i = 0; i < cut.collar.positions.length; i += 3) {
      const x = Math.abs(cut.collar.positions[i]);
      const y = Math.abs(cut.collar.positions[i + 1]);
      if (Math.abs(x - island_mm) < 2 && y < island_mm) nearIsland++;
    }
    expect(nearIsland).toBeGreaterThan(0);
  });
});

describe('nothing to cut', () => {
  it('declines an empty footprint rather than building a degenerate solid', () => {
    expect(buildWaterCut([], 0.15, options)).toBeNull();
  });
});

describe('a lake on dished ground', () => {
  /**
   * The regression, stated as the thing that actually breaks: no terrain may
   * survive above the basin floor anywhere inside the footprint, or the insert
   * cannot reach the bottom.
   */
  it('leaves no ground standing above the basin floor', () => {
    const cut = buildWaterCut(lake(), 0.15, options)!;
    let worstAbove = -Infinity;
    for (let x = -600; x <= 600; x += 25) {
      for (let y = -600; y <= 600; y += 25) {
        worstAbove = Math.max(worstAbove, drapeZ(x, y) - cut.floor_mm);
      }
    }
    // Ground is above the floor everywhere (that is what makes it a basin),
    // but the floor must be below ALL of it by at least the cut depth.
    expect(worstAbove).toBeGreaterThan(0);
    let lowestUnder = Infinity;
    for (let x = -600; x <= 600; x += 25) {
      for (let y = -600; y <= 600; y += 25) {
        lowestUnder = Math.min(lowestUnder, drapeZ(x, y));
      }
    }
    expect(cut.floor_mm).toBeLessThanOrEqual(lowestUnder - options.depth_mm + 1e-6);
  });
});
