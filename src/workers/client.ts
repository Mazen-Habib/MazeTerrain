/**
 * Main-thread handle for the mesh worker.
 *
 * One worker, one generate() call, cancellable (docs/03-architecture.md,
 * threading and progress).
 */
import * as Comlink from 'comlink';
import type { GenerateApi } from './generate.worker';
import type { GenerateConfig, MeshBundle, ProgressCallback } from '../geometry/types';

let worker: Worker | null = null;
let api: Comlink.Remote<GenerateApi> | null = null;

function ensureWorker(): Comlink.Remote<GenerateApi> {
  if (!api) {
    worker = new Worker(new URL('./generate.worker.ts', import.meta.url), { type: 'module' });
    api = Comlink.wrap<GenerateApi>(worker);
  }
  return api;
}

export function generate(
  config: GenerateConfig,
  onProgress: ProgressCallback,
): Promise<MeshBundle> {
  return ensureWorker().generate(config, Comlink.proxy(onProgress));
}

export function cancelGeneration(): void {
  void api?.cancel();
}

/**
 * Hard stop. Comlink's cancel() cannot interrupt a synchronous triangulation
 * loop, so a user who cancels mid-build gets the worker torn down and rebuilt.
 */
export function terminateWorker(): void {
  worker?.terminate();
  worker = null;
  api = null;
}
