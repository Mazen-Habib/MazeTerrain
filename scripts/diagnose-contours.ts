/**
 * Contour geometry: manifoldness, and how far the terrain punches through.
 *
 * The build reports "Layer contours is not manifold: 0 open edges, 26
 * non-manifold edge(s)", so an edge is shared by more than two triangles.
 * Open edges being zero rules out a hole: this is geometry folded onto itself.
 */
import { traceContours } from '../src/geometry/contours';
import { buildRibbonField } from '../src/geometry/ribbonField';
import { extrudeDraped } from '../src/geometry/extrude';
import { validateMesh, weldVertices } from '../src/geometry/validate';
import { worldToPrint } from '../src/geometry/coords';
import { sampleHeightfieldAt } from '../src/geometry/heightfield';
import { makeHeightfield, scaleFor } from '../tests/helpers';

const extent_km = Number(process.argv[2] ?? 34.1);
const interval_m = Number(process.argv[3] ?? 50);
const cells = Number(process.argv[4] ?? 260);

// 532..2937 m, like the reported build.
const hf = makeHeightfield(
  cells, cells,
  (i, j) =>
    1700 + 900 * Math.sin(i / 40) + 700 * Math.cos(j / 33) +
    260 * Math.sin(i / 11 + j / 9) + 90 * Math.cos(j / 5),
  (extent_km * 1000) / (cells - 1),
);
const LAT = 33.9, LON = 73.4, half = extent_km / 2;
const bbox = {
  west: LON - half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  east: LON + half / (111.32 * Math.cos((LAT * Math.PI) / 180)),
  south: LAT - half / 110.574,
  north: LAT + half / 110.574,
};
const scale = scaleFor(hf, { bbox });

console.log(`\n${extent_km} km, ${cells} cells, spacing ${hf.spacingX_m.toFixed(1)} m`);
console.log(`relief ${hf.min_m.toFixed(0)}..${hf.max_m.toFixed(0)} m, scale ${scale.scale.toFixed(5)} mm/m`);

const traced = traceContours(hf, interval_m);
console.log(`levels ${traced.levels.length}, lines ${traced.lines.length}`);

const width_m = 0.4 / scale.scale;
console.log(`contour ribbon width: ${width_m.toFixed(0)} m in the world (0.40 mm on the model)`);
console.log(`terrain grid: ${hf.spacingX_m.toFixed(0)} m -> maxEdge would be ${Math.max(hf.spacingX_m, width_m).toFixed(0)} m`);

const t0 = Date.now();
const ribbon = buildRibbonField(traced.lines, width_m, null, 3);
console.log(`ribbon: ${ribbon.polygons.length} polygons in ${((Date.now()-t0)/1000).toFixed(1)} s`);

const height_mm = 0.7;
const drape = (x: number, y: number) => worldToPrint(x, y, sampleHeightfieldAt(hf, x, y), scale)[2];
const toXY = (x: number, y: number): [number, number] => [x * scale.scale, y * scale.scale];

for (const [label, maxEdge] of [
  ['as shipped', Math.max(hf.spacingX_m, width_m)],
  ['grid', hf.spacingX_m],
] as const) {
  const mesh = extrudeDraped(ribbon.polygons, drape, toXY, {
    height_mm, penetration_mm: 1.0, minBottom_mm: 0.2, maxEdge_m: maxEdge as number,
  });
  // The product welds before validating (repairAndValidate). Validating the
  // raw buffer hides every fault the weld reintroduces.
  const raw = validateMesh(mesh.positions, mesh.indices);
  const w = weldVertices(mesh.positions, mesh.indices);
  const post = validateMesh(w.positions, w.indices);

  // Only TOP vertices: extrudeDraped pushes top then bottom for each, so the
  // tops are the even ones. A bottom sits a penetration below ground by design.
  let worst = 0, n = 0;
  for (let v = 0; v < mesh.positions.length / 3; v += 2) {
    const i = v * 3;
    const ground = drape(mesh.positions[i] / scale.scale, mesh.positions[i + 1] / scale.scale);
    const above = ground - mesh.positions[i + 2];
    if (above > worst) worst = above;
    if (above > 0.05) n++;
  }
  console.log(
    `${label.padEnd(11)} maxEdge ${String(Math.round(maxEdge as number)).padStart(4)} m  ` +
    `tris ${String(mesh.triangles).padStart(8)}
` +
    `  raw    open ${String(raw.openEdges).padStart(4)}  nonMan ${String(raw.nonManifoldEdges).padStart(4)}
` +
    `  welded open ${String(post.openEdges).padStart(4)}  nonMan ${String(post.nonManifoldEdges).padStart(4)}  ` +
    `(weld merged ${w.merged} vertices)
` +
    `  terrain above the contour top: worst ${worst.toFixed(2)} mm, ${n} of ${mesh.positions.length / 6} tops`,
  );
}

// --- Are there tiny isolated pieces? --------------------------------------
//
// A closed contour around a small bump becomes its own ring. Below a certain
// size that is not a line any more, it is a speck standing 0.7 mm off the
// terrain — which is exactly what "floating geometry" looks like on screen.
console.log('\nfootprint of each contour polygon, in print mm:');
const areas: number[] = [];
for (const poly of ribbon.polygons) {
  const outer = poly[0];
  let a2 = 0;
  for (let i = 0; i < outer.length; i++) {
    const p = outer[i];
    const q = outer[(i + 1) % outer.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  areas.push(Math.abs(a2 / 2) * scale.scale * scale.scale);
}
areas.sort((a, b) => a - b);
const nozzleArea = 0.4 * 0.4;
console.log(`  ${areas.length} polygons, smallest ${areas[0].toFixed(4)} mm2, ` +
  `median ${areas[Math.floor(areas.length / 2)].toFixed(2)} mm2, largest ${areas[areas.length - 1].toFixed(0)} mm2`);
console.log(`  under one nozzle square (${nozzleArea.toFixed(2)} mm2): ` +
  `${areas.filter((a) => a < nozzleArea).length}`);
console.log(`  under four nozzle squares: ${areas.filter((a) => a < nozzleArea * 4).length}`);

// How steep is the ground under a contour? A ribbon on ground that falls more
// than its own height across its width is a tilted fin, not a line.
let steepest = 0, steepCount = 0, total = 0;
for (const poly of ribbon.polygons) {
  for (const ring of poly) {
    for (let i = 0; i < ring.length; i += 7) {
      const [x, y] = ring[i];
      const z0 = drape(x, y);
      const w = width_m;
      const dz = Math.max(
        Math.abs(drape(x + w, y) - z0),
        Math.abs(drape(x, y + w) - z0),
      );
      total++;
      if (dz > steepest) steepest = dz;
      if (dz > height_mm) steepCount++;
    }
  }
}
console.log(`\nground fall across one ribbon width (${width_m.toFixed(0)} m):`);
console.log(`  worst ${steepest.toFixed(2)} mm, and ${steepCount} of ${total} samples ` +
  `fall further than the ${height_mm} mm the contour stands proud`);
