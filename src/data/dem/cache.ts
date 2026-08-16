/**
 * IndexedDB tile cache.
 *
 * docs/08-pitfalls.md#refetch-on-every-tweak: cache the fetched *inputs*, keyed
 * on the fetch inputs alone. A user nudging baseThickness_mm and regenerating
 * ten times must trigger exactly zero network requests after the first build.
 */

const DB_NAME = 'mazeterrain';
const DB_VERSION = 1;
const STORE = 'dem-tiles';

/** docs/03-architecture.md caching table. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CachedTile {
  key: string;
  elevations: Float32Array;
  storedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function available(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase | null> {
  if (!available()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    // A cache miss is always survivable — never fail a build because IndexedDB
    // is unavailable (private browsing, quota, corrupt profile).
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });

  return dbPromise;
}

export function tileKey(dataset: string, z: number, x: number, y: number): string {
  return `dem:${dataset}/${z}/${x}/${y}`;
}

export async function readTile(key: string): Promise<Float32Array | null> {
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
      const row = req.result as CachedTile | undefined;
      if (!row) return resolve(null);
      if (Date.now() - row.storedAt > TTL_MS) return resolve(null);
      resolve(row.elevations);
    };
    req.onerror = () => resolve(null);
  });
}

export async function writeTile(key: string, elevations: Float32Array): Promise<void> {
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
    // Store a copy: the caller's buffer may be transferred to the main thread.
    tx.objectStore(STORE).put({
      key,
      elevations: new Float32Array(elevations),
      storedAt: Date.now(),
    } satisfies CachedTile);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}
