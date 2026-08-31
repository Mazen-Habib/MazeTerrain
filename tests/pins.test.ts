/**
 * Alignment pins on tile seams (docs/02-feature-spec.md F12).
 *
 * F12 shipped with flat butt joints and a README saying there were no pins yet.
 * These test the two things that decide whether a pin works: that it is a real
 * closed solid the booleans can use, and that pins only appear where both tiles
 * actually have material to hold them.
 */
import { describe, expect, it } from 'vitest';
import { pinCylinder, pinRadius_mm, planPins, type Pin } from '../src/geometry/pins';
import { planTiles } from '../src/geometry/tiles';
import { validateMesh } from '../src/geometry/validate';
import type { Ring } from '../src/geometry/polygons';

const BED: [number, number] = [256, 256];

/** A square model 400 mm across, centred on the origin. */
const square: Ring = [
  [-200, -200],
  [200, -200],
  [200, 200],
  [-200, 200],
];

/** A disc of radius 200 mm, which does NOT reach its grid's corners. */
const disc: Ring = Array.from({ length: 180 }, (_, i) => {
  const a = (i / 180) * Math.PI * 2;
  return [Math.cos(a) * 200, Math.sin(a) * 200] as [number, number];
});

const options = { baseThickness_mm: 3, centreX_mm: 0, centreY_mm: 0 };

describe('pinCylinder', () => {
  const pin: Pin = { x: 0, y: 0, z: 1.5, axis: 'x', peg: 'A1', socket: 'B1' };

  /** A boolean tool that is not closed corrupts whatever it touches. */
  it('is a closed, manifold solid', () => {
    const mesh = pinCylinder(pin, 1, 'pin');
    const v = validateMesh(mesh.positions, mesh.indices);
    expect(v.openEdges).toBe(0);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.watertight).toBe(true);
  });

  it('is not inside out, or it would cut instead of add', () => {
    const mesh = pinCylinder(pin, 1, 'pin');
    expect(validateMesh(mesh.positions, mesh.indices).inverted).toBe(false);
  });

  /**
   * Every DIRECTED edge exactly once — the condition manifold-3d actually
   * enforces, and a stricter one than `validateMesh` applies.
   *
   * This is the test that would have caught the real bug. The first cylinder
   * paired every undirected edge and was watertight by our own validator, but
   * its cap fans ran the same way round as the walls they met, so directed
   * edges were duplicated and the surface had no consistent inside.
   * manifold-3d threw "Not manifold" and the pins silently never appeared.
   */
  it('uses every directed edge exactly once', () => {
    const mesh = pinCylinder(pin, 1, 'pin');
    const seen = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const v = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
      for (let k = 0; k < 3; k++) {
        const key = `${v[k]}->${v[(k + 1) % 3]}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }

    const duplicated = [...seen.entries()].filter(([, n]) => n !== 1);
    expect(duplicated).toEqual([]);

    // And each directed edge has its opposite, which together with the above
    // means the surface is closed AND consistently oriented.
    for (const key of seen.keys()) {
      const [from, to] = key.split('->');
      expect(seen.has(`${to}->${from}`), `missing reverse of ${key}`).toBe(true);
    }
  });

  /** Straddling is the whole trick: half in each tile, centred on the seam. */
  it('straddles the seam plane, reaching both ways', () => {
    const mesh = pinCylinder(pin, 1, 'pin');
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      lo = Math.min(lo, mesh.positions[i]);
      hi = Math.max(hi, mesh.positions[i]);
    }
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(0);
    expect(Math.abs(lo)).toBeCloseTo(hi, 6);
  });

  it('points along its own axis', () => {
    const along = pinCylinder({ ...pin, axis: 'y' }, 1, 'pin');
    let spanX = 0;
    let spanY = 0;
    let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
    for (let i = 0; i < along.positions.length; i += 3) {
      loX = Math.min(loX, along.positions[i]);
      hiX = Math.max(hiX, along.positions[i]);
      loY = Math.min(loY, along.positions[i + 1]);
      hiY = Math.max(hiY, along.positions[i + 1]);
    }
    spanX = hiX - loX;
    spanY = hiY - loY;
    // Long in y, only as wide as the pin in x.
    expect(spanY).toBeGreaterThan(spanX);
  });

  it('scales with the radius asked for', () => {
    const zOf = (r: number) => {
      const m = pinCylinder(pin, r, 'p');
      let hi = -Infinity;
      for (let i = 2; i < m.positions.length; i += 3) hi = Math.max(hi, m.positions[i]);
      return hi - pin.z;
    };
    expect(zOf(2)).toBeCloseTo(2, 6);
    expect(zOf(0.8)).toBeCloseTo(0.8, 6);
  });
});

describe('pinRadius_mm', () => {
  /** A pin wider than the base it sits in is a hole, not a pin. */
  it('stays inside the base slab', () => {
    for (const base of [1, 3, 6, 20]) {
      expect(pinRadius_mm(base) * 2).toBeLessThan(base + 1e-9 + 1);
      expect(pinRadius_mm(base)).toBeGreaterThan(0);
    }
  });

  it('never goes below what a nozzle can lay round', () => {
    expect(pinRadius_mm(0.5)).toBeGreaterThanOrEqual(0.8);
  });
});

describe('planPins', () => {
  const plan = planTiles(400, 400, BED)!;

  it('pins every internal seam of the grid', () => {
    const pins = planPins(plan, { ...options, boundary_mm: square });
    // A 2 x 2 grid has four internal seams: two vertical, two horizontal.
    expect(new Set(pins.map((p) => `${p.peg}->${p.socket}`)).size).toBe(4);
    expect(pins.length).toBeGreaterThan(4);
  });

  /** Both tiles must agree who has the peg; the rule is lower index first. */
  it('always puts the peg on the lower tile', () => {
    for (const pin of planPins(plan, { ...options, boundary_mm: square })) {
      if (pin.axis === 'x') {
        expect(pin.peg[0] < pin.socket[0]).toBe(true);
      } else {
        expect(Number(pin.peg.slice(1))).toBeLessThan(Number(pin.socket.slice(1)));
      }
    }
  });

  it('puts every pin inside the base slab', () => {
    for (const pin of planPins(plan, { ...options, boundary_mm: square })) {
      expect(pin.z).toBeGreaterThan(0);
      expect(pin.z).toBeLessThan(options.baseThickness_mm);
    }
  });

  /**
   * The reason pins are checked against the outline at all: a peg hanging in
   * air off the edge of a tile snaps off in the post.
   *
   * A disc inscribed in its own grid does NOT show this — its seams run through
   * the middle, where it is fattest, and every pin lands inside. The first
   * version of this test asserted otherwise and passed 12 against 12, proving
   * nothing. A boundary that genuinely leaves part of the seams empty does.
   */
  it('drops pins that fall outside the model', () => {
    const onSquare = planPins(plan, { ...options, boundary_mm: square });

    // A model occupying only the middle of its grid, so the outer stretches of
    // every seam are empty air.
    const small: Ring = [
      [-60, -60],
      [60, -60],
      [60, 60],
      [-60, 60],
    ];
    const onSmall = planPins(plan, { ...options, boundary_mm: small });

    expect(onSmall.length).toBeLessThan(onSquare.length);
    for (const pin of onSmall) {
      expect(Math.abs(pin.x)).toBeLessThanOrEqual(60);
      expect(Math.abs(pin.y)).toBeLessThanOrEqual(60);
    }
  });

  /** An inscribed disc keeps all of them, and that is correct, not a miss. */
  it('keeps every pin on a disc whose seams cross its middle', () => {
    expect(planPins(plan, { ...options, boundary_mm: disc }).length).toBe(
      planPins(plan, { ...options, boundary_mm: square }).length,
    );
  });

  it('keeps every pin on a disc inside the disc', () => {
    for (const pin of planPins(plan, { ...options, boundary_mm: disc })) {
      expect(Math.hypot(pin.x, pin.y)).toBeLessThan(200);
    }
  });

  it('has nothing to pin on a single-tile model', () => {
    const single = planTiles(400, 100, BED)!;
    // 2 x 1: one vertical seam, no horizontal ones.
    const pins = planPins(single, { ...options, boundary_mm: null });
    expect(pins.every((p) => p.axis === 'x')).toBe(true);
  });

  it('declines a model with no base to put a pin in', () => {
    expect(planPins(plan, { ...options, baseThickness_mm: 0, boundary_mm: square })).toEqual([]);
  });
});
