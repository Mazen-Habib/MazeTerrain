/**
 * What does the cutout boolean actually produce where a route crosses itself?
 *
 * The reported artefact is grey fragments sitting on the red insert, only where
 * the route overlaps. The cut tool is one mesh that may contain several
 * polygons — and concatenated solids are not a union
 * (docs/08-pitfalls.md#concatenated-solids-are-not-a-union), so if any of those
 * polygons touch or overlap, the kernel accepts the mesh and reasons about it
 * wrongly.
 */
import { buildRouteSolid } from '../src/geometry/route';
import { subtractParts } from '../src/geometry/boolean';
import { validateMesh } from '../src/geometry/validate';
import { buildTerrainMesh } from '../src/geometry/terrain';
import { unprojectENU } from '../src/geometry/coords';
import { makeHeightfield, scaleFor } from '../tests/helpers';
import type { Route, RoutePoint } from '../src/data/gpx/types';
import type { Pt } from '../src/data/gpx/simplify';
import type { MeshPart } from '../src/geometry/types';

const hf = makeHeightfield(160, 160, (i, j) => 800 + 320 * Math.sin(i / 16) + 260 * Math.cos(j / 19), 185);
const scale = scaleFor(hf);

function route(points: Pt[], width_mm: number): Route {
  const rp: RoutePoint[] = points.map(([x, y]) => {
    const [lon, lat] = unprojectENU(x, y, scale.origin);
    return { lon, lat };
  });
  return {
    id: 'r', name: 'test', points: rp, distance_m: 0, elevationGain_m: null,
    bbox: { west: 0, south: 0, east: 0, north: 0 },
    style: {
      color: '#FF0D00', width_mm, height_mm: 1.2, profile: 'raised',
      elevationSource: 'dem', demBlend: 0, visible: true,
    },
  };
}

/** A track that switchbacks hard enough for neighbouring passes to merge. */
const switchbacks: Pt[] = [];
for (let i = 0; i < 400; i++) {
  const t = i / 399;
  const seg = Math.floor(t * 9);
  const u = (t * 9) % 1;
  const dir = seg % 2 === 0 ? 1 : -1;
  switchbacks.push([-6000 + dir * (u - 0.5) * 11000, -6000 + seg * 1300]);
}

const terrainMesh = buildTerrainMesh(hf, scale);
const terrain: MeshPart = {
  name: 'terrain', color: '#A0907A',
  positions: terrainMesh.positions, indices: terrainMesh.indices, manifold: true,
};

for (const width_mm of [2, 4, 8]) {
  const tool = buildRouteSolid(route(switchbacks, width_mm), {
    heightfield: hf, scale, selection: null,
    nozzleDiameter_mm: 0.4, baseThickness_mm: 3,
    cut: { kind: 'cut', depth_mm: 1, proud_mm: 1 },
  });

  const v = validateMesh(tool.mesh.positions, tool.mesh.indices);
  const cutPart: MeshPart = {
    name: 'cut', color: '#fff',
    positions: tool.mesh.positions, indices: tool.mesh.indices, manifold: true,
  };

  let result = 'n/a';
  try {
    const cut = await subtractParts(terrain, [cutPart], { name: 'model', color: '#A0907A' });
    const rv = validateMesh(cut.positions, cut.indices);
    result =
      `tris ${cut.indices.length / 3}  open ${rv.openEdges}  nonMan ${rv.nonManifoldEdges}  ` +
      `degenerate ${rv.degenerateTriangles}  volume ${(rv.volume_mm3 ?? 0).toFixed(0)}`;
  } catch (err) {
    result = `THREW: ${String(err).slice(0, 90)}`;
  }

  console.log(
    `\nwidth ${width_mm} mm  cut tool: tris ${tool.mesh.triangles}  ` +
      `open ${v.openEdges}  nonMan ${v.nonManifoldEdges}  degenerate ${v.degenerateTriangles}`,
  );
  console.log(`  subtract -> ${result}`);
}
