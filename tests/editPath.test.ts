/**
 * Vertex editing for a drawn route (docs/02-feature-spec.md F1.3).
 *
 * The interaction is three array operations and a handle layout, so it is
 * tested as three array operations and a handle layout. What the pointer does
 * with them is MapView's business.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_EDITABLE_POINTS,
  MIN_ROUTE_POINTS,
  canEditVertices,
  deleteVertex,
  insertVertex,
  midpoint,
  moveVertex,
  vertexHandles,
} from '../src/map/editPath';
import { metresBetween, type LonLat } from '../src/map/draw';

/** A short line near Islamabad, roughly a kilometre a side. */
const LINE: LonLat[] = [
  [73.04, 33.7],
  [73.05, 33.71],
  [73.06, 33.71],
  [73.07, 33.72],
];

describe('moveVertex', () => {
  it('moves the one asked for and nothing else', () => {
    const moved = moveVertex(LINE, 1, [73.045, 33.705]);
    expect(moved[1]).toEqual([73.045, 33.705]);
    expect(moved[0]).toEqual(LINE[0]);
    expect(moved[3]).toEqual(LINE[3]);
    expect(moved).toHaveLength(LINE.length);
  });

  it('does not write through to the caller’s array', () => {
    const before = [...LINE];
    moveVertex(LINE, 0, [0, 0]);
    expect(LINE).toEqual(before);
  });

  it('ignores an index that is not there', () => {
    expect(moveVertex(LINE, 9, [0, 0])).toEqual(LINE);
    expect(moveVertex(LINE, -1, [0, 0])).toEqual(LINE);
  });
});

describe('deleteVertex', () => {
  it('removes the point and closes the gap', () => {
    const next = deleteVertex(LINE, 1);
    expect(next).toEqual([LINE[0], LINE[2], LINE[3]]);
  });

  it('can remove an end', () => {
    expect(deleteVertex(LINE, 0)).toEqual(LINE.slice(1));
    expect(deleteVertex(LINE, 3)).toEqual(LINE.slice(0, 3));
  });

  /**
   * A one-point route is not a route, and silently producing one would ship a
   * route with no length into the geometry pipeline. Refusing lets the caller
   * say why instead.
   */
  it('refuses to leave less than a line', () => {
    const pair = LINE.slice(0, MIN_ROUTE_POINTS);
    expect(deleteVertex(pair, 0)).toBeNull();
    expect(deleteVertex(pair, 1)).toBeNull();
  });

  it('refuses an index that is not there', () => {
    expect(deleteVertex(LINE, 4)).toBeNull();
  });
});

describe('insertVertex', () => {
  it('lands the new point AT the index given', () => {
    const next = insertVertex(LINE, 2, [73.055, 33.712]);
    expect(next[2]).toEqual([73.055, 33.712]);
    expect(next).toHaveLength(5);
    expect(next[3]).toEqual(LINE[2]);
  });

  it('clamps rather than tearing a hole', () => {
    expect(insertVertex(LINE, 99, [0, 0])).toHaveLength(5);
    expect(insertVertex(LINE, 99, [0, 0])[4]).toEqual([0, 0]);
    expect(insertVertex(LINE, -3, [0, 0])[0]).toEqual([0, 0]);
  });
});

describe('midpoint', () => {
  /**
   * The handle has to sit ON the drawn line. A midpoint off the segment reads
   * as a rendering bug, and the user drags it to "fix" a line that was fine.
   */
  it('sits halfway along the segment, on the ground', () => {
    const a: LonLat = [73.04, 33.7];
    const b: LonLat = [73.06, 33.72];
    const m = midpoint(a, b);
    const toA = metresBetween(m, a);
    const toB = metresBetween(m, b);
    expect(Math.abs(toA - toB)).toBeLessThan(0.5);
    expect(toA + toB).toBeCloseTo(metresBetween(a, b), 0);
  });

  it('handles a segment that crosses a degree of longitude', () => {
    const m = midpoint([72.9, 33.7], [73.1, 33.7]);
    expect(m[0]).toBeCloseTo(73.0, 3);
  });
});

describe('vertexHandles', () => {
  const handles = vertexHandles(LINE);
  const roles = (role: string) =>
    handles.features.filter((f) => f.properties?.['role'] === role);

  it('gives one handle per point and one per gap', () => {
    expect(roles('vertex')).toHaveLength(4);
    expect(roles('midpoint')).toHaveLength(3);
  });

  /**
   * A midpoint's index is where the new point WOULD land, so the drag that
   * follows the insert is already holding it. Off by one here and inserting a
   * point moves the wrong one.
   */
  it('indexes midpoints by where an inserted point would go', () => {
    const mids = roles('midpoint');
    expect(mids.map((f) => f.properties?.['index'])).toEqual([1, 2, 3]);

    // Insert at that index, and the point lands between the two it was drawn
    // between.
    const mid = mids[0];
    const next = insertVertex(LINE, mid.properties?.['index'] as number, [73.045, 33.705]);
    expect(next[0]).toEqual(LINE[0]);
    expect(next[2]).toEqual(LINE[1]);
  });

  it('marks the ends, because direction of travel shows in the model', () => {
    const ends = roles('vertex').map((f) => f.properties?.['end']);
    expect(ends).toEqual(['start', null, null, 'finish']);
  });

  it('puts every handle on the line it belongs to', () => {
    for (const f of roles('vertex')) {
      const i = f.properties?.['index'] as number;
      expect(f.geometry.coordinates).toEqual(LINE[i]);
    }
    for (const f of roles('midpoint')) {
      const i = f.properties?.['index'] as number;
      const [x, y] = f.geometry.coordinates as LonLat;
      expect(metresBetween([x, y], midpoint(LINE[i - 1], LINE[i]))).toBeLessThan(0.1);
    }
  });

  /**
   * A recorded marathon is twenty thousand points. Drawing a handle on each,
   * plus a midpoint between them, is forty thousand circles for an interaction
   * aimed at hand-drawn lines of a dozen points.
   */
  it('draws nothing for a line too big to edit by hand', () => {
    const huge: LonLat[] = Array.from(
      { length: MAX_EDITABLE_POINTS + 1 },
      (_, i) => [73 + i * 1e-4, 33.7] as LonLat,
    );
    expect(canEditVertices(huge)).toBe(false);
    expect(vertexHandles(huge).features).toHaveLength(0);

    const atCap = huge.slice(0, MAX_EDITABLE_POINTS);
    expect(canEditVertices(atCap)).toBe(true);
    expect(vertexHandles(atCap).features).toHaveLength(MAX_EDITABLE_POINTS * 2 - 1);
  });

  it('draws nothing for something that is not yet a line', () => {
    expect(canEditVertices([LINE[0]])).toBe(false);
    expect(vertexHandles([LINE[0]]).features).toHaveLength(0);
    expect(vertexHandles([]).features).toHaveLength(0);
  });
});

describe('a whole edit session', () => {
  /**
   * The gesture sequence the UI actually produces: split a segment, drag the
   * new point, then delete a different one. The line has to survive all of it
   * with its ends intact.
   */
  it('splits, drags and deletes without disturbing the ends', () => {
    let points: LonLat[] = [...LINE];
    const start = points[0];
    const finish = points[points.length - 1];

    const mid = vertexHandles(points).features.find((f) => f.properties?.['role'] === 'midpoint');
    const at = mid?.properties?.['index'] as number;

    points = insertVertex(points, at, midpoint(LINE[0], LINE[1]));
    expect(points).toHaveLength(5);

    points = moveVertex(points, at, [73.043, 33.708]);
    expect(points[at]).toEqual([73.043, 33.708]);

    const trimmed = deleteVertex(points, 3);
    expect(trimmed).not.toBeNull();
    points = trimmed as LonLat[];

    expect(points).toHaveLength(4);
    expect(points[0]).toEqual(start);
    expect(points[points.length - 1]).toEqual(finish);
  });
});
