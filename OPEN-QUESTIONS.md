# Open Questions

*Last updated: 2026-09-01*

Unresolved decisions. **Add to this file whenever you hit a fork you can't resolve
alone.** Format: question, why it matters, options, owner, status.

---

## Product

### Q1 — Project name
`MazeTerrain` is the working title from the reference PDF. Is it final?
**Why it matters:** domain, package name, export filenames, 3MF metadata strings.
**Status:** open · **Owner:** project owner

### Q2 — Free vs paid — **resolved 2026-09-01: free, with voluntary contributions**
Owner: "ditch the paid one, add contribution for now."

No size cap, no paid tier, no fulfilment gate. What this buys, and it is the reason the
decision was easy:

- **No accounts, no payments, no quota tracking, no backend.** The paid option was the
  only thing that required any of them. MazeTerrain stays entirely client-side.
- **Esri World Imagery becomes usable** under its non-commercial terms, which unblocks Q6.
- **No payment surface to secure.** Contributions are an outbound link to a hosted
  platform; the app never sees a card number or a billing detail. See
  `src/config/support.ts`.

The cost side is unchanged and still real: Overpass is volunteer infrastructure and DEM
bandwidth is not free. That is now a Q8 problem (when to self-host) rather than a pricing
one.

Two things this decision does NOT settle: Q3 (print fulfilment is a separate business,
still open) and Q5 (if contributions ever become revenue in a way that matters, the ODbL
question needs a real opinion rather than a working assumption).

### Q3 — Do we offer print fulfilment?
The highest-margin version of this product prints and ships the model. Very different
business.
**Status:** open, likely out of scope for v1

---

## Legal / data

### Q4 — Strava API terms — **resolved 2026-09-01: not building it**
Checked rather than assumed, and the owner's instinct was right — Strava restructured the
developer program in June 2026 and there is no longer a free tier that fits this project:

| | Standard | Extended Access |
|---|---|---|
| athletes | **10** | large user bases |
| requirement | an active Strava subscription (~$11.99/mo) **from the developer** | application, reviewed and approved by Strava |
| approval | self-service | "generally inclusive of applications serving 10 000 users or more" |

The subscription is not the blocker. **The 10-athlete cap is.** Standard tier cannot serve
a public tool at all, and Extended Access is explicitly aimed at applications that already
have ten thousand users — which a tool with no Strava integration cannot acquire. There is
no rung on this ladder that a new free project can stand on.

Also relevant: as of 1 June 2026 Strava blocks apps routing its data through third-party
intermediary platforms, and from 1 June 2027 the token and URL scheme changes — so the
integration would need rework on Strava's schedule, not ours.

**Instead**, to attack the same friction (manual export is the biggest drop-off) without
an API: accept `.fit` and `.tcx` alongside `.gpx`. Garmin and Wahoo devices write `.fit`
natively, so today those users convert a file before they can even start. That is free,
needs nobody's approval, and helps people who do not use Strava at all.

**Status:** resolved · revisit only if Strava's tiers change

### Q5 — ODbL and monetisation
Working assumption (see `docs/04-data-sources.md`, §6 Attribution requirements): a 3D model
derived from OSM is a Produced Work — attribution required, share-alike not triggered, as
long as we never distribute raw OSM extracts.
**Action:** if the project takes money, get an actual legal opinion.
**Status:** open · assumption documented, not verified

### Q6 — Satellite imagery licensing — **unblocked 2026-09-01**
Esri World Imagery is free with attribution for non-commercial use. Q2 resolved to free,
so those terms apply and the satellite basemap can be built.
**Carries an obligation:** "non-commercial" is now a promise the project is making, not
just a box it happens to sit in. If Q2 is ever revisited, this basemap goes with it.
**Status:** ready to build · no longer blocked

---

## Technical

### Q7 — DEM source: tiles vs COG
Mapterhorn terrain-RGB tiles are simple, cached, and identical to what the map preview
uses. Copernicus GeoTIFF via WCS/COG is higher precision with proper NoData, but needs a
proxy and a GeoTIFF decoder.
**Recommendation:** ship tiles (Phase 0–2), evaluate COG if quantisation artifacts show up
on low-relief terrain.
**Status:** recommendation made, not ratified

### Q8 — When do we self-host OSM?
A planet `osm2pgsql` import is hundreds of GB and hours of processing, and it's what
TerraPrinter did. But it's a Phase 3+ problem.
**Trigger to define:** what request volume or Overpass failure rate makes this urgent?
**Status:** open · needs a threshold, not a feeling

### Q9 — `manifold-3d` vs hand-rolled booleans
`manifold-3d` (WASM) guarantees manifold output but adds ~1 MB and a WASM init cost.
Hand-rolling CSG for the cutout mode is a multi-week trap.
**Recommendation:** use `manifold-3d`, lazy-loaded only when cutout mode is selected.
**Status:** recommendation made

### Q10 — Insert bottom: draped or flat?
For `single-color-cutout` + `inlay`, the insert's underside can follow the terrain
(perfect seat, needs supports) or be flat (trivial print, only works on gentle terrain).
**Previous spec:** offer both, default draped with a warning.
**Resolved 2026-08-22 — flat only.** No draped option and no segmented third option. An
insert that needs supports on its underside is an insert most people will print badly, and
supporting a long thin overhang well is exactly the thing hobby printers do worst.

Consequences, which the implementation has to carry:

- The channel floor is flat too, or the insert cannot seat on it. Both are placed one
  `insetDepth_mm` below the **lowest ground under the ribbon** — not under the centreline.
  The ribbon is wide, and on a side slope its edge reaches lower than the line down the
  middle; a floor set from the centreline leaves stretches with no channel cut at all.
- The insert is handed the channel's floor rather than computing its own. Left to work it
  out itself it gets a different answer, because it is narrower and so covers slightly
  different ground.
- On a route that climbs, the channel is as deep as the climb. `assemble` warns
  (`cutout-deep-channel`) once that exceeds three times the requested depth, because it is
  the real cost of this decision and the user should hear it before slicing rather than
  after.

**Status:** resolved

### Q11 — Route elevation when GPX has good barometric data
Some users specifically want *their* recorded elevation, not the DEM. Currently specced
as an option with a DEM blend. Is a blend actually comprehensible to users, or should it
be a hard binary?
**Status:** open · resolve with a user test, not an argument

### Q12 — Multi-tile in v1?
Prints larger than a 256 mm bed need tiling. It's specced as Phase 4, but a user asking
for a 300 mm wall piece hits a wall immediately.
**Status:** open · currently Phase 4

### Q13 — Mobile scope — **resolved 2026-09-01: none, for now**
Owner: "NO mobile scope for now." Desktop-only. Not a responsive pass, not view-and-export
— nothing.

**The one thing this still owes:** a phone that loads the app currently gets the desktop
layout, badly, with no explanation. Whatever ships to real users needs a short "open this
on a computer" screen below some width, because silently serving a broken layout is not
the same decision as declining to support mobile.

**Status:** resolved · the small-screen notice is tracked in the roadmap, not here

---

## UX

### Q14 — Units — **resolved 2026-09-01: split. Shipped same day.**
Print dimensions are always millimetres; ground distances, elevations and areas follow a
toggle that defaults from browser locale (US → imperial, everywhere else → metric).

Why split rather than a global toggle: every printer and slicer in this space speaks mm,
`worldToPrint()` is the one conversion this codebase permits, and nobody sets a base
thickness of 0.118 inches. Converting print sizes would have been work in service of a
worse readout.

Two limits, deliberate and documented in `src/config/units.ts`:

- **Readouts convert; inputs do not.** Contour interval and DEM sampling step stay metric
  sliders, because converting an input means changing its domain, its step, its stored
  meaning and its parsing — exactly the cost the global-toggle option carried. If US users
  turn out to want 40 ft contour intervals, that is a separate deliberate change.
- **Filament length stays metric.** It is print-side and sold by the metre everywhere.

`en-GB` deliberately defaults to metric despite miles on road signs, because the same
reader wants hill heights in metres and one flag cannot serve both.

**Status:** resolved · `src/config/units.ts`, `tests/units.test.ts`

---

## Resolved

*(Move items here with the decision and date when they're settled.)*

### Q15 — "Brim" naming collision — **resolved 2026-08-27**
There is no brim in MazeTerrain. The owner: "Leave brim that is to be selected in slicer.
We can use frame." A bed-adhesion brim is a slicer setting and belongs to the person
slicing; duplicating the word for a decorative lip would only confuse them. The two
specced controls collapse into one **Frame** with width and height — narrow gives the lip,
wide gives the picture frame with room for a plaque, and the geometry was identical either
way. `brimEnabled` / `brimWidth_mm` are struck from F5.

### Q16 — Preset library — **resolved 2026-08-27**
Yes, ship a curated set. An empty dropdown teaches nobody what presets are for. Built-ins
are listed above the user's own and cannot be edited or deleted; saving over a built-in
name creates a personal preset that shadows it.

### R1 — Route width unit — **resolved 2026-08-17**
Print millimetres, not world metres. Map2Model uses mm; TerraPrinter uses metres and the
result is that users must do the scale arithmetic themselves. mm is correct.
See `docs/08-pitfalls.md#unprintable-route-width`.

### R2 — Route elevation default — **resolved 2026-08-17**
Drape on the DEM. GPX `<ele>` is an opt-in. Prevents the floating/sinking route class of
bug entirely by default.

### R3 — Generation trigger — **resolved 2026-08-17**
Manual, behind an explicit Generate button, with a dirty state. Auto-regeneration on
every slider change is hostile and expensive.
