# Peakora — Project Reference Repository

> **This repo contains no code yet.** It is the specification and context pack that
> Claude Code (or any other agent/developer) reads *before* writing a single line.

## What we're building

A browser app that turns a GPS route + a real-world map area into a **3D-printable
model**. The user uploads a GPX file (Strava, Garmin, Komoot, Wahoo…), the track is
drawn on a map, they draw a circle/rectangle/polygon around the part they want, and
the app generates a watertight mesh containing:

- real terrain relief from elevation data,
- the route embossed as a raised (or recessed) ridge,
- roads, water, railways, buildings, greenery and other OSM features,

then exports **STL** (single body) and **3MF** (multi-material, AMS/MMU-ready).

## How to use this repo

| If you are… | Start here |
|---|---|
| Claude Code, picking up the build | [`CLAUDE.md`](CLAUDE.md) |
| A human wanting the pitch | [`docs/01-project-overview.md`](docs/01-project-overview.md) |
| Implementing a feature | [`docs/02-feature-spec.md`](docs/02-feature-spec.md) |
| Writing the mesh code | [`docs/05-geometry-pipeline.md`](docs/05-geometry-pipeline.md) |
| About to hit a known landmine | [`docs/08-pitfalls.md`](docs/08-pitfalls.md) ← **read this one** |

## Document map

```
README.md                        ← you are here
CLAUDE.md                        ← agent operating instructions
OPEN-QUESTIONS.md                ← unresolved decisions (add to this as you go)
docs/
  01-project-overview.md         vision, users, scope, non-goals
  02-feature-spec.md             every feature, every parameter, defaults + ranges
  03-architecture.md             modules, data flow, tech stack, worker boundaries
  04-data-sources.md             DEM + OSM + tiles, licences, attribution, rate limits
  05-geometry-pipeline.md        the actual maths: projection → mesh → export
  06-export-formats.md           STL, 3MF, AMS/MMU, single-colour cutout mode
  07-ui-spec.md                  panel/tab layout, control inventory, states
  08-pitfalls.md                 known bugs and traps, harvested from prior art
  09-roadmap.md                  phased milestones, definition of done per phase
  10-glossary.md                 domain vocabulary
  references/
    competitors.md               deep notes on the 4 reference platforms
    screenshots/                 annotated UI captures from those platforms
```

## Status

| Doc | State |
|---|---|
| 01 Project overview | Draft — stable |
| 02 Feature spec | Draft — **expect additions from the owner** |
| 03 Architecture | Proposed — not yet ratified |
| 04 Data sources | Draft — needs a licensing decision |
| 05 Geometry pipeline | Draft — the algorithms are sound, constants need tuning |
| 06 Export formats | Draft |
| 07 UI spec | Draft — low fidelity, no visual design yet |
| 08 Pitfalls | Living document — append every bug you hit |
| 09 Roadmap | Proposed |

## Conventions

- **Units.** Anything ending in `_mm` is millimetres in *print space*. Anything
  ending in `_m` is metres in *world space*. Never mix them in one variable.
- **Dates** are ISO-8601.
- **Every doc has a `Last updated` line.** Bump it when you edit.
