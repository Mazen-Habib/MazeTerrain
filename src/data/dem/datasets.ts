/**
 * DEM dataset registry (docs/04-data-sources.md §1).
 *
 * The dataset is a config value with a per-dataset decode function, so adding a
 * source is a table entry rather than a code change. The active dataset name is
 * surfaced in the model stats — users ask, and showing it is a trust signal.
 */

export type DemEncoding = 'terrarium' | 'mapbox';

export interface DemDataset {
  id: string;
  label: string;
  urlTemplate: string;
  tileSize: number;
  maxZoom: number;
  encoding: DemEncoding;
  /** Legally required, not decorative (docs/04 §6). */
  attribution: string;
}

export const DEM_DATASETS: Record<string, DemDataset> = {
  mapterhorn: {
    id: 'mapterhorn',
    label: 'Mapterhorn (Copernicus GLO-30 + national high-res)',
    urlTemplate: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
    tileSize: 512,
    maxZoom: 14,
    encoding: 'terrarium',
    attribution:
      'Contains modified Copernicus DEM data © DLR e.V. 2010-2014 / © Airbus DS 2014-2018; tiles by Mapterhorn',
  },
  'aws-terrarium': {
    id: 'aws-terrarium',
    label: 'AWS Terrain Tiles (Tilezen / Joerd)',
    urlTemplate: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    tileSize: 256,
    maxZoom: 13,
    encoding: 'terrarium',
    attribution: 'Elevation tiles by Tilezen / Joerd; sources include SRTM, GMTED2010, Copernicus',
  },
};

export const DEFAULT_DATASET = 'mapterhorn';

export function getDataset(id: string): DemDataset {
  const d = DEM_DATASETS[id];
  if (!d) throw new Error(`Unknown DEM dataset: ${id}`);
  return d;
}

/**
 * The value a terrarium tile carries where there is no measurement: R=G=B=0
 * decodes to exactly -32768. Never let it reach the mesh — it prints as a
 * bottomless pit at tile seams. See docs/08-pitfalls.md#dem-nodata-spikes.
 */
export const TERRARIUM_NODATA = -32768;

/** Anything below this is a sentinel, not terrain. Marianas Trench is -10 994 m. */
export const IMPLAUSIBLE_ELEVATION_M = -12000;

/** Decode one RGBA pixel run into elevations, writing into `out`. */
export function decodePixels(
  rgba: Uint8ClampedArray,
  out: Float32Array,
  encoding: DemEncoding,
): void {
  const n = out.length;
  if (encoding === 'terrarium') {
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      out[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      out[i] = -10000 + (rgba[p] * 65536 + rgba[p + 1] * 256 + rgba[p + 2]) * 0.1;
    }
  }
}
