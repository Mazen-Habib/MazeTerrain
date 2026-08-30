/**
 * 3D booleans, for the single-colour modes.
 *
 * CLAUDE.md: don't reach for a CSG library until the hand-rolled path is the
 * bottleneck — "but *do* reach for `manifold-3d` rather than writing your own
 * boolean kernel if it comes to that". The cutout mode is a genuine 3D subtract
 * of one solid from another, which is exactly the case it comes to that, and
 * OPEN-QUESTIONS **Q9** recommends this library lazy-loaded.
 *
 * Lazy is the operative word: the WASM is ~1 MB and most models never do a
 * boolean at all, so nothing here is imported until a single-colour mode is
 * actually selected.
 */
import type { MeshPart } from './types';

/** Minimal shape of what `manifold-3d` hands back, so this file owns its types. */
interface ManifoldMesh {
  numProp: number;
  vertProperties: Float32Array;
  triVerts: Uint32Array;
}

interface ManifoldSolid {
  subtract(other: ManifoldSolid): ManifoldSolid;
  add(other: ManifoldSolid): ManifoldSolid;
  intersect(other: ManifoldSolid): ManifoldSolid;
  getMesh(): ManifoldMesh;
  volume(): number;
  isEmpty(): boolean;
  delete(): void;
}

interface ManifoldModule {
  setup(): void;
  Manifold: {
    ofMesh(mesh: ManifoldMesh): ManifoldSolid;
    union(solids: readonly ManifoldSolid[]): ManifoldSolid;
  };
  Mesh: new (options: {
    numProp: number;
    vertProperties: Float32Array;
    triVerts: Uint32Array;
  }) => ManifoldMesh;
}

let loading: Promise<ManifoldModule> | null = null;

/** Node resolves the WASM from the filesystem; the browser needs a served URL. */
const IS_NODE =
  typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;

/**
 * Load and initialise the boolean kernel, once.
 *
 * In the browser the WASM URL is resolved through the bundler rather than left
 * to Emscripten's own `locateFile`, which guesses a path relative to the script
 * and gets it wrong inside a bundled Web Worker. Under Node the bundler's URL
 * is the wrong thing entirely — it points at a path relative to the served
 * root — so the default resolution is left alone there.
 */
export function loadBooleans(): Promise<ManifoldModule> {
  if (!loading) {
    loading = (async () => {
      const { default: Module } = await import('manifold-3d');
      const init = Module as unknown as (o: object) => Promise<ManifoldModule>;

      let options: object = {};
      if (!IS_NODE) {
        const { default: wasmUrl } = await import('manifold-3d/manifold.wasm?url');
        options = { locateFile: () => wasmUrl };
      }

      const wasm = await init(options);
      wasm.setup();
      return wasm;
    })();
  }
  return loading;
}

/** Test seam: lets the suite run the same code against an injected module. */
export function __setBooleanModule(module: Promise<ManifoldModule> | null): void {
  loading = module;
}

export class BooleanError extends Error {
  readonly userMessage: string;
  constructor(message: string, userMessage: string) {
    super(message);
    this.name = 'BooleanError';
    this.userMessage = userMessage;
  }
}

function toSolid(wasm: ManifoldModule, part: MeshPart): ManifoldSolid {
  return wasm.Manifold.ofMesh(
    new wasm.Mesh({
      numProp: 3,
      // Copied: the kernel takes ownership of the buffers it is handed, and the
      // caller's part is still needed afterwards for the multicolour output.
      vertProperties: new Float32Array(part.positions),
      triVerts: new Uint32Array(part.indices),
    }),
  );
}

function fromSolid(solid: ManifoldSolid, name: string, color: string): MeshPart {
  const mesh = solid.getMesh();
  if (mesh.numProp !== 3) {
    // Only ever 3 for the meshes this module creates, but a silent stride
    // mismatch would corrupt every vertex rather than fail.
    throw new BooleanError(
      `Unexpected numProp ${mesh.numProp}`,
      'The boolean operation returned geometry this app cannot read.',
    );
  }
  return {
    name,
    color,
    positions: new Float32Array(mesh.vertProperties),
    indices: new Uint32Array(mesh.triVerts),
    manifold: true,
  };
}

export interface BooleanResultOptions {
  name: string;
  color: string;
}

/**
 * `base` minus every one of `tools`.
 *
 * Tools are unioned first rather than subtracted one at a time: a chain of
 * subtracts costs a full boolean per tool, and unioning them is one pass over
 * geometry that mostly does not touch the base at all.
 */
export async function subtractParts(
  base: MeshPart,
  tools: MeshPart[],
  options: BooleanResultOptions,
): Promise<MeshPart> {
  if (tools.length === 0) return { ...base, name: options.name, color: options.color };

  const wasm = await loadBooleans();
  const baseSolid = toSolid(wasm, base);
  const toolSolids = tools.map((tool) => toSolid(wasm, tool));

  try {
    const cutter = toolSolids.length === 1 ? toolSolids[0] : wasm.Manifold.union(toolSolids);
    const result = baseSolid.subtract(cutter);

    if (result.isEmpty()) {
      throw new BooleanError(
        'Subtract produced an empty solid',
        'Cutting the route out of the terrain removed everything. The channel is ' +
          'probably deeper than the model is thick — reduce the cut depth or increase ' +
          'the base thickness.',
      );
    }
    return fromSolid(result, options.name, options.color);
  } finally {
    // WASM memory is not garbage collected. A build that leaks a few hundred
    // megabytes of solids will take the tab with it on the second run.
    baseSolid.delete();
    for (const solid of toolSolids) solid.delete();
  }
}

/**
 * Union parts into one solid.
 *
 * Note this is a real union, not a concatenation. Concatenating overlapping
 * solids into one buffer produces something the kernel accepts without
 * complaint and then reasons about wrongly — two overlapping unit cubes come
 * back reporting the sum of their volumes, counting the shared region twice.
 * See docs/08-pitfalls.md#concatenated-solids-are-not-a-union.
 */
export async function unionParts(
  parts: MeshPart[],
  options: BooleanResultOptions,
): Promise<MeshPart> {
  if (parts.length === 0) {
    throw new BooleanError('Nothing to union', 'There is no geometry to combine.');
  }
  if (parts.length === 1) return { ...parts[0], name: options.name, color: options.color };

  const wasm = await loadBooleans();
  const solids = parts.map((part) => toSolid(wasm, part));
  try {
    return fromSolid(wasm.Manifold.union(solids), options.name, options.color);
  } finally {
    for (const solid of solids) solid.delete();
  }
}

/**
 * The part of `base` inside `boundary` — everything else discarded.
 *
 * Used to cut a model into bed-sized tiles: intersecting with a tall box gives
 * one tile with a clean vertical seam, and doing it per cell gives the set.
 *
 * Returns null rather than throwing when nothing survives. A corner cell of a
 * circular model is legitimately empty, and an empty tile is a fact about the
 * grid, not an error.
 */
export async function intersectPart(
  base: MeshPart,
  boundary: MeshPart,
  options: BooleanResultOptions,
): Promise<MeshPart | null> {
  const wasm = await loadBooleans();
  const baseSolid = toSolid(wasm, base);
  const boxSolid = toSolid(wasm, boundary);

  try {
    const result = baseSolid.intersect(boxSolid);
    if (result.isEmpty()) return null;
    return fromSolid(result, options.name, options.color);
  } finally {
    baseSolid.delete();
    boxSolid.delete();
  }
}
