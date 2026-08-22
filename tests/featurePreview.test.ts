import { describe, expect, it } from 'vitest';
import { buildFeaturePreview, enabledLineLayers } from '../src/map/featurePreview';
import type { LineFeature } from '../src/data/osm/normalise';
import { testConfig } from './helpers';

/** A straight line across the test bbox, roughly 9 km. */
function line(subtype: string, width_m: number, offset: number): LineFeature {
  return {
    layer: 'roads',
    subtype,
    width_m,
    bridge: false,
    layerOrder: 0,
    points: [
      [7.63, 45.95 + offset * 0.00002],
      [7.73, 45.95 + offset * 0.00002],
    ],
  };
}

function many(subtype: string, width_m: number, count: number): LineFeature[] {
  return Array.from({ length: count }, (_, i) => line(subtype, width_m, i));
}

describe('buildFeaturePreview', () => {
  it('draws nothing without features', () => {
    expect(buildFeaturePreview([], testConfig()).geojson.features).toHaveLength(0);
  });

  it('lists only the line layers that are switched on', () => {
    const config = testConfig();
    expect(enabledLineLayers(config)).toContain('roads');
    config.layers.roads = { ...config.layers.roads, enabled: false };
    expect(enabledLineLayers(config)).not.toContain('roads');
  });

  it('carries the printed width, so the map shows the built hierarchy', () => {
    const features = [...many('motorway', 20, 1), ...many('track', 3, 1)];
    const { geojson } = buildFeaturePreview(features, testConfig());

    const width = (subtype: string) =>
      geojson.features.find((f) => f.properties.subtype === subtype)!.properties.width_mm;

    expect(width('motorway')).toBeGreaterThan(width('track'));
    expect(width('track')).toBeCloseTo(0.4, 5); // the floor, one 0.4 mm nozzle
  });

  /**
   * The point of the preview: a class present in the data but cut by the
   * legibility filter is still drawn, flagged, so it is visible that the model
   * will not contain it.
   */
  it('draws classes that will be cut, marked as not included', () => {
    // Enough residential to blow the coverage budget several times over.
    const features = [...many('motorway', 20, 2), ...many('residential', 6, 400)];
    const { geojson, summary } = buildFeaturePreview(features, testConfig());

    expect(summary.droppedByLayer.roads).toContain('residential');
    expect(summary.suggestedMinWidth_mm.roads).toBeGreaterThan(0);

    const residential = geojson.features.filter((f) => f.properties.subtype === 'residential');
    expect(residential.length).toBe(400);
    expect(residential.every((f) => f.properties.included === false)).toBe(true);

    const motorway = geojson.features.filter((f) => f.properties.subtype === 'motorway');
    expect(motorway.every((f) => f.properties.included === true)).toBe(true);

    expect(summary.drawn).toBe(402);
    expect(summary.included).toBe(2);
  });

  it('omits classes the user unticked entirely, rather than drawing them faded', () => {
    const config = testConfig();
    config.layers.roads = { ...config.layers.roads, subtypes: ['motorway'] };
    const features = [...many('motorway', 20, 1), ...many('residential', 6, 5)];

    const { geojson } = buildFeaturePreview(features, config);
    expect(geojson.features).toHaveLength(1);
    expect(geojson.features[0].properties.subtype).toBe('motorway');
  });

  it('reflects the layer colour, so the map matches the model', () => {
    const config = testConfig();
    config.layers.roads = { ...config.layers.roads, color: '#123456' };
    const { geojson } = buildFeaturePreview(many('motorway', 20, 1), config);
    expect(geojson.features[0].properties.color).toBe('#123456');
  });

  /** Lowering the floor is the lever the warning suggests — it must actually work. */
  it('keeps every class once the floor drops to the suggested width', () => {
    const config = testConfig();
    const features = [...many('motorway', 20, 2), ...many('residential', 6, 400)];

    const first = buildFeaturePreview(features, config);
    const suggested = first.summary.suggestedMinWidth_mm.roads;
    expect(suggested).toBeGreaterThan(0);

    config.layers.roads = { ...config.layers.roads, minWidth_mm: suggested };
    const second = buildFeaturePreview(features, config);

    expect(second.summary.droppedByLayer.roads).toBeUndefined();
    expect(second.summary.included).toBe(402);
  });
});
