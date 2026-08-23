/**
 * Large-area path end to end, without the network.
 *
 * Live verification against Overpass is worth doing but cannot be the guard:
 * the public instance blocks bursty clients, which is exactly what a test suite
 * looks like. This drives the real `fetchOsm` through a fake server that
 * behaves the way Overpass does — including returning a way in FULL to every
 * tile it touches — and then builds geometry from the result.
 */
import { describe, expect, it } from 'vitest';
import { fetchOsm, tileBBox, bboxArea_km2 } from '../src/data/osm/overpass';
import { normalise } from '../src/data/osm/normalise';
import { buildLineLayer } from '../src/geometry/features';
import { bboxRingWorld } from '../src/geometry/selection';
import { validateMesh } from '../src/geometry/validate';
import { projectENU } from '../src/geometry/coords';
import { defaultLayers } from '../src/config/presets';
import { makeHeightfield, scaleFor } from './helpers';
import type { BBox } from '../src/geometry/types';

/** A 21.4 km selection over Islamabad — the case that could not be built. */
const LAT = 33.7;
const LON = 73.06;
const HALF_KM = 21.4 / 2;
const BBOX: BBox = {
  west: LON - HALF_KM / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + HALF_KM / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - HALF_KM / 110.574,
  north: LAT + HALF_KM / 110.574,
};

/** Parse the bbox back out of an Overpass query, the way the server would. */
function bboxOf(query: string): BBox {
  const m = /\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/.exec(query);
  if (!m) throw new Error('no bbox in query');
  return {
    south: Number(m[1]),
    west: Number(m[2]),
    north: Number(m[3]),
    east: Number(m[4]),
  };
}

/**
 * A fake Overpass over a fixed grid of long east-west and north-south roads.
 *
 * Each road spans the whole test area, so most of them cross several tiles.
 * Like the real server this returns any way that INTERSECTS the query bbox,
 * with its full geometry — which is what makes deduplication necessary.
 */
function fakeOverpass(spacing_deg = 0.02) {
  const calls: BBox[] = [];
  /** Elements handed out across all tiles, before deduplication. */
  const served = { count: 0 };

  const west = BBOX.west - 0.2;
  const east = BBOX.east + 0.2;
  const south = BBOX.south - 0.2;
  const north = BBOX.north + 0.2;

  const roads: Array<{ id: number; geometry: Array<{ lat: number; lon: number }> }> = [];
  let id = 1;
  for (let lat = south; lat <= north; lat += spacing_deg) {
    roads.push({
      id: id++,
      geometry: [
        { lat, lon: west },
        { lat, lon: east },
      ],
    });
  }
  for (let lon = west; lon <= east; lon += spacing_deg) {
    roads.push({
      id: id++,
      geometry: [
        { lat: south, lon },
        { lat: north, lon },
      ],
    });
  }

  const fetchImpl = async (_url: unknown, init: unknown) => {
    const body = String((init as { body?: unknown }).body ?? '');
    const query = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
    const box = bboxOf(query);
    calls.push(box);

    const hit = roads.filter((r) => {
      const lats = r.geometry.map((g) => g.lat);
      const lons = r.geometry.map((g) => g.lon);
      return (
        Math.min(...lats) <= box.north &&
        Math.max(...lats) >= box.south &&
        Math.min(...lons) <= box.east &&
        Math.max(...lons) >= box.west
      );
    });

    served.count += hit.length;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        elements: hit.map((r) => ({
          type: 'way',
          id: r.id,
          tags: { highway: 'residential' },
          geometry: r.geometry,
        })),
      }),
    } as unknown as Response;
  };

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, roads, served };
}

describe('large selection, end to end', () => {
  it('splits, fetches and merges without duplicating boundary-crossing ways', async () => {
    const server = fakeOverpass();

    const response = await fetchOsm(BBOX, ['roads'], {
      fetchImpl: server.fetchImpl,
      backoffMs: 1,
      tileGapMs: 0,
    });

    // One request per tile, and every request a whole grid cell.
    expect(server.calls).toHaveLength(tileBBox(BBOX).length);
    for (const box of server.calls) expect(bboxArea_km2(box)).toBeLessThanOrEqual(100);

    // Every road appears exactly once despite crossing many tiles.
    const ids = response.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);

    // The tiles really did hand out the same ways repeatedly, so the dedupe
    // above is doing work rather than passing vacuously.
    expect(server.served.count).toBeGreaterThan(response.elements.length * 2);
    expect(response.elements.length).toBeGreaterThan(0);
    expect(response.elements.length).toBeLessThanOrEqual(server.roads.length);
  });

  /**
   * Tiles are grid-aligned and NOT clipped to the selection, so the fetch
   * returns features up to a tile beyond it. Without a clip ring those get
   * built hanging off the side of the terrain.
   */
  it('keeps built geometry inside the selection, not inside the tiles', async () => {
    const server = fakeOverpass(0.05);
    const response = await fetchOsm(BBOX, ['roads'], {
      fetchImpl: server.fetchImpl,
      backoffMs: 1,
      tileGapMs: 0,
    });
    const lines = normalise(response).lines;
    expect(lines.length).toBeGreaterThan(0);

    const hf = makeHeightfield(80, 80, (i, j) => 500 + i + j, 300);
    const scale = scaleFor(hf);
    const clip = bboxRingWorld(BBOX, scale.origin);

    const layers = defaultLayers();
    const build = (selection: typeof clip | null) =>
      buildLineLayer('roads', lines, [], {
        heightfield: hf,
        scale,
        selection,
        nozzleDiameter_mm: 0.4,
        baseThickness_mm: 3,
        layers,
        triangleBudget: 5_000_000,
      });

    const built = build(clip);
    expect(built.part).not.toBeNull();

    // The clip ring in print millimetres, with a tolerance for the ribbon's
    // own half-width spilling over the edge.
    const corners = [
      projectENU(BBOX.west, BBOX.south, scale.origin),
      projectENU(BBOX.east, BBOX.north, scale.origin),
    ];
    const minX = corners[0][0] * scale.scale - 2;
    const maxX = corners[1][0] * scale.scale + 2;
    const minY = corners[0][1] * scale.scale - 2;
    const maxY = corners[1][1] * scale.scale + 2;

    const spill = (positions: Float32Array) => {
      let outside = 0;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        if (x < minX || x > maxX || y < minY || y > maxY) outside++;
      }
      return outside;
    };

    expect(spill(built.part!.positions)).toBe(0);

    // The same build without a clip ring spills well outside — which is what a
    // rectangle selection used to do, once tiles started reaching past it.
    // Without this the assertion above would pass whether or not it is clipped.
    const unclipped = build(null);
    expect(spill(unclipped.part!.positions)).toBeGreaterThan(0);
  });

  it('builds a manifold solid from the merged network', async () => {
    const server = fakeOverpass(0.05);
    const response = await fetchOsm(BBOX, ['roads'], {
      fetchImpl: server.fetchImpl,
      backoffMs: 1,
      tileGapMs: 0,
    });

    const hf = makeHeightfield(80, 80, (i, j) => 500 + i + j, 300);
    const scale = scaleFor(hf);
    const built = buildLineLayer('roads', normalise(response).lines, [], {
      heightfield: hf,
      scale,
      selection: bboxRingWorld(BBOX, scale.origin),
      nozzleDiameter_mm: 0.4,
      baseThickness_mm: 3,
      layers: defaultLayers(),
      triangleBudget: 5_000_000,
    });

    const v = validateMesh(built.part!.positions, built.part!.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });
});
