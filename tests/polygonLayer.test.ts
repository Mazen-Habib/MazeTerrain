/**
 * Polygon layers: water areas, greenery, sand and buildings.
 *
 * These are the last Phase 2 geometry, and the one place a real polygon clip
 * was needed — line layers derive their footprints from a distance field and
 * mask the selection before tracing, which polygons cannot do.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPolygonLayer,
  groupPolygons,
  type LayerSettings,
} from '../src/geometry/features';
import { validateMesh } from '../src/geometry/validate';
import { unprojectENU } from '../src/geometry/coords';
import { defaultLayers } from '../src/config/presets';
import { makeHeightfield, scaleFor } from './helpers';
import type { PolygonFeature } from '../src/data/osm/normalise';
import type { Pt } from '../src/data/gpx/simplify';
import type { Ring } from '../src/geometry/polygons';

const hf = makeHeightfield(60, 60, (i, j) => 300 + 2 * i + 1.5 * j);
const scale = scaleFor(hf);
// Buildings, greenery and sand ship disabled — they are expensive and most
// models do not want them — so the tests turn on what they exercise.
const base = defaultLayers();
const layers: Record<string, LayerSettings> = {
  ...base,
  buildings: { ...base.buildings, enabled: true },
  greenery: { ...base.greenery, enabled: true },
};

const options = {
  heightfield: hf,
  scale,
  selection: null,
  nozzleDiameter_mm: 0.4,
  baseThickness_mm: 3,
  layers,
  triangleBudget: 5_000_000,
};

/** Build a polygon feature from rings given in world metres. */
function polygon(
  rings: Pt[][],
  overrides: Partial<PolygonFeature> = {},
): PolygonFeature {
  return {
    layer: 'buildings',
    // `building=yes` classifies as the 'other' group, not as 'yes'.
    subtype: 'other',
    bridge: false,
    layerOrder: 0,
    rings: rings.map((ring) => ring.map((p) => unprojectENU(p[0], p[1], scale.origin))),
    ...overrides,
  };
}

function box(cx: number, cy: number, half: number): Pt[] {
  return [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
  ];
}

/** Height of the tallest vertex in a built part, print mm. */
function topZ(positions: Float32Array): number {
  let max = -Infinity;
  for (let i = 2; i < positions.length; i += 3) max = Math.max(max, positions[i]);
  return max;
}

describe('buildPolygonLayer — buildings', () => {
  it('builds a manifold solid from a footprint', () => {
    const built = buildPolygonLayer('buildings', [polygon([box(0, 0, 300)], { height_m: 20 })], options);

    expect(built.part).not.toBeNull();
    expect(built.stats.features).toBe(1);

    const v = validateMesh(built.part!.positions, built.part!.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.manifold).toBe(true);
  });

  /** docs/02-feature-spec.md: height comes from the OSM tag cascade. */
  it('makes a taller building taller in the mesh', () => {
    const short = buildPolygonLayer('buildings', [polygon([box(0, 0, 300)], { height_m: 6 })], options);
    const tall = buildPolygonLayer('buildings', [polygon([box(0, 0, 300)], { height_m: 60 })], options);

    expect(topZ(tall.part!.positions)).toBeGreaterThan(topZ(short.part!.positions));
  });

  it('falls back to the default height when the tags say nothing', () => {
    const built = buildPolygonLayer('buildings', [polygon([box(0, 0, 300)])], options);
    expect(built.part).not.toBeNull();
    expect(topZ(built.part!.positions)).toBeGreaterThan(0);
  });

  it('keeps many buildings manifold as one part', () => {
    const many: PolygonFeature[] = [];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        many.push(polygon([box(-1500 + i * 700, -1500 + j * 700, 200)], { height_m: 10 + i }));
      }
    }
    const built = buildPolygonLayer('buildings', many, options);
    expect(built.stats.features).toBe(25);

    const v = validateMesh(built.part!.positions, built.part!.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  it('carries a courtyard through as a hole', () => {
    const withHole = polygon([box(0, 0, 600), box(0, 0, 200)], { height_m: 15 });
    const solid = polygon([box(0, 0, 600)], { height_m: 15 });

    const a = buildPolygonLayer('buildings', [withHole], options);
    const b = buildPolygonLayer('buildings', [solid], options);

    // A hole means more geometry, not less, and must stay closed.
    expect(a.stats.triangles).toBeGreaterThan(b.stats.triangles);
    const v = validateMesh(a.part!.positions, a.part!.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  it('respects the triangle budget rather than dying inside V8', () => {
    const many: PolygonFeature[] = [];
    for (let i = 0; i < 200; i++) many.push(polygon([box(-2000 + i * 20, 0, 8)], { height_m: 9 }));

    const built = buildPolygonLayer('buildings', many, { ...options, triangleBudget: 200 });
    expect(built.stats.truncated).toBe(true);
    expect(built.stats.triangles).toBeLessThan(2000);
  });
});

describe('buildPolygonLayer — sheet layers', () => {
  const water = (rings: Pt[][]) =>
    polygon(rings, { layer: 'water', subtype: 'lake' });

  it('builds water as one flat sheet, manifold', () => {
    const built = buildPolygonLayer(
      'water',
      [water([box(-800, -800, 400)]), water([box(900, 900, 300)])],
      options,
    );

    expect(built.part?.name).toBe('water');
    expect(built.part?.color).toBe(layers.water.color);
    expect(built.stats.features).toBe(2);

    const v = validateMesh(built.part!.positions, built.part!.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  it('honours the subtype filter', () => {
    const filtered = {
      ...options,
      layers: { ...layers, water: { ...layers.water, subtypes: ['reservoir'] } },
    };
    expect(buildPolygonLayer('water', [water([box(0, 0, 400)])], filtered).part).toBeNull();
  });

  it('returns nothing when the layer is off', () => {
    const off = {
      ...options,
      layers: { ...layers, water: { ...layers.water, enabled: false } },
    };
    expect(buildPolygonLayer('water', [water([box(0, 0, 400)])], off).part).toBeNull();
  });
});

describe('buildPolygonLayer — clipping to the selection', () => {
  /** A circle, the way a circle selection arrives in world metres. */
  const circle: Ring = Array.from({ length: 64 }, (_, i) => {
    const t = (i / 64) * Math.PI * 2;
    return [1200 * Math.cos(t), 1200 * Math.sin(t)] as [number, number];
  });

  it('drops a building entirely outside the selection', () => {
    const built = buildPolygonLayer(
      'buildings',
      [polygon([box(5000, 5000, 200)], { height_m: 10 })],
      { ...options, selection: circle },
    );
    expect(built.part).toBeNull();
    expect(built.stats.features).toBe(0);
  });

  it('cuts a building that straddles the edge, and stays manifold', () => {
    const straddling = polygon([box(1200, 0, 400)], { height_m: 10 });

    const clipped = buildPolygonLayer('buildings', [straddling], {
      ...options,
      selection: circle,
    });
    const unclipped = buildPolygonLayer('buildings', [straddling], options);

    expect(clipped.part).not.toBeNull();

    // Genuinely cut, not merely passed through.
    const extentX = (positions: Float32Array) => {
      let max = -Infinity;
      for (let i = 0; i < positions.length; i += 3) max = Math.max(max, positions[i]);
      return max;
    };
    expect(extentX(clipped.part!.positions)).toBeLessThan(
      extentX(unclipped.part!.positions) - 1e-6,
    );

    const v = validateMesh(clipped.part!.positions, clipped.part!.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  it('leaves a building well inside the selection untouched', () => {
    const inside = polygon([box(0, 0, 200)], { height_m: 10 });
    const a = buildPolygonLayer('buildings', [inside], { ...options, selection: circle });
    const b = buildPolygonLayer('buildings', [inside], options);
    expect(a.stats.triangles).toBe(b.stats.triangles);
  });
});

describe('groupPolygons', () => {
  it('groups by layer', () => {
    const grouped = groupPolygons([
      polygon([box(0, 0, 100)]),
      polygon([box(0, 0, 100)], { layer: 'water' }),
      polygon([box(0, 0, 100)]),
    ]);
    expect(grouped.get('buildings')).toHaveLength(2);
    expect(grouped.get('water')).toHaveLength(1);
  });
});
