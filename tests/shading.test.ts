/**
 * How the preview shades each part (docs/07-ui-spec.md, F7.1).
 *
 * F7.1: "The preview must render the *export* geometry, not a separate
 * approximation. If preview and export diverge, users lose trust immediately."
 * Averaging every normal is such a divergence: an STL stores a normal per
 * facet, so it comes out crisp, while the viewer drew every 90-degree edge as
 * a fillet. See docs/08-pitfalls.md#the-viewer-smooths-away-every-hard-edge.
 *
 * The geometry here is real, built by the same functions the exporter uses, and
 * the assertion is the one that matters: after shading, does a vertex normal
 * still describe the face it is shading?
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { chooseShading } from '../src/preview/Viewer';
import { buildFrame } from '../src/geometry/frame';
import { buildBaseline, buildLabelTool } from '../src/geometry/label';
import { buildTerrainMesh } from '../src/geometry/terrain';
import { makeHeightfield, scaleFor } from './helpers';
import type { Ring } from '../src/geometry/polygons';

describe('chooseShading', () => {
  it('creases anything small enough, whatever it is', () => {
    expect(chooseShading('frame', 5_000)).toBe('crease');
    expect(chooseShading('terrain', 5_000)).toBe('crease');
    expect(chooseShading('roads', 5_000)).toBe('crease');
  });

  /** Faceting a sampled surface looks far worse than a slightly soft rim. */
  it('keeps a large surface smooth rather than faceting the relief', () => {
    expect(chooseShading('terrain', 900_000)).toBe('smooth');
    // The single-colour body contains the terrain, so it counts as a surface.
    expect(chooseShading('model', 900_000)).toBe('smooth');
  });

  /** An extruded solid IS flat everywhere, and saying so in the shader is free. */
  it('flat-shades a large extruded part rather than smearing its edges', () => {
    expect(chooseShading('roads', 900_000)).toBe('flat');
    expect(chooseShading('buildings', 900_000)).toBe('flat');
    expect(chooseShading('contours', 900_000)).toBe('flat');
  });
});

/** Worst angle, in degrees, between a vertex normal and a face using it. */
function shadingError(geometry: THREE.BufferGeometry): { worst: number; misshaded: number } {
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const index = geometry.getIndex();
  const triangles = index ? index.count / 3 : pos.count / 3;
  const at = (t: number, e: number) => (index ? index.getX(t * 3 + e) : t * 3 + e);

  let worst = 0;
  let over = 0;
  let count = 0;

  for (let t = 0; t < triangles; t++) {
    const a = at(t, 0);
    const b = at(t, 1);
    const c = at(t, 2);
    const ux = pos.getX(b) - pos.getX(a);
    const uy = pos.getY(b) - pos.getY(a);
    const uz = pos.getZ(b) - pos.getZ(a);
    const vx = pos.getX(c) - pos.getX(a);
    const vy = pos.getY(c) - pos.getY(a);
    const vz = pos.getZ(c) - pos.getZ(a);
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    nz /= len;

    for (const v of [a, b, c]) {
      const dot = Math.max(-1, Math.min(1, nx * nor.getX(v) + ny * nor.getY(v) + nz * nor.getZ(v)));
      const degrees = (Math.acos(dot) * 180) / Math.PI;
      count++;
      if (degrees > worst) worst = degrees;
      if (degrees > 20) over++;
    }
  }

  return { worst, misshaded: count === 0 ? 0 : over / count };
}

/** Only the two buffers matter here, so this takes the least both meshes share. */
function geometryOf(
  mesh: { positions: Float32Array; indices: Uint32Array },
  crease: boolean,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  if (crease) return toCreasedNormals(g, (50 * Math.PI) / 180);
  g.computeVertexNormals();
  return g;
}

describe('creased normals on real parts', () => {
  const bbox = { west: 7.62, south: 45.94, east: 7.74, north: 46.02 };
  const cells = 90;
  const hf = makeHeightfield(
    cells,
    cells,
    (i, j) => 500 + 90 * Math.sin(i / 12) + 60 * Math.cos(j / 9),
    60,
  );
  const scale = scaleFor(hf, { bbox });
  const half_m = ((cells - 1) * hf.spacingX_m) / 2;

  const ring: Ring = Array.from({ length: 120 }, (_, i) => {
    const a = (i / 120) * Math.PI * 2;
    return [Math.cos(a) * half_m, Math.sin(a) * half_m] as [number, number];
  });

  const frame = buildFrame(ring, { width_mm: 12.5, height_mm: 4.5, baseThickness_mm: 3, scale });
  const baseline = buildBaseline(
    ring.map(([x, y]) => [x * scale.scale, y * scale.scale] as [number, number]),
    (12.5 + 6.5) / 2,
  )!;
  const label = buildLabelTool(
    'MARGALLA TRAIL 3',
    {
      capHeight_mm: 6.5,
      depth_mm: 1,
      strokeWidth_mm: 'auto',
      minStrokeWidth_mm: 0.4,
      surfaceZ_mm: frame.top_mm,
    },
    baseline,
  );

  /**
   * The reported bug: the frame was fine in the exported STL and visibly wrong
   * in the viewer. Every one of its vertices sits where a horizontal face meets
   * a vertical one, so averaging turned the whole rim into a fillet.
   */
  it('stops the frame being shaded as a fillet', () => {
    const averaged = shadingError(geometryOf(frame.mesh, false));
    expect(averaged.worst).toBeGreaterThan(60);
    expect(averaged.misshaded).toBeGreaterThan(0.5);

    const creased = shadingError(geometryOf(frame.mesh, true));
    expect(creased.worst).toBeLessThan(20);
    expect(creased.misshaded).toBe(0);
  });

  it('stops an engraved label being shaded as a smear', () => {
    expect(shadingError(geometryOf(label.mesh, false)).misshaded).toBeGreaterThan(0.4);
    // Not zero: the tight turns at the end of a stroke are genuinely sharper
    // than the crease angle, and faceting them is honest.
    expect(shadingError(geometryOf(label.mesh, true)).misshaded).toBeLessThan(0.02);
  });

  it('leaves the terrain smooth while sharpening its rim', () => {
    const creased = shadingError(geometryOf(buildTerrainMesh(hf, scale), true));
    expect(creased.worst).toBeLessThan(20);
  });
});
