/**
 * Bilinear sampling over a tile mosaic, plus NoData repair.
 *
 * CLAUDE.md: "Never sample a DEM with nearest-neighbour. Bilinear minimum."
 * Staircase artifacts are immediately visible on any slope
 * (docs/08-pitfalls.md#staircase-terrain).
 */
import { IMPLAUSIBLE_ELEVATION_M } from './datasets';
import { latToTileY, lonToTileX } from './tiles';

/** A stitched grid of decoded elevation tiles. */
export interface Mosaic {
  /** Row-major elevations in metres, width*height. */
  data: Float32Array;
  width: number;
  height: number;
  z: number;
  tileSize: number;
  /** World-pixel coordinate of mosaic pixel (0,0) at zoom z. */
  originPxX: number;
  originPxY: number;
}

export function isNoData(v: number): boolean {
  return !Number.isFinite(v) || v <= IMPLAUSIBLE_ELEVATION_M;
}

/**
 * Replace NoData runs by diffusing from valid neighbours.
 *
 * Iterative Jacobi relaxation restricted to the invalid cells: each pass sets an
 * invalid cell to the mean of whichever 4-neighbours are already valid, and the
 * valid frontier grows inward one ring per pass. Cheap, stable, and it never
 * touches measured data.
 *
 * Returns the number of cells repaired.
 */
export function inpaintNoData(m: Mosaic, maxPasses = 64): number {
  const { data, width, height } = m;
  const n = data.length;

  const invalid = new Uint8Array(n);
  let remaining = 0;
  for (let i = 0; i < n; i++) {
    if (isNoData(data[i])) {
      invalid[i] = 1;
      remaining++;
    }
  }
  if (remaining === 0) return 0;

  const repaired = remaining;

  // Seed the holes so an all-NoData region still resolves to something finite.
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!invalid[i]) {
      sum += data[i];
      count++;
    }
  }
  const fallback = count > 0 ? sum / count : 0;
  for (let i = 0; i < n; i++) {
    if (invalid[i]) data[i] = fallback;
  }
  if (count === 0) return repaired;

  const settled = Uint8Array.from(invalid, (v) => (v ? 0 : 1));

  for (let pass = 0; pass < maxPasses && remaining > 0; pass++) {
    const next = new Uint8Array(settled);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        if (settled[i]) continue;

        let acc = 0;
        let k = 0;
        if (x > 0 && settled[i - 1]) {
          acc += data[i - 1];
          k++;
        }
        if (x < width - 1 && settled[i + 1]) {
          acc += data[i + 1];
          k++;
        }
        if (y > 0 && settled[i - width]) {
          acc += data[i - width];
          k++;
        }
        if (y < height - 1 && settled[i + width]) {
          acc += data[i + width];
          k++;
        }

        if (k > 0) {
          data[i] = acc / k;
          next[i] = 1;
          remaining--;
        }
      }
    }
    settled.set(next);
  }

  return repaired;
}

/**
 * Bilinear sample at fractional mosaic pixel coordinates.
 * Coordinates are clamped, so sampling outside the mosaic returns the edge value
 * rather than NaN.
 */
export function sampleBilinear(m: Mosaic, px: number, py: number): number {
  const { data, width, height } = m;

  const x = px < 0 ? 0 : px > width - 1 ? width - 1 : px;
  const y = py < 0 ? 0 : py > height - 1 ? height - 1 : py;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < width ? x0 + 1 : width - 1;
  const y1 = y0 + 1 < height ? y0 + 1 : height - 1;

  const fx = x - x0;
  const fy = y - y0;

  const r0 = y0 * width;
  const r1 = y1 * width;

  const h00 = data[r0 + x0];
  const h10 = data[r0 + x1];
  const h01 = data[r1 + x0];
  const h11 = data[r1 + x1];

  return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
}

/** Sample the mosaic at a geographic coordinate. */
export function sampleLonLat(m: Mosaic, lon: number, lat: number): number {
  const px = lonToTileX(lon, m.z) * m.tileSize - m.originPxX;
  const py = latToTileY(lat, m.z) * m.tileSize - m.originPxY;
  return sampleBilinear(m, px, py);
}

/**
 * Area-averaged sample over the output cell's footprint.
 *
 * Bilinear reads the four pixels nearest a point. When the output step is
 * coarser than the source — which is the normal case once the sampling step is
 * floored at one nozzle width — point sampling skips source pixels entirely and
 * whichever ones it happens to land on become spikes and pits. Averaging the
 * footprint is the correct downsample and costs one pass over a small window.
 *
 * Falls back to bilinear when the footprint is a pixel or less, i.e. when we are
 * upsampling and there is nothing to average.
 */
export function sampleBoxLonLat(m: Mosaic, lon: number, lat: number, radiusPx: number): number {
  if (radiusPx < 1) return sampleLonLat(m, lon, lat);

  const px = lonToTileX(lon, m.z) * m.tileSize - m.originPxX;
  const py = latToTileY(lat, m.z) * m.tileSize - m.originPxY;
  const cx = Math.round(px);
  const cy = Math.round(py);

  let acc = 0;
  let n = 0;
  for (let dy = -radiusPx; dy <= radiusPx; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= m.height) continue;
    const row = y * m.width;
    for (let dx = -radiusPx; dx <= radiusPx; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= m.width) continue;
      acc += m.data[row + x];
      n++;
    }
  }

  return n > 0 ? acc / n : sampleLonLat(m, lon, lat);
}
