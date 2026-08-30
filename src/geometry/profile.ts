/**
 * Elevation profile strip (docs/02-feature-spec.md F11).
 *
 * The side view of the route's climb, as a bar below the model: distance left
 * to right, height up. It is the graphic every race medal and trail plaque
 * carries, and it says the one thing the map cannot — a flat 10K and a mountain
 * 10K look identical from above.
 *
 * Two decisions worth stating, because both had a plausible alternative.
 *
 * **The chart lies FLAT, in plan.** The profile shape is drawn in XY and raised
 * in Z, so it reads looking down at the model, exactly as the rest of the model
 * does, and prints with no supports. Standing the silhouette up in Z instead
 * would be a truer "elevation view" and would need supports, overhang at every
 * descent, and a viewing angle nobody looks at a plaque from.
 *
 * **The bar overlaps the model rather than touching it.** A circle meets a
 * tangent line at a single point, so a bar merely butted against a disc would
 * be joined by nothing. Pushing it `overlap_mm` into the boundary gives a real
 * contact area — on a 100 mm disc, 3 mm of overlap is a 35 mm wide joint — and
 * the union fuses it into the base slab. This is the same rule as everywhere
 * else in the pipeline: features PENETRATE, they do not kiss
 * (docs/08-pitfalls.md#non-manifold-export).
 */
import { extrudeDraped, type SolidMesh } from './extrude';
import { pointInRing } from './route';
import { sampleHeightfieldAt, type Heightfield } from './heightfield';
import type { MultiPolygon, Ring } from './polygons';
import type { ResolvedScale } from './coords';

const EMPTY: SolidMesh = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangles: 0,
};

/** One point of the sampled profile. */
export interface ProfileSample {
  /** Distance along the route from its start, metres. */
  distance_m: number;
  /** Ground elevation there, metres. */
  elevation_m: number;
  /** Whether this point is on the model at all. */
  inside?: boolean;
  /** Set on a trimmed run — see `longestInsideRun`. */
  covered?: number;
}

export interface ProfileStats {
  samples: number;
  distance_m: number;
  /** Lowest and highest ground the route crosses, metres. */
  range_m: [number, number];
  /** Sum of the positive elevation deltas, metres. The number people quote. */
  gain_m: number;
  /**
   * Fraction of the route's length the chart actually covers, 0-1.
   *
   * Below 1 when the route runs outside the selection: there is no terrain out
   * there to read a height from, so that part cannot be charted.
   */
  covered: number;
}

export interface ProfileOptions {
  /** Depth of the bar, print mm — the chart's vertical axis on the page. */
  depth_mm: number;
  /** How far the profile ridge stands above the bar's plate, print mm. */
  height_mm: number;
  /** How far the bar pushes into the model's boundary, print mm. */
  overlap_mm: number;
  baseThickness_mm: number;
  scale: ResolvedScale;
}

export interface ProfileResult {
  mesh: SolidMesh;
  stats: ProfileStats | null;
  /** Absolute Z of the ridge's top face, print mm. */
  top_mm: number;
}

/**
 * How many points the chart is drawn from.
 *
 * A recorded marathon has twenty thousand; a bar 100 mm wide cannot show more
 * than a few hundred without the ridge turning into noise finer than the
 * nozzle. Resampling at even distance also fixes a real distortion: GPX points
 * are dense where you walked and sparse where you ran, so plotting them by
 * index rather than by distance stretches the slow parts.
 */
const CHART_SAMPLES = 240;

/**
 * Sample the route's ground profile from the DEM, at even distances.
 *
 * Always the DEM, never the file's `<ele>`: the profile sits a centimetre from
 * the terrain it describes, and a barometric drift that shows a climb the
 * printed relief plainly does not have reads as a bug in the model. It is also
 * the only source a hand-drawn route has.
 */
export function sampleProfile(
  routeXY_m: ReadonlyArray<readonly [number, number]>,
  heightfield: Heightfield,
  samples = CHART_SAMPLES,
  selection: Ring | null = null,
): ProfileSample[] {
  if (routeXY_m.length < 2) return [];

  // Cumulative distance along the polyline.
  const cumulative: number[] = [0];
  for (let i = 1; i < routeXY_m.length; i++) {
    const dx = routeXY_m[i][0] - routeXY_m[i - 1][0];
    const dy = routeXY_m[i][1] - routeXY_m[i - 1][1];
    cumulative.push(cumulative[i - 1] + Math.hypot(dx, dy));
  }
  const total_m = cumulative[cumulative.length - 1];
  if (!(total_m > 0)) return [];

  const out: ProfileSample[] = [];
  let seg = 1;
  for (let i = 0; i < samples; i++) {
    const target = (i / (samples - 1)) * total_m;
    while (seg < cumulative.length - 1 && cumulative[seg] < target) seg++;

    const span = cumulative[seg] - cumulative[seg - 1];
    const t = span > 0 ? (target - cumulative[seg - 1]) / span : 0;
    const x_m = routeXY_m[seg - 1][0] + (routeXY_m[seg][0] - routeXY_m[seg - 1][0]) * t;
    const y_m = routeXY_m[seg - 1][1] + (routeXY_m[seg][1] - routeXY_m[seg - 1][1]) * t;

    out.push({
      distance_m: target,
      elevation_m: sampleHeightfieldAt(heightfield, x_m, y_m),
      inside: selection ? pointInRing(x_m, y_m, selection) : true,
    });
  }

  return selection ? longestInsideRun(out) : out;
}

/**
 * The longest unbroken stretch of the route that is on the model.
 *
 * A route can leave the selection and come back. Outside it there is no DEM to
 * read, and `sampleHeightfieldAt` clamps to the edge of the grid — which drew a
 * dead-flat plateau across a third of the bar and looked like real terrain.
 * That is the worst kind of wrong: confidently plausible.
 *
 * Concatenating the inside pieces instead would put a discontinuity in the
 * middle of a chart whose whole x axis is "distance travelled", so the longest
 * single run is charted and the caller is told what fraction it covers.
 */
function longestInsideRun(samples: ProfileSample[]): ProfileSample[] {
  let best: ProfileSample[] = [];
  let run: ProfileSample[] = [];

  for (const s of samples) {
    if (s.inside) {
      run.push(s);
      if (run.length > best.length) best = run;
    } else {
      run = [];
    }
  }

  if (best.length < 2) return [];

  // Re-base so the chart starts at zero: the x axis is distance along the part
  // being shown, not along a route that mostly is not there.
  const origin = best[0].distance_m;
  const total = samples.length > 0 ? samples[samples.length - 1].distance_m : 0;
  const covered = total > 0 ? (best[best.length - 1].distance_m - origin) / total : 1;

  return best.map((s) => ({ ...s, distance_m: s.distance_m - origin, covered }));
}

export function profileStats(samples: readonly ProfileSample[]): ProfileStats | null {
  if (samples.length < 2) return null;

  let lo = Infinity;
  let hi = -Infinity;
  let gain = 0;
  for (let i = 0; i < samples.length; i++) {
    const e = samples[i].elevation_m;
    if (e < lo) lo = e;
    if (e > hi) hi = e;
    if (i > 0 && e > samples[i - 1].elevation_m) gain += e - samples[i - 1].elevation_m;
  }

  return {
    samples: samples.length,
    distance_m: samples[samples.length - 1].distance_m,
    range_m: [lo, hi],
    gain_m: gain,
    covered: samples[0].covered ?? 1,
  };
}

/**
 * The silhouette polygon, in PRINT millimetres, with its baseline on y = 0 and
 * the curve above it.
 *
 * Exported for the tests and for anything that wants to draw the same chart on
 * screen: the shape is the feature, and it is worth being able to check it
 * without building a mesh.
 */
export function profilePolygon(
  samples: readonly ProfileSample[],
  width_mm: number,
  depth_mm: number,
): Ring {
  if (samples.length < 2 || !(width_mm > 0) || !(depth_mm > 0)) return [];

  const stats = profileStats(samples);
  if (!stats) return [];

  const [lo, hi] = stats.range_m;
  const relief_m = hi - lo;
  const total_m = stats.distance_m;
  if (!(total_m > 0)) return [];

  const ring: Ring = [];

  // The curve, left to right.
  for (const s of samples) {
    const x = (s.distance_m / total_m) * width_mm;
    // A dead-flat route still gets a readable bar rather than a zero-height
    // sliver: with no relief the chart is a plain rectangle, which is honest.
    const y = relief_m > 0 ? ((s.elevation_m - lo) / relief_m) * depth_mm : depth_mm;
    ring.push([x, y]);
  }

  // Back along the baseline to close the silhouette.
  ring.push([width_mm, 0]);
  ring.push([0, 0]);

  return ring;
}

/**
 * Build the strip: a plate the thickness of the base, with the profile raised
 * on top of it.
 *
 * @param routeXY_m   the route in world metres, in the model's ENU frame
 * @param modelRing_m the model's outer boundary in world metres, which the bar
 *                    is placed under and pushed into
 */
export function buildProfileStrip(
  routeXY_m: ReadonlyArray<readonly [number, number]>,
  modelRing_m: Ring,
  heightfield: Heightfield,
  options: ProfileOptions,
): ProfileResult {
  const top_mm = options.baseThickness_mm + options.height_mm;

  if (modelRing_m.length < 3 || !(options.depth_mm > 0) || !(options.height_mm > 0)) {
    return { mesh: EMPTY, stats: null, top_mm };
  }

  const samples = sampleProfile(routeXY_m, heightfield, CHART_SAMPLES, modelRing_m);
  const stats = profileStats(samples);
  if (!stats) return { mesh: EMPTY, stats: null, top_mm };

  // Where the model ends, in world metres.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  for (const [x, y] of modelRing_m) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { mesh: EMPTY, stats: null, top_mm };
  }

  const mmPerM = options.scale.scale;
  if (!(mmPerM > 0)) return { mesh: EMPTY, stats: null, top_mm };

  const width_m = maxX - minX;
  const depth_m = options.depth_mm / mmPerM;
  const overlap_m = options.overlap_mm / mmPerM;

  // The bar's top edge sits INSIDE the boundary by the overlap, so the union
  // has real contact area to fuse rather than a tangent point.
  const barTopY_m = minY + overlap_m;
  const barBottomY_m = barTopY_m - depth_m;

  const plate: Ring = [
    [minX, barBottomY_m],
    [maxX, barBottomY_m],
    [maxX, barTopY_m],
    [minX, barTopY_m],
  ];

  // The chart is drawn in the part of the bar that clears the model, so the
  // ridge is never buried in the overlap.
  const chartDepth_mm = Math.max(0, options.depth_mm - options.overlap_mm);
  const silhouette_mm = profilePolygon(samples, width_m * mmPerM, chartDepth_mm);
  if (silhouette_mm.length < 3) return { mesh: EMPTY, stats, top_mm };

  // Back into world metres, positioned on the bar. The chart's baseline runs
  // along the bar's outer edge and the peaks point INWARD, towards the model,
  // so the silhouette reads the same way up as the terrain behind it.
  const silhouette_m: Ring = silhouette_mm.map(
    ([x_mm, y_mm]) => [minX + x_mm / mmPerM, barBottomY_m + y_mm / mmPerM] as [number, number],
  );

  const toPrintXY = (x_m: number, y_m: number): [number, number] => [x_m * mmPerM, y_m * mmPerM];
  const flat = (z: number) => ({
    height_mm: 0,
    penetration_mm: 0,
    minBottom_mm: 0,
    // Two flat faces: there is no drape to follow, and subdividing a planar
    // face only multiplies triangles. Same reasoning as the frame.
    maxEdge_m: Infinity,
    flatBottom_mm: 0,
    flatTop_mm: z,
  });

  const plateMesh = extrudeDraped(
    [[plate]] as MultiPolygon,
    () => options.baseThickness_mm,
    toPrintXY,
    flat(options.baseThickness_mm),
  );

  // The ridge starts at the build plate, not at the plate's top face: two
  // solids meeting on a shared plane are coincident coplanar faces, which is
  // the documented way to produce a non-manifold union. Overlapping prisms
  // merge cleanly.
  const ridgeMesh = extrudeDraped(
    [[silhouette_m]] as MultiPolygon,
    () => top_mm,
    toPrintXY,
    flat(top_mm),
  );

  return { mesh: mergeSolids(plateMesh, ridgeMesh), stats, top_mm };
}

/** Concatenate two solids, offsetting the second's indices. */
function mergeSolids(a: SolidMesh, b: SolidMesh): SolidMesh {
  if (a.triangles === 0) return b;
  if (b.triangles === 0) return a;

  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);

  const offset = a.positions.length / 3;
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + offset;

  return { positions, indices, triangles: a.triangles + b.triangles };
}
