import { describe, expect, it } from 'vitest';
import { buildTerrainMesh } from '../src/geometry/terrain';
import {
  removeDegenerates,
  repairAndValidate,
  signedVolume,
  validateMesh,
  weldVertices,
} from '../src/geometry/validate';
import { makeHeightfield, scaleFor } from './helpers';

/** A unit cube, correctly wound with outward normals. */
function unitCube() {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // z = 0
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // z = 1
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom, facing -Z
    4, 5, 6, 4, 6, 7, // top, facing +Z
    0, 1, 5, 0, 5, 4, // south
    1, 2, 6, 1, 6, 5, // east
    2, 3, 7, 2, 7, 6, // north
    3, 0, 4, 3, 4, 7, // west
  ]);
  return { positions, indices };
}

describe('validateMesh on a known-good solid', () => {
  it('passes a unit cube', () => {
    const { positions, indices } = unitCube();
    const v = validateMesh(positions, indices);
    expect(v.manifold).toBe(true);
    expect(v.watertight).toBe(true);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.inverted).toBe(false);
    expect(v.volume_mm3).toBeCloseTo(1, 6);
  });
});

/**
 * docs/09-roadmap.md Phase 0: "Manifold validation that actually catches a
 * deliberately broken mesh." Each case below breaks it a different way.
 */
describe('validateMesh catches deliberately broken meshes', () => {
  it('detects a hole left by a removed triangle', () => {
    const { positions, indices } = unitCube();
    const holed = indices.slice(0, indices.length - 3);
    const v = validateMesh(positions, holed);
    expect(v.watertight).toBe(false);
    expect(v.manifold).toBe(false);
    expect(v.openEdges).toBe(3);
  });

  it('detects an inside-out mesh', () => {
    const { positions, indices } = unitCube();
    const flipped = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i += 3) {
      flipped[i] = indices[i];
      flipped[i + 1] = indices[i + 2];
      flipped[i + 2] = indices[i + 1];
    }
    const v = validateMesh(positions, flipped);
    // Reversing every winding keeps it closed but turns it into a void.
    expect(v.watertight).toBe(true);
    expect(v.inverted).toBe(true);
    expect(signedVolume(positions, flipped)).toBeLessThan(0);
  });

  it('detects an edge shared by three faces', () => {
    const { positions, indices } = unitCube();
    const extra = new Uint32Array(indices.length + 3);
    extra.set(indices);
    // A stray fin hanging off edge 0-1.
    extra[indices.length] = 0;
    extra[indices.length + 1] = 1;
    extra[indices.length + 2] = 6;
    const v = validateMesh(positions, extra);
    expect(v.nonManifoldEdges).toBeGreaterThan(0);
    expect(v.manifold).toBe(false);
  });

  it('detects degenerate triangles', () => {
    const { positions, indices } = unitCube();
    const withDegenerate = new Uint32Array(indices.length + 3);
    withDegenerate.set(indices);
    withDegenerate[indices.length] = 0;
    withDegenerate[indices.length + 1] = 1;
    withDegenerate[indices.length + 2] = 1;
    expect(validateMesh(positions, withDegenerate).degenerateTriangles).toBe(1);
  });

  it('detects phantom open edges from unwelded duplicate vertices', () => {
    // Split vertex 5 into a coincident twin and repoint one face at it. The mesh
    // is geometrically closed but topologically torn.
    const { positions, indices } = unitCube();
    const split = new Float32Array(positions.length + 3);
    split.set(positions);
    split[positions.length] = positions[15];
    split[positions.length + 1] = positions[16];
    split[positions.length + 2] = positions[17];
    const twin = positions.length / 3;

    // Triangle 7 is [1, 6, 5]; index 23 is its reference to vertex 5. Repointing
    // exactly one face at the twin leaves four edges with a single face each.
    const torn = Uint32Array.from(indices);
    expect(torn[23]).toBe(5);
    torn[23] = twin;

    const v = validateMesh(split, torn);
    expect(v.watertight).toBe(false);
    expect(v.openEdges).toBe(4);
    // ...and welding puts it back together.
    expect(repairAndValidate(split, torn).validation.watertight).toBe(true);
  });
});

describe('weldVertices', () => {
  it('merges coincident vertices and rewrites indices', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const welded = weldVertices(positions, indices);
    expect(welded.merged).toBe(1);
    expect(welded.positions.length / 3).toBe(2);
    expect(Array.from(welded.indices)).toEqual([0, 1, 0]);
  });

  it('leaves distinct vertices alone', () => {
    const { positions, indices } = unitCube();
    expect(weldVertices(positions, indices).merged).toBe(0);
  });
});

describe('removeDegenerates', () => {
  it('drops repeated-vertex triangles', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2, 0, 1, 1]);
    const result = removeDegenerates(positions, indices);
    expect(result.removed).toBe(1);
    expect(result.indices.length / 3).toBe(1);
  });

  it('drops zero-area collinear triangles', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    expect(removeDegenerates(positions, indices).removed).toBe(1);
  });
});

describe('repairAndValidate', () => {
  it('reports a real terrain mesh as clean without changing it', () => {
    const hf = makeHeightfield(16, 12, (i, j) => 300 + 5 * i + 3 * j);
    const mesh = buildTerrainMesh(hf, scaleFor(hf));
    const repaired = repairAndValidate(mesh.positions, mesh.indices);

    expect(repaired.merged).toBe(0);
    expect(repaired.removed).toBe(0);
    expect(repaired.validation.manifold).toBe(true);
    expect(repaired.indices.length).toBe(mesh.indices.length);
  });
});

/**
 * docs/08-pitfalls.md#repair-that-breaks-closure — a real Phase 1 failure: a
 * route reported "234 open edge(s), 0 non-manifold edges" and blocked export.
 * 234 = 78 x 3: the repair step deleted 78 sliver triangles from a mesh that
 * was already closed, and each deletion left three edges with one face.
 */
describe('repair never breaks a closed mesh', () => {
  /** A unit cube with an extra zero-area sliver welded into one face. */
  function cubeWithSliver() {
    const { positions, indices } = unitCube();

    // Split the bottom face triangle (0,2,1) across a point exactly on edge 0-2,
    // which produces one real triangle and one zero-area sliver.
    const withPoint = new Float32Array(positions.length + 3);
    withPoint.set(positions);
    const m = positions.length / 3;
    withPoint[positions.length] = 0.5;
    withPoint[positions.length + 1] = 0.5;
    withPoint[positions.length + 2] = 0;

    const out: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      if (indices[i] === 0 && indices[i + 1] === 2 && indices[i + 2] === 1) {
        out.push(0, 2, m, 0, m, 1, 2, 1, m);
      } else {
        out.push(indices[i], indices[i + 1], indices[i + 2]);
      }
    }
    return { positions: withPoint, indices: Uint32Array.from(out) };
  }

  it('keeps a closed mesh closed even when it contains slivers', () => {
    const { positions, indices } = cubeWithSliver();

    const before = validateMesh(positions, indices);
    expect(before.watertight).toBe(true);

    const repaired = repairAndValidate(positions, indices);
    expect(repaired.validation.watertight).toBe(true);
    expect(repaired.validation.openEdges).toBe(0);
    // Deleting the sliver would have opened three edges, so it must be kept.
    expect(repaired.removed).toBe(0);
  });

  it('treats a watertight mesh with slivers as manifold, so export is not blocked', () => {
    const { positions, indices } = cubeWithSliver();
    const v = validateMesh(positions, indices);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.manifold).toBe(true);
  });

  it('still reports the slivers rather than hiding them', () => {
    const { positions, indices } = unitCube();
    const withDegenerate = new Uint32Array(indices.length + 3);
    withDegenerate.set(indices);
    withDegenerate[indices.length] = 0;
    withDegenerate[indices.length + 1] = 1;
    withDegenerate[indices.length + 2] = 1;
    expect(validateMesh(positions, withDegenerate).degenerateTriangles).toBe(1);
  });

  it('still repairs a mesh that degenerate removal genuinely helps', () => {
    // A lone degenerate triangle floating free: removing it strictly improves things.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const repaired = repairAndValidate(positions, indices);
    expect(repaired.removed).toBe(1);
    expect(repaired.indices.length).toBe(0);
  });
});

describe('repairAndValidate never makes a mesh worse', () => {
  /**
   * Two square prisms meeting at a single shared corner, kept apart by giving
   * each its own copy of that corner. This is the shape splitBowtieVertices
   * produces, and the shape a positional weld destroys: fuse the two copies and
   * the vertical edge through the corner gains four adjacent faces.
   */
  function touchingPrisms(gap: number) {
    const positions: number[] = [];
    const indices: number[] = [];

    const addBox = (x0: number, y0: number, x1: number, y1: number) => {
      const o = positions.length / 3;
      for (const z of [0, 1]) {
        positions.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
      }
      // bottom (0..3) wound down, top (4..7) wound up, then the four walls.
      indices.push(o + 0, o + 2, o + 1, o + 0, o + 3, o + 2);
      indices.push(o + 4, o + 5, o + 6, o + 4, o + 6, o + 7);
      for (let i = 0; i < 4; i++) {
        const a = o + i;
        const b = o + ((i + 1) % 4);
        indices.push(a, b, b + 4, a, b + 4, a + 4);
      }
    };

    addBox(0, 0, 1, 1);
    // Second box touches the first at (1,1) exactly when gap is 0.
    addBox(1 + gap, 1 + gap, 2 + gap, 2 + gap);

    return {
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
    };
  }

  it('keeps a mesh that welding would break', () => {
    const { positions, indices } = touchingPrisms(0);

    // As built it is two closed solids: manifold.
    expect(validateMesh(positions, indices).manifold).toBe(true);
    // Welding fuses the shared corner and ruins it.
    const welded = weldVertices(positions, indices);
    expect(validateMesh(welded.positions, welded.indices).manifold).toBe(false);

    // The repair must notice and decline.
    const repaired = repairAndValidate(positions, indices);
    expect(repaired.validation.manifold).toBe(true);
    expect(repaired.validation.nonManifoldEdges).toBe(0);
    expect(repaired.merged).toBe(0);
  });

  it('still welds when welding actually helps', () => {
    const cube = unitCube();
    // Duplicate every vertex, so the mesh arrives as unshared triangles.
    const positions = new Float32Array(cube.indices.length * 3);
    const indices = new Uint32Array(cube.indices.length);
    for (let i = 0; i < cube.indices.length; i++) {
      const v = cube.indices[i] * 3;
      positions[i * 3] = cube.positions[v];
      positions[i * 3 + 1] = cube.positions[v + 1];
      positions[i * 3 + 2] = cube.positions[v + 2];
      indices[i] = i;
    }

    expect(validateMesh(positions, indices).watertight).toBe(false);

    const repaired = repairAndValidate(positions, indices);
    expect(repaired.validation.manifold).toBe(true);
    expect(repaired.merged).toBeGreaterThan(0);
  });
});
