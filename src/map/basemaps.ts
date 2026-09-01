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
import type { StyleSpecification } from 'maplibre-gl';
import { DEM_DATASETS } from '../data/dem/datasets';

export interface Basemap {
  id: string;
  label: string;
  /**
   * A style URL, or a style built here.
   *
   * The OpenFreeMap basemaps are hosted vector styles and are just a URL. The
   * satellite one has no hosted style to point at — it is raster tiles served
   * straight from ArcGIS — so it is assembled below.
   */
  style: string | StyleSpecification;
  /**
   * The layer the hillshade and overlays must be inserted BEFORE, so labels
   * stay readable on top of them.
   *
   * Left unset, `MapView` falls back to the first line or symbol layer, which
   * is right for a vector style and finds nothing at all in a raster one — and
   * a hillshade with no `beforeId` lands on top of everything and renders as a
   * uniform pale wash that looks exactly like a basemap that failed to load.
   */
  labelLayerId?: string;
  /** Shown bottom-right, non-dismissible. Legally required, not decorative. */
  attribution: string;
}

/**
 * Esri World Imagery, as a MapLibre style (OPEN-QUESTIONS Q6).
 *
 * Free **for non-commercial use, with attribution**. That is a promise the
 * project now makes rather than a state it happens to be in — Q2 landed on
 * "free with voluntary contributions" on 2026-09-01, and if that is ever
 * revisited this basemap goes with it. See `docs/04-data-sources.md`.
 *
 * The labels are a second, separate tile set. Imagery on its own is genuinely
 * hard to navigate — without place names there is no way to tell which valley
 * you are looking at — so the reference overlay is not decoration, it is what
 * makes the basemap usable for choosing a selection.
 *
 * ArcGIS REST tile paths are `/tile/{level}/{row}/{col}`, which is z/y/x. The
 * x and y read the wrong way round here on purpose; swapping them to look
 * tidier mirrors the world.
 */
const ARCGIS = 'https://server.arcgisonline.com/ArcGIS/rest/services';

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    'esri-imagery': {
      type: 'raster',
      tiles: [`${ARCGIS}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      // World Imagery is deeper than this in some cities and shallower in
      // others. Capping here means MapLibre upscales the last good tile past
      // z19 rather than requesting tiles that come back as blank squares.
      maxzoom: 19,
      attribution: 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
    'esri-labels': {
      type: 'raster',
      tiles: [`${ARCGIS}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  layers: [
    // Under the imagery, so a tile that has not arrived yet is dark rather
    // than white. White reads as "broken"; dark reads as "loading".
    { id: 'background', type: 'background', paint: { 'background-color': '#0b1016' } },
    { id: 'esri-imagery', type: 'raster', source: 'esri-imagery' },
    { id: 'satellite-labels', type: 'raster', source: 'esri-labels' },
  ],
};

export const BASEMAPS: Basemap[] = [
  {
    id: 'street',
    label: 'Street',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: '© OpenStreetMap contributors · OpenFreeMap',
  },
  {
    id: 'bright',
    label: 'Bright',
    style: 'https://tiles.openfreemap.org/styles/bright',
    attribution: '© OpenStreetMap contributors · OpenFreeMap',
  },
  {
    id: 'light',
    label: 'Light',
    style: 'https://tiles.openfreemap.org/styles/positron',
    attribution: '© OpenStreetMap contributors · OpenFreeMap',
  },
  {
    id: 'satellite',
    label: 'Satellite',
    style: SATELLITE_STYLE,
    labelLayerId: 'satellite-labels',
    // Verbatim from `docs/04-data-sources.md` §6, which lists it as
    // non-negotiable. Do not shorten it to fit the footer.
    attribution:
      'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community · Powered by Esri',
  },
];

/**
 * Satellite landed 2026-09-01, once Q2 resolved to free and unblocked Q6.
 *
 * Topo is still absent, for the unrelated reason that OpenTopoMap asks not to
 * be used as a product tile server.
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
