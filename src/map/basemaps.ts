/**
 * Map data endpoints.
 *
 * docs/03-architecture.md: "Design the data layer with a single DATA_ENDPOINTS
 * config constant so that flipping from public Overpass to a first-party mirror
 * is a one-line change." This is that constant for the map side.
 *
 * Basemaps are OpenFreeMap: keyless, vector, and explicitly intended for
 * production use. `tile.openstreetmap.org` is deliberately absent — it is not a
 * CDN for products, and treating it as one gets your IP blocked
 * (docs/08-pitfalls.md#tile-server-abuse).
 */
import { DEM_DATASETS } from '../data/dem/datasets';

export interface Basemap {
  id: string;
  label: string;
  styleUrl: string;
  /** Shown bottom-right, non-dismissible. Legally required, not decorative. */
  attribution: string;
}

export const BASEMAPS: Basemap[] = [
  {
    id: 'street',
    label: 'Street',
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: '© OpenStreetMap contributors · OpenFreeMap',
  },
  {
    id: 'bright',
    label: 'Bright',
    styleUrl: 'https://tiles.openfreemap.org/styles/bright',
    attribution: '© OpenStreetMap contributors · OpenFreeMap',
  },
  {
    id: 'light',
    label: 'Light',
    styleUrl: 'https://tiles.openfreemap.org/styles/positron',
    attribution: '© OpenStreetMap contributors · OpenFreeMap',
  },
];

/**
 * Satellite is missing on purpose. Esri World Imagery is free for
 * non-commercial use with attribution, and OPEN-QUESTIONS **Q6** cannot be
 * answered until **Q2** (free vs paid) is. Adding it now would bake a licensing
 * assumption into the product. Topo is absent for the related reason that
 * OpenTopoMap asks not to be used as a product tile server.
 */
export const DEFAULT_BASEMAP = 'street';

/**
 * The live hillshade on the map reads from the SAME terrain tiles the mesh is
 * sampled from, so the relief on screen is the relief that gets printed
 * (docs/04-data-sources.md §1).
 */
export function demSource(datasetId: string) {
  const dataset = DEM_DATASETS[datasetId] ?? DEM_DATASETS['mapterhorn'];
  return {
    type: 'raster-dem' as const,
    tiles: [dataset.urlTemplate],
    tileSize: dataset.tileSize,
    encoding: dataset.encoding,
    maxzoom: dataset.maxZoom,
    attribution: dataset.attribution,
  };
}
