/**
 * Contours over the user's real terrain, at the settings from their screenshot:
 * 34.1 km, 50 m interval, 0.7 mm rings, 0.4 mm nozzle, 1.5x exaggeration.
 *
 * The synthetic field used earlier is far too smooth to judge how contours look
 * on a mountain, and "it works on my fixture" is exactly the mistake that put
 * the buildings layer on screen as splatter.
 */
import { readFileSync } from 'node:fs';
import { realHeightfield } from './lib/realdem';
import { traceContours, suggestInterval } from '../src/geometry/contours';
import { buildRibbonField } from '../src/geometry/ribbonField';
import { extrudeDraped } from '../src/geometry/extrude';
import { validateMesh, weldVertices } from '../src/geometry/validate';
import { worldToPrint } from '../src/geometry/coords';
import { sampleHeightfieldAt } from '../src/geometry/heightfield';
import { scaleFor } from '../tests/helpers';
import type { RoutePoint } from '../src/data/gpx/types';

const gpx = process.argv[2] ?? 'C:/Users/Mazen/Downloads/Galiyat Mountain Trail 100K Race Route.gpx';
const interval_m = Number(process.argv[3] ?? 50);
const lineHeight_mm = Number(process.argv[4] ?? 0.7);

const xml = readFileSync(gpx, 'utf8');
const points: RoutePoint[] = [];
const re = /lat="([-0-9.]+)"\s+lon="([-0-9.]+)"/g;
let m: RegExpExecArray | null;
while ((m = re.exec(xml))) points.push({ lat: Number(m[1]), lon: Number(m[2]) });

let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
for (const p of points) {
  minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
}
// Square it off, the way a selection box is.
const cx = (minLon + maxLon) / 2, cy = (minLat + maxLat) / 2;
const halfLat = Math.max((maxLat - minLat) / 2, ((maxLon - minLon) / 2) * Math.cos((cy * Math.PI) / 180));
const halfLon = halfLat / Math.cos((cy * Math.PI) / 180);
const bbox = { west: cx - halfLon, east: cx + halfLon, south: cy - halfLat, north: cy + halfLat };

const cells = Number(process.argv[5] ?? 420);
console.log(`\nfetching real elevation for ${(halfLat * 2 * 110.574).toFixed(1)} km square...`);
const hf = await realHeightfield(bbox, 12, cells);
const scale = scaleFor(hf, { bbox });

console.log(`${cells} cells, spacing ${hf.spacingX_m.toFixed(0)} m, relief ${hf.min_m.toFixed(0)}..${hf.max_m.toFixed(0)} m`);
console.log(`scale ${scale.scale.toFixed(5)} mm/m, zScale ${scale.zScale.toFixed(5)} mm/m`);

const relief_mm = (hf.max_m - hf.min_m) * scale.zScale;
console.log(`relief on the model: ${relief_mm.toFixed(2)} mm`);

const auto = suggestInterval(hf, 0.4 / scale.scale, scale.zScale, lineHeight_mm);
console.log(`
auto interval would be ${auto} m (asked for ${interval_m} m)`);
const traced = traceContours(hf, interval_m === 0 ? auto : interval_m);
const spacing_mm = (interval_m * scale.zScale);
console.log(`\n${traced.levels.length} levels, ${traced.lines.length} lines`);
console.log(`vertical spacing between rings: ${spacing_mm.toFixed(3)} mm`);
console.log(`each ring stands ${lineHeight_mm} mm proud -> it buries the next ` +
  `${Math.floor(lineHeight_mm / Math.max(spacing_mm, 1e-6))} ring(s) above it`);

const width_m = 0.4 / scale.scale;
const ribbon = buildRibbonField(traced.lines, width_m, null, 3);
console.log(`\nribbon width ${width_m.toFixed(0)} m; ${ribbon.polygons.length} polygons`);

const drape = (x: number, y: number) => worldToPrint(x, y, sampleHeightfieldAt(hf, x, y), scale)[2];
const toXY = (x: number, y: number): [number, number] => [x * scale.scale, y * scale.scale];

const mesh = extrudeDraped(ribbon.polygons, drape, toXY, {
  height_mm: lineHeight_mm, penetration_mm: 1.0, minBottom_mm: 0.2,
  maxEdge_m: Math.max(hf.spacingX_m, width_m),
});
const raw = validateMesh(mesh.positions, mesh.indices);
const w = weldVertices(mesh.positions, mesh.indices);
const post = validateMesh(w.positions, w.indices);
console.log(`\ncontour mesh: ${mesh.triangles} triangles`);
console.log(`  raw    open ${raw.openEdges}  nonMan ${raw.nonManifoldEdges}`);
console.log(`  welded open ${post.openEdges}  nonMan ${post.nonManifoldEdges}  (merged ${w.merged})`);

// How far does the ground fall across one ribbon width? Where that exceeds the
// ring height, the ring is a tilted fin rather than a line on a surface.
let steepest = 0, over = 0, total = 0;
for (const poly of ribbon.polygons) {
  for (const ring of poly) {
    for (let i = 0; i < ring.length; i += 5) {
      const [x, y] = ring[i];
      const z0 = drape(x, y);
      const dz = Math.max(Math.abs(drape(x + width_m, y) - z0), Math.abs(drape(x, y + width_m) - z0));
      total++;
      if (dz > steepest) steepest = dz;
      if (dz > lineHeight_mm) over++;
    }
  }
}
console.log(`\nground fall across one ribbon width: worst ${steepest.toFixed(2)} mm`);
console.log(`  ${over} of ${total} samples fall further than the ring is tall`);

// Footprint coverage: how much of the model is contour?
let area_mm2 = 0;
for (const poly of ribbon.polygons) {
  for (let r = 0; r < poly.length; r++) {
    const ring = poly[r];
    let a2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      a2 += p[0] * q[1] - q[0] * p[1];
    }
    area_mm2 += (r === 0 ? 1 : -1) * Math.abs(a2 / 2) * scale.scale * scale.scale;
  }
}
console.log(`\ncontours cover ${area_mm2.toFixed(0)} mm2 of the 100 x 100 mm plate ` +
  `(${(area_mm2 / 100).toFixed(1)}%)`);
