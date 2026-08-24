/**
 * Sliver triangles and fans in the route solid.
 *
 * A "fan" — many long thin triangles radiating from one vertex — is what a
 * triangulator produces when a ring doubles back on itself or collapses to a
 * spur. It reads on screen as a spray of geometry shooting off the ribbon, and
 * no manifold check notices: the edges still pair up perfectly.
 *
 * Run against the real GPX rather than a synthetic path, because the shapes
 * that provoke it come from real recorded tracks.
 */
import { readFileSync } from 'node:fs';
import { buildRouteSolid } from '../src/geometry/route';
import { validateMesh } from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { Route, RoutePoint } from '../src/data/gpx/types';

const path = process.argv[2] ?? 'C:/Users/Mazen/Downloads/Milo_Marathon_2026.gpx';
const xml = readFileSync(path, 'utf8');

const points: RoutePoint[] = [];
const re = /lat="([-0-9.]+)"\s+lon="([-0-9.]+)"/g;
let m: RegExpExecArray | null;
while ((m = re.exec(xml))) points.push({ lat: Number(m[1]), lon: Number(m[2]) });
if (points.length === 0) throw new Error('no track points');

let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
for (const p of points) {
  minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
}
const bbox = { west: minLon, east: maxLon, south: minLat, north: maxLat };
console.log(`\n${points.length} track points, ${(maxLon-minLon).toFixed(4)} x ${(maxLat-minLat).toFixed(4)} deg`);

const cells = 200;
const extent_m = (maxLat - minLat) * 110574;
const hf = makeHeightfield(cells, cells, (i, j) => 520 + 8 * Math.sin(i / 18) + 6 * Math.cos(j / 21), extent_m / (cells - 1));
const scale = scaleFor(hf, { bbox });

const route: Route = {
  id: 'r', name: 'milo', points, distance_m: 0, elevationGain_m: null, bbox,
  style: {
    color: '#FF0D00', width_mm: 2, height_mm: 1.2, profile: 'raised',
    elevationSource: 'dem', demBlend: 0, visible: true,
  },
};

const built = buildRouteSolid(route, {
  heightfield: hf, scale, selection: null, nozzleDiameter_mm: 0.4, baseThickness_mm: 3,
});
console.log(`route: ${built.mesh.triangles} triangles, ${built.stats.simplifiedPoints} simplified points`);

// Is the refinement making these, or were they always in the contour?
import('../src/geometry/ribbonField').then(async ({ buildRibbonField }) => {
  const { extrudeDraped } = await import('../src/geometry/extrude');
  const { projectENU, worldToPrint } = await import('../src/geometry/coords');
  const { sampleHeightfieldAt } = await import('../src/geometry/heightfield');
  const { resample, simplifyPoints, toleranceForScale } = await import('../src/data/gpx/simplify');
  const proj = points.map((p) => projectENU(p.lon, p.lat, scale.origin));
  const simp = simplifyPoints(proj, toleranceForScale(scale.scale));
  const centre = resample(simp, hf.spacingX_m);
  const ribbon = buildRibbonField(centre, 2 / scale.scale, null);
  let pts = 0;
  for (const poly of ribbon.polygons) for (const r of poly) pts += r.length;
  const drape = (x: number, y: number) => worldToPrint(x, y, sampleHeightfieldAt(hf, x, y), scale)[2];
  const toXY = (x: number, y: number): [number, number] => [x * scale.scale, y * scale.scale];
  for (const [label, maxEdge] of [['unrefined', Infinity], ['refined', hf.spacingX_m]] as const) {
    const mesh = extrudeDraped(ribbon.polygons, drape, toXY, {
      height_mm: 1.2, penetration_mm: 1, minBottom_mm: 0.2, maxEdge_m: maxEdge as number,
    });
    let sl = 0;
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const a = mesh.indices[k]*3, b = mesh.indices[k+1]*3, c = mesh.indices[k+2]*3;
      const L = Math.max(
        Math.hypot(mesh.positions[b]-mesh.positions[a], mesh.positions[b+1]-mesh.positions[a+1]),
        Math.hypot(mesh.positions[c]-mesh.positions[b], mesh.positions[c+1]-mesh.positions[b+1]),
        Math.hypot(mesh.positions[a]-mesh.positions[c], mesh.positions[a+1]-mesh.positions[c+1]));
      const ux=mesh.positions[b]-mesh.positions[a], uy=mesh.positions[b+1]-mesh.positions[a+1];
      const vx=mesh.positions[c]-mesh.positions[a], vy=mesh.positions[c+1]-mesh.positions[a+1];
      const area2=Math.abs(ux*vy-uy*vx);
      if (area2/Math.max(L,1e-12) > 1e-12 && L/(area2/Math.max(L,1e-12)) > 200) sl++;
    }
    console.log(`  ${label.padEnd(10)} contour pts ${pts}  tris ${mesh.triangles}  slivers ${sl} (${(sl/mesh.triangles*100).toFixed(0)}%)`);
  }
});

const v = validateMesh(built.mesh.positions, built.mesh.indices);
console.log(`validate: open ${v.openEdges} nonMan ${v.nonManifoldEdges} degenerate ${v.degenerateTriangles}`);

/**
 * Aspect ratio of a triangle: longest edge over the shortest altitude. A fat
 * triangle is near 1; a sliver runs to thousands.
 */
const { positions: P, indices: I } = built.mesh;
const fanCount = new Map<number, number>();
let worst = 0;
let worstAt: number[] | null = null;
let slivers = 0;

for (let k = 0; k < I.length; k += 3) {
  const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
  const e = [
    Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]),
    Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]),
    Math.hypot(P[a] - P[c], P[a + 1] - P[c + 1], P[a + 2] - P[c + 2]),
  ];
  const longest = Math.max(...e);
  // Twice the area, via the cross product.
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
  const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
  const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  const altitude = area2 / Math.max(longest, 1e-12);
  const aspect = altitude > 1e-12 ? longest / altitude : Infinity;

  if (aspect > 200) {
    slivers++;
    for (const idx of [I[k], I[k + 1], I[k + 2]]) fanCount.set(idx, (fanCount.get(idx) ?? 0) + 1);
  }
  if (Number.isFinite(aspect) && aspect > worst) {
    worst = aspect;
    worstAt = [P[a], P[a + 1], P[a + 2]];
  }
}

// Where do the slivers live: the draped surfaces, or the vertical walls?
let wallSlivers = 0, surfaceSlivers = 0;
let minEdgeXY = Infinity;
for (let k = 0; k < I.length; k += 3) {
  const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
  const zs = [P[a + 2], P[b + 2], P[c + 2]];
  const L = Math.max(
    Math.hypot(P[b]-P[a], P[b+1]-P[a+1], P[b+2]-P[a+2]),
    Math.hypot(P[c]-P[b], P[c+1]-P[b+1], P[c+2]-P[b+2]),
    Math.hypot(P[a]-P[c], P[a+1]-P[c+1], P[a+2]-P[c+2]));
  const ux=P[b]-P[a], uy=P[b+1]-P[a+1], uz=P[b+2]-P[a+2];
  const vx=P[c]-P[a], vy=P[c+1]-P[a+1], vz=P[c+2]-P[a+2];
  const area2=Math.hypot(uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx);
  const alt = area2 / Math.max(L, 1e-12);
  if (!(alt > 1e-12 && L/alt > 200)) continue;
  // A wall spans the full height; a surface triangle is flat-ish in Z.
  if (Math.max(...zs) - Math.min(...zs) > 0.5) wallSlivers++; else surfaceSlivers++;
  const exy = Math.min(
    Math.hypot(P[b]-P[a], P[b+1]-P[a+1]),
    Math.hypot(P[c]-P[b], P[c+1]-P[b+1]),
    Math.hypot(P[a]-P[c], P[a+1]-P[c+1]));
  if (exy < minEdgeXY) minEdgeXY = exy;
}
console.log(`
sliver location: ${wallSlivers} in walls, ${surfaceSlivers} in draped surfaces`);
console.log(`shortest XY edge among slivers: ${minEdgeXY.toFixed(6)} mm`);

const hubs = [...fanCount.entries()].filter(([, n]) => n > 6).sort((x, y) => y[1] - x[1]);
console.log(`\nslivers (aspect > 200): ${slivers} of ${I.length / 3}`);
console.log(`worst aspect: ${worst.toFixed(0)}${worstAt ? ` at ${worstAt.map((n) => n.toFixed(1)).join(', ')}` : ''}`);
console.log(`fan hubs (a vertex in more than 6 slivers): ${hubs.length}`);
for (const [idx, n] of hubs.slice(0, 5)) {
  console.log(`  vertex ${idx} in ${n} slivers, at ${P[idx*3].toFixed(1)}, ${P[idx*3+1].toFixed(1)}, ${P[idx*3+2].toFixed(2)}`);
}
