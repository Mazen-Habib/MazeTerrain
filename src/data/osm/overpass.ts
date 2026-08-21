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

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const TIMEOUT_S = 60;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1500;

/** docs/03-architecture.md caching table: OSM responses for 7 days. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DB_NAME = 'mazeterrain';
const DB_VERSION = 2;
const STORE = 'osm-extracts';

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

/** Cache key: the fetch inputs only, never print parameters. */
export function extractKey(bbox: BBox, layers: LayerId[]): string {
  const box = [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(5)).join(',');
  return `osm:${box}:${[...layers].sort().join('+')}`;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // The DEM store belongs to the same database; do not drop it on upgrade.
      if (!db.objectStoreNames.contains('dem-tiles')) {
        db.createObjectStore('dem-tiles', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });

  return dbPromise;
}

async function readCache(key: string): Promise<OverpassResponse | null> {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readonly');
    } catch {
      resolve(null);
      return;
    }
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      const row = req.result as { data: OverpassResponse; storedAt: number } | undefined;
      if (!row || Date.now() - row.storedAt > TTL_MS) return resolve(null);
      resolve(row.data);
    };
    req.onerror = () => resolve(null);
  });
}

async function writeCache(key: string, data: OverpassResponse): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    tx.objectStore(STORE).put({ key, data, storedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
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
}

/**
 * Fetch an extract, rotating mirrors and backing off.
 *
 * Returns an empty element list rather than throwing when the area genuinely
 * has no matching features — "no data here" is an answer, not a failure.
 */
export async function fetchOsm(
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
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
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
            `OpenStreetMap is rate-limiting requests (HTTP ${res.status}). Wait 30 seconds ` +
              `and try again, or reduce your selection area.`,
            res.status,
          );
        }
        await sleep(backoff * Math.pow(2, attempt), options.signal);
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
