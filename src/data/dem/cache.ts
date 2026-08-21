/**
 * DEM tile cache.
 *
 * docs/08-pitfalls.md#refetch-on-every-tweak: cache the fetched *inputs*, keyed
 * on the fetch inputs alone. A user nudging baseThickness_mm and regenerating
 * ten times must trigger exactly zero network requests after the first build.
 *
 * The connection itself lives in data/idb.ts — see the deadlock note there for
 * why there is exactly one.
 */
import { DEM_STORE, idbGet, idbPut } from '../idb';

/** docs/03-architecture.md caching table. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CachedTile {
  key: string;
  elevations: Float32Array;
  storedAt: number;
}

export function tileKey(dataset: string, z: number, x: number, y: number): string {
  return `dem:${dataset}/${z}/${x}/${y}`;
}

export async function readTile(key: string): Promise<Float32Array | null> {
  const row = await idbGet<CachedTile>(DEM_STORE, key);
  if (!row) return null;
  if (Date.now() - row.storedAt > TTL_MS) return null;
  return row.elevations;
}

export async function writeTile(key: string, elevations: Float32Array): Promise<void> {
  // Store a copy: the caller's buffer may be transferred to the main thread.
  await idbPut(DEM_STORE, {
    key,
    elevations: new Float32Array(elevations),
    storedAt: Date.now(),
  } satisfies CachedTile);
}
