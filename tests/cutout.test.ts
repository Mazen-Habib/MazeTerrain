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
  return routeFromPoints(points, width_mm);
}

function routeFromPoints(points: Pt[], width_mm: number): Route {
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

  /**
   * docs/08-pitfalls.md#the-channel-decapitates-what-it-crosses
   *
   * A tool whose top drapes the terrain stops a fixed distance above the
   * ground, so anything standing taller keeps the part of itself above the tool
   * and is left hanging once its base is cut away. Measured on a 9.2 km city
   * model: roads reached 1.08 mm and buildings 1.20 mm above the ground while
   * the tool stopped at 1.00 mm, and the subtract freed 159 detached pieces.
   */
  it('tops out at one flat plane above everything, not a fixed height above the ground', () => {
    const top_mm = 40;
    const flat = buildRouteSolid(routeAcross(), {
      ...common,
      cut: { kind: 'cut', depth_mm: 1, proud_mm: 1, toolTop_mm: top_mm },
    });

    const [lo, hi] = zRange(flat.mesh.positions);
    expect(hi).toBeCloseTo(top_mm, 4);
    // Well clear of the draped tool, which follows the climbing terrain.
    expect(hi).toBeGreaterThan(zRange(tool.mesh.positions)[1]);
    // The floor is untouched: only the top is flattened.
    expect(lo).toBeCloseTo(zRange(tool.mesh.positions)[0], 4);

    const v = validateMesh(flat.mesh.positions, flat.mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  it('leaves the insert draped — only the cutting tool gets a flat top', () => {
    const insert = buildRouteSolid(routeAcross(), {
      ...common,
      cut: { kind: 'insert', depth_mm: 1, proud_mm: 0.4, clearance_mm: 0.15, toolTop_mm: 40 },
    });
    expect(zRange(insert.mesh.positions)[1]).toBeLessThan(40);
  });

  it('reports the ground range the channel crosses, so callers need not guess', () => {
    const [lo, hi] = tool.stats.groundRange_mm ?? [0, 0];
    expect(hi).toBeGreaterThan(lo);
    // The floor sits exactly the depth below the lowest ground under the ribbon.
    expect(tool.stats.flatBottom_mm).toBeCloseTo(lo - 1, 4);
  });
});

describe('how far the insert stands proud', () => {
  const insertAt = (proud_mm: number) =>
    buildRouteSolid(routeAcross(), {
      ...common,
      cut: { kind: 'insert', depth_mm: 1, proud_mm, clearance_mm: 0.15 },
    });

  /**
   * The route's Height control drives this. Zero has to mean flush, and the
   * range has to reach far enough for a route that deliberately stands out of
   * the model, which is what reads in a single colour.
   */
  it('sits flush with the terrain at zero', () => {
    const flush = insertAt(0);
    const surface = buildRouteSolid(routeAcross(), {
      ...common,
      cut: { kind: 'cut', depth_mm: 0, proud_mm: 0 },
    });
    // Same top as the bare terrain under the ribbon. Not to the last micron:
    // the insert is inset by the clearance, so its footprint covers slightly
    // different ground and finds a slightly different high point.
    expect(zRange(flush.mesh.positions)[1]).toBeCloseTo(zRange(surface.mesh.positions)[1], 1);
  });

  it('rises by exactly what it is asked for', () => {
    const base = zRange(insertAt(0).mesh.positions)[1];
    for (const proud of [0.4, 1.5, 3]) {
      expect(zRange(insertAt(proud).mesh.positions)[1]).toBeCloseTo(base + proud, 3);
    }
  });

  it('stays a closed solid however far it stands out', () => {
    for (const proud of [0, 0.4, 3]) {
      const v = validateMesh(insertAt(proud).mesh.positions, insertAt(proud).mesh.indices);
      expect(v.openEdges).toBe(0);
      expect(v.nonManifoldEdges).toBe(0);
    }
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

/**
 * The insert has to stay inside the channel.
 *
 * The failure: the channel and the insert were rasterised as two SEPARATE
 * distance fields, at cell sizes derived from their own (different) widths.
 * Nothing then held the narrower contour inside the wider one. Measured on a
 * 29.5 km model with a route that nearly touched itself, the intended 44 m gap
 * collapsed to 0.5 m — the two surfaces touched, and the render speckled with
 * z-fighting exactly along the overlapping stretches.
 *
 * Now both come off ONE field: a distance field's level sets are exact offset
 * curves, so tracing the same field at two levels gives a true clearance.
 */
describe('insert stays inside its channel', () => {
  /** Switchbacks tight enough for neighbouring passes of the route to merge. */
  function switchbacks(): Pt[] {
    const pts: Pt[] = [];
    for (let i = 0; i < 240; i++) {
      const t = i / 239;
      const seg = Math.floor(t * 7);
      const u = (t * 7) % 1;
      const dir = seg % 2 === 0 ? 1 : -1;
      pts.push([dir * (u - 0.5) * 3600, -1600 + seg * 460]);
    }
    return pts;
  }

  function ringsOf(positions: Float32Array): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < positions.length; i += 3) out.push([positions[i], positions[i + 1]]);
    return out;
  }

  const clearance_mm = 0.15;
  const line = switchbacks();
  const r = routeFromPoints(line, 4);

  const cut = buildRouteSolid(r, {
    ...common,
    cut: { kind: 'cut', depth_mm: 1, proud_mm: 1, clearance_mm },
  });
  const insert = buildRouteSolid(r, {
    ...common,
    cut: {
      kind: 'insert',
      depth_mm: 1,
      proud_mm: 0.4,
      clearance_mm,
      floor_mm: cut.stats.flatBottom_mm!,
    },
  });

  it('builds both', () => {
    expect(cut.mesh.triangles).toBeGreaterThan(0);
    expect(insert.mesh.triangles).toBeGreaterThan(0);
  });

  /**
   * Every insert vertex must lie within the channel's XY footprint. The check
   * is a point-in-polygon against the channel's own top outline, so it fails if
   * the insert pokes through the wall anywhere — which is what produced the
   * speckling.
   */
  it('never pokes outside the channel footprint', () => {
    const channelXY = ringsOf(cut.mesh.positions);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of channelXY) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }

    let outside = 0;
    for (const [x, y] of ringsOf(insert.mesh.positions)) {
      if (x < minX - 1e-6 || x > maxX + 1e-6 || y < minY - 1e-6 || y > maxY + 1e-6) outside++;
    }
    expect(outside).toBe(0);
  });

  it('is narrower than the channel by two clearances', () => {
    expect(cut.stats.width_mm - insert.stats.width_mm).toBeCloseTo(2 * clearance_mm, 6);
  });

  it('stays a closed solid through the tight turns', () => {
    for (const m of [cut.mesh, insert.mesh]) {
      const v = validateMesh(m.positions, m.indices);
      expect(v.openEdges).toBe(0);
      expect(v.nonManifoldEdges).toBe(0);
    }
  });
});
