/**
 * Large selections: ultramarathon-sized fetches.
 *
 * A 100 km route needs a selection close to a degree across, which is roughly
 * 150 Overpass tiles. The old loop gave up after three consecutive failures,
 * which against the public instance meant stopping around a dozen — exactly
 * what a real 64-area build did, reporting "stopped answering after 12 of 64".
 *
 * The fix is not to retry harder. Overpass publishes when it will next accept a
 * query, so the client can queue for an advertised slot instead of guessing.
 * Waiting a stated length is politeness; retrying blind is what gets an IP
 * refused, and this app has done that to itself before.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fetchOsm,
  OverpassError,
  parseSlotWait,
  planOsmTiles,
} from '../src/data/osm/overpass';
import { boxIntersectsRing } from '../src/geometry/selection';

const SMALL_BBOX = { west: 7.6, south: 45.94, east: 7.68, north: 46.0 };
/** Half a degree square: well past the single-query limit, so it tiles. */
const WIDE = { west: 7.0, south: 45.0, east: 7.5, north: 45.5 };

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const statusText = (text: string) =>
  ({ ok: true, status: 200, text: async () => text }) as unknown as Response;

/** Backoffs and gaps to nothing, so the suite does not sit through real waits. */
const FAST = { backoffMs: 1, tileGapMs: 0, rateLimitBackoffMs: 1 };

describe('reading the slot status', () => {
  it('reads free slots as no wait', () => {
    expect(
      parseSlotWait('Connected as: 1\nCurrent time: x\nRate limit: 2\n2 slots available now.'),
    ).toBe(0);
  });

  it('reads the advertised wait', () => {
    expect(
      parseSlotWait('Rate limit: 2\nSlot available after: 2026-09-02T10:01:23Z, in 83 seconds.'),
    ).toBe(83_000);
  });

  /** Several queued slots: the soonest is the one worth waiting for. */
  it('takes the soonest of several slots', () => {
    const text =
      'Rate limit: 2\n' +
      'Slot available after: 2026-09-02T10:02:00Z, in 120 seconds.\n' +
      'Slot available after: 2026-09-02T10:01:23Z, in 42 seconds.';
    expect(parseSlotWait(text)).toBe(42_000);
  });

  /** A slot that freed while the response was in flight reports negative. */
  it('clamps a negative wait to zero', () => {
    expect(parseSlotWait('Slot available after: x, in -4 seconds.')).toBe(0);
  });

  /**
   * The format is not versioned and is not meant for machines. Anything
   * unrecognised has to mean "just try", never "wait forever".
   */
  it('treats an unreadable status as no wait', () => {
    expect(parseSlotWait('<html>502 Bad Gateway</html>')).toBe(0);
    expect(parseSlotWait('')).toBe(0);
  });
});

describe('a fetch that hits the rate limit', () => {
  /**
   * The behaviour asked for: a run that runs out of capacity waits for the
   * advertised slot and then FINISHES, rather than stopping with two thirds of
   * the map missing.
   */
  it('waits for a slot and then completes the run', async () => {
    let queries = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/status')) {
        return statusText('Slot available after: x, in 0 seconds.');
      }
      queries++;
      // Refuse the first few, then answer everything — the shape of running
      // out of slots and getting one back.
      if (queries <= 3) return { ok: false, status: 429 } as unknown as Response;
      return ok({ elements: [{ type: 'way', id: queries }] });
    });

    const partial = vi.fn();
    const result = await fetchOsm(WIDE, ['roads'], {
      ...FAST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onPartial: partial,
    });

    expect(result.elements.length).toBeGreaterThan(0);
    // Continued past the failures rather than reporting a partial model.
    expect(partial).not.toHaveBeenCalled();
  });

  /**
   * The safety rail. When the instance advertises no wait there is nothing to
   * queue FOR, so the run stops with what it has instead of grinding — that
   * part of the old circuit breaker was right and is kept.
   */
  it('stops when no slot is advertised rather than grinding', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/status')) return statusText('2 slots available now.');
      return { ok: false, status: 429 } as unknown as Response;
    });

    await expect(
      fetchOsm(WIDE, ['roads'], { ...FAST, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(OverpassError);
  });

  /** A spent budget also stops it, however generous the server is being. */
  it('honours the waiting budget', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/status')) {
        return statusText('Slot available after: x, in 30 seconds.');
      }
      return { ok: false, status: 429 } as unknown as Response;
    });

    await expect(
      fetchOsm(WIDE, ['roads'], {
        ...FAST,
        slotWaitBudgetMs: 0,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(OverpassError);
  });
});

describe('tiles the selection does not reach', () => {
  it('are not fetched', async () => {
    const fetchImpl = vi.fn(async () => ok({ elements: [{ type: 'way', id: 1 }] }));

    const all = await fetchOsm(WIDE, ['roads'], {
      ...FAST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const everyTile = fetchImpl.mock.calls.length;

    fetchImpl.mockClear();
    // A small triangle in one corner of the same bounding box.
    const ring: Array<[number, number]> = [
      [7.0, 45.0],
      [7.1, 45.0],
      [7.0, 45.1],
    ];
    await fetchOsm(WIDE, ['roads'], {
      ...FAST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      keepTile: (tile) => boxIntersectsRing(tile, ring),
    });

    expect(all.elements.length).toBeGreaterThan(0);
    expect(fetchImpl.mock.calls.length).toBeLessThan(everyTile);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('planOsmTiles', () => {
  it('reports one request for a small selection', () => {
    const plan = planOsmTiles(SMALL_BBOX);
    expect(plan.single).toBe(true);
    expect(plan.tiles).toBe(1);
  });

  /**
   * The figure shown before a build starts. Someone told "about six minutes"
   * waits; someone told nothing assumes it has hung and cancels.
   */
  it('reports the request count and a time for a large one', () => {
    const plan = planOsmTiles({ west: 7.0, south: 45.0, east: 8.0, north: 46.0 });
    expect(plan.single).toBe(false);
    expect(plan.tiles).toBeGreaterThan(100);
    expect(plan.seconds).toBeGreaterThan(60);
  });

  it('counts fewer tiles when the outline excludes some', () => {
    const box = { west: 7.0, south: 45.0, east: 8.0, north: 46.0 };
    const ring: Array<[number, number]> = [
      [7.0, 45.0],
      [7.2, 45.0],
      [7.2, 45.2],
      [7.0, 45.2],
    ];
    expect(planOsmTiles(box, (t) => boxIntersectsRing(t, ring)).tiles).toBeLessThan(
      planOsmTiles(box).tiles,
    );
  });
});

describe('boxIntersectsRing', () => {
  const square: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it('keeps a box wholly inside the ring', () => {
    expect(boxIntersectsRing({ west: 2, south: 2, east: 3, north: 3 }, square)).toBe(true);
  });

  it('keeps a box that contains the whole ring', () => {
    expect(boxIntersectsRing({ west: -5, south: -5, east: 20, north: 20 }, square)).toBe(true);
  });

  /**
   * The case a centre-point test gets wrong: the outline clips one corner of
   * the tile, so most of the tile is outside but some of the model is in it.
   * Dropping it leaves a rectangular hole in the road network, which reads as a
   * geometry bug rather than a fetch that skipped something.
   */
  it('keeps a box the ring only clips a corner of', () => {
    expect(boxIntersectsRing({ west: 9, south: 9, east: 15, north: 15 }, square)).toBe(true);
  });

  it('keeps a box the ring crosses without either containing the other', () => {
    expect(boxIntersectsRing({ west: -1, south: 4, east: 11, north: 6 }, square)).toBe(true);
  });

  it('drops a box that misses entirely', () => {
    expect(boxIntersectsRing({ west: 20, south: 20, east: 30, north: 30 }, square)).toBe(false);
  });

  /** A degenerate outline must not silently drop the whole map. */
  it('keeps everything when the ring is not a polygon', () => {
    expect(boxIntersectsRing({ west: 20, south: 20, east: 30, north: 30 }, [[0, 0]])).toBe(true);
  });
});
