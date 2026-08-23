/**
 * How straight is a straight road?
 *
 * The footprint is built in 2D from a distance field, before any draping, so
 * this needs no DEM: a perfectly straight centreline should come out as a
 * perfectly straight pair of edges. Whatever deviation there is here is the
 * jaggedness visible on the model.
 */
import { buildRibbonField, FEATURE_CELLS_PER_HALF_WIDTH } from '../src/geometry/ribbonField';
import type { Pt } from '../src/data/gpx/simplify';

const extent_m = 9300;
const modelWidth_mm = 100;
const scale = modelWidth_mm / extent_m;

/** The user's model: a residential class on the ladder at a 0.4 mm nozzle. */
const width_mm = 0.57;
const width_m = width_mm / scale;

console.log(`\nmodel ${modelWidth_mm} mm over ${extent_m} m -> ${scale.toFixed(5)} mm/m`);
console.log(`road ${width_mm} mm = ${width_m.toFixed(1)} m wide`);

for (const cellsPerHalf of [FEATURE_CELLS_PER_HALF_WIDTH, 6, 12, 24]) {
  // One straight road along +X, well away from anything else.
  const line: Pt[] = [
    [-3000, 0],
    [3000, 0],
  ];
  const t0 = Date.now();
  const field = buildRibbonField([line], width_m, null, cellsPerHalf);
  const ms = Date.now() - t0;

  if (field.polygons.length === 0) {
    console.log(`  cells/half ${cellsPerHalf}: nothing built`);
    continue;
  }

  const ring = field.polygons[0][0];
  const half = width_m / 2;

  // Along the straight middle of the road, every contour point should sit at
  // exactly +half or -half in Y. Measure how far they actually stray.
  let worst = 0;
  let sum = 0;
  let n = 0;
  for (const [x, y] of ring) {
    if (x < -2500 || x > 2500) continue; // skip the rounded end caps
    const err = Math.abs(Math.abs(y) - half);
    worst = Math.max(worst, err);
    sum += err;
    n++;
  }

  const cell_m = half / cellsPerHalf;
  console.log(
    `  cells/half ${String(cellsPerHalf).padStart(2)}  cell ${cell_m.toFixed(2).padStart(6)} m  ` +
      `pts ${String(ring.length).padStart(5)}  ` +
      `edge error mean ${(sum / n).toFixed(3)} m / worst ${worst.toFixed(3)} m  ` +
      `= ${(worst * scale * 1000).toFixed(1)} µm printed  ${ms} ms`,
  );
}

// And what a real network costs at each resolution.
console.log('\nA 20 x 20 grid of streets, 300 m apart:');
const grid: Pt[][] = [];
for (let i = 0; i < 20; i++) {
  const o = -3000 + i * 300;
  grid.push([[o, -3000], [o, 3000]]);
  grid.push([[-3000, o], [3000, o]]);
}
for (const cellsPerHalf of [FEATURE_CELLS_PER_HALF_WIDTH, 6, 12]) {
  const t0 = Date.now();
  const field = buildRibbonField(grid, width_m, null, cellsPerHalf);
  let pts = 0;
  for (const poly of field.polygons) for (const ring of poly) pts += ring.length;
  console.log(
    `  cells/half ${String(cellsPerHalf).padStart(2)}  polygons ${String(field.polygons.length).padStart(3)}  ` +
      `contour points ${String(pts).padStart(7)}  ${Date.now() - t0} ms` +
      `${field.stats?.coarsened ? '  COARSENED' : ''}`,
  );
}
