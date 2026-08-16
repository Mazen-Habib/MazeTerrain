# CLAUDE.md — Operating instructions for the coding agent

*Last updated: 2026-08-17*

Read this file first, in full, before doing anything else in this repo.

---

## 1. What this repo is

A **specification pack**, not a codebase. The docs describe a browser app called
**MazeTerrain** that converts a GPX route + a map selection into a 3D-printable mesh.

Your job is to turn this spec into working software, incrementally, while keeping the
spec updated as reality diverges from it.

## 2. Reading order

Do not skim. Read these before your first commit:

1. `docs/01-project-overview.md` — what and why
2. `docs/03-architecture.md` — module boundaries you must respect
3. `docs/05-geometry-pipeline.md` — the core algorithms
4. `docs/08-pitfalls.md` — **non-negotiable.** These are bugs that other, shipped
   products in this exact space had to fix. Do not rediscover them.

Then read `docs/02-feature-spec.md` for the feature you're actually building, and
`docs/04-data-sources.md` if you're touching any network call.

## 3. Hard rules

### Geometry
- **The mesh must be watertight and manifold.** Every export path ends in a validation
  step. If it isn't manifold, it is a bug, not a "slicer will fix it".
- **North is +Y. Up is +Z. Right-handed.** Get this wrong once and every model ships
  mirrored. See `docs/08-pitfalls.md#mirrored-models`.
- **Never sample a DEM with nearest-neighbour.** Bilinear minimum. Staircase artifacts
  are immediately visible on any slope.
- **Features must penetrate the terrain, not sit on it.** Roads, routes, buildings and
  rails extrude *downward* into the base by a real-world depth before the union. Zero-gap
  contact produces coincident faces, which produce non-manifold exports.

### Units
- World space is metres, EPSG:3857 / local ENU. Print space is millimetres.
- One conversion function, one direction, one place: `worldToPrint()` in the geometry
  module. Nothing else may do the maths inline.
- Suffix every variable: `baseThickness_mm`, `routeWidth_m`, `elevation_m`.

### Performance
- **All mesh generation runs in a Web Worker.** The main thread never blocks. Progress
  is reported back as discrete stages (see `docs/07-ui-spec.md#generation-states`).
- Generation is **manual**, gated behind a Generate button. Settings changes mark the
  model dirty; they do not trigger a rebuild.
- Never `Math.max(...hugeArray)` or `arr.push(...hugeArray)`. Stack overflow at scale
  is a documented prior-art bug.

### Data
- Assume every external API will rate-limit you. Every fetch has retry with backoff,
  a 429 branch with a user-facing message, and a cache.
- Attribution strings are legally required, not decorative. See `docs/04-data-sources.md`.

## 4. Workflow expectations

- **Small vertical slices.** A slice that draws a box on a map and exports a flat plate
  STL is more valuable than three-quarters of a perfect terrain sampler.
- **Follow the roadmap phases in `docs/09-roadmap.md`.** Don't build Phase 4 features
  during Phase 1.
- **Write the golden-file test as you go.** For a fixed bbox + fixed settings, the mesh
  triangle count and bounding box should be stable. This catches regressions that visual
  inspection misses.
- Before implementing anything from `docs/02-feature-spec.md`, check whether that
  feature has an entry in `OPEN-QUESTIONS.md`. If it does and it's unresolved, ask.

## 5. When the spec is wrong

It will be. The owner wrote it from memory plus competitor screenshots, not from a
working system.

- If a constant is wrong, change it and note the new value in the doc.
- If an approach is unworkable, **stop and say so** with the specific reason. Don't
  silently substitute a different architecture.
- If you discover a new failure mode, append it to `docs/08-pitfalls.md` immediately,
  in the same format as the existing entries.

## 6. What not to do

- Don't scrape or reverse-engineer the reference platforms. They are prior art to learn
  the *problem shape* from, not code to copy. Their screenshots are in this repo purely
  to communicate UX intent.
- Don't add a backend before Phase 3. Everything up to that point runs client-side.
- Don't introduce a heavyweight CSG library (three-bvh-csg, manifold-3d) until profiling
  shows the hand-rolled path is the bottleneck — but *do* reach for `manifold-3d` rather
  than writing your own boolean kernel if it comes to that.
- Don't add analytics, accounts, or payment flows unless the roadmap says so.
