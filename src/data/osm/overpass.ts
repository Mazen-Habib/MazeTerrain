/**
 * Overpass API client.
 *
 * CLAUDE.md: "Assume every external API will rate-limit you. Every fetch has
 * retry with backoff, a 429 branch with a user-facing message, and a cache."
 * Overpass will absolutely rate-limit you, and its admins block anonymous
 * high-volume clients (docs/04-data-sources.md §2).
 *
 * The endpoint list is the one constant that changes when Phase 3+ swaps to a
 * first-party planet mirror (OPEN-QUESTIONS Q8).
 */
import type { BBox } from '../../geometry/types';
import type { LayerId } from './tags';
import { idbGet, idbPut, OSM_STORE } from '../idb';

/**
 * Public Overpass instances, tried in order.
 *
 * More than two, because two is not redundancy: measured 2026-08-30, both of
 * the original pair were unusable from one machine at the same time.
 *
 * **Every entry must serve the WHOLE PLANET.** `overpass.osm.ch` was added here
 * for exactly one day and taken straight back out: it is the Swiss instance, it
 * answers HTTP 200 with an empty `elements` array for anywhere outside
 * Switzerland, and the app dutifully reported "No roads found in this area" for
 * a Pakistani city with three motorways through it. A regional mirror does not
 * fail — it lies, which is far worse than the outage it was added to fix.
 * See docs/08-pitfalls.md#a-mirror-that-lies-beats-a-mirror-that-fails.
 *
 * These are other people's machines: the sequential fetch and the gap between
 * tiles below are what keep this a polite client on all of them.
 */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * The endpoint that last answered, tried first next time.
 *
 * Without this, every tile starts again at the head of the list and pays the
 * same timeouts on the same dead instance. One tile discovering a working
 * mirror should be enough for the other sixty-two — which is the difference
 * between a build that works and one that gives up.
 *
 * Module-level and deliberately not persisted: which instance is healthy is a
 * fact about the next few minutes, not about the user.
 */
let preferredEndpoint = 0;

const TIMEOUT_S = 60;
/** At least one attempt per endpoint, plus one for a transient failure. */
const MAX_ATTEMPTS = OVERPASS_ENDPOINTS.length + 1;
const BASE_BACKOFF_MS = 1500;

/**
 * How long to wait after an explicit rate-limit response.
 *
 * Separate from the generic backoff, and much longer, because a 429 means
 * something different from a transient failure: the public instance runs a
 * small pool of slots per client and frees them on a timer measured in tens of
 * seconds. Retrying a rate limit after 1.5 s just spends another attempt.
 * Measured: a 12-tile fetch got through 7 tiles before the pool ran dry.
 */
const RATE_LIMIT_BACKOFF_MS = 8000;

/**
 * Area above which one query is split into several.
 *
 * A 458 km2 selection returns nothing as a single request, so large areas have
 * to be split. But splitting is not free in the direction you would expect:
 * the constraint is the NUMBER of requests, not the size of each. Tiling that
 * same selection into 35 small queries got this client connect-refused by
 * overpass-api.de partway through — the public instance stops answering an IP
 * that fires a burst at it, exactly as docs/04-data-sources.md warns.
 *
 * So tiles are as large as a single query can carry, not as small as is safe.
 * Measured on Islamabad: ~98 km2 of roads returns fine (6 392 ways). 100 leaves
 * headroom under that while keeping a 21 km city to single figures of requests.
 * See docs/08-pitfalls.md#tiling-into-a-rate-limit.
 */
const MAX_SINGLE_QUERY_KM2 = 100;

/**
 * Tile size for split queries, in degrees, on a grid aligned to whole
 * multiples of itself.
 *
 * Alignment is the point. Tiles are NOT clipped to the selection, so the same
 * tile serves any selection overlapping it — nudge a 100 km route selection and
 * almost every tile comes from cache instead of the network. The cost is
 * fetching up to one tile-ring beyond the selection edge, which is bounded and
 * cheap next to re-fetching everything.
 *
 * 0.08 degrees is ~8.9 km of latitude everywhere, and at most that much
 * longitude (at the equator), so a tile never exceeds ~79 km2 and shrinks
 * toward the poles. That keeps every sub-query inside the limit above without
 * needing latitude-dependent sizing, and keeps the request count low: the
 * 21.4 km selection that started this goes from 35 requests to 9.
 */
const TILE_DEG = 0.08;

/**
 * Sub-queries in flight at once, and the pause between them.
 *
 * One at a time, with a gap. docs/04-data-sources.md: Overpass admins block
 * high-volume anonymous clients, and this client proved it — two concurrent
 * streams of small tiles earned a connect-refusal from overpass-api.de after
 * roughly 45 requests, which then persisted. Sequential-with-a-gap is slower
 * per selection and is the difference between working and being blocked.
 */
const TILE_CONCURRENCY = 1;
const TILE_GAP_MS = 1500;

/** docs/03-architecture.md caching table: OSM responses for 7 days. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;


export class OverpassError extends Error {
  readonly userMessage: string;
  readonly status: number | undefined;

  constructor(message: string, userMessage: string, status?: number) {
    super(message);
    this.name = 'OverpassError';
    this.userMessage = userMessage;
    this.status = status;
  }
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  /** `out geom` puts coordinates inline, which saves a second pass for node refs. */
  geometry?: Array<{ lat: number; lon: number }>;
  members?: Array<{
    type: string;
    ref: number;
    role: string;
    geometry?: Array<{ lat: number; lon: number }>;
  }>;
  lat?: number;
  lon?: number;
}

export interface OverpassResponse {
  elements: OverpassElement[];
}

/** Which OSM selectors each layer needs. Kept beside the layer ids so they cannot drift. */
const LAYER_SELECTORS: Record<LayerId, string[]> = {
  roads: [
    'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service|pedestrian|track)$"]',
  ],
  trails: ['way["highway"~"^(path|footway|bridleway|cycleway|steps)$"]'],
  railways: [
    'way["railway"~"^(rail|light_rail|subway|tram|monorail|narrow_gauge|funicular)$"]["railway"!~"^(abandoned|disused|razed|proposed|construction)$"]',
  ],
  water: [
    'way["waterway"~"^(river|stream|canal|riverbank)$"]',
    'way["natural"="water"]',
    'relation["natural"="water"]',
    'way["landuse"="reservoir"]',
  ],
  buildings: ['way["building"]', 'relation["building"]', 'way["building:part"]'],
  greenery: [
    'way["leisure"~"^(park|garden|pitch|golf_course)$"]',
    'way["landuse"~"^(forest|grass|meadow|recreation_ground)$"]',
    'way["natural"~"^(wood|grass|meadow)$"]',
    'relation["leisure"~"^(park|golf_course)$"]',
  ],
  sand: ['way["natural"~"^(beach|sand|dune)$"]'],
  aeroways: ['way["aeroway"~"^(runway|taxiway|apron)$"]'],
  piers: ['way["man_made"~"^(pier|breakwater)$"]'],
  skiruns: ['way["piste:type"~"^(downhill|nordic)$"]'],
};

/**
 * One query for every enabled layer, not one per layer.
 *
 * Overpass costs are per request as much as per byte, and a model needs all its
 * layers or none — batching is both faster and a great deal politer.
 */
export function buildQuery(bbox: BBox, layers: LayerId[]): string {
  const box = `${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)}`;
  const selectors = layers.flatMap((id) => LAYER_SELECTORS[id] ?? []);
  if (selectors.length === 0) return '';

  const body = selectors.map((s) => `  ${s}(${box});`).join('\n');
  return `[out:json][timeout:${TIMEOUT_S}];\n(\n${body}\n);\nout body geom;`;
}

/** Rough area of a bbox in square kilometres, good enough to choose a strategy. */
export function bboxArea_km2(bbox: BBox): number {
  const midLat = ((bbox.north + bbox.south) / 2) * (Math.PI / 180);
  const height_km = (bbox.north - bbox.south) * 110.574;
  const width_km = (bbox.east - bbox.west) * 111.32 * Math.cos(midLat);
  return Math.abs(height_km * width_km);
}

/**
 * Cover a bbox with grid-aligned tiles.
 *
 * Every tile is a whole grid cell, never clipped, so two overlapping selections
 * ask for byte-identical sub-queries and the second one is free.
 */
export function tileBBox(bbox: BBox, tileDeg: number = TILE_DEG): BBox[] {
  const snap = (v: number) => Math.floor(v / tileDeg) * tileDeg;
  // Round the grid indices, not the coordinates: repeated floating-point
  // addition of 0.04 drifts enough over a wide bbox to duplicate or skip a row.
  const x0 = Math.round(snap(bbox.west) / tileDeg);
  const y0 = Math.round(snap(bbox.south) / tileDeg);
  const x1 = Math.round(snap(bbox.east) / tileDeg);
  const y1 = Math.round(snap(bbox.north) / tileDeg);

  const tiles: BBox[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      tiles.push({
        west: x * tileDeg,
        south: y * tileDeg,
        east: (x + 1) * tileDeg,
        north: (y + 1) * tileDeg,
      });
    }
  }
  return tiles;
}

/** Cache key: the fetch inputs only, never print parameters. */
export function extractKey(bbox: BBox, layers: LayerId[]): string {
  const box = [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(5)).join(',');
  return `osm:${box}:${[...layers].sort().join('+')}`;
}

interface CachedExtract {
  key: string;
  data: OverpassResponse;
  storedAt: number;
}

async function readCache(key: string): Promise<OverpassResponse | null> {
  const row = await idbGet<CachedExtract>(OSM_STORE, key);
  if (!row) return null;
  if (Date.now() - row.storedAt > TTL_MS) return null;
  return row.data;
}

async function writeCache(key: string, data: OverpassResponse): Promise<void> {
  await idbPut(OSM_STORE, { key, data, storedAt: Date.now() } satisfies CachedExtract);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export interface FetchOsmOptions {
  signal?: AbortSignal;
  onAttempt?: (message: string) => void;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so the suite does not sit through real backoff waits. */
  backoffMs?: number;
  /** Injected in tests so the suite does not sit through the politeness gap. */
  tileGapMs?: number;
  /** Injected in tests so the suite does not sit through a rate-limit wait. */
  rateLimitBackoffMs?: number;
  /**
   * Which instance answered, reported on every success.
   *
   * So an empty result can be traced to a server rather than believed. A
   * regional mirror returns a perfectly valid empty response for most of the
   * world, and without knowing who answered there is no way to tell that from
   * genuinely empty ground.
   */
  onEndpoint?: (hostname: string) => void;
}

/**
 * Fetch one extract, rotating mirrors and backing off.
 *
 * Returns an empty element list rather than throwing when the area genuinely
 * has no matching features — "no data here" is an answer, not a failure.
 */
async function fetchOne(
  bbox: BBox,
  layers: LayerId[],
  options: FetchOsmOptions = {},
): Promise<OverpassResponse> {
  if (layers.length === 0) return { elements: [] };

  const query = buildQuery(bbox, layers);
  if (!query) return { elements: [] };

  const key = extractKey(bbox, layers);
  const cached = await readCache(key);
  if (cached) return cached;

  const doFetch = options.fetchImpl ?? fetch;
  const backoff = options.backoffMs ?? BASE_BACKOFF_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Start at whichever instance last worked, then walk the rest.
    const index = (preferredEndpoint + attempt) % OVERPASS_ENDPOINTS.length;
    const endpoint = OVERPASS_ENDPOINTS[index];
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    try {
      options.onAttempt?.(`Querying OpenStreetMap (${new URL(endpoint).hostname})`);

      const res = await doFetch(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (res.status === 429 || res.status === 504) {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new OverpassError(
            `Overpass returned HTTP ${res.status}`,
            `OpenStreetMap is rate-limiting requests (HTTP ${res.status}). Wait a minute ` +
              `and press Generate again — the areas that already loaded are cached, so it ` +
              `picks up where it stopped rather than starting over.`,
            res.status,
          );
        }
        const rateLimitBackoff = options.rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_MS;
        await sleep(rateLimitBackoff * Math.pow(2, attempt), options.signal);
        continue;
      }

      if (!res.ok) {
        throw new OverpassError(
          `Overpass returned HTTP ${res.status}`,
          `Could not load map features (HTTP ${res.status}). The terrain will still ` +
            `generate — turn the feature layers off to skip this step.`,
          res.status,
        );
      }

      const data = (await res.json()) as OverpassResponse;
      if (!Array.isArray(data.elements)) {
        throw new OverpassError('Overpass response had no elements array', 'Malformed response from OpenStreetMap.');
      }

      preferredEndpoint = index;
      options.onEndpoint?.(new URL(endpoint).hostname);
      void writeCache(key, data);
      return data;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      if (err instanceof OverpassError && err.status !== undefined && attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }
      lastError = err;
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(backoff * Math.pow(2, attempt), options.signal);
      }
    }
  }

  throw new OverpassError(
    `Overpass failed after ${MAX_ATTEMPTS} attempts: ${String(lastError)}`,
    `Could not reach OpenStreetMap after several attempts. The terrain will still ` +
      `generate — turn the feature layers off to skip this step.`,
  );
}


/**
 * Merge tile responses, dropping elements seen more than once.
 *
 * A way crossing a tile boundary is returned in full by every tile it touches —
 * Overpass clips the *selection*, not the geometry — so without dedupe a road
 * along a grid line is built twice, and the ribbon field stamps it twice.
 */
export function mergeResponses(responses: OverpassResponse[]): OverpassResponse {
  const seen = new Set<string>();
  const elements: OverpassElement[] = [];
  for (const response of responses) {
    for (const element of response.elements) {
      const id = `${element.type}:${element.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      elements.push(element);
    }
  }
  return { elements };
}

/** Run tasks with a bounded number in flight, preserving result order. */
async function pooled<T>(
  count: number,
  limit: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      results[index] = await task(index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return results;
}

/**
 * Fetch every OSM feature in a bbox, splitting large areas into tiles.
 *
 * Small selections keep the exact-bbox single query, which is the cheapest
 * thing that works and matches its own cache entry. Past
 * `MAX_SINGLE_QUERY_KM2` the request is split across a fixed grid — a single
 * query at that size does not return at all, so tiling is what makes large
 * selections possible rather than merely faster.
 *
 * A tile that fails after its own retries fails the whole fetch. A road network
 * missing a rectangular chunk looks like a geometry bug, and is worse than an
 * honest "could not load map features" with the terrain still built.
 */
export async function fetchOsm(
  bbox: BBox,
  layers: LayerId[],
  options: FetchOsmOptions = {},
): Promise<OverpassResponse> {
  if (layers.length === 0) return { elements: [] };

  if (bboxArea_km2(bbox) <= MAX_SINGLE_QUERY_KM2) {
    return fetchOne(bbox, layers, options);
  }

  const tiles = tileBBox(bbox);
  let done = 0;

  const responses = await pooled(tiles.length, TILE_CONCURRENCY, async (index) => {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // The inner fetch's own per-attempt message would overwrite the tile count
    // on every retry, so progress is reported here instead.
    const { onAttempt: _perAttempt, ...rest } = options;
    const response = await fetchOne(tiles[index], layers, rest);
    done++;
    options.onAttempt?.(`Map data, area ${done} of ${tiles.length}`);
    // Space the requests out. A burst is what gets an IP refused, and the
    // cache means this cost is paid once per area rather than per build.
    if (done < tiles.length) await sleep(options.tileGapMs ?? TILE_GAP_MS, options.signal);
    return response;
  });

  return mergeResponses(responses);
}
