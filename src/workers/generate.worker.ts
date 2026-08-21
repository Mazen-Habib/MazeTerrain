/// <reference lib="webworker" />
/**
 * The mesh worker.
 *
 * CLAUDE.md: "All mesh generation runs in a Web Worker. The main thread never
 * blocks." Nothing in src/geometry may be imported by the main thread.
 */
import * as Comlink from 'comlink';
import { assemble } from '../geometry/assemble';
import type { GenerateRequest, MeshBundle, ProgressCallback } from '../geometry/types';

let controller: AbortController | null = null;

/** Every typed array in the bundle, so they move rather than being cloned. */
function transferables(bundle: MeshBundle): Transferable[] {
  const out: Transferable[] = [];
  for (const part of bundle.parts) {
    out.push(part.positions.buffer);
    // Indices come from slice(), so they always own a distinct buffer. Guard
    // anyway: transferring the same buffer twice throws.
    if (!out.includes(part.indices.buffer)) out.push(part.indices.buffer);
    if (part.normals && !out.includes(part.normals.buffer)) out.push(part.normals.buffer);
  }
  return out;
}

const api = {
  async generate(request: GenerateRequest, onProgress: ProgressCallback): Promise<MeshBundle> {
    controller = new AbortController();
    try {
      const bundle = await assemble(request, onProgress, controller.signal);
      return Comlink.transfer(bundle, transferables(bundle));
    } catch (err) {
      // V8 throws "Map maximum size exceeded" (a Map caps at 16 777 216 entries)
      // and "Invalid array length" when the geometry outgrows what the engine
      // can hold. Neither tells the user anything, and both mean the same thing.
      const message = err instanceof Error ? err.message : String(err);
      if (
        err instanceof RangeError ||
        /maximum size exceeded|Invalid array length|Array buffer allocation failed/i.test(message)
      ) {
        const wrapped = new Error(
          'This selection produces more geometry than the browser can hold. ' +
            'Reduce the area, or turn off some feature layers.',
        );
        (wrapped as Error & { userMessage: string }).userMessage = wrapped.message;
        throw wrapped;
      }
      throw err;
    } finally {
      controller = null;
    }
  },

  /** Aborts in-flight fetches and stops the build. Must actually cancel. */
  cancel(): void {
    controller?.abort();
  },
};

export type GenerateApi = typeof api;

Comlink.expose(api);
