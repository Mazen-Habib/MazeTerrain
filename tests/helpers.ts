import { resolveScale } from '../src/geometry/coords';
import { extremes, type Heightfield } from '../src/geometry/heightfield';
import type { BBox, GenerateConfig } from '../src/geometry/types';

/** Build a heightfield from a deterministic function, bypassing the network. */
export function makeHeightfield(
  cols: number,
  rows: number,
  fn: (i: number, j: number) => number,
  spacing_m = 100,
): Heightfield {
  const data = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) data[j * cols + i] = fn(i, j);
  }
  const { min, max } = extremes(data);
  return {
    cols,
    rows,
    data,
    min_m: min,
    max_m: max,
    spacingX_m: spacing_m,
    spacingY_m: spacing_m,
  };
}

export function testConfig(overrides: Partial<GenerateConfig> = {}): GenerateConfig {
  const bbox: BBox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };
  return {
    bbox,
    dataset: 'mapterhorn',
    modelWidth_mm: 100,
    baseThickness_mm: 3,
    verticalExaggeration: 1.5,
    maxHeight_mm: 30,
    seaLevelOffset_m: 0,
    resolution_m: 'auto',
    smoothing: 0,
    layerHeight_mm: 0.2,
    ...overrides,
  };
}

/** A ResolvedScale matching a synthetic heightfield's own extent. */
export function scaleFor(hf: Heightfield, overrides: Partial<GenerateConfig> = {}) {
  const extentX_m = (hf.cols - 1) * hf.spacingX_m;
  const extentY_m = (hf.rows - 1) * hf.spacingY_m;
  const config = testConfig({
    resolution_m: hf.spacingX_m,
    ...overrides,
  });
  const s = resolveScale(config, hf.min_m, hf.max_m);
  // Override the geographic-derived extent with the synthetic grid's own, so the
  // scale factor matches the vertices the mesh builder will emit.
  s.extentX_m = extentX_m;
  s.extentY_m = extentY_m;
  s.scale = config.modelWidth_mm / Math.max(extentX_m, extentY_m);

  const relief_m = Math.max(0, hf.max_m - hf.min_m + config.seaLevelOffset_m);
  const requested = config.verticalExaggeration;
  const requestedHeight_mm = relief_m * s.scale * requested;
  s.effectiveExaggeration =
    requestedHeight_mm > config.maxHeight_mm && relief_m > 0
      ? config.maxHeight_mm / (relief_m * s.scale)
      : requested;
  s.exaggerationClamped = s.effectiveExaggeration !== requested;
  s.zScale = s.scale * s.effectiveExaggeration;
  return s;
}

/** Bounding box of an interleaved xyz position buffer. */
export function boundsOf(positions: Float32Array) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i];
    if (positions[i] > maxX) maxX = positions[i];
    if (positions[i + 1] < minY) minY = positions[i + 1];
    if (positions[i + 1] > maxY) maxY = positions[i + 1];
    if (positions[i + 2] < minZ) minZ = positions[i + 2];
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}
