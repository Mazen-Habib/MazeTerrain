// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  boundsOfPoints,
  elevationGain,
  GpxParseError,
  haversine,
  parseGpxText,
  routeDistance,
  unionBBox,
} from '../src/data/gpx/parse';
import { smoothPolyline, type Pt } from '../src/data/gpx/simplify';

const TRACK = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin Connect" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Margalla Trail 5</name>
    <trkseg>
      <trkpt lat="33.7400" lon="73.0500"><ele>600</ele><time>2026-08-17T06:00:00Z</time></trkpt>
      <trkpt lat="33.7410" lon="73.0510"><ele>640</ele><time>2026-08-17T06:01:00Z</time></trkpt>
      <trkpt lat="33.7420" lon="73.0520"><ele>620</ele><time>2026-08-17T06:02:00Z</time></trkpt>
      <trkpt lat="33.7430" lon="73.0530"><ele>700</ele><time>2026-08-17T06:03:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const ROUTE_ONLY = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <rte>
    <name>Planned loop</name>
    <rtept lat="45.0" lon="7.0"/>
    <rtept lat="45.01" lon="7.01"/>
    <rtept lat="45.02" lon="7.0"/>
  </rte>
</gpx>`;

const NO_ELEVATION = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="45.0" lon="7.0"/>
    <trkpt lat="45.01" lon="7.01"/>
  </trkseg></trk>
</gpx>`;

const TWO_SEGMENTS = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Day one</name><trkseg>
    <trkpt lat="45.0" lon="7.0"/><trkpt lat="45.01" lon="7.01"/>
  </trkseg>
  <trkseg>
    <trkpt lat="45.2" lon="7.2"/><trkpt lat="45.21" lon="7.21"/>
  </trkseg></trk>
</gpx>`;

describe('haversine', () => {
  it('matches a known distance', () => {
    // One degree of latitude is close to 111.2 km anywhere.
    expect(haversine(0, 0, 0, 1)).toBeGreaterThan(111_000);
    expect(haversine(0, 0, 0, 1)).toBeLessThan(111_400);
  });

  it('is zero for identical points', () => {
    expect(haversine(7.5, 45.5, 7.5, 45.5)).toBe(0);
  });
});

describe('parseGpxText', () => {
  it('reads track points, name and derived stats', () => {
    const routes = parseGpxText(TRACK, 'margalla.gpx');
    expect(routes).toHaveLength(1);

    const route = routes[0];
    expect(route.name).toBe('Margalla Trail 5');
    expect(route.points).toHaveLength(4);
    expect(route.points[0].lat).toBe(33.74);
    expect(route.points[0].lon).toBe(73.05);
    expect(route.points[0].ele).toBe(600);
    expect(route.points[0].t).toBe(Date.parse('2026-08-17T06:00:00Z'));
  });

  it('sums only positive elevation deltas', () => {
    const route = parseGpxText(TRACK, 'margalla.gpx')[0];
    // 600 -> 640 (+40), 640 -> 620 (ignored), 620 -> 700 (+80).
    expect(route.elevationGain_m).toBe(120);
  });

  it('reports null gain when the file carries no elevation', () => {
    expect(parseGpxText(NO_ELEVATION, 'flat.gpx')[0].elevationGain_m).toBeNull();
  });

  it('computes a bounding box that contains every point', () => {
    const route = parseGpxText(TRACK, 'margalla.gpx')[0];
    expect(route.bbox.west).toBeCloseTo(73.05, 6);
    expect(route.bbox.east).toBeCloseTo(73.053, 6);
    expect(route.bbox.south).toBeCloseTo(33.74, 6);
    expect(route.bbox.north).toBeCloseTo(33.743, 6);
  });

  it('falls back to rte when there is no trk', () => {
    const routes = parseGpxText(ROUTE_ONLY, 'planned.gpx');
    expect(routes).toHaveLength(1);
    expect(routes[0].points).toHaveLength(3);
  });

  it('splits multiple track segments into separate routes', () => {
    const routes = parseGpxText(TWO_SEGMENTS, 'trip.gpx');
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes[0].style.color).not.toBe(routes[1].style.color);
  });

  it('falls back to the filename when the track has no name', () => {
    expect(parseGpxText(NO_ELEVATION, 'my-run.gpx')[0].name).toBe('my-run');
  });

  it('applies the F1.2 style defaults', () => {
    const style = parseGpxText(TRACK, 'margalla.gpx')[0].style;
    expect(style.width_mm).toBe(1.5);
    expect(style.height_mm).toBe(1.2);
    expect(style.elevationSource).toBe('dem');
    expect(style.visible).toBe(true);
  });

  it('rejects a file with no track points, with an actionable message', () => {
    const empty = '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"></gpx>';
    expect(() => parseGpxText(empty, 'empty.gpx')).toThrow(GpxParseError);
    try {
      parseGpxText(empty, 'empty.gpx');
    } catch (err) {
      expect((err as GpxParseError).userMessage).toMatch(/no track points/i);
    }
  });

  it('rejects malformed XML rather than producing an empty route', () => {
    expect(() => parseGpxText('<gpx><trk>', 'broken.gpx')).toThrow(GpxParseError);
  });

  it('drops coordinates outside the valid lon/lat range', () => {
    const bad = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
        <trkpt lat="45.0" lon="7.0"/>
        <trkpt lat="999" lon="7.01"/>
        <trkpt lat="45.02" lon="7.02"/>
      </trkseg></trk></gpx>`;
    expect(parseGpxText(bad, 'bad.gpx')[0].points).toHaveLength(2);
  });
});

describe('routeDistance', () => {
  it('sums consecutive segment lengths', () => {
    const points = [
      { lon: 0, lat: 0 },
      { lon: 0, lat: 1 },
      { lon: 0, lat: 2 },
    ];
    expect(routeDistance(points)).toBeCloseTo(haversine(0, 0, 0, 1) * 2, 3);
  });

  it('is zero for a single point', () => {
    expect(routeDistance([{ lon: 1, lat: 1 }])).toBe(0);
  });
});

describe('unionBBox', () => {
  it('covers every input box', () => {
    const u = unionBBox([
      { west: 0, south: 0, east: 1, north: 1 },
      { west: -1, south: 2, east: 0.5, north: 3 },
    ]);
    expect(u).toEqual({ west: -1, south: 0, east: 1, north: 3 });
  });

  it('returns null for no input', () => {
    expect(unionBBox([])).toBeNull();
  });
});

describe('elevationGain / boundsOfPoints', () => {
  it('ignores points missing elevation', () => {
    expect(elevationGain([{ lon: 0, lat: 0, ele: 10 }, { lon: 0, lat: 1 }])).toBeNull();
  });

  it('bounds a single point to a degenerate box', () => {
    const b = boundsOfPoints([{ lon: 5, lat: 6 }]);
    expect(b).toEqual({ west: 5, south: 6, east: 5, north: 6 });
  });
});

/**
 * Hand-drawn routes (docs/02-feature-spec.md F1.3).
 *
 * A clicked polyline is all hard corners where a recorded track never is, so a
 * drawn route carries a smoothing amount and a recorded one carries zero.
 */
describe('smoothPolyline', () => {
  /** A right-angle corner: the shape Chaikin exists to round off. */
  const corner: Pt[] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];

  it('leaves the line exactly as drawn at zero', () => {
    expect(smoothPolyline(corner, 0)).toEqual(corner);
  });

  it('pins the endpoints, so the route still starts and ends where it was drawn', () => {
    const smoothed = smoothPolyline(corner, 1);
    expect(smoothed[0]).toEqual(corner[0]);
    expect(smoothed[smoothed.length - 1]).toEqual(corner[corner.length - 1]);
  });

  it('cuts the corner rather than passing through it', () => {
    const smoothed = smoothPolyline(corner, 1);
    // Nothing lands on the sharp vertex any more.
    const onCorner = smoothed.filter(([x, y]) => Math.hypot(x - 10, y) < 0.5);
    expect(onCorner).toHaveLength(0);

    // And the rounded path is shorter than the two legs it replaced.
    const length = (pts: Pt[]) =>
      pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
    expect(length(smoothed)).toBeLessThan(length(corner));
  });

  it('rounds further the more it is asked for', () => {
    // "Rounder" is a gentler turn, not points further from the corner: Chaikin
    // converges on a spline, so more passes put MORE points near the corner
    // while the angle between consecutive segments keeps shrinking.
    const sharpestTurn = (pts: Pt[]) => {
      let worst = 0;
      for (let i = 1; i + 1 < pts.length; i++) {
        const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
        const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
        let turn = Math.abs(b - a);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        worst = Math.max(worst, turn);
      }
      return worst;
    };

    expect(sharpestTurn(corner)).toBeCloseTo(Math.PI / 2, 6);
    expect(sharpestTurn(smoothPolyline(corner, 0.25))).toBeLessThan(sharpestTurn(corner));
    expect(sharpestTurn(smoothPolyline(corner, 1))).toBeLessThan(
      sharpestTurn(smoothPolyline(corner, 0.25)),
    );
  });

  it('stays inside the corner it is rounding', () => {
    // Chaikin is a convex-hull operation: nothing may escape the original line.
    for (const [x, y] of smoothPolyline(corner, 1)) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(10 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(10 + 1e-9);
    }
  });

  it('has nothing to do with two points, which have no corner', () => {
    const line: Pt[] = [
      [0, 0],
      [1, 1],
    ];
    expect(smoothPolyline(line, 1)).toEqual(line);
  });
});
