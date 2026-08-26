import { describe, expect, it } from 'vitest';
import {
  buildLineLayer,
  estimatedWidths_mm,
  groupLines,
  ladderWidth_mm,
  mergeSolids,
  resolveMinWidth_mm,
  selectLegibleSubtypes,
  splitAgainstWater,
  waterRings,
  type LayerSettings,
} from '../src/geometry/features';
import type { LineFeature, PolygonFeature } from '../src/data/osm/normalise';
import type { Pt } from '../src/data/gpx/simplify';
import type { Ring } from '../src/geometry/polygons';
import { validateMesh, weldVertices } from '../src/geometry/validate';
import { buildRibbonField } from '../src/geometry/ribbonField';
import { extrudeDraped } from '../src/geometry/extrude';
import { unprojectENU } from '../src/geometry/coords';
import { defaultLayers } from '../src/config/presets';
import { makeHeightfield, scaleFor } from './helpers';

const hf = makeHeightfield(60, 60, (i, j) => 300 + 2 * i + 1.5 * j);
const scale = scaleFor(hf);

/** A square of water in world metres, centred on the origin. */
const LAKE: Ring = [
  [-500, -500],
  [500, -500],
  [500, 500],
  [-500, 500],
];

function lineAcrossLake(): Pt[] {
  const out: Pt[] = [];
  for (let x = -1500; x <= 1500; x += 100) out.push([x, 0]);
  return out;
}

describe('splitAgainstWater', () => {
  /** docs/05 Stage 2-3c: a road diving under a river is the classic artefact. */
  it('deletes the wet part of a road that is not a bridge', () => {
    const { segments, drowned } = splitAgainstWater(lineAcrossLake(), false, [LAKE]);

    expect(drowned).toBeGreaterThan(0);
    expect(segments).toHaveLength(2);

    for (const segment of segments) {
      for (const [x] of segment.points) {
        expect(Math.abs(x)).toBeGreaterThanOrEqual(500 - 100);
      }
    }
  });

  /** docs/05 Stage 2-3b: bridges are kept, not deleted. */
  it('keeps a bridge intact across the same water', () => {
    const { segments, drowned } = splitAgainstWater(lineAcrossLake(), true, [LAKE]);
    expect(drowned).toBe(0);
    expect(segments).toHaveLength(1);
    expect(segments[0].bridge).toBe(true);
    expect(segments[0].points).toHaveLength(31);
  });

  it('leaves a road that never touches water alone', () => {
    const dry: Pt[] = [
      [-1500, 2000],
      [1500, 2000],
    ];
    const { segments, drowned } = splitAgainstWater(dry, false, [LAKE]);
    expect(drowned).toBe(0);
    expect(segments).toHaveLength(1);
  });

  it('does nothing when there is no water at all', () => {
    const { segments } = splitAgainstWater(lineAcrossLake(), false, []);
    expect(segments).toHaveLength(1);
  });

  it('drops a road entirely submerged rather than emitting a stub', () => {
    const submerged: Pt[] = [
      [-100, 0],
      [0, 0],
      [100, 0],
    ];
    const { segments } = splitAgainstWater(submerged, false, [LAKE]);
    expect(segments).toHaveLength(0);
  });
});

describe('waterRings', () => {
  it('takes outer rings only, so an island in a lake stays dry land', () => {
    const polygons: PolygonFeature[] = [
      {
        layer: 'water',
        subtype: 'lake',
        bridge: false,
        layerOrder: 0,
        rings: [
          [
            [0, 0],
            [0.01, 0],
            [0.01, 0.01],
            [0, 0.01],
          ],
          [
            [0.004, 0.004],
            [0.006, 0.004],
            [0.006, 0.006],
            [0.004, 0.006],
          ],
        ],
      },
      {
        layer: 'greenery',
        subtype: 'park',
        bridge: false,
        layerOrder: 0,
        rings: [
          [
            [1, 1],
            [1.01, 1],
            [1.01, 1.01],
          ],
        ],
      },
    ];

    const rings = waterRings(polygons, scale);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });
});

describe('mergeSolids', () => {
  it('offsets indices so parts do not reference each other', () => {
    const a = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      triangles: 1,
    };
    const merged = mergeSolids([a, a]);
    expect(merged.triangles).toBe(2);
    expect(Array.from(merged.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(merged.positions).toHaveLength(18);
  });

  it('returns an empty solid for no input', () => {
    expect(mergeSolids([]).triangles).toBe(0);
  });
});

describe('buildLineLayer', () => {
  const layers = defaultLayers();
  const options = {
    heightfield: hf,
    scale,
    selection: null,
    nozzleDiameter_mm: 0.4,
    baseThickness_mm: 3,
    layers,
    triangleBudget: 5_000_000,
  };

  /** The builder works in lon/lat, so synthetic metres go back through the projection. */
  function feature(points: Pt[], overrides: Partial<LineFeature> = {}): LineFeature {
    return {
      layer: 'roads',
      subtype: 'primary',
      // 60 m reads as ~1 mm at this synthetic scale, so it clears the nozzle.
      // A 12 m road here would be 0.2 mm and is now dropped by design.
      width_m: 60,
      bridge: false,
      layerOrder: 0,
      points: points.map((p) => unprojectENU(p[0], p[1], scale.origin)),
      ...overrides,
    };
  }

  it('builds a manifold solid for a road', () => {
    const road = feature([
      [-2000, -500],
      [0, 0],
      [2000, 600],
    ]);
    const built = buildLineLayer('roads', [road], [], options);

    expect(built.part).not.toBeNull();
    expect(built.stats.triangles).toBeGreaterThan(0);

    const v = validateMesh(built.part!.positions, built.part!.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.manifold).toBe(true);
  });

  it('gives the part the layer name and colour, for one 3MF object per layer', () => {
    const built = buildLineLayer('roads', [feature([[-1000, 0], [1000, 0]])], [], options);
    expect(built.part?.name).toBe('roads');
    expect(built.part?.color).toBe(layers.roads.color);
  });

  it('merges every road into a single part', () => {
    const two = [feature([[-1000, -200], [1000, -200]]), feature([[-1000, 200], [1000, 200]])];
    const built = buildLineLayer('roads', two, [], options);
    expect(built.stats.features).toBe(2);
    expect(built.part).not.toBeNull();
  });

  it('returns nothing when the layer is disabled', () => {
    const off = { ...options, layers: { ...layers, roads: { ...layers.roads, enabled: false } } };
    expect(buildLineLayer('roads', [feature([[-1000, 0], [1000, 0]])], [], off).part).toBeNull();
  });

  it('honours the subtype filter', () => {
    const filtered: Record<string, LayerSettings> = {
      ...layers,
      roads: { ...layers.roads, subtypes: ['motorway'] },
    };
    const built = buildLineLayer(
      'roads',
      [feature([[-1000, 0], [1000, 0]], { subtype: 'residential' })],
      [],
      { ...options, layers: filtered },
    );
    expect(built.part).toBeNull();
  });

  /**
   * docs/08-pitfalls.md#sub-nozzle-classes-become-porridge — classes are taken
   * in importance order until they would overcrowd the model, so a lone road
   * always survives however narrow it is.
   */
  it('keeps the most important class however narrow it is', () => {
    const built = buildLineLayer(
      'roads',
      [feature([[-1000, 0], [1000, 0]], { width_m: 2, subtype: 'service' })],
      [],
      options,
    );
    expect(built.stats.droppedSubtypes).toHaveLength(0);
    expect(built.part).not.toBeNull();
  });

  /**
   * A dense grid of residential streets plus one motorway. Crowding is a
   * judgement, not an error, so by default it builds and only reports.
   */
  function blanketingGrid(): LineFeature[] {
    const dense: LineFeature[] = [
      feature([[-2500, 0], [2500, 0]], { width_m: 200, subtype: 'motorway' }),
    ];
    for (let i = 0; i < 120; i++) {
      const y = -2500 + i * 40;
      dense.push(feature([[-2500, y], [2500, y]], { width_m: 60, subtype: 'residential' }));
    }
    return dense;
  }

  it('builds a blanketing grid anyway, and reports the crowding', () => {
    const built = buildLineLayer('roads', blanketingGrid(), [], options);

    expect(built.stats.crowdedSubtypes).toContain('residential');
    expect(built.stats.coverage).toBeGreaterThan(0.25);
    // Reported, not removed: the user asked for these streets.
    expect(built.stats.droppedSubtypes).toHaveLength(0);
    expect(built.stats.suggestedMinWidth_mm).toBeGreaterThan(0);
    expect(built.part).not.toBeNull();
  });

  it('drops the lesser classes only when explicitly asked to', () => {
    const enforce: Record<string, LayerSettings> = {
      ...layers,
      roads: { ...layers.roads, legibilityFilter: true },
    };
    const built = buildLineLayer('roads', blanketingGrid(), [], {
      ...options,
      layers: enforce,
    });

    expect(built.stats.droppedSubtypes).toContain('residential');
    expect(built.part).not.toBeNull();
  });

  /** docs/08-pitfalls.md#sub-nozzle-features */
  it('clamps instead when the user asks for it', () => {
    const keep: Record<string, LayerSettings> = {
      ...layers,
      roads: { ...layers.roads, legibilityFilter: false },
    };
    // legibilityFilter is off by default; spelled out here because this test is
    // about the width floor, not about class selection.
    const built = buildLineLayer(
      'roads',
      [feature([[-1000, 0], [1000, 0]], { width_m: 2 })],
      [],
      { ...options, layers: keep },
    );
    expect(built.stats.widthClamped).toBe(true);
    expect(built.stats.width_mm).toBeGreaterThanOrEqual(0.4);
  });

  it('deletes a road through water but keeps the bridge over it', () => {
    const road = feature(lineAcrossLake());
    const bridge = feature(lineAcrossLake(), { bridge: true });

    const drowned = buildLineLayer('roads', [road], [LAKE], options);
    const kept = buildLineLayer('roads', [bridge], [LAKE], options);

    expect(drowned.stats.drownedSegments).toBeGreaterThan(0);
    expect(kept.stats.drownedSegments).toBe(0);
    // The bridge survives as one piece; the road comes back as two.
    expect(kept.stats.features).toBe(1);
    expect(drowned.stats.features).toBe(2);
  });

  it('gives a bridge a flat deck rather than draping it into the riverbed', () => {
    const bridge = feature(lineAcrossLake(), { bridge: true });
    const built = buildLineLayer('roads', [bridge], [LAKE], options);
    const p = built.part!.positions;

    // The terrain ramps steadily across this heightfield, so a draped deck would
    // span a wide Z range. A flat deck spans only its own thickness.
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 2; i < p.length; i += 3) {
      if (p[i] < minZ) minZ = p[i];
      if (p[i] > maxZ) maxZ = p[i];
    }

    const draped = buildLineLayer('roads', [feature(lineAcrossLake())], [], options);
    const dp = draped.part!.positions;
    let dMin = Infinity;
    let dMax = -Infinity;
    for (let i = 2; i < dp.length; i += 3) {
      if (dp[i] < dMin) dMin = dp[i];
      if (dp[i] > dMax) dMax = dp[i];
    }

    expect(maxZ - minZ).toBeLessThan(dMax - dMin);
  });

  it('stays manifold for a bridge, which uses a different Z sampler', () => {
    const built = buildLineLayer(
      'roads',
      [feature(lineAcrossLake(), { bridge: true })],
      [LAKE],
      options,
    );
    expect(validateMesh(built.part!.positions, built.part!.indices).manifold).toBe(true);
  });
});

describe('groupLines', () => {
  it('buckets features by layer', () => {
    const lines = [
      { layer: 'roads' },
      { layer: 'roads' },
      { layer: 'railways' },
    ] as unknown as LineFeature[];
    const grouped = groupLines(lines);
    expect(grouped.get('roads')).toHaveLength(2);
    expect(grouped.get('railways')).toHaveLength(1);
    expect(grouped.get('water')).toBeUndefined();
  });
});

/**
 * docs/08-pitfalls.md#feature-triangle-explosion — a 249 km2 selection over
 * Islamabad and Rawalpindi with roads on died inside V8 with
 * "Map maximum size exceeded", because a JS Map caps at 16 777 216 entries and
 * the edge maps hold roughly 1.5 per triangle.
 */
describe('triangle budget', () => {
  const layers = defaultLayers();

  const mkFeature = (points: Pt[]): LineFeature => ({
    layer: 'roads',
    subtype: 'primary',
    width_m: 60,
    bridge: false,
    layerOrder: 0,
    points: points.map((p) => unprojectENU(p[0], p[1], scale.origin)),
  });

  function manyRoads(count: number): LineFeature[] {
    const out: LineFeature[] = [];
    for (let i = 0; i < count; i++) {
      const y = -2500 + i * 40;
      out.push({
        layer: 'roads',
        subtype: 'primary',
        width_m: 60,
        bridge: false,
        layerOrder: 0,
        points: [
          [-2500, y],
          [2500, y],
        ].map((p) => unprojectENU(p[0], p[1], scale.origin)),
      });
    }
    return out;
  }

  it('stops before spending a budget it cannot afford', () => {
    const built = buildLineLayer('roads', manyRoads(40), [], {
      heightfield: hf,
      scale,
      selection: null,
      nozzleDiameter_mm: 0.4,
      baseThickness_mm: 3,
      layers,
      triangleBudget: 40,
    });

    // The cost is estimated from the contour before any triangle is built, so
    // the budget is respected rather than discovered after the fact.
    expect(built.stats.truncated).toBe(true);
    expect(built.stats.triangles).toBeLessThanOrEqual(40);
  });

  /**
   * The measured problem: OSM splits a street into many short ways, and 67.5%
   * of them were shorter than their own printed width in a sample of Islamabad,
   * with end caps accounting for 56.4% of all contour. Stamping the network into
   * one field must make those splits cost nothing.
   */
  it('costs the same whether a street is one way or twenty', () => {
    const options = {
      heightfield: hf,
      scale,
      selection: null,
      nozzleDiameter_mm: 0.4,
      baseThickness_mm: 3,
      layers,
      triangleBudget: 5_000_000,
    };

    const whole: LineFeature[] = [mkFeature([[-2400, 0], [2400, 0]])];

    // The same street, as OSM actually stores it: twenty abutting ways.
    const split: LineFeature[] = [];
    for (let i = 0; i < 20; i++) {
      const x0 = -2400 + i * 240;
      split.push(mkFeature([[x0, 0], [x0 + 240, 0]]));
    }

    const asOne = buildLineLayer('roads', whole, [], options);
    const asMany = buildLineLayer('roads', split, [], options);

    expect(asOne.part).not.toBeNull();
    expect(asMany.part).not.toBeNull();
    // Within a few percent, not twenty times over.
    expect(asMany.stats.triangles).toBeLessThan(asOne.stats.triangles * 1.3);
    expect(validateMesh(asMany.part!.positions, asMany.part!.indices).manifold).toBe(true);
  });

  it('builds everything when the budget is ample', () => {
    const built = buildLineLayer('roads', manyRoads(4), [], {
      heightfield: hf,
      scale,
      selection: null,
      nozzleDiameter_mm: 0.4,
      baseThickness_mm: 3,
      layers,
      triangleBudget: 5_000_000,
    });
    expect(built.stats.truncated).toBe(false);
    expect(built.stats.features).toBe(4);
  });
});

/**
 * docs/08-pitfalls.md#bowtie-vertices-from-touching-contours — a road network
 * clipped to a circle produced a contour that touched itself at one point,
 * making the surface a bowtie there and the vertical wall edge four-faced.
 */
describe('touching contours', () => {
  function circleRing(r: number, n = 192): Ring {
    const ring: Ring = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return ring;
  }

  function streetGrid(): Pt[][] {
    const lines: Pt[][] = [];
    for (let i = 0; i < 10; i++) {
      const c = -2000 + i * 440;
      lines.push([[-2200, c], [2200, c]], [[c, -2200], [c, 2200]]);
    }
    return lines;
  }

  const extrude = (lines: Pt[][], selection: Ring | null) => {
    const field = buildRibbonField(lines, 60, selection, 3);
    return extrudeDraped(
      field.polygons,
      () => 5,
      (x, y) => [x * 0.01, y * 0.01],
      { height_mm: 1, penetration_mm: 1, minBottom_mm: 0.2, maxEdge_m: Infinity },
    );
  };

  it('stays manifold where a clipped network pinches against the boundary', () => {
    for (const radius of [1800, 1200, 700]) {
      const mesh = extrude(streetGrid(), circleRing(radius));
      expect(mesh.triangles).toBeGreaterThan(0);
      const v = validateMesh(mesh.positions, mesh.indices);
      expect(v.nonManifoldEdges).toBe(0);
      expect(v.openEdges).toBe(0);
      expect(v.manifold).toBe(true);
    }
  });

  /**
   * The split has to hold up to a positional weld.
   *
   * Splitting a pinch by index alone is undone by the first thing downstream
   * that treats two vertices at the same coordinates as one — which is every
   * validation path, every boolean kernel and every slicer. This test is the
   * one that was missing: the contours layer went into repairAndValidate clean
   * and came out with 26 non-manifold edges, and checking the unwelded buffer
   * saw nothing wrong.
   */
  it('keeps the split apart through a positional weld', () => {
    for (const radius of [1800, 1200, 700]) {
      const mesh = extrude(streetGrid(), circleRing(radius));
      const welded = weldVertices(mesh.positions, mesh.indices);
      const v = validateMesh(welded.positions, welded.indices);
      expect(v.nonManifoldEdges).toBe(0);
      expect(v.manifold).toBe(true);
    }
  });

  it('leaves an unclipped network alone', () => {
    const mesh = extrude(streetGrid(), null);
    expect(validateMesh(mesh.positions, mesh.indices).manifold).toBe(true);
  });

  /** A city block is a hole; 81 of them must survive the merge. */
  it('keeps the blocks between streets as holes', () => {
    const field = buildRibbonField(streetGrid(), 60, null, 3);
    expect(field.polygons).toHaveLength(1);
    expect(field.polygons[0].length).toBeGreaterThan(50);
  });
});

/**
 * Width model.
 *
 * The failure this replaces: at 11.2 km across, every road class fell under the
 * printable floor, so all ten clamped to the same 0.8 mm — 90 m of real width
 * on streets 100 m apart. The bands touched and the city printed as one slab.
 */
describe('printed width', () => {
  const scale = 100 / 11200; // the user's 11.2 km model at 100 mm
  const floor = 0.2; // one 0.2 mm nozzle

  it('takes an explicit floor at face value, including below the nozzle', () => {
    expect(resolveMinWidth_mm('auto', 0.4)).toBe(0.4);
    expect(resolveMinWidth_mm(0.1, 0.4)).toBe(0.1);
    expect(resolveMinWidth_mm(1.5, 0.4)).toBe(1.5);
  });

  it('puts the narrowest class exactly on the floor', () => {
    expect(ladderWidth_mm(3, 3, floor, scale)).toBeCloseTo(floor, 10);
  });

  it('keeps classes distinguishable instead of collapsing them', () => {
    const track = ladderWidth_mm(3, 3, floor, scale);
    const residential = ladderWidth_mm(6, 3, floor, scale);
    const trunk = ladderWidth_mm(16, 3, floor, scale);

    expect(residential).toBeGreaterThan(track * 1.2);
    expect(trunk).toBeGreaterThan(residential * 1.2);
    // ...but compressed, or the widest class closes the grid again.
    expect(trunk / track).toBeLessThan(16 / 3);
  });

  it('never draws a road narrower than true scale, and never exaggerates a large model', () => {
    // A 2 km model: a 20 m motorway is 1 mm, already well over the floor.
    const big = 100 / 2000;
    expect(ladderWidth_mm(20, 3, floor, big)).toBeCloseTo(20 * big, 10);
  });
});

describe('selectLegibleSubtypes', () => {
  const ordered = ['motorway', 'primary', 'residential', 'track'];

  /**
   * The greedy version skipped an overflowing class and kept buying cheaper
   * ones after it, so an Islamabad model dropped residential streets and spent
   * the change on tracks and footpaths.
   */
  it('cuts the tail, never the middle', () => {
    const lengths = new Map([
      ['motorway', 1_000],
      ['primary', 1_000],
      ['residential', 10_000_000], // far too much to fit
      ['track', 100], // cheap, but less important than residential
    ]);
    const { kept, dropped } = selectLegibleSubtypes(
      ordered, lengths, () => 0.5, 0.01, 10_000,
    );
    expect([...kept]).toEqual(['motorway', 'primary']);
    expect(dropped).toEqual(['residential', 'track']);
  });

  it('always keeps the most important class, however dense', () => {
    const lengths = new Map([['motorway', 1e9], ['primary', 1e9]]);
    const { kept } = selectLegibleSubtypes(ordered, lengths, () => 0.5, 0.01, 10_000);
    expect([...kept]).toEqual(['motorway']);
  });
});

/**
 * Per-class width overrides.
 *
 * The ladder gives sane defaults that follow the model's scale, but tuning a
 * print means setting a class directly — and what you set has to be what gets
 * built, not a starting point the floor or the layer multiplier then moves.
 */
describe('per-class width overrides', () => {
  const layers = defaultLayers();
  const options = {
    heightfield: hf,
    scale,
    selection: null,
    nozzleDiameter_mm: 0.4,
    baseThickness_mm: 3,
    layers,
    triangleBudget: 5_000_000,
  };

  function road(subtype: string, width_m: number): LineFeature {
    return {
      layer: 'roads',
      subtype,
      width_m,
      bridge: false,
      layerOrder: 0,
      points: [
        [-2000, 0],
        [2000, 0],
      ].map((p) => unprojectENU(p[0], p[1], scale.origin)),
    };
  }

  function widthsFor(overrides: Record<string, number>, extra: Partial<LayerSettings> = {}) {
    const built = buildLineLayer('roads', [road('motorway', 20), road('track', 3)], [], {
      ...options,
      layers: {
        ...layers,
        roads: { ...layers.roads, subtypeWidth_mm: overrides, ...extra },
      },
    });
    return built.stats;
  }

  it('uses the ladder when nothing is overridden', () => {
    const plain = widthsFor({});
    expect(plain.width_mm).toBeGreaterThan(plain.narrowestWidth_mm);
  });

  it('takes an override as the final printed width', () => {
    const stats = widthsFor({ motorway: 1.75 });
    expect(stats.width_mm).toBeCloseTo(1.75, 5);
  });

  it('does not let widthScale move a hand-set class', () => {
    const scaled = widthsFor({ motorway: 1.75 }, { widthScale: 3 });
    expect(scaled.width_mm).toBeCloseTo(1.75, 5);
  });

  it('does not let the floor raise a hand-set class', () => {
    // 0.05 mm is well under the 0.4 mm floor for this nozzle.
    const stats = widthsFor({ motorway: 0.05, track: 0.05 });
    expect(stats.narrowestWidth_mm).toBeCloseTo(0.05, 5);
    expect(stats.width_mm).toBeCloseTo(0.05, 5);
  });

  it('leaves other classes on the ladder', () => {
    const stats = widthsFor({ motorway: 2 });
    // track is untouched, so it still sits on the floor.
    expect(stats.narrowestWidth_mm).toBeCloseTo(0.4, 5);
    expect(stats.width_mm).toBeCloseTo(2, 5);
  });

  it('feeds overrides into the crowding budget', () => {
    const dense: LineFeature[] = [];
    for (let i = 0; i < 60; i++) {
      const y = -2500 + i * 80;
      dense.push({
        layer: 'roads',
        subtype: 'residential',
        width_m: 60,
        bridge: false,
        layerOrder: 0,
        points: [
          [-2500, y],
          [2500, y],
        ].map((p) => unprojectENU(p[0], p[1], scale.origin)),
      });
    }

    const wide = buildLineLayer('roads', dense, [], {
      ...options,
      layers: { ...layers, roads: { ...layers.roads, subtypeWidth_mm: { residential: 3 } } },
    });
    const narrow = buildLineLayer('roads', dense, [], {
      ...options,
      layers: { ...layers, roads: { ...layers.roads, subtypeWidth_mm: { residential: 0.1 } } },
    });

    expect(wide.stats.coverage).toBeGreaterThan(narrow.stats.coverage);
    expect(wide.stats.crowdedSubtypes).toContain('residential');
    expect(narrow.stats.crowdedSubtypes).toHaveLength(0);
  });
});

describe('estimatedWidths_mm', () => {
  const natural: Record<string, number> = { motorway: 20, residential: 6, track: 3 };
  const settings = { widthScale: 1, subtypeWidth_mm: {} };
  const at = (s: typeof settings) =>
    estimatedWidths_mm(['motorway', 'residential', 'track'], (k) => natural[k], s, 0.4, 100 / 11200);

  it('matches the ladder, so the panel shows what will be built', () => {
    const w = at(settings);
    expect(w.get('track')).toBeCloseTo(0.4, 5); // narrowest class sits on the floor
    expect(w.get('residential')).toBeGreaterThan(w.get('track')!);
    expect(w.get('motorway')).toBeGreaterThan(w.get('residential')!);
  });

  it('reports an override rather than the ladder value', () => {
    const w = at({ widthScale: 1, subtypeWidth_mm: { residential: 1.2 } });
    expect(w.get('residential')).toBeCloseTo(1.2, 5);
    expect(w.get('track')).toBeCloseTo(0.4, 5);
  });
});
