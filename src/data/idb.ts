/**
 * The one IndexedDB connection.
 *
 * There was briefly more than one: the DEM cache opened `mazeterrain` at
 * version 1 and kept the handle forever, while the OSM cache opened the same
 * database at version 2. The version-2 upgrade then blocked behind the still-open
 * version-1 connection, and every later open — including plain `open(name)` with
 * no version at all — hung. A build would sit on "Fetching elevation tiles"
 * indefinitely, which reads as the app simply not working.
 *
 * One database, one version, one place that declares every store.
 * See docs/08-pitfalls.md#indexeddb-version-deadlock.
 */

/**
 * Still the pre-rename name, on purpose (2026-09-02).
 *
 * Renaming the database orphans every cached DEM and OSM tile — which after
 * the large-selection work is worth real minutes to a user, and costs the
 * public Overpass instance real requests to rebuild. The name is invisible.
 */
const DB_NAME = 'mazeterrain';

/** Bump this, and add the store below. Never open this database anywhere else. */
const DB_VERSION = 2;

export const DEM_STORE = 'dem-tiles';
export const OSM_STORE = 'osm-extracts';

const STORES = [DEM_STORE, OSM_STORE];

/**
 * A cache must never be able to block a build.
 *
 * If the database cannot be opened promptly — a wedged upgrade, a private
 * window, a corrupt profile — we give up and run without a cache rather than
 * leaving the caller waiting on a promise that will never settle.
 */
const OPEN_TIMEOUT_MS = 3000;

let dbPromise: Promise<IDBDatabase | null> | null = null;

export function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };

    const timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS);

    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      clearTimeout(timer);
      finish(null);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      // Another tab wanting a newer version must not be blocked by this handle,
      // which is exactly the deadlock this module exists to prevent.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      finish(db);
    };

    req.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    req.onblocked = () => {
      clearTimeout(timer);
      finish(null);
    };
  });

  return dbPromise;
}

/** Read one row, resolving null on any problem. */
export function idbGet<T>(store: string, key: string): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        let tx: IDBTransaction;
        try {
          tx = db.transaction(store, 'readonly');
        } catch {
          return resolve(null);
        }
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
        req.onerror = () => resolve(null);
      }),
  );
}

/** Write one row. Failures are ignored: a cache miss is always survivable. */
export function idbPut(store: string, value: { key: string } & Record<string, unknown>): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) return resolve();
        let tx: IDBTransaction;
        try {
          tx = db.transaction(store, 'readwrite');
        } catch {
          return resolve();
        }
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      }),
  );
}
