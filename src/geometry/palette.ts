/**
 * Hypsometric tints — colouring terrain by height (docs/02-feature-spec.md F3.3).
 *
 * The convention every physical atlas uses: greens for low ground, browns and
 * greys as it rises, white for the tops. It is not decoration. A single flat
 * colour hides everything the relief is doing until the light happens to catch
 * it, which is exactly what a printed model of a mountain range looked like
 * before this — one tan blob.
 *
 * **Bands, not a gradient**, and that is the whole design. A smooth ramp looks
 * better on screen and is useless to a printer: a colour printer has four or
 * five filaments, not a spectrum. Discrete bands mean what the preview shows is
 * what the printer can actually make, and each band maps to one filament slot.
 * The screen deliberately gives up some prettiness so it stops lying about the
 * object.
 *
 * Bands are positioned on the model's OWN elevation range rather than on
 * absolute metres. A 60 m Dutch polder and a 4 000 m alpine massif both want
 * their tops to read as tops; anchoring snow to a fixed altitude would give the
 * polder no snow and the Himalaya nothing else.
 */

export interface TerrainBand {
  /** What this band is, for the 3MF material name and the legend. */
  name: string;
  /** Hex colour, as everything else in the pipeline uses. */
  color: string;
  /**
   * Top of this band as a fraction of the model's elevation range, 0-1.
   *
   * The last band's is 1 by definition.
   */
  upTo: number;
}

/**
 * Five bands, because five is what a colour printer has.
 *
 * An AMS or MMU carries four filaments; five bands means one is likely to be
 * shared or the top swapped in, which is a better failure than a palette the
 * machine cannot express at all. The spacing is uneven on purpose: the eye
 * reads the top of a mountain far more than the middle, so snow and rock get
 * the narrow bands and the long green middle is one colour.
 */
export const TERRAIN_BANDS: readonly TerrainBand[] = [
  { name: 'Lowland', color: '#4A7C3F', upTo: 0.2 },
  { name: 'Foothill', color: '#6B8E4E', upTo: 0.45 },
  { name: 'Upland', color: '#A08B5F', upTo: 0.68 },
  { name: 'Rock', color: '#8C8377', upTo: 0.86 },
  { name: 'Snow', color: '#F2F2F0', upTo: 1 },
];

/**
 * The single colour a monochrome model is printed in.
 *
 * Green rather than the tan it used to be. A one-colour terrain has no
 * hypsometric tint to carry meaning, so the colour is doing nothing but setting
 * a mood — and a landscape reads as a landscape in green in a way it does not
 * in beige, which reads as a biscuit.
 */
export const SINGLE_COLOR = '#5E8C4A';

/**
 * Which band a height falls in.
 *
 * @param t height as a fraction of the model's own elevation range, 0-1
 */
export function bandIndexFor(t: number): number {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  for (let i = 0; i < TERRAIN_BANDS.length; i++) {
    if (clamped <= TERRAIN_BANDS[i].upTo) return i;
  }
  return TERRAIN_BANDS.length - 1;
}

/** The colour for a height, as a hex string. */
export function bandColorFor(t: number): string {
  return TERRAIN_BANDS[bandIndexFor(t)].color;
}

/**
 * A band index per triangle, for the whole mesh.
 *
 * Per TRIANGLE rather than per vertex, because that is what a 3MF material
 * assignment is and what a slicer can act on. A triangle straddling a boundary
 * is put in the band its highest corner is in: on a mountain that keeps the
 * snowline crisp rather than letting the last row of triangles dilute it.
 *
 * Returns null when there is no range to band — a dead flat model is one
 * colour, and pretending otherwise would paint noise.
 */
export function bandTriangles(
  positions: Float32Array,
  indices: Uint32Array,
  minZ: number,
  maxZ: number,
): Uint8Array | null {
  const span = maxZ - minZ;
  if (!(span > 0) || indices.length === 0) return null;

  const out = new Uint8Array(indices.length / 3);
  for (let t = 0; t < indices.length; t += 3) {
    let highest = -Infinity;
    for (let k = 0; k < 3; k++) {
      const z = positions[indices[t + k] * 3 + 2];
      if (z > highest) highest = z;
    }
    out[t / 3] = bandIndexFor((highest - minZ) / span);
  }
  return out;
}

/** Z range across a position buffer, or null when there is nothing in it. */
export function zRangeOf(positions: Float32Array): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    const z = positions[i];
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}
