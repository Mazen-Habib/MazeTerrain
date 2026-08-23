/**
 * Does the insert actually fit inside the channel cut for it?
 *
 * The cut tool and the insert are built by two separate calls to
 * `buildRibbonField`, at two different widths. That field rasterises onto a grid
 * whose cell size is derived from the ribbon's own half-width, so the two are
 * discretised on DIFFERENT grids. Nothing guarantees the narrower contour lands
 * inside the wider one — and where it does not, the insert pokes through the
 * channel wall and interpenetrates the terrain.
 */
import { buildRibbonField, FEATURE_CELLS_PER_HALF_WIDTH } from '../src/geometry/ribbonField';
import type { Pt } from '../src/data/gpx/simplify';
import type { Ring } from '../src/geometry/polygons';

/** Signed distance from a point to a ring: positive inside. */
function distanceInside(x: number, y: number, rings: Ring[]): number {
  let inside = false;
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;

      const dx = xj - xi;
      const dy = yj - yi;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / len2));
      best = Math.min(best, Math.hypot(x - (xi + t * dx), y - (yi + t * dy)));
    }
  }
  return inside ? best : -best;
}

const scale_mm_per_m = 100 / 29500; // the user's 29.5 km model
const clearance_mm = 0.15;
const width_mm = 2.0;

const cutWidth_m = width_mm / scale_mm_per_m;
const insertWidth_m = (width_mm - 2 * clearance_mm) / scale_mm_per_m;

console.log(`\nmodel 100 mm over 29.5 km -> ${scale_mm_per_m.toFixed(6)} mm/m`);
console.log(`channel ${cutWidth_m.toFixed(0)} m, insert ${insertWidth_m.toFixed(0)} m, clearance ${(clearance_mm / scale_mm_per_m).toFixed(0)} m per side\n`);

/** A route that wanders and doubles back, like a real mountain track. */
function windingRoute(n: number, amp: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * Math.PI * 5;
    pts.push([-6000 + (i / (n - 1)) * 12000, Math.sin(t) * amp + Math.sin(t * 3.1) * amp * 0.4]);
  }
  return pts;
}

for (const [name, line] of [
  ['gentle', windingRoute(160, 800)],
  ['tight switchbacks', windingRoute(220, 2600)],
  ['near self-touching', windingRoute(300, 4200)],
] as const) {
  const inset_m = clearance_mm / scale_mm_per_m;
  // One field, two levels, one grid.
  const cut = buildRibbonField([line], cutWidth_m, null, FEATURE_CELLS_PER_HALF_WIDTH, { resolve_m: inset_m });
  const insert = buildRibbonField([line], cutWidth_m, null, FEATURE_CELLS_PER_HALF_WIDTH, { inset_m });

  const cutRings: Ring[] = [];
  for (const poly of cut.polygons) for (const ring of poly) cutRings.push(ring);

  // Every insert vertex should sit inside the channel, by about the clearance.
  let worstOutside = 0;
  let outsideCount = 0;
  let total = 0;
  let closest = Infinity;
  // Sample ALONG the edges, not just at vertices: two contours can cross
  // between their vertices while every vertex stays inside.
  for (const poly of insert.polygons) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        for (let k = 0; k < 8; k++) {
          const t = k / 8;
          const x = a[0] + (b[0] - a[0]) * t;
          const y = a[1] + (b[1] - a[1]) * t;
          total++;
          const d = distanceInside(x, y, cutRings);
          if (d < closest) closest = d;
          if (d < 0) { outsideCount++; worstOutside = Math.max(worstOutside, -d); }
        }
      }
    }
  }

  const cellCut = cutWidth_m / 2 / FEATURE_CELLS_PER_HALF_WIDTH;
  const cellIns = cutWidth_m / 2 / FEATURE_CELLS_PER_HALF_WIDTH;
  console.log(
    `${name.padEnd(20)} channel cell ${cellCut.toFixed(1)} m / insert cell ${cellIns.toFixed(1)} m\n` +
      `  samples outside the channel: ${outsideCount} of ${total}` +
      `  worst ${worstOutside.toFixed(1)} m
` +
      `  closest approach to the channel wall: ${closest.toFixed(1)} m ` +
      `(${(closest * scale_mm_per_m).toFixed(3)} mm) — wanted ${(clearance_mm / scale_mm_per_m).toFixed(0)} m`,
  );
}
