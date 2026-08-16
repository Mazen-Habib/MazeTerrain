/**
 * Stage 1 output: the sampled elevation grid the mesh is built from.
 *
 * The grid is regular in local ENU metres — not in degrees — so a square
 * selection is square on the print bed at any latitude.
 */
import { sampleBoxLonLat, type Mosaic } from '../data/dem/sampler';
import { metresPerPixel } from '../data/dem/tiles';
import { unprojectENU, type ResolvedGrid } from './coords';

export interface Heightfield {
  cols: number;
  rows: number;
  /** Row-major, row 0 is the southern edge. Metres. */
  data: Float32Array;
  min_m: number;
  max_m: number;
  /** Spacing between samples, metres. */
  spacingX_m: number;
  spacingY_m: number;
}

/**
 * Most DEMs report the sea floor as 0 rather than carrying bathymetry, but some
 * report genuine negatives at coastlines from interpolation noise. Clamping at
 * sea level is the documented default (docs/04-data-sources.md, sampling rules).
 *
 * Caveat worth knowing: this also flattens real below-sea-level land such as the
 * Dead Sea shore or Death Valley. Revisit when bathymetry lands in Phase 4.
 */
const CLAMP_TO_SEA_LEVEL = true;

/** Sample a mosaic into the output grid. */
export function buildHeightfield(mosaic: Mosaic, grid: ResolvedGrid): Heightfield {
  const { cols, rows, extentX_m, extentY_m, origin } = grid;

  // Distribute samples across exactly the requested extent, so the printed model
  // matches the selection rather than the rounded-up grid.
  const spacingX_m = cols > 1 ? extentX_m / (cols - 1) : 0;
  const spacingY_m = rows > 1 ? extentY_m / (rows - 1) : 0;
  const x0_m = -extentX_m / 2;
  const y0_m = -extentY_m / 2;

  const data = new Float32Array(cols * rows);

  // How many source pixels each output cell covers. Above one, we are
  // downsampling and must average rather than point-sample, or single source
  // pixels survive as spikes (docs/08-pitfalls.md#sub-nozzle-terrain-detail).
  const sourceMpp = metresPerPixel(mosaic.z, origin.lat0, mosaic.tileSize);
  const footprintPx = grid.resolution_m / sourceMpp;
  const radiusPx = Math.floor(footprintPx / 2);

  for (let j = 0; j < rows; j++) {
    const y_m = y0_m + j * spacingY_m;
    const rowOffset = j * cols;
    for (let i = 0; i < cols; i++) {
      const x_m = x0_m + i * spacingX_m;
      const [lon, lat] = unprojectENU(x_m, y_m, origin);
      let h = sampleBoxLonLat(mosaic, lon, lat, radiusPx);
      if (CLAMP_TO_SEA_LEVEL && h < 0) h = 0;
      data[rowOffset + i] = h;
    }
  }

  const { min, max } = extremes(data);
  return { cols, rows, data, min_m: min, max_m: max, spacingX_m, spacingY_m };
}

/**
 * Laplacian smoothing, `passes` iterations.
 * Cosmetic only — it flattens genuine features, which is why the default is 0.
 */
export function smoothHeightfield(hf: Heightfield, passes: number, lambda = 0.5): void {
  if (passes <= 0) return;

  const { cols, rows, data } = hf;
  const scratch = new Float32Array(data.length);

  for (let pass = 0; pass < passes; pass++) {
    for (let j = 0; j < rows; j++) {
      const row = j * cols;
      for (let i = 0; i < cols; i++) {
        const idx = row + i;

        let acc = 0;
        let k = 0;
        if (i > 0) {
          acc += data[idx - 1];
          k++;
        }
        if (i < cols - 1) {
          acc += data[idx + 1];
          k++;
        }
        if (j > 0) {
          acc += data[idx - cols];
          k++;
        }
        if (j < rows - 1) {
          acc += data[idx + cols];
          k++;
        }

        scratch[idx] = k > 0 ? data[idx] + lambda * (acc / k - data[idx]) : data[idx];
      }
    }
    data.set(scratch);
  }

  const { min, max } = extremes(data);
  hf.min_m = min;
  hf.max_m = max;
}

/**
 * Min/max by loop.
 * Never `Math.max(...array)` — spread arguments blow the call stack past roughly
 * 100k elements, and this array routinely holds a million
 * (docs/08-pitfalls.md#call-stack-overflow).
 */
export function extremes(data: Float32Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 0;
  }
  return { min, max };
}
