/**
 * Polygon types for the geometry pipeline.
 *
 * These were imported from `polygon-clipping` until its sweep line proved too
 * fragile for real route input (docs/08-pitfalls.md#boolean-ribbon-union-unreliable).
 * The shapes are the standard GeoJSON-style nesting, kept local so no boolean
 * library is a load-bearing dependency of the type system.
 */

/** [x, y] in world metres. */
export type Pair = [number, number];

/** A closed ring. The repeated closing vertex is optional; openRing() strips it. */
export type Ring = Pair[];

/** Outer ring first, holes after. */
export type Polygon = Ring[];

export type MultiPolygon = Polygon[];
