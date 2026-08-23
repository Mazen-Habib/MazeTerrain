/**
 * Does the CLIPPED terrain builder make spikes?
 *
 * A rectangle selection takes `buildTerrainMesh`; every other shape takes
 * `buildClippedTerrainMesh`, which rebuilds the surface against an inside mask.
 * A build measured through the rectangle path came out clean, and the reported
 * spikes were on a circle, so this exercises the other path on the same data.
 */
import { buildTerrainMesh } from '../src/geometry/terrain';
import { buildClippedTerrainMesh } from '../src/geometry/terrainClip';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { Ring } from '../src/geometry/polygons';

/** Rolling terrain with a little noise, like a real DEM. */
const hf = makeHeightfield(220, 220, (i, j) => {
  const base = 500 + 60 * Math.sin(i / 18) + 45 * Math.cos(j / 22);
  const noise = 3 * Math.sin(i * 1.7) * Math.cos(j * 2.3);
  return base + noise;
}, 60);
const scale = scaleFor(hf);

const extent = (hf.cols - 1) * hf.spacingX_m;
const radius = extent * 0.45;
const circle: Ring = Array.from({ length: 128 }, (_, i) => {
  const t = (i / 128) * Math.PI * 2;
  return [radius * Math.cos(t), radius * Math.sin(t)] as [number, number];
});

/**
 * Spikes, measured on the mesh rather than the grid: bin vertices in XY and
 * look for a bin whose top stands far above its neighbours' tops.
 */
function spikeReport(positions: Float32Array, bin_mm: number) {
  const cells = new Map<string, number>();
  for (let i = 0; i < positions.length; i += 3) {
    const k = `${Math.round(positions[i] / bin_mm)},${Math.round(positions[i + 1] / bin_mm)}`;
    const z = positions[i + 2];
    const c = cells.get(k);
    if (c === undefined || z > c) cells.set(k, z);
  }

  const deltas: number[] = [];
  let worst = 0;
  let over1 = 0;
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
    const d = top - ring[Math.floor(ring.length / 2)];
    deltas.push(d);
    if (d > worst) worst = d;
    if (d > 1) over1++;
  }
  deltas.sort((a, b) => a - b);
  return {
    bins: cells.size,
    p99: deltas[Math.floor(deltas.length * 0.99)],
    p999: deltas[Math.floor(deltas.length * 0.999)],
    worst,
    over1mm: over1,
  };
}

const step_mm = scale.resolution_m * scale.scale;
console.log(`\ngrid ${hf.cols}x${hf.rows} @ ${hf.spacingX_m} m, print step ${step_mm.toFixed(3)} mm`);

for (const [name, mesh] of [
  ['rectangle (buildTerrainMesh)', buildTerrainMesh(hf, scale)],
  ['circle    (buildClippedTerrainMesh)', buildClippedTerrainMesh(hf, scale, circle)],
] as const) {
  const r = spikeReport(mesh.positions, Math.max(0.05, step_mm));
  console.log(
    `\n${name}\n` +
      `  triangles ${mesh.indices.length / 3}\n` +
      `  above neighbours, mm: p99 ${r.p99.toFixed(3)}  p99.9 ${r.p999.toFixed(3)}  worst ${r.worst.toFixed(3)}\n` +
      `  bins over 1 mm: ${r.over1mm}`,
  );
}
