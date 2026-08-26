/**
 * 3D booleans.
 *
 * Runs against the real `manifold-3d` kernel, not a stub: the whole reason for
 * taking the dependency is that hand-rolled CSG is a multi-week trap
 * (OPEN-QUESTIONS Q9), so a test that stubs it out would be testing nothing.
 */
import { describe, expect, it } from 'vitest';
import { subtractParts, unionParts, BooleanError } from '../src/geometry/boolean';
import { validateMesh } from '../src/geometry/validate';
import type { MeshPart } from '../src/geometry/types';

/** An axis-aligned box as a closed, correctly wound mesh. */
function boxPart(
  name: string,
  min: [number, number, number],
  max: [number, number, number],
  color = '#888888',
): MeshPart {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4, // front
    1, 2, 6, 1, 6, 5, // right
    2, 3, 7, 2, 7, 6, // back
    3, 0, 4, 3, 4, 7, // left
  ]);
  return { name, color, positions, indices, manifold: true };
}

function volumeOf(part: MeshPart): number {
  const { positions: p, indices: t } = part;
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return Math.abs(v) / 6;
}

describe('subtractParts', () => {
  const terrain = boxPart('terrain', [0, 0, 0], [10, 10, 10]);

  it('cuts a channel and keeps the result watertight', async () => {
    const tool = boxPart('route', [4, -1, 5], [6, 11, 11]);
    const cut = await subtractParts(terrain, [tool], { name: 'model', color: '#A0907A' });

    // 1000 minus a 2 x 10 x 5 channel.
    expect(volumeOf(cut)).toBeCloseTo(1000 - 100, 1);

    const v = validateMesh(cut.positions, cut.indices);
    expect(v.watertight).toBe(true);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
  });

  it('carries the requested name and colour', async () => {
    const cut = await subtractParts(terrain, [boxPart('t', [4, 4, 4], [6, 6, 12])], {
      name: 'model',
      color: '#123456',
    });
    expect(cut.name).toBe('model');
    expect(cut.color).toBe('#123456');
  });

  it('unions several tools rather than chaining subtracts', async () => {
    const a = boxPart('a', [1, -1, 5], [3, 11, 11]);
    const b = boxPart('b', [7, -1, 5], [9, 11, 11]);
    const cut = await subtractParts(terrain, [a, b], { name: 'model', color: '#fff' });
    expect(volumeOf(cut)).toBeCloseTo(1000 - 100 - 100, 1);
  });

  it('handles overlapping tools without double-counting the overlap', async () => {
    const a = boxPart('a', [4, -1, 5], [6, 11, 11]);
    const b = boxPart('b', [5, -1, 5], [7, 11, 11]);
    // Union of the two is 3 wide, not 4.
    const cut = await subtractParts(terrain, [a, b], { name: 'model', color: '#fff' });
    expect(volumeOf(cut)).toBeCloseTo(1000 - 150, 1);
  });

  it('returns the base untouched when there is nothing to cut', async () => {
    const cut = await subtractParts(terrain, [], { name: 'model', color: '#fff' });
    expect(volumeOf(cut)).toBeCloseTo(1000, 1);
  });

  /** A cut that eats the whole model is a settings problem, and must say so. */
  it('explains itself when the cut removes everything', async () => {
    const everything = boxPart('t', [-1, -1, -1], [11, 11, 11]);
    await expect(
      subtractParts(terrain, [everything], { name: 'model', color: '#fff' }),
    ).rejects.toThrow(BooleanError);

    try {
      await subtractParts(terrain, [everything], { name: 'model', color: '#fff' });
    } catch (err) {
      expect((err as BooleanError).userMessage).toMatch(/removed everything/i);
      expect((err as BooleanError).userMessage).toMatch(/depth|thickness/i);
    }
  });

  it('leaves the input parts usable afterwards', async () => {
    const before = volumeOf(terrain);
    await subtractParts(terrain, [boxPart('t', [4, 4, 4], [6, 6, 12])], {
      name: 'model',
      color: '#fff',
    });
    // The kernel takes ownership of what it is given, so the caller's buffers
    // must have been copied — the multicolour parts are still needed.
    expect(volumeOf(terrain)).toBeCloseTo(before, 6);
  });
});

describe('unionParts', () => {
  it('adds the volume of two disjoint solids', async () => {
    const a = boxPart('a', [0, 0, 0], [2, 2, 2]);
    const b = boxPart('b', [5, 0, 0], [7, 2, 2]);
    const joined = await unionParts([a, b], { name: 'model', color: '#fff' });
    expect(volumeOf(joined)).toBeCloseTo(16, 3);
  });

  /**
   * The reason this is a real union and not a concatenation: two overlapping
   * cubes stitched into one buffer are accepted by the kernel without complaint
   * and report the SUM of their volumes, counting the shared region twice.
   */
  it('counts an overlap once', async () => {
    const a = boxPart('a', [0, 0, 0], [10, 10, 10]);
    const b = boxPart('b', [5, 0, 0], [15, 10, 10]);
    const joined = await unionParts([a, b], { name: 'model', color: '#fff' });
    expect(volumeOf(joined)).toBeCloseTo(1500, 1);

    const v = validateMesh(joined.positions, joined.indices);
    expect(v.watertight).toBe(true);
    expect(v.nonManifoldEdges).toBe(0);
  });

  it('passes a single part straight through', async () => {
    const a = boxPart('a', [0, 0, 0], [2, 2, 2]);
    const joined = await unionParts([a], { name: 'model', color: '#abc' });
    expect(joined.name).toBe('model');
    expect(joined.color).toBe('#abc');
    expect(volumeOf(joined)).toBeCloseTo(8, 6);
  });

  it('refuses an empty list rather than returning an empty mesh', async () => {
    await expect(unionParts([], { name: 'model', color: '#fff' })).rejects.toThrow(BooleanError);
  });
});

/**
 * docs/08-pitfalls.md#the-channel-decapitates-what-it-crosses
 *
 * The channel has to cut through everything standing on the terrain, not just
 * the terrain. A tool that stops short leaves the top of whatever it crosses
 * floating over the trench — a perfectly closed solid that no manifold check
 * objects to, which is why this needs its own test.
 */
describe('a channel cut through something standing on the terrain', () => {
  /** Connected components over welded positions. */
  function componentCount(part: MeshPart): number {
    const { positions, indices } = part;
    const n = positions.length / 3;
    const weld = new Map<string, number>();
    const canon = new Int32Array(n);
    for (let v = 0; v < n; v++) {
      const k =
        positions[v * 3].toFixed(4) +
        ',' +
        positions[v * 3 + 1].toFixed(4) +
        ',' +
        positions[v * 3 + 2].toFixed(4);
      const seen = weld.get(k);
      if (seen === undefined) {
        weld.set(k, v);
        canon[v] = v;
      } else canon[v] = seen;
    }
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const uni = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    for (let v = 0; v < n; v++) uni(v, canon[v]);
    for (let k = 0; k < indices.length; k += 3) {
      uni(indices[k], indices[k + 1]);
      uni(indices[k + 1], indices[k + 2]);
    }
    const roots = new Set<number>();
    for (let k = 0; k < indices.length; k += 3) roots.add(find(indices[k]));
    return roots.size;
  }

  // Ground 0..5, with a 3-tall tower standing on it that the channel crosses.
  const ground = boxPart('ground', [0, 0, 0], [10, 10, 5]);
  const tower = boxPart('tower', [4, 4, 4.5], [6, 6, 8]);

  it('leaves the top of the tower floating when the tool stops too low', async () => {
    const body = await unionParts([ground, tower], { name: 'body', color: '#888888' });
    expect(componentCount(body)).toBe(1);

    // Spans the tower's whole footprint, but reaches only 1 above the ground
    // surface -- below the tower's 8. Everything holding the cap up is removed.
    const short = boxPart('cut', [0, 3.5, 4], [10, 6.5, 6]);
    const cut = await subtractParts(body, [short], { name: 'model', color: '#888888' });

    expect(componentCount(cut)).toBeGreaterThan(1);
  });

  it('cuts cleanly through when the tool clears everything', async () => {
    const body = await unionParts([ground, tower], { name: 'body', color: '#888888' });

    // The fix: one flat top above the tallest thing in the model.
    const tall = boxPart('cut', [0, 3.5, 4], [10, 6.5, 13]);
    const cut = await subtractParts(body, [tall], { name: 'model', color: '#888888' });

    // The tower is taken out along with the ground beneath it, and what remains
    // is one piece.
    expect(componentCount(cut)).toBe(1);
    expect(validateMesh(cut.positions, cut.indices).manifold).toBe(true);
  });
});
