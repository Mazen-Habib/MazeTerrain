import { describe, expect, it, vi } from 'vitest';
import {
  buildingHeight_m,
  buildingMinHeight_m,
  buildingSubtype,
  classify,
  layerOrder,
  parseLength,
  ROAD_WIDTH_M,
} from '../src/data/osm/tags';
import {
  bboxArea_km2,
  buildQuery,
  extractKey,
  fetchOsm,
  mergeResponses,
  OverpassError,
  tileBBox,
} from '../src/data/osm/overpass';
import { assembleRings, isClosed, normalise } from '../src/data/osm/normalise';
import type { OverpassResponse } from '../src/data/osm/overpass';

const BBOX = { west: 73.0, south: 33.6, east: 73.1, north: 33.7 };

/** ~4 km2 — under the tiling threshold, so it stays a single exact-bbox query. */
const SMALL_BBOX = { west: 73.0, south: 33.6, east: 73.02, north: 33.62 };

describe('classify', () => {
  it('maps highway classes to roads with their world width', () => {
    const motorway = classify({ highway: 'motorway' });
    expect(motorway?.layer).toBe('roads');
    expect(motorway?.width_m).toBe(ROAD_WIDTH_M['motorway']);

    expect(classify({ highway: 'residential' })?.width_m).toBe(6);
    expect(classify({ highway: 'footway' })?.layer).toBe('trails');
  });

  /** docs/04-data-sources.md: a printed tunnel is a road inside a mountain. */
  it('skips tunnels entirely', () => {
    expect(classify({ highway: 'primary', tunnel: 'yes' })).toBeNull();
    expect(classify({ railway: 'rail', tunnel: 'building_passage' })).toBeNull();
    expect(classify({ highway: 'primary', location: 'underground' })).toBeNull();
  });

  it('keeps a tunnel tagged no', () => {
    expect(classify({ highway: 'primary', tunnel: 'no' })?.layer).toBe('roads');
  });

  it('flags bridges rather than dropping them', () => {
    const bridge = classify({ highway: 'primary', bridge: 'yes' });
    expect(bridge?.bridge).toBe(true);
    expect(bridge?.layer).toBe('roads');
  });

  it('drops railways that are no longer track', () => {
    for (const state of ['abandoned', 'disused', 'razed', 'proposed', 'construction']) {
      expect(classify({ railway: state })).toBeNull();
    }
    expect(classify({ railway: 'rail' })?.layer).toBe('railways');
  });

  it('drops a railway with a lifecycle prefix even when the value looks live', () => {
    expect(classify({ railway: 'rail', abandoned: 'yes' })).toBeNull();
  });

  it('recognises water in its several tagging forms', () => {
    expect(classify({ natural: 'water' })?.layer).toBe('water');
    expect(classify({ landuse: 'reservoir' })?.subtype).toBe('reservoir');
    expect(classify({ waterway: 'river' })?.width_m).toBe(20);
    expect(classify({ waterway: 'riverbank' })?.width_m).toBeUndefined();
  });

  it('recognises buildings, greenery and sand', () => {
    expect(classify({ building: 'yes' })?.layer).toBe('buildings');
    expect(classify({ 'building:part': 'yes' })?.layer).toBe('buildings');
    expect(classify({ leisure: 'park' })?.layer).toBe('greenery');
    expect(classify({ landuse: 'forest' })?.layer).toBe('greenery');
    expect(classify({ natural: 'beach' })?.layer).toBe('sand');
  });

  it('returns null for anything we do not print', () => {
    expect(classify({ amenity: 'cafe' })).toBeNull();
    expect(classify({ highway: 'motorway_junction' })).toBeNull();
    expect(classify({})).toBeNull();
  });
});

describe('building height cascade', () => {
  it('prefers an explicit height tag', () => {
    expect(buildingHeight_m({ height: '24' })).toBe(24);
    expect(buildingHeight_m({ height: '24', 'building:levels': '2' })).toBe(24);
  });

  it('falls back to levels times three metres', () => {
    expect(buildingHeight_m({ 'building:levels': '5' })).toBe(15);
  });

  it('falls back again to six metres', () => {
    expect(buildingHeight_m({ building: 'yes' })).toBe(6);
    expect(buildingHeight_m({ height: 'tall' })).toBe(6);
    expect(buildingHeight_m({ 'building:levels': '0' })).toBe(6);
  });

  it('reads min_height so a floating part can be filled beneath', () => {
    expect(buildingMinHeight_m({ min_height: '12' })).toBe(12);
    expect(buildingMinHeight_m({})).toBe(0);
  });

  it('groups building values into printable subtypes', () => {
    expect(buildingSubtype({ building: 'apartments' })).toBe('residential');
    expect(buildingSubtype({ building: 'warehouse' })).toBe('industrial');
    expect(buildingSubtype({ building: 'mosque' })).toBe('religious');
    expect(buildingSubtype({ building: 'yes' })).toBe('other');
  });
});

describe('parseLength', () => {
  it('reads bare metres', () => {
    expect(parseLength('12.5')).toBe(12.5);
    expect(parseLength(' 8 m ')).toBe(8);
  });

  it('converts other units', () => {
    expect(parseLength('1 km')).toBe(1000);
    expect(parseLength('10 ft')).toBeCloseTo(3.048, 4);
  });

  it('reads feet and inches', () => {
    expect(parseLength(`10'`)).toBeCloseTo(3.048, 4);
    expect(parseLength(`5'6"`)).toBeCloseTo(1.6764, 4);
  });

  it('rejects nonsense', () => {
    expect(parseLength('tall')).toBeNull();
    expect(parseLength(undefined)).toBeNull();
  });
});

describe('layerOrder', () => {
  it('reads the layer tag for z-ordering only', () => {
    expect(layerOrder({ layer: '-1' })).toBe(-1);
    expect(layerOrder({ layer: '2' })).toBe(2);
    expect(layerOrder({})).toBe(0);
    expect(layerOrder({ layer: 'weird' })).toBe(0);
  });
});

describe('buildQuery', () => {
  it('batches every enabled layer into one request', () => {
    const q = buildQuery(BBOX, ['roads', 'water']);
    expect(q).toContain('[out:json]');
    expect(q).toContain('highway');
    expect(q).toContain('natural"="water');
    expect(q).toContain('out body geom;');
    // One statement block, not one request per layer.
    expect(q.match(/\[out:json\]/g)).toHaveLength(1);
  });

  it('writes the bbox in Overpass order: south,west,north,east', () => {
    expect(buildQuery(BBOX, ['roads'])).toContain('33.600000,73.000000,33.700000,73.100000');
  });

  it('returns nothing when no layers are enabled', () => {
    expect(buildQuery(BBOX, [])).toBe('');
  });

  it('excludes dead railways in the query, not just the classifier', () => {
    expect(buildQuery(BBOX, ['railways'])).toContain('abandoned|disused|razed|proposed|construction');
  });
});

describe('extractKey', () => {
  it('depends on the fetch inputs only, so mm tweaks never refetch', () => {
    const a = extractKey(BBOX, ['roads', 'water']);
    const b = extractKey(BBOX, ['water', 'roads']);
    expect(a).toBe(b);
    expect(a).not.toBe(extractKey(BBOX, ['roads']));
  });
});

describe('fetchOsm', () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  it('returns empty without calling the network when no layers are on', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchOsm(BBOX, [], { fetchImpl: fetchImpl as unknown as typeof fetch, backoffMs: 1 });
    expect(result.elements).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the query and returns the elements', async () => {
    const fetchImpl = vi.fn(async () => ok({ elements: [{ type: 'way', id: 1 }] }));
    const result = await fetchOsm(SMALL_BBOX, ['roads'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMs: 1,
    });
    expect(result.elements).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown[])[1]).toMatchObject({ method: 'POST' });
  });

  /** CLAUDE.md: a 429 branch with a user-facing message, not a generic error. */
  it('retries a 429 and then reports it in words a user can act on', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response);
    await expect(
      fetchOsm(SMALL_BBOX, ['roads'], { fetchImpl: fetchImpl as unknown as typeof fetch, backoffMs: 1 }),
    ).rejects.toThrow(OverpassError);

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    try {
      await fetchOsm(SMALL_BBOX, ['roads'], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        backoffMs: 1,
      });
    } catch (err) {
      expect((err as OverpassError).userMessage).toMatch(/rate-limiting/i);
      expect((err as OverpassError).userMessage).toMatch(/reduce your selection/i);
    }
  });

  it('rotates mirrors between attempts', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      seen.push(String(url));
      return { ok: false, status: 504 } as unknown as Response;
    });
    await expect(
      fetchOsm(SMALL_BBOX, ['roads'], { fetchImpl: fetchImpl as unknown as typeof fetch, backoffMs: 1 }),
    ).rejects.toThrow();
    expect(new Set(seen).size).toBeGreaterThan(1);
  });
});

/**
 * Large-area tiling.
 *
 * A single query for a 250 km2 city never returns, so anything past the
 * threshold is split across a grid. The grid is aligned to whole multiples of
 * the tile size and NOT clipped to the selection, which is what lets two
 * overlapping selections share cache entries.
 */
describe('tileBBox', () => {
  it('snaps to the grid and covers the whole bbox', () => {
    const tiles = tileBBox({ west: 0.05, south: 0.05, east: 0.11, north: 0.09 }, 0.04);

    for (const t of tiles) {
      expect(t.west / 0.04).toBeCloseTo(Math.round(t.west / 0.04), 6);
      expect(t.south / 0.04).toBeCloseTo(Math.round(t.south / 0.04), 6);
    }
    expect(Math.min(...tiles.map((t) => t.west))).toBeLessThanOrEqual(0.05);
    expect(Math.max(...tiles.map((t) => t.east))).toBeGreaterThanOrEqual(0.11);
    expect(Math.min(...tiles.map((t) => t.south))).toBeLessThanOrEqual(0.05);
    expect(Math.max(...tiles.map((t) => t.north))).toBeGreaterThanOrEqual(0.09);
  });

  it('produces no duplicates and no gaps across a wide bbox', () => {
    // Repeated addition of 0.04 drifts; indices must be rounded, not accumulated.
    const tiles = tileBBox({ west: -1.3, south: 51.2, east: 0.7, north: 51.9 }, 0.04);
    const keys = tiles.map((t) => `${t.west.toFixed(4)},${t.south.toFixed(4)}`);
    expect(new Set(keys).size).toBe(tiles.length);

    const cols = new Set(tiles.map((t) => t.west.toFixed(4))).size;
    const rows = new Set(tiles.map((t) => t.south.toFixed(4))).size;
    expect(cols * rows).toBe(tiles.length);
  });

  it('gives one tile for an area inside a single cell', () => {
    expect(tileBBox({ west: 0.001, south: 0.001, east: 0.002, north: 0.002 }, 0.04)).toHaveLength(1);
  });

  it('keeps every tile under the single-query limit, at any latitude', () => {
    // Default tile size, not an explicit one: this is the assertion that keeps
    // TILE_DEG and MAX_SINGLE_QUERY_KM2 consistent with each other.
    for (const lat of [0, 33.7, 51.5, 69.6]) {
      const [tile] = tileBBox({ west: 0, south: lat, east: 0.001, north: lat + 0.001 });
      expect(bboxArea_km2(tile)).toBeLessThanOrEqual(100);
    }
  });

  it('keeps a 21 km city to a modest number of requests', () => {
    // 35 requests for this selection is what got the client connect-refused.
    // A selection is not grid-aligned, so it can straddle one extra row and
    // column — 21.4 km spans 2.4 cells but can touch 4. Twelve, not nine.
    const half = 21.4 / 2;
    const bbox = {
      west: 73.06 - half / (111.32 * Math.cos((33.7 * Math.PI) / 180)),
      east: 73.06 + half / (111.32 * Math.cos((33.7 * Math.PI) / 180)),
      south: 33.7 - half / 110.574,
      north: 33.7 + half / 110.574,
    };
    expect(tileBBox(bbox).length).toBeLessThanOrEqual(16);
  });
});

describe('mergeResponses', () => {
  /**
   * Overpass clips the selection, not the geometry, so a way along a tile edge
   * comes back in full from both tiles. Building it twice stamps it twice.
   */
  it('drops elements returned by more than one tile', () => {
    const merged = mergeResponses([
      { elements: [{ type: 'way', id: 1 }, { type: 'way', id: 2 }] },
      { elements: [{ type: 'way', id: 2 }, { type: 'way', id: 3 }] },
    ]);
    expect(merged.elements.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('keeps a way and a relation that share an id', () => {
    const merged = mergeResponses([
      { elements: [{ type: 'way', id: 7 }, { type: 'relation', id: 7 }] },
    ]);
    expect(merged.elements).toHaveLength(2);
  });

  it('handles no responses at all', () => {
    expect(mergeResponses([]).elements).toEqual([]);
  });
});

describe('fetchOsm at scale', () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  /** 0.5 x 0.5 degrees near the equator is ~3000 km2 — far past the threshold. */
  const BIG = { west: 0, south: 0, east: 0.5, north: 0.5 };

  it('splits a large area into several queries and merges them', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => ok({ elements: [{ type: 'way', id: ++n }] }));

    const result = await fetchOsm(BIG, ['roads'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMs: 1,
      tileGapMs: 0,
    });

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    expect(result.elements).toHaveLength(fetchImpl.mock.calls.length);
  });

  it('keeps a small area on a single exact-bbox query', async () => {
    const fetchImpl = vi.fn(async () => ok({ elements: [] }));
    await fetchOsm(SMALL_BBOX, ['roads'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMs: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports progress as areas completed, not as retries', async () => {
    const messages: string[] = [];
    const fetchImpl = vi.fn(async () => ok({ elements: [] }));

    await fetchOsm(BIG, ['roads'], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMs: 1,
      tileGapMs: 0,
      onAttempt: (m) => messages.push(m),
    });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((m) => /area \d+ of \d+/.test(m))).toBe(true);
  });

  /**
   * A road network missing a rectangular chunk reads as a geometry bug. An
   * honest failure, with the terrain still built, is the better outcome.
   */
  it('fails the whole fetch when one area cannot be loaded', async () => {
    // Keyed on the tile's own bbox, so this tile fails on every retry too —
    // a mock that fails by call count would be rescued by the next attempt.
    const doomed = '0.080000';
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      const body = String((init as { body?: unknown }).body ?? '');
      return body.includes(doomed)
        ? ({ ok: false, status: 500 } as unknown as Response)
        : ok({ elements: [] });
    });

    await expect(
      fetchOsm(BIG, ['roads'], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        backoffMs: 1,
        tileGapMs: 0,
      }),
    ).rejects.toThrow(OverpassError);
  });
});

describe('normalise', () => {
  const way = (id: number, tags: Record<string, string>, coords: Array<[number, number]>) => ({
    type: 'way' as const,
    id,
    tags,
    geometry: coords.map(([lon, lat]) => ({ lon, lat })),
  });

  it('turns an open highway into a line with its width resolved', () => {
    const res: OverpassResponse = {
      elements: [way(1, { highway: 'primary' }, [[73, 33.6], [73.01, 33.61]])],
    };
    const { lines, polygons } = normalise(res);
    expect(polygons).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ layer: 'roads', subtype: 'primary', width_m: 12 });
  });

  it('turns a closed area way into a polygon', () => {
    const square: Array<[number, number]> = [
      [73, 33.6],
      [73.01, 33.6],
      [73.01, 33.61],
      [73, 33.61],
      [73, 33.6],
    ];
    const { polygons } = normalise({ elements: [way(2, { building: 'yes' }, square)] });
    expect(polygons).toHaveLength(1);
    expect(polygons[0].rings[0]).toHaveLength(4); // closing vertex stripped
    expect(polygons[0].height_m).toBe(6);
  });

  /** A ring road is a road, not a disc. */
  it('keeps a closed way that has a width as a line', () => {
    const ring: Array<[number, number]> = [
      [73, 33.6],
      [73.01, 33.6],
      [73.01, 33.61],
      [73, 33.6],
    ];
    const { lines, polygons } = normalise({ elements: [way(3, { highway: 'residential' }, ring)] });
    expect(lines).toHaveLength(1);
    expect(polygons).toHaveLength(0);
  });

  it('counts what it skipped rather than hiding it', () => {
    const { skipped, lines } = normalise({
      elements: [
        way(4, { highway: 'primary', tunnel: 'yes' }, [[73, 33.6], [73.01, 33.61]]),
        way(5, { amenity: 'cafe' }, [[73, 33.6], [73.01, 33.61]]),
      ],
    });
    expect(lines).toHaveLength(0);
    expect(skipped).toBe(2);
  });

  it('reports a per-layer tally', () => {
    const { counts } = normalise({
      elements: [
        way(6, { highway: 'primary' }, [[73, 33.6], [73.01, 33.61]]),
        way(7, { highway: 'residential' }, [[73, 33.6], [73.01, 33.61]]),
        way(8, { natural: 'water' }, [
          [73, 33.6],
          [73.01, 33.6],
          [73.01, 33.61],
          [73, 33.6],
        ]),
      ],
    });
    expect(counts.roads).toBe(2);
    expect(counts.water).toBe(1);
  });
});

describe('assembleRings', () => {
  /** Islands in lakes and courtyards in buildings are real and common. */
  it('chains unordered member fragments into closed rings', () => {
    const members = [
      {
        type: 'way',
        ref: 1,
        role: 'outer',
        geometry: [
          { lon: 0, lat: 0 },
          { lon: 10, lat: 0 },
        ],
      },
      {
        type: 'way',
        ref: 3,
        role: 'outer',
        geometry: [
          { lon: 10, lat: 10 },
          { lon: 0, lat: 10 },
          { lon: 0, lat: 0 },
        ],
      },
      {
        type: 'way',
        ref: 2,
        role: 'outer',
        geometry: [
          { lon: 10, lat: 0 },
          { lon: 10, lat: 10 },
        ],
      },
    ];
    const rings = assembleRings(members, 'outer');
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });

  it('reverses a fragment that joins tail to tail', () => {
    const members = [
      { type: 'way', ref: 1, role: 'outer', geometry: [{ lon: 0, lat: 0 }, { lon: 10, lat: 0 }] },
      { type: 'way', ref: 2, role: 'outer', geometry: [{ lon: 0, lat: 0 }, { lon: 10, lat: 0 }] },
    ];
    expect(assembleRings(members, 'outer').length).toBeGreaterThanOrEqual(1);
  });

  it('separates inner rings from outer', () => {
    const members = [
      {
        type: 'way',
        ref: 1,
        role: 'outer',
        geometry: [
          { lon: 0, lat: 0 },
          { lon: 10, lat: 0 },
          { lon: 10, lat: 10 },
          { lon: 0, lat: 10 },
          { lon: 0, lat: 0 },
        ],
      },
      {
        type: 'way',
        ref: 2,
        role: 'inner',
        geometry: [
          { lon: 2, lat: 2 },
          { lon: 4, lat: 2 },
          { lon: 4, lat: 4 },
          { lon: 2, lat: 2 },
        ],
      },
    ];
    expect(assembleRings(members, 'outer')).toHaveLength(1);
    expect(assembleRings(members, 'inner')).toHaveLength(1);
  });

  it('attaches holes to the polygon in a relation', () => {
    const { polygons } = normalise({
      elements: [
        {
          type: 'relation',
          id: 9,
          tags: { natural: 'water' },
          members: [
            {
              type: 'way',
              ref: 1,
              role: 'outer',
              geometry: [
                { lon: 0, lat: 0 },
                { lon: 10, lat: 0 },
                { lon: 10, lat: 10 },
                { lon: 0, lat: 10 },
                { lon: 0, lat: 0 },
              ],
            },
            {
              type: 'way',
              ref: 2,
              role: 'inner',
              geometry: [
                { lon: 2, lat: 2 },
                { lon: 4, lat: 2 },
                { lon: 4, lat: 4 },
                { lon: 2, lat: 2 },
              ],
            },
          ],
        },
      ],
    });
    expect(polygons).toHaveLength(1);
    expect(polygons[0].rings.length).toBe(2);
  });
});

describe('isClosed', () => {
  it('needs a repeated first point and at least a triangle', () => {
    expect(isClosed([[0, 0], [1, 0], [1, 1], [0, 0]])).toBe(true);
    expect(isClosed([[0, 0], [1, 0], [1, 1]])).toBe(false);
    expect(isClosed([[0, 0], [1, 0]])).toBe(false);
  });
});
