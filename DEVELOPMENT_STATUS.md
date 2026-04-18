# Development Status

Last updated: 2026-04-19

## Workflow

- Modify and verify in `develop`.
- Commit and push with `git`.
- Fast-forward `C:\SpaceWork_deploy`.
- Run web deployment and verify the public URLs.

## Progress Tracking

- Primary document: this file
- Progress snapshot command:
  - `node scripts/report-terrain-progress.mjs --case seoul-hillside,gyeyang-large`
- Notes:
  - Use the snapshot script to see contour closure counts, export-vs-terrain-basis mismatch counts, band-boundary mismatch counts, band counts, and placement status.
  - Update this file every working session so the next conversation can resume from here.

## Current Board

- `Completed`
  - Pipeline audit: source contours -> export contours -> terrain bands -> terrain solids -> placement flow
  - Added terrain pipeline diagnostics in export preparation
  - Added progress snapshot script
  - Added persistent top-level status document
  - Switched export contour assembly to terrain-basis-first generation
  - Flattened 3DM contour display curves onto the bottom reference plane
  - Preserved native 5m anchor levels inside the resolved terrain basis when the render interval relaxes
  - Added export verification that fails if export curves diverge from the terrain basis
  - Added building Z diagnostics against the terrain basis
  - Added road terrain-basis coverage diagnostics
- `In Progress`
  - Reconnecting building/road Z placement to the same terrain basis
  - Turning the new placement diagnostics into stricter export-side failures where appropriate
- `Next`
  - Validate buildings and roads against the final terrain basis, not parallel fallback logic
  - Add explicit export-side checks for building/road terrain-base mismatches
  - Keep reducing band-boundary mismatch noise so the diagnostics point only at real geometry errors

## Current Focus

- Terrain contour algorithm audit
- Terrain/export curve alignment
- Building and road Z placement validation
- Heavier debug instrumentation so regressions are obvious

## User-Requested Target Behavior

### Terrain model

For native `5m` contours:

1. Use official raw contour data as the source of truth.
2. If a contour is clipped by the requested range, close it by combining it with the outer boundary.
3. Place those contour curves flat on the bottom layer as reference curves.
4. Use the same closed contour basis at the correct Z elevation to extrude contour terrain bands.
5. Do not leave terrain-construction curves embedded inside the final terrain solid.

For requested `1m` contour models from `5m` source:

1. Start from the same closed `5m` raw contour basis.
2. Generate the missing `1m` intermediate contour curves from that closed contour basis.
3. Place those curves flat on the bottom layer as reference curves.
4. Use the same contour basis to build the stepped terrain solid.

### Buildings / roads / other layers

- XY comes from source geometry.
- Z must be derived from the same terrain basis that produced the terrain solid.
- If terrain bands and placement logic use different sources, the model will drift vertically.

## Current Algorithm Snapshot

### Source terrain and contour loading

- `buildSiteContext()` loads parcel, terrain grid, contours, buildings, roads.
- `resolveTerrainContext()` prefers official contour files and derives a terrain grid from them.

### Export contour preparation

- `prepareSiteContextForExport()` may refine the terrain grid and may augment display contours for finer requested intervals.
- `normalizeContourFeatureCollection()` merges and normalizes contour inputs.
- `buildClosedContourExportCollection()` now assembles export curves from the terrain contour basis first, then uses native closed loops only as level-gap fallback.

### Terrain solid generation

- `buildRawAnchoredContourBandAssembly()` builds higher-side contour areas from native contour inputs.
- `buildContourBandGroups()` mixes raw-anchored groups with grid fallback when needed.
- `getCachedCumulativeContourBandGroups()` and `getCachedRenderableContourBandGroups()` derive cumulative and renderable band groups.
- `addRhinoContourBandTerrain()` extrudes those band groups into the 3DM terrain solid.

### Z placement

- Buildings use `resolveBuildingPlacementForRing()` and `addRhinoBuildings()`.
- Roads in contour mode use `buildRoadContourSurfaceGroups()` and top-surface intersections.
- These placements are only correct if the terrain basis used for placement matches the terrain basis used for the final solid.

## Confirmed Structural Problems

1. Export curves and terrain solids were allowed to diverge.
   - Export curves could reuse generated contour features that did not come from the same contour-band basis as the final terrain solid.
   - Terrain solids come from contour band groups, but display curves could come from a different generated contour path.

2. Open contour closure is central and needs first-class diagnostics.
   - The important step is not only "can we close the curve" but also "did we choose the correct higher side."

3. Building and road Z placement are downstream consumers.
   - If terrain bands are wrong, Z placement will also be wrong.
   - We still need more explicit diagnostics that compare placement results against the final terrain basis.

4. Debug visibility had been too weak.
   - The code had many helper paths, but not enough one-shot summaries that clearly say whether curves, terrain, and placement still agree.

## Changes Introduced In This Turn

1. Added reusable site-context caching so export format changes do not force a full site-context rebuild.
2. Increased export artifact cache size so large 3DM files can actually be cached.
3. Added terrain pipeline diagnostics into export preparation:
   - canonical contour input counts
   - open contour closure counts
   - native closed loop counts
   - export contour counts by level
   - terrain-basis contour counts by level
   - cumulative/renderable band summaries
   - export-vs-terrain-basis mismatch summary
   - export-vs-band-boundary mismatch summary
   - building placement source summary
4. Switched export contour assembly to terrain-basis-first output:
   - export curves now prefer `resolvedAreaAboveByLevel` / top-surface terrain basis output
   - native closed loops only fill levels that the terrain basis still does not cover
5. Flattened 3DM contour display curves:
   - 3DM contour curves now sit on the flat reference plane instead of floating through the terrain solid
6. Preserved native contour anchor levels in heavy relaxed-interval cases:
   - `resolvedAreaAboveByLevel` now keeps native 5m anchor levels even when the render interval is coarser
7. Added regression coverage for export-vs-terrain-basis mismatch:
   - `verify:exports` now fails if 3DM export curves diverge from the terrain basis
8. Added placement diagnostics:
   - building placement now records terrain-basis elevation, delta, and alignment state
   - road placement now records terrain-basis coverage over the road footprint

## Latest Snapshot

Source:

- `node scripts/report-terrain-progress.mjs --case seoul-hillside,gyeyang-large`
- generated at `2026-04-18T15:10:08.330Z`

Summary:

- `seoul-hillside`
  - requested/source/effective interval: `1 / 5 / 1`
  - native open contours: `18`
  - accepted closures: `16`
  - rejected closures: `2`
  - native closed loops: `17`
  - terrain-basis contours: `58 features / 51 levels`
  - source/cumulative/renderable/top-surface bands: `15 / 15 / 15 / 15`
  - export-vs-terrain-basis mismatch level count: `0`
  - export-vs-band-boundary mismatch level count: `39`
- `gyeyang-large`
  - requested/source/effective interval: `1 / 5 / 2`
  - native open contours: `76`
  - accepted closures: `60`
  - rejected closures: `16`
  - native closed loops: `60`
  - terrain-basis contours: `266 features / 104 levels`
  - source/cumulative/renderable/top-surface bands: `12 / 12 / 12 / 6`
  - export-vs-terrain-basis mismatch level count: `0`
  - export-vs-band-boundary mismatch level count: `100`

Placement notes:

- Local progress snapshots may still show `buildingPlacement.sampleCount = 0` or `roadPlacement.roadFeatureCount = 0` when upstream building/road providers are unavailable in the local environment.
- The placement diagnostics themselves are covered by baseline synthetic regressions, and `verify:baseline` / `verify:exports` are green after this change.

Interpretation:

- The export contour path is now structurally tied to the terrain basis instead of reusing a separate display contour path.
- `seoul-hillside` now satisfies the intended rule at the export-vs-terrain-basis level.
- `gyeyang-large` now also satisfies the export-vs-terrain-basis rule even with `effective=2m`.
- The next real issue is no longer contour-basis alignment itself; it is downstream Z placement validation for buildings and roads.
- We now have the diagnostics needed to tell whether a building base elevation matched the terrain basis and how much of the road footprint actually received terrain-basis coverage.

## What This Turn Still Does Not Claim

- This does not mean the terrain algorithm is fully fixed.
- This is a structural alignment step plus stronger instrumentation.
- The remaining work is to validate building/road Z against that same basis and catch those failures automatically.
- Some of that validation is now instrumented, but the project still needs stronger failure gates for real-world building/road Z regressions.

## Next Steps

1. Promote the new building placement diagnostics into stronger export checks once we confirm acceptable fallback behavior on real parcels.
2. Decide a failure threshold for road terrain-basis coverage and wire that into export verification.
3. Keep export contour curves flat on the bottom reference plane across 3DM/SKP/OBJ and verify that with tests.
4. Keep updating this file every work session so the next conversation can resume from the same state quickly.
