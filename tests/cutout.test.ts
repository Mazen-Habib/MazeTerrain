/**
 * Cutout mode: the channel, and the piece that seats in it.
 *
 * The assertion that matters is fit. A channel and an insert built from the
 * same route are only useful if the insert is narrower than the cavity by the
 * clearance, and if both share one flat floor — OPEN-QUESTIONS **Q10**,
 * resolved 2026-08-23 in favour of a flat underside so the insert prints
 * without supports.
 */
import { describe, expect, it } from 'vitest';
import { buildRouteSolid } from '../src/geometry/route';
import { validateMesh } from '../src/geometry/validate';
import { unprojectENU } from '../src/geometry/coords';
import { makeHeightfield, scaleFor } from './helpers';
import type { Route } from '../src/data/gpx/types';
import type { Pt } from '../src/data/gpx/simplify';

/** Terrain that climbs steadily, so a flat floor has something to be flat against. */
const hf = makeHeightfield(60, 60, (i, j) => 200 + 6 * i + 4 * j);
const scale = scaleFor(hf);

function routeAcross(width_mm = 3): Route {
  const points: Pt[] = [];
  for (let x = -2000; x <= 2000; x += 100) points.push([x, x * 0.3]);
  return {
    id: 'r',
    name: 'test route',
    distance_m: 4000,
    elevationGain_m: null,
    points: points.map((p) => {
      const [lon, lat] = unprojectENU(p[0], p[1], scale.origin);
      return { lon, lat };
    }),
    style: {
      color: '#FF0D00',
      width_mm,
      height_mm: 1.2,
      profile: 'raised',
      elevationSource: 'dem',
      demBlend: 0,
      visible: true,
    },
    bbox: { west: 0, south: 0, east: 0, north: 0 },
  };
}

const common = {
  heightfield: hf,
  scale,
  selection: null,
  nozzleDiameter_mm: 0.4,
  baseThickness_mm: 3,
};

function zRange(positions: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    lo = Math.min(lo, positions[i]);
    hi = Math.max(hi, positions[i]);
  }
  return [lo, hi];
}

/** Distinct Z values on the underside, to tell flat from draped. */
function bottomIsFlat(positions: Float32Array): boolean {
  const [lo] = zRange(positions);
  let count = 0;
  for (let i = 2; i < positions.length; i += 3) {
    if (Math.abs(positions[i] - lo) < 1e-4) count++;
  }
  // A flat underside puts half the vertices on exactly one plane.
  return count >= positions.length / 3 / 2 - 1;
}

describe('cut tool', () => {
  const tool = buildRouteSolid(routeAcross(), {
    ...common,
    cut: { kind: 'cut', depth_mm: 1, proud_mm: 1 },
  });

  it('is a closed solid', () => {
    const v = validateMesh(tool.mesh.positions, tool.mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  it('has a flat underside, not a draped one', () => {
    expect(bottomIsFlat(tool.mesh.positions)).toBe(true);
  });

  /**
   * The floor has to clear the lowest ground under the ribbon, not under the
   * centreline. The ribbon is wide, and on a side slope its edge reaches lower
   * than the line down the middle — a floor set from the centreline leaves
   * stretches with no channel cut at all.
   */
  it('sits the depth below the lowest ground under the whole ribbon', () => {
    // depth 0 and proud 0 makes the solid span exactly the terrain it covers.
    const surface = buildRouteSolid(routeAcross(), {
      ...common,
      cut: { kind: 'cut', depth_mm: 0, proud_mm: 0 },
    });
    const [terrainLow] = zRange(surface.mesh.positions);
    expect(zRange(tool.mesh.positions)[0]).toBeCloseTo(terrainLow - 1, 4);
  });

  it('goes deeper when asked to', () => {
    const deeper = buildRouteSolid(routeAcross(), {
      ...common,
      cut: { kind: 'cut', depth_mm: 3, proud_mm: 1 },
    });
    expect(zRange(deeper.mesh.positions)[0]).toBeLessThan(zRange(tool.mesh.positions)[0]);
  });
});

describe('inlay insert', () => {
  const clearance_mm = 0.15;
  const cut = buildRouteSolid(routeAcross(4), {
    ...common,
    cut: { kind: 'cut', depth_mm: 1, proud_mm: 1 },
  });
  const insert = buildRouteSolid(routeAcross(4), {
    ...common,
    cut: {
      kind: 'insert',
      depth_mm: 1,
      proud_mm: 0.4,
      clearance_mm,
      floor_mm: cut.stats.flatBottom_mm!,
    },
  });

  it('is a closed solid', () => {
    const v = validateMesh(insert.mesh.positions, insert.mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  /** The whole point: it has to be narrower than the cavity, by the clearance. */
  it('is exactly two clearances narrower than the channel', () => {
    expect(cut.stats.width_mm - insert.stats.width_mm).toBeCloseTo(2 * clearance_mm, 6);
  });

  it('shares the channel floor, so it seats rather than floats', () => {
    expect(zRange(insert.mesh.positions)[0]).toBeCloseTo(zRange(cut.mesh.positions)[0], 4);
  });

  it('has a flat underside so it prints without supports', () => {
    expect(bottomIsFlat(insert.mesh.positions)).toBe(true);
  });

  it('stands proud of the terrain by the requested amount', () => {
    const flush = buildRouteSolid(routeAcross(4), {
      ...common,
      cut: {
        kind: 'insert',
        depth_mm: 1,
        proud_mm: 0,
        clearance_mm,
        floor_mm: cut.stats.flatBottom_mm!,
      },
    });
    const proud = zRange(insert.mesh.positions)[1] - zRange(flush.mesh.positions)[1];
    expect(proud).toBeCloseTo(0.4, 3);
  });

  it('never goes below zero width, however large the clearance', () => {
    const silly = buildRouteSolid(routeAcross(0.5), {
      ...common,
      cut: { kind: 'insert', depth_mm: 1, proud_mm: 0.4, clearance_mm: 5 },
    });
    expect(silly.stats.width_mm).toBeGreaterThan(0);
  });
});
