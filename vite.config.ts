/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // MapLibre ships its tile-parsing worker as a separate ESM entry that Vite's
    // dependency optimizer cannot rewrite. When it mangles it the worker never
    // starts, so vector tiles are fetched and never decoded: the map paints its
    // background layer and nothing else, which reads as a blank white map.
    // Vite says so itself, in a warning that is easy to scroll past.
    exclude: ['maplibre-gl'],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * Longer than the 5 s default, because a good many of these tests build
     * real geometry — a city's worth of ribbons, a marathon route, a boolean
     * through the WASM kernel — rather than exercising pure functions. Raised
     * when Delaunay flipping was added: production got faster, but the test
     * fixtures are deliberately punishing and were tripping the default.
     */
    testTimeout: 30_000,
  },
});
