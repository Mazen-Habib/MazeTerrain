/**
 * Does the route solid make spikes?
 *
 * Terrain and roads both measured clean. Every build that showed cones had a
 * GPX route loaded and the builds measured clean did not, so this is the next
 * suspect. A real GPX is noisy — repeated points, jitter, and points that fall
 * outside the heightfield entirely — so this feeds it all of that.
 */
import { buildRouteSolid } from '../src/geometry/route';
import { unprojectENU } from '../src/geometry/coords';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { Route, RoutePoint } from '../src/data/gpx/types';

const hf = makeHeightfield(200, 200, (i, j) => {
  const base = 500 + 70 * Math.sin(i / 20) + 50 * Math.cos(j / 25);
  return base + 4 * Math.sin(i * 1.9) * Math.cos(j * 2.1);
}, 47);
const scale = scaleFor(hf);
const extent = (hf.cols - 1) * hf.spacingX_m;

function route(points: Array<[number, number]>, width_mm = 2): Route {
  const rp: RoutePoint[] = points.map(([x, y]) => {
    const [lon, lat] = unprojectENU(x, y, scale.origin);
    return { lon, lat };
  });
  return {
    id: 'r',
    name: 'diagnostic',
    points: rp,
    distance_m: 0,
    elevationGain_m: null,
    bbox: { west: 0, south: 0, east: 0, north: 0 },
    style: {
      color: '#FF0D00',
      width_mm,
      height_mm: 1.2,
      profile: 'raised',
      elevationSource: 'dem',
      demBlend: 0,
      visible: true,
    },
  };
}

function spikes(positions: Float32Array, bin_mm: number) {
  const cells = new Map<string, number>();
  for (let i = 0; i < positions.length; i += 3) {
    const k = `${Math.round(positions[i] / bin_mm)},${Math.round(positions[i + 1] / bin_mm)}`;
    const z = positions[i + 2];
    const c = cells.get(k);
    if (c === undefined || z > c) cells.set(k, z);
  }
  let worst = 0;
  let over1 = 0;
  const d: number[] = [];
  for (const [k, top] of cells) {
    const [gx, gy] = k.split(',').map(Number);
    const ring: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const n = cells.get(`${gx + dx},${gy + dy}`);
        if (n !== undefined) ring.push(n);
      }
    }
    if (ring.length < 5) continue;
    ring.sort((a, b) => a - b);
    const delta = top - ring[Math.floor(ring.length / 2)];
    d.push(delta);
    if (delta > worst) worst = delta;
    if (delta > 1) over1++;
  }
  d.sort((a, b) => a - b);
  return { worst, over1, p999: d.length ? d[Math.floor(d.length * 0.999)] : 0 };
}

const half = extent / 2;
const cases: Array<[string, Array<[number, number]>]> = [
  [
    'clean diagonal',
    Array.from({ length: 200 }, (_, i) => [-half + (i * extent) / 199, -half + (i * extent) / 199]),
  ],
  [
    'runs well outside the heightfield',
    Array.from({ length: 200 }, (_, i) => [
      -half * 3 + (i * extent * 3) / 199,
      -half * 0.4 + Math.sin(i / 7) * half * 0.3,
    ]),
  ],
  [
    'doubles back on itself',
    Array.from({ length: 300 }, (_, i) => {
      const t = (i / 299) * Math.PI * 6;
      return [Math.cos(t) * half * 0.7, Math.sin(t * 2) * half * 0.5] as [number, number];
    }),
  ],
  [
    'hairpins and repeated points',
    Array.from({ length: 400 }, (_, i) => {
      const seg = Math.floor(i / 20);
      const t = (i % 20) / 19;
      const dir = seg % 2 === 0 ? 1 : -1;
      return [
        -half * 0.8 + dir * t * half * 1.5 + (i % 3 === 0 ? 0 : 0.001),
        -half * 0.8 + seg * (half * 0.15),
      ] as [number, number];
    }),
  ],
];

console.log(`\nheightfield ${hf.cols}x${hf.rows} @ ${hf.spacingX_m} m, scale ${scale.scale.toFixed(5)} mm/m`);

for (const [name, pts] of cases) {
  const built = buildRouteSolid(route(pts), {
    heightfield: hf,
    scale,
    selection: null,
    nozzleDiameter_mm: 0.4,
    baseThickness_mm: 3,
  });
  if (built.mesh.triangles === 0) {
    console.log(`  ${name.padEnd(36)} nothing built`);
    continue;
  }
  const s = spikes(built.mesh.positions, 0.4);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < built.mesh.positions.length; i += 3) {
    lo = Math.min(lo, built.mesh.positions[i]);
    hi = Math.max(hi, built.mesh.positions[i]);
  }
  console.log(
    `  ${name.padEnd(36)} tris ${String(built.mesh.triangles).padStart(6)}  ` +
      `z ${lo.toFixed(2)}..${hi.toFixed(2)} mm  ` +
      `spike p99.9 ${s.p999.toFixed(3)} worst ${s.worst.toFixed(3)} mm  over1mm ${s.over1}`,
  );
}
