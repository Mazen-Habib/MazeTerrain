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

  /** Enough residential to blow the coverage budget several times over. */
  const blanketing = () => [...many('motorway', 20, 2), ...many('residential', 6, 400)];

  /**
   * The default: crowded classes are flagged, not removed. The map shows them
   * as they will be built, so the crowding is visible before generating rather
   * than after.
   */
  it('flags crowded classes but still marks them as included', () => {
    // An explicit floor, because 'auto' now lowers itself until the layer fits
    // and so never crowds — that is the subject of its own test below.
    const config = testConfig();
    config.layers.roads = { ...config.layers.roads, minWidth_mm: 0.4 };
    const { geojson, summary } = buildFeaturePreview(blanketing(), config);

    expect(summary.crowdedByLayer.roads).toContain('residential');
    expect(summary.coverageByLayer.roads).toBeGreaterThan(0.25);
    expect(summary.suggestedMinWidth_mm.roads).toBeGreaterThan(0);

    expect(summary.droppedByLayer.roads).toBeUndefined();
    expect(summary.drawn).toBe(402);
    expect(summary.included).toBe(402);

    const residential = geojson.features.filter((f) => f.properties.subtype === 'residential');
    expect(residential.every((f) => f.properties.included && f.properties.crowded)).toBe(true);

    const motorway = geojson.features.filter((f) => f.properties.subtype === 'motorway');
    expect(motorway.every((f) => f.properties.crowded === false)).toBe(true);
  });

  it('marks classes as not included once the filter is set to enforce', () => {
    const config = testConfig();
    config.layers.roads = {
      ...config.layers.roads,
      legibilityFilter: true,
      minWidth_mm: 0.4,
    };
    const { geojson, summary } = buildFeaturePreview(blanketing(), config);

    expect(summary.droppedByLayer.roads).toContain('residential');
    expect(summary.included).toBe(2);
    expect(summary.drawn).toBe(402);

    const residential = geojson.features.filter((f) => f.properties.subtype === 'residential');
    expect(residential.every((f) => f.properties.included === false)).toBe(true);
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
  it('stops crowding once the floor drops to the suggested width', () => {
    const config = testConfig();
    config.layers.roads = { ...config.layers.roads, minWidth_mm: 0.4 };
    const features = blanketing();

    const first = buildFeaturePreview(features, config);
    const suggested = first.summary.suggestedMinWidth_mm.roads;
    expect(suggested).toBeGreaterThan(0);

    config.layers.roads = { ...config.layers.roads, minWidth_mm: suggested };
    const second = buildFeaturePreview(features, config);

    expect(second.summary.crowdedByLayer.roads).toBeUndefined();
    expect(second.summary.coverageByLayer.roads).toBeLessThanOrEqual(0.25);
    expect(second.summary.included).toBe(402);
  });
});

/**
 * "Auto" min width.
 *
 * A fixed floor cannot be right at every scale. One nozzle is exactly right on
 * a neighbourhood; on a city it buries the model — 1 237 km of Islamabad road
 * at a 0.4 mm floor covers 80.6% of a 9.3 km model. Auto starts at the nozzle
 * and comes down until the layer fits, so the same default works at both ends.
 */
describe('auto min width adapts to the scale', () => {
  /** Enough residential to bury the model at a fixed floor. */
  const blanketing = () => [...many('motorway', 20, 2), ...many('residential', 6, 400)];

  it('leaves a sparse model at one nozzle', () => {
    const config = testConfig();
    const sparse = many('motorway', 20, 2);
    const { summary } = buildFeaturePreview(sparse, config);
    // Nothing crowded, so nothing to reduce.
    expect(summary.crowdedByLayer.roads).toBeUndefined();
    expect(summary.widthByLayer.roads.motorway).toBeGreaterThanOrEqual(
      config.nozzleDiameter_mm - 1e-9,
    );
  });

  it('comes down on a model a fixed floor would bury', () => {
    const dense = blanketing();
    const auto = buildFeaturePreview(dense, testConfig());

    const fixed = testConfig();
    fixed.layers.roads = { ...fixed.layers.roads, minWidth_mm: 0.4 };
    const pinned = buildFeaturePreview(dense, fixed);

    expect(auto.summary.coverageByLayer.roads).toBeLessThan(
      pinned.summary.coverageByLayer.roads,
    );
    expect(auto.summary.widthByLayer.roads.residential).toBeLessThan(
      pinned.summary.widthByLayer.roads.residential,
    );
    // ...and the point of coming down: the model reads as a map again.
    expect(auto.summary.coverageByLayer.roads).toBeLessThanOrEqual(0.26);
  });

  it('still lets an explicit width win, however crowded', () => {
    const config = testConfig();
    config.layers.roads = { ...config.layers.roads, minWidth_mm: 0.8 };
    const { summary } = buildFeaturePreview(blanketing(), config);
    expect(summary.widthByLayer.roads.residential).toBeGreaterThanOrEqual(0.8 - 1e-9);
  });
});
