/**
 * Terrain-RGB tile fetch and decode.
 *
 * CLAUDE.md: "Assume every external API will rate-limit you. Every fetch has
 * retry with backoff, a 429 branch with a user-facing message, and a cache."
 */
import { decodePixels, type DemDataset } from './datasets';
import { readTile, tileKey, writeTile } from './cache';
import type { Mosaic } from './sampler';
import { tileUrl, type TileRange } from './tiles';

/** Cap concurrency at 8 (docs/05-geometry-pipeline.md, Stage 1). */
const MAX_CONCURRENCY = 8;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;

/** Carries a message meant for a human, not a stack trace. */
export class TileFetchError extends Error {
  readonly userMessage: string;
  readonly status: number | undefined;

  constructor(message: string, userMessage: string, status?: number) {
    super(message);
    this.name = 'TileFetchError';
    this.userMessage = userMessage;
    this.status = status;
  }
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

/** Decode an image blob into elevations via OffscreenCanvas. */
async function decodeTile(blob: Blob, dataset: DemDataset): Promise<Float32Array> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2D context available for tile decoding');

    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);

    const out = new Float32Array(width * height);
    decodePixels(data, out, dataset.encoding);
    return out;
  } finally {
    bitmap.close();
  }
}

async function fetchOneTile(
  dataset: DemDataset,
  z: number,
  x: number,
  y: number,
  signal: AbortSignal | undefined,
): Promise<Float32Array> {
  const key = tileKey(dataset.id, z, x, y);

  const cached = await readTile(key);
  if (cached) return cached;

  const url = tileUrl(dataset.urlTemplate, z, x, y);
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    try {
      const res = await fetch(url, signal ? { signal } : {});

      if (res.status === 429 || res.status === 503 || res.status === 504) {
        if (attempt === MAX_RETRIES) {
          throw new TileFetchError(
            `Tile ${z}/${x}/${y} failed with HTTP ${res.status}`,
            `The elevation tile server is rate-limiting requests (HTTP ${res.status}). ` +
              `Wait about a minute and try again, or reduce your selection area.`,
            res.status,
          );
        }
        // Honour Retry-After when the server bothers to send one.
        const retryAfter = Number(res.headers.get('Retry-After'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : BASE_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(wait, signal);
        continue;
      }

      if (res.status === 404 || res.status === 204) {
        // A genuine gap in coverage. Hand back NoData and let the inpainter deal
        // with it rather than failing the whole build.
        return new Float32Array(dataset.tileSize * dataset.tileSize).fill(-32768);
      }

      if (!res.ok) {
        throw new TileFetchError(
          `Tile ${z}/${x}/${y} failed with HTTP ${res.status}`,
          `Could not load elevation data (HTTP ${res.status} from ${dataset.label}). ` +
            `Try a different DEM dataset, or check your connection.`,
          res.status,
        );
      }

      const elevations = await decodeTile(await res.blob(), dataset);
      void writeTile(key, elevations);
      return elevations;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      if (err instanceof TileFetchError && err.status !== undefined) throw err;
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt), signal);
      }
    }
  }

  throw new TileFetchError(
    `Tile ${z}/${x}/${y} failed after ${MAX_RETRIES + 1} attempts: ${String(lastError)}`,
    `Could not load elevation data from ${dataset.label} after several attempts. ` +
      `Check your connection, or try a different DEM dataset.`,
  );
}

/**
 * Fetch every tile in the range and stitch it into one mosaic.
 *
 * The range already carries a one-tile margin so the bilinear sampler has
 * neighbours at the selection edge.
 */
export async function buildMosaic(
  dataset: DemDataset,
  range: TileRange,
  onTile?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Mosaic> {
  const { z, xMin, yMin, nx, ny } = range;
  const ts = dataset.tileSize;

  const width = nx * ts;
  const height = ny * ts;
  const data = new Float32Array(width * height);

  const jobs: Array<{ x: number; y: number }> = [];
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      jobs.push({ x: xMin + tx, y: yMin + ty });
    }
  }

  const total = jobs.length;
  let done = 0;
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];

      const elevations = await fetchOneTile(dataset, z, job.x, job.y, signal);

      // Blit into the mosaic. Row by row, no spreads — a 512px tile is 262 144
      // values and `set(...)` with spread arguments blows the call stack
      // (docs/08-pitfalls.md#call-stack-overflow).
      const offsetX = (job.x - xMin) * ts;
      const offsetY = (job.y - yMin) * ts;
      for (let row = 0; row < ts; row++) {
        data.set(
          elevations.subarray(row * ts, row * ts + ts),
          (offsetY + row) * width + offsetX,
        );
      }

      done++;
      onTile?.(done, total);
    }
  }

  const pool = Array.from({ length: Math.min(MAX_CONCURRENCY, jobs.length) }, worker);
  await Promise.all(pool);

  return {
    data,
    width,
    height,
    z,
    tileSize: ts,
    originPxX: xMin * ts,
    originPxY: yMin * ts,
  };
}
