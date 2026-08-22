/**
 * OSM tag -> layer mapping.
 *
 * docs/04-data-sources.md: "Maintain in src/data/osm/tags.ts as explicit tables,
 * not regex scattered through the code." Everything that decides what a way IS
 * lives here, so the non-obvious rules are in one readable place rather than
 * spread across the geometry.
 */

export type LayerId =
  | 'roads'
  | 'trails'
  | 'railways'
  | 'water'
  | 'buildings'
  | 'greenery'
  | 'sand'
  | 'aeroways'
  | 'piers'
  | 'skiruns';

export type LayerKind = 'line' | 'polygon';

export interface LayerDefinition {
  id: LayerId;
  label: string;
  kind: LayerKind;
  /** F4 defaults. */
  enabled: boolean;
  color: string;
  /** Print millimetres above the terrain. Water is handled separately. */
  height_mm: number;
  subtypes: string[];
}

/** docs/02-feature-spec.md F4, with colours from docs/07-ui-spec.md. */
export const LAYERS: LayerDefinition[] = [
  {
    id: 'roads',
    label: 'Roads',
    kind: 'line',
    enabled: true,
    color: '#4A4A4A',
    height_mm: 1.0,
    subtypes: [
      'motorway',
      'trunk',
      'primary',
      'secondary',
      'tertiary',
      'residential',
      'unclassified',
      'living_street',
      'service',
      'pedestrian',
      'track',
    ],
  },
  {
    id: 'trails',
    label: 'Trails / paths',
    kind: 'line',
    enabled: false,
    color: '#8B6F47',
    height_mm: 0.6,
    subtypes: ['path', 'footway', 'bridleway', 'cycleway', 'steps'],
  },
  {
    id: 'railways',
    label: 'Railways',
    kind: 'line',
    enabled: false,
    color: '#6B6B6B',
    height_mm: 1.0,
    subtypes: ['rail', 'light_rail', 'subway', 'tram', 'monorail', 'narrow_gauge', 'funicular'],
  },
  {
    id: 'water',
    label: 'Water',
    kind: 'polygon',
    enabled: true,
    color: '#3B7EA1',
    height_mm: 0.4,
    subtypes: ['river', 'stream', 'canal', 'lake', 'reservoir', 'pond', 'riverbank'],
  },
  {
    id: 'buildings',
    label: 'Buildings',
    kind: 'polygon',
    enabled: false,
    color: '#D9D2C5',
    height_mm: 0,
    subtypes: ['residential', 'commercial', 'industrial', 'retail', 'civic', 'religious', 'other'],
  },
  {
    id: 'greenery',
    label: 'Greenery / parks',
    kind: 'polygon',
    enabled: false,
    color: '#6E8B58',
    height_mm: 0.4,
    subtypes: ['park', 'forest', 'wood', 'grass', 'meadow', 'garden', 'pitch', 'golf_course'],
  },
  {
    id: 'sand',
    label: 'Sand / beach',
    kind: 'polygon',
    enabled: false,
    color: '#D6C08A',
    height_mm: 0.3,
    subtypes: ['beach', 'sand', 'dune'],
  },
  {
    id: 'aeroways',
    label: 'Aeroways',
    kind: 'line',
    enabled: false,
    color: '#5A5F6B',
    height_mm: 0.8,
    subtypes: ['runway', 'taxiway', 'apron'],
  },
  {
    id: 'piers',
    label: 'Piers',
    kind: 'line',
    enabled: false,
    color: '#7A6A55',
    height_mm: 1.0,
    subtypes: ['pier', 'breakwater'],
  },
  {
    id: 'skiruns',
    label: 'Ski runs',
    kind: 'line',
    enabled: false,
    color: '#C8D6E5',
    height_mm: 0.6,
    subtypes: ['downhill', 'nordic'],
  },
];

export const LAYER_BY_ID: Record<LayerId, LayerDefinition> = Object.fromEntries(
  LAYERS.map((l) => [l.id, l]),
) as Record<LayerId, LayerDefinition>;

/**
 * World widths per road class, in metres, BEFORE any scaling.
 *
 * docs/04-data-sources.md: derive from the highway class, not the `width` tag,
 * which is sparsely mapped and wildly inconsistent where it exists.
 */
export const ROAD_WIDTH_M: Record<string, number> = {
  motorway: 20,
  trunk: 16,
  primary: 12,
  secondary: 10,
  tertiary: 8,
  residential: 6,
  unclassified: 6,
  living_street: 5,
  service: 4,
  pedestrian: 4,
  track: 3,
  path: 2,
  footway: 2,
  cycleway: 2,
  bridleway: 2,
  steps: 2,
};

export const RAIL_WIDTH_M = 5;
export const AEROWAY_WIDTH_M: Record<string, number> = { runway: 45, taxiway: 20, apron: 40 };
export const PIER_WIDTH_M = 4;
export const SKI_WIDTH_M = 20;

/** Railway lifecycle states that are not track any more. */
const DEAD_RAILWAYS = new Set(['abandoned', 'disused', 'razed', 'proposed', 'construction']);

/** docs/04: building height cascade — `height` -> `building:levels` x 3 m -> 6 m. */
export const METRES_PER_LEVEL = 3.0;
export const DEFAULT_BUILDING_HEIGHT_M = 6;

export interface Classification {
  layer: LayerId;
  subtype: string;
  /** Bridges get a flat deck rather than a draped one. */
  bridge: boolean;
  /** Real-world width for line features, metres. Undefined for polygons. */
  width_m?: number;
}

export type Tags = Record<string, string>;

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== 'no' && value !== 'false' && value !== '0';
}

/**
 * Decide what a tagged way is, or that it is nothing we print.
 *
 * Returns null for anything skipped. The most important skip is `tunnel`: a
 * printed tunnel is a road embedded inside a mountain, which reads as an
 * artefact rather than a road (docs/04-data-sources.md).
 */
/**
 * The real-world width `classify` assigns to a class, without needing a feature.
 *
 * The Layers panel needs each class's width to show what it will print at
 * before any OSM data has been fetched. Kept next to `classify` so the two
 * cannot drift: every branch below mirrors one there.
 */
export function defaultWidth_m(layer: LayerId, subtype: string): number {
  switch (layer) {
    case 'roads':
      return ROAD_WIDTH_M[subtype] ?? 6;
    case 'trails':
      return ROAD_WIDTH_M[subtype] ?? 2;
    case 'railways':
      return RAIL_WIDTH_M;
    case 'aeroways':
      return AEROWAY_WIDTH_M[subtype] ?? 20;
    case 'piers':
      return PIER_WIDTH_M;
    case 'skiruns':
      return SKI_WIDTH_M;
    case 'water':
      return subtype === 'river' ? 20 : subtype === 'canal' ? 12 : 5;
    default:
      return 6;
  }
}

export function classify(tags: Tags): Classification | null {
  if (truthy(tags['tunnel'])) return null;
  if (tags['location'] === 'underground') return null;

  const bridge = truthy(tags['bridge']);

  const highway = tags['highway'];
  if (highway) {
    if (LAYER_BY_ID.roads.subtypes.includes(highway)) {
      return { layer: 'roads', subtype: highway, bridge, width_m: ROAD_WIDTH_M[highway] ?? 6 };
    }
    if (LAYER_BY_ID.trails.subtypes.includes(highway)) {
      return { layer: 'trails', subtype: highway, bridge, width_m: ROAD_WIDTH_M[highway] ?? 2 };
    }
    return null;
  }

  const railway = tags['railway'];
  if (railway) {
    if (DEAD_RAILWAYS.has(railway)) return null;
    // A lifecycle prefix means the track is gone even if the value looks live.
    for (const state of DEAD_RAILWAYS) if (tags[state] !== undefined) return null;
    if (LAYER_BY_ID.railways.subtypes.includes(railway)) {
      return { layer: 'railways', subtype: railway, bridge, width_m: RAIL_WIDTH_M };
    }
    return null;
  }

  const aeroway = tags['aeroway'];
  if (aeroway && LAYER_BY_ID.aeroways.subtypes.includes(aeroway)) {
    return { layer: 'aeroways', subtype: aeroway, bridge, width_m: AEROWAY_WIDTH_M[aeroway] ?? 20 };
  }

  const manMade = tags['man_made'];
  if (manMade && LAYER_BY_ID.piers.subtypes.includes(manMade)) {
    return { layer: 'piers', subtype: manMade, bridge, width_m: PIER_WIDTH_M };
  }

  if (tags['piste:type'] && LAYER_BY_ID.skiruns.subtypes.includes(tags['piste:type'])) {
    return { layer: 'skiruns', subtype: tags['piste:type'], bridge, width_m: SKI_WIDTH_M };
  }

  // --- polygons ------------------------------------------------------------
  const waterway = tags['waterway'];
  if (waterway && ['river', 'stream', 'canal', 'riverbank'].includes(waterway)) {
    // Waterway ways are centrelines; riverbank is already an area.
    return waterway === 'riverbank'
      ? { layer: 'water', subtype: waterway, bridge }
      : {
          layer: 'water',
          subtype: waterway,
          bridge,
          width_m: waterway === 'river' ? 20 : waterway === 'canal' ? 12 : 5,
        };
  }
  if (tags['natural'] === 'water' || tags['landuse'] === 'reservoir') {
    const kind = tags['water'] ?? (tags['landuse'] === 'reservoir' ? 'reservoir' : 'lake');
    return {
      layer: 'water',
      subtype: LAYER_BY_ID.water.subtypes.includes(kind) ? kind : 'lake',
      bridge,
    };
  }

  if (tags['building'] !== undefined || tags['building:part'] !== undefined) {
    return { layer: 'buildings', subtype: buildingSubtype(tags), bridge };
  }

  const leisure = tags['leisure'];
  if (leisure && LAYER_BY_ID.greenery.subtypes.includes(leisure)) {
    return { layer: 'greenery', subtype: leisure, bridge };
  }
  const landuse = tags['landuse'];
  if (landuse && LAYER_BY_ID.greenery.subtypes.includes(landuse)) {
    return { layer: 'greenery', subtype: landuse, bridge };
  }
  const natural = tags['natural'];
  if (natural && LAYER_BY_ID.greenery.subtypes.includes(natural)) {
    return { layer: 'greenery', subtype: natural, bridge };
  }
  if (natural && LAYER_BY_ID.sand.subtypes.includes(natural)) {
    return { layer: 'sand', subtype: natural, bridge };
  }

  return null;
}

const BUILDING_GROUPS: Record<string, string> = {
  house: 'residential',
  apartments: 'residential',
  residential: 'residential',
  detached: 'residential',
  terrace: 'residential',
  dormitory: 'residential',
  commercial: 'commercial',
  office: 'commercial',
  hotel: 'commercial',
  industrial: 'industrial',
  warehouse: 'industrial',
  factory: 'industrial',
  retail: 'retail',
  supermarket: 'retail',
  shop: 'retail',
  civic: 'civic',
  school: 'civic',
  university: 'civic',
  hospital: 'civic',
  government: 'civic',
  church: 'religious',
  mosque: 'religious',
  temple: 'religious',
  synagogue: 'religious',
  cathedral: 'religious',
};

export function buildingSubtype(tags: Tags): string {
  const value = tags['building'] ?? tags['building:part'] ?? 'yes';
  return BUILDING_GROUPS[value] ?? 'other';
}

/**
 * Building height in metres, via the documented cascade.
 * Never returns zero: an unprintable flat footprint is worse than an estimate.
 */
export function buildingHeight_m(tags: Tags): number {
  const explicit = parseLength(tags['height']);
  if (explicit !== null && explicit > 0) return explicit;

  const levels = Number.parseFloat(tags['building:levels'] ?? '');
  if (Number.isFinite(levels) && levels > 0) return levels * METRES_PER_LEVEL;

  return DEFAULT_BUILDING_HEIGHT_M;
}

/**
 * Height at which a building part starts, metres.
 *
 * A part with `min_height` floats unless something fills the space beneath it
 * (docs/08-pitfalls.md#floating-parts). We return it so the builder can extrude
 * down to the ground instead.
 */
export function buildingMinHeight_m(tags: Tags): number {
  const min = parseLength(tags['min_height'] ?? tags['building:min_level']);
  return min !== null && min > 0 ? min : 0;
}

/** OSM lengths are usually bare metres but may carry units. */
export function parseLength(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();

  const feetInches = /^(\d+(?:\.\d+)?)'\s*(?:(\d+(?:\.\d+)?)")?$/.exec(trimmed);
  if (feetInches) {
    const feet = Number.parseFloat(feetInches[1]);
    const inches = feetInches[2] ? Number.parseFloat(feetInches[2]) : 0;
    return (feet * 12 + inches) * 0.0254;
  }

  const withUnit = /^(-?\d+(?:\.\d+)?)\s*(m|km|ft|mi)?$/i.exec(trimmed);
  if (!withUnit) return null;

  const n = Number.parseFloat(withUnit[1]);
  if (!Number.isFinite(n)) return null;

  switch ((withUnit[2] ?? 'm').toLowerCase()) {
    case 'km':
      return n * 1000;
    case 'ft':
      return n * 0.3048;
    case 'mi':
      return n * 1609.344;
    default:
      return n;
  }
}

/** `layer` is for z-ordering of overlapping ways, never an absolute height. */
export function layerOrder(tags: Tags): number {
  const n = Number.parseInt(tags['layer'] ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}
