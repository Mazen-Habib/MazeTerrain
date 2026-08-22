/**
 * What the model will contain, drawn on the map before you build it.
 *
 * The highlight is generated from the *same* OSM lines and the *same* planner
 * the mesh builder uses (`planLineLayer`), so the map cannot promise roads the
 * model will not have. That matters more than it sounds: the basemap's own
 * vector tiles look like an obvious free source for this, but OpenMapTiles
 * collapses residential, unclassified and living_street into one `minor` class
 * and ships no `subclass` for them, so a tile-driven highlight would show a
 * different set of streets from the one being printed.
 *
 * Classes the legibility filter will cut are still drawn, faded — seeing that a
 * class is present in the data but will not be built is the whole point.
 */
import type { LineFeature } from '../data/osm/normalise';
import { LAYERS, LAYER_BY_ID, type LayerId } from '../data/osm/tags';
import { resolveScale } from '../geometry/coords';
import { planLineLayer } from '../geometry/features';
import type { GenerateConfig } from '../geometry/types';

export interface PreviewFeatureProperties {
  layer: string;
  subtype: string;
  color: string;
  /** Printed width in millimetres, so the map can show the real hierarchy. */
  width_mm: number;
  /** False when the legibility filter will cut this class. */
  included: boolean;
}

export interface PreviewSummary {
  /** Lines drawn per layer, and how many of them will actually be built. */
  drawn: number;
  included: number;
  /** Subtypes present in the data but cut, per layer. */
  droppedByLayer: Record<string, string[]>;
  suggestedMinWidth_mm: Record<string, number>;
}

export interface FeaturePreview {
  geojson: GeoJSON.FeatureCollection<GeoJSON.LineString, PreviewFeatureProperties>;
  summary: PreviewSummary;
}

const EMPTY: FeaturePreview = {
  geojson: { type: 'FeatureCollection', features: [] },
  summary: { drawn: 0, included: 0, droppedByLayer: {}, suggestedMinWidth_mm: {} },
};

/** Line layers that are switched on, in the order they are drawn. */
export function enabledLineLayers(config: GenerateConfig): LayerId[] {
  return LAYERS.filter((l) => l.kind === 'line' && config.layers[l.id]?.enabled).map((l) => l.id);
}

export function buildFeaturePreview(
  lines: LineFeature[],
  config: GenerateConfig,
): FeaturePreview {
  if (lines.length === 0) return EMPTY;

  // Elevation only drives the vertical exaggeration, which a flat map preview
  // has no use for; the horizontal scale this needs is elevation-independent.
  const scale = resolveScale(config, 0, 0);

  const byLayer = new Map<LayerId, LineFeature[]>();
  for (const line of lines) {
    const list = byLayer.get(line.layer);
    if (list) list.push(line);
    else byLayer.set(line.layer, [line]);
  }

  const features: GeoJSON.Feature<GeoJSON.LineString, PreviewFeatureProperties>[] = [];
  const summary: PreviewSummary = {
    drawn: 0,
    included: 0,
    droppedByLayer: {},
    suggestedMinWidth_mm: {},
  };

  for (const layer of enabledLineLayers(config)) {
    const group = byLayer.get(layer);
    const settings = config.layers[layer];
    if (!group || group.length === 0 || !settings) continue;
    if (LAYER_BY_ID[layer].kind !== 'line') continue;

    const plan = planLineLayer(layer, group, settings, scale, config.nozzleDiameter_mm);
    if (plan.dropped.length > 0) {
      summary.droppedByLayer[layer] = plan.dropped;
      summary.suggestedMinWidth_mm[layer] = plan.suggestedMinWidth_mm;
    }

    for (const feature of group) {
      // Absent from the plan means the subtype is unticked under "Include" —
      // the user has already said they do not want it, so it is not drawn.
      if (!plan.projected.has(feature)) continue;
      if (feature.points.length < 2) continue;

      const included = plan.kept.has(feature.subtype);
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: feature.points as number[][] },
        properties: {
          layer,
          subtype: feature.subtype,
          color: settings.color,
          width_mm: plan.widthBySubtype.get(feature.subtype) ?? plan.minWidth_mm,
          included,
        },
      });
      summary.drawn++;
      if (included) summary.included++;
    }
  }

  return { geojson: { type: 'FeatureCollection', features }, summary };
}
