/**
 * Overpass JSON -> typed feature collections.
 *
 * docs/05-geometry-pipeline.md Stage 2: "Normalise raw OSM into typed
 * collections with layer + subtype + derived width/height already resolved."
 * The geometry never sees a tag.
 */
import type { LonLat } from '../../map/draw';
import type { OverpassElement, OverpassResponse } from './overpass';
import {
  buildingHeight_m,
  buildingMinHeight_m,
  classify,
  layerOrder,
  type LayerId,
  type Tags,
} from './tags';

export interface LineFeature {
  layer: LayerId;
  subtype: string;
  /** Real-world width before any user scaling, metres. */
  width_m: number;
  bridge: boolean;
  layerOrder: number;
  points: LonLat[];
}

export interface PolygonFeature {
  layer: LayerId;
  subtype: string;
  bridge: boolean;
  layerOrder: number;
  /** Outer ring first, holes after — islands in lakes and courtyards are real. */
  rings: LonLat[][];
  /** Buildings only. */
  height_m?: number;
  minHeight_m?: number;
}

export interface OsmFeatures {
  lines: LineFeature[];
  polygons: PolygonFeature[];
  /** Ways skipped because they are tunnels or dead railways. */
  skipped: number;
  counts: Partial<Record<LayerId, number>>;
}

const CLOSED_EPSILON = 1e-9;

function toPoints(geometry: Array<{ lat: number; lon: number }> | undefined): LonLat[] {
  if (!geometry) return [];
  const out: LonLat[] = [];
  for (const p of geometry) {
    if (Number.isFinite(p.lon) && Number.isFinite(p.lat)) out.push([p.lon, p.lat]);
  }
  return out;
}

export function isClosed(points: LonLat[]): boolean {
  if (points.length < 4) return false;
  const a = points[0];
  const b = points[points.length - 1];
  return Math.abs(a[0] - b[0]) < CLOSED_EPSILON && Math.abs(a[1] - b[1]) < CLOSED_EPSILON;
}

/** Strip the repeated closing vertex; the geometry layer works with open rings. */
function openRing(points: LonLat[]): LonLat[] {
  return isClosed(points) ? points.slice(0, -1) : points;
}

/**
 * Stitch a multipolygon relation's member ways into rings.
 *
 * Members arrive as unordered fragments that share endpoints, so they have to be
 * chained. Getting this wrong loses every lake with an island and every building
 * with a courtyard (docs/10-glossary.md, Multipolygon).
 */
export function assembleRings(
  members: NonNullable<OverpassElement['members']>,
  role: 'outer' | 'inner',
): LonLat[][] {
  const fragments = members
    .filter((m) => m.type === 'way' && (m.role === role || (role === 'outer' && m.role === '')))
    .map((m) => toPoints(m.geometry))
    .filter((p) => p.length >= 2);

  const rings: LonLat[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < fragments.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const ring = [...fragments[i]];

    let extended = true;
    while (extended && !isClosed(ring)) {
      extended = false;
      const tail = ring[ring.length - 1];

      for (let j = 0; j < fragments.length; j++) {
        if (used.has(j)) continue;
        const candidate = fragments[j];
        const head = candidate[0];
        const last = candidate[candidate.length - 1];

        if (Math.hypot(head[0] - tail[0], head[1] - tail[1]) < CLOSED_EPSILON) {
          ring.push(...candidate.slice(1));
        } else if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) < CLOSED_EPSILON) {
          for (let k = candidate.length - 2; k >= 0; k--) ring.push(candidate[k]);
        } else {
          continue;
        }

        used.add(j);
        extended = true;
        break;
      }
    }

    const open = openRing(ring);
    if (open.length >= 3) rings.push(open);
  }

  return rings;
}

/**
 * Normalise a raw Overpass response.
 *
 * A way that is tagged as an area and is geometrically closed becomes a polygon;
 * everything else with a width becomes a line. Waterway centrelines stay lines
 * so they can be given a printable width — a river drawn as a zero-width line is
 * not a river.
 */
export function normalise(response: OverpassResponse): OsmFeatures {
  const lines: LineFeature[] = [];
  const polygons: PolygonFeature[] = [];
  const counts: Partial<Record<LayerId, number>> = {};
  let skipped = 0;

  const bump = (layer: LayerId) => {
    counts[layer] = (counts[layer] ?? 0) + 1;
  };

  for (const element of response.elements) {
    const tags = (element.tags ?? {}) as Tags;
    if (Object.keys(tags).length === 0) continue;

    const kind = classify(tags);
    if (!kind) {
      skipped++;
      continue;
    }

    const order = layerOrder(tags);

    if (element.type === 'relation') {
      if (!element.members) continue;
      const outers = assembleRings(element.members, 'outer');
      const inners = assembleRings(element.members, 'inner');
      if (outers.length === 0) continue;

      for (const outer of outers) {
        const feature: PolygonFeature = {
          layer: kind.layer,
          subtype: kind.subtype,
          bridge: kind.bridge,
          layerOrder: order,
          rings: [outer, ...inners],
        };
        if (kind.layer === 'buildings') {
          feature.height_m = buildingHeight_m(tags);
          feature.minHeight_m = buildingMinHeight_m(tags);
        }
        polygons.push(feature);
        bump(kind.layer);
      }
      continue;
    }

    if (element.type !== 'way') continue;
    const points = toPoints(element.geometry);
    if (points.length < 2) continue;

    // A closed way with no width is an area; a closed way WITH a width is still a
    // line, because a ring road is a road rather than a disc.
    if (kind.width_m === undefined && isClosed(points)) {
      const feature: PolygonFeature = {
        layer: kind.layer,
        subtype: kind.subtype,
        bridge: kind.bridge,
        layerOrder: order,
        rings: [openRing(points)],
      };
      if (kind.layer === 'buildings') {
        feature.height_m = buildingHeight_m(tags);
        feature.minHeight_m = buildingMinHeight_m(tags);
      }
      polygons.push(feature);
      bump(kind.layer);
      continue;
    }

    if (kind.width_m === undefined) {
      // An area tag on an unclosed way is broken data, not geometry we can use.
      skipped++;
      continue;
    }

    lines.push({
      layer: kind.layer,
      subtype: kind.subtype,
      width_m: kind.width_m,
      bridge: kind.bridge,
      layerOrder: order,
      points,
    });
    bump(kind.layer);
  }

  return { lines, polygons, skipped, counts };
}
