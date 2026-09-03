/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  build: {
    /**
     * Split the vendor code out of the app bundle.
     *
     * It shipped as one 1.79 MB file, which meant a one-line CSS change
     * invalidated every byte of three.js and MapLibre in everyone's cache. The
     * total downloaded on a cold visit is the same; what changes is that a
     * deploy only busts the chunk that actually changed, and the browser can
     * fetch and parse the big three in parallel.
     *
     * Matched on the full node_modules path, not a bare name: `three` as a
     * substring also hits anything with "three" anywhere in its path, and a
     * mis-sorted module in a vendor chunk is the kind of thing that only shows
     * up as a circular-import crash in production.
     */
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/node_modules/maplibre-gl/')) return 'maplibre';
          if (id.includes('/node_modules/three/')) return 'three';
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/scheduler/')
          ) {
            return 'react';
          }
          return undefined;
        },
      },
    },
    /**
     * The default 500 kB fired on every build and so stopped meaning anything.
     * MapLibre alone is 947 kB and cannot be split further without taking the
     * library apart, so the limit sits just above it — high enough to be quiet
     * about the one chunk we cannot help, low enough to still speak up if the
     * app chunk ever grows into that territory.
     */
    chunkSizeWarningLimit: 1000,
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
