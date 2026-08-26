# Open Questions

*Last updated: 2026-08-17*

Unresolved decisions. **Add to this file whenever you hit a fork you can't resolve
alone.** Format: question, why it matters, options, owner, status.

---

## Product

### Q1 — Project name
`MazeTerrain` is the working title from the reference PDF. Is it final?
**Why it matters:** domain, package name, export filenames, 3MF metadata strings.
**Status:** open · **Owner:** project owner

### Q2 — Free vs paid
Every free competitor is donation-funded and eats real infrastructure cost (Overpass,
DEM bandwidth, eventually a planet mirror). Type II charges because it's a fulfilment
business.
**Options:** fully free + donations · free with a size cap and paid tier above it
(Type II caps free at 75 mm) · free tool + optional print fulfilment.
**Why it matters:** determines whether we need accounts, payments, and quota tracking in
the architecture at all — and whether Esri's non-commercial imagery terms are usable.
**Status:** open · **Owner:** project owner

### Q3 — Do we offer print fulfilment?
The highest-margin version of this product prints and ships the model. Very different
business.
**Status:** open, likely out of scope for v1

---

## Legal / data

### Q4 — Strava API terms
Direct Strava OAuth import would remove the "export your GPX manually" friction, which is
the single biggest drop-off point in the funnel.
**Concern:** Strava's API terms restrict derivative products, bulk data use, and some
commercial applications; approval is not automatic and terms have tightened historically.
**Action:** read the current API agreement before building anything. v1 ships manual GPX
upload regardless.
**Status:** open · needs a real read, not a guess

### Q5 — ODbL and monetisation
Working assumption (see `docs/04-data-sources.md`, §6 Attribution requirements): a 3D model
derived from OSM is a Produced Work — attribution required, share-alike not triggered, as
long as we never distribute raw OSM extracts.
**Action:** if the project takes money, get an actual legal opinion.
**Status:** open · assumption documented, not verified

### Q6 — Satellite imagery licensing
Esri World Imagery is free with attribution for non-commercial use. If Q2 lands on
"paid", we need a different provider or a licence.
**Status:** blocked on Q2

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

### Q13 — Mobile scope
Drawing a polygon on a phone is genuinely bad UX. Is "view and export an existing
project" enough for v1 mobile, or does the whole flow need to work?
**Status:** open · current spec says desktop-first

---

## UX

### Q14 — Units: metric only?
All specced parameters are mm/m/km. US users think in inches for print size, and miles
for route distance.
**Options:** metric only · a global unit toggle (Type II has one) · metric for print,
user-locale for distances.
**Status:** open

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
