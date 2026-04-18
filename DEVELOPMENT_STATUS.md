# Development Status

Last updated: 2026-04-18

## Workflow

- `develop`에서 수정하고 검증한다.
- `git`에 반영한다.
- `C:\SpaceWork_deploy`를 fast-forward 한다.
- 웹 배포를 실행하고 공개 URL을 확인한다.

## Progress Tracking

- Primary document: this file
- Progress snapshot command:
  - `node scripts/report-terrain-progress.mjs --case seoul-hillside,gyeyang-large`
- Notes:
  - Use the snapshot script to see current contour closure counts, curve/terrain mismatch counts, band counts, and placement status.
  - Update this file every working session so the next conversation can resume from here.

## Current Board

- `Completed`
  - Pipeline audit: source contours -> export contours -> terrain bands -> terrain solids -> placement flow
  - Added terrain pipeline diagnostics in export preparation
  - Added progress snapshot script
  - Added persistent top-level status document
- `In Progress`
  - Replacing “display-generated contour reuse” with a terrain-basis-first export path
  - Identifying the first levels where export curves and terrain cumulative bands diverge
  - Reconnecting building/road Z placement to the same terrain basis
- `Next`
  - Rebuild terrain bands from one closed contour basis instead of separate display/band paths
  - Make 5m closed raw contours the root of both export curves and terrain solids
  - Generate intermediate 1m curves only from that closed 5m basis
  - Validate buildings and roads against the final terrain basis, not parallel fallback logic

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
- `buildClosedContourExportCollection()` closes native open contours against the clip boundary and prepares export contour curves.

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

1. Export curves and terrain solids have been allowed to diverge.
   - Export curves could reuse generated contour features that did not come from the same contour-band basis as the final terrain solid.
   - Terrain solids come from contour band groups, but display curves could come from a different generated contour path.

2. Open contour closure is central and needs first-class diagnostics.
   - The important step is not only “can we close the curve” but also “did we choose the correct higher side”.

3. Building and road Z placement are downstream consumers.
   - If terrain bands are wrong, Z placement will also be wrong.
   - We still need more explicit diagnostics that compare placement results against the final terrain basis.

4. Debug visibility has been too weak.
   - The code had many helper paths, but not enough one-shot summaries that clearly say whether curves, terrain, and placement still agree.

## Changes Introduced In This Turn

1. Added reusable site-context caching so export format changes do not force a full site-context rebuild.
2. Increased export artifact cache size so large 3DM files can actually be cached.
3. Added terrain pipeline diagnostics into export preparation:
   - canonical contour input counts
   - open contour closure counts
   - native closed loop counts
   - export contour counts by level
   - cumulative/renderable band summaries
   - curve-vs-terrain mismatch level summary
   - building placement source summary
4. Tightened export contour reuse:
   - generated contour features are only reused when they are terrain-aligned generated contours
   - arbitrary generated display contours are no longer treated as trusted export contour sources

## Latest Snapshot

Source:

- `node scripts/report-terrain-progress.mjs --case seoul-hillside,gyeyang-large`
- generated at `2026-04-18T04:53:50.450Z`

Summary:

- `seoul-hillside`
  - requested/source/effective interval: `1 / 5 / 1`
  - native open contours: `18`
  - accepted closures: `16`
  - rejected closures: `2`
  - native closed loops: `17`
  - source/cumulative/renderable/top-surface bands: `15 / 15 / 15 / 15`
  - curve-terrain mismatch level count: `37`
  - first mismatches appear immediately from `85m` upward
- `gyeyang-large`
  - requested/source/effective interval: `1 / 5 / 2`
  - native open contours: `76`
  - accepted closures: `60`
  - rejected closures: `16`
  - native closed loops: `60`
  - source/cumulative/renderable/top-surface bands: `12 / 12 / 12 / 6`
  - curve-terrain mismatch level count: `98`
  - first mismatches appear immediately from `35m` upward

Interpretation:

- The main structural problem is still present.
- Export contour curves are still much denser than the cumulative terrain band boundaries.
- That means the current model still does not satisfy the intended rule:
  - “Use the same closed contour basis for both the bottom reference curves and the terrain solid.”
- This is now measurable and visible instead of hidden.

## What This Turn Still Does Not Claim

- This does not mean the terrain algorithm is fully fixed.
- This is a structural cleanup plus instrumentation step so the next terrain fix can be made against a clearly visible pipeline.
- The remaining work is to make terrain band generation fully follow the intended “raw closed contour basis first” model.

## Next Steps

1. Use the new terrain diagnostics on the broken live cases and identify which levels diverge first.
2. Rework terrain band generation so native closed contours and generated intermediate contours are derived from one contour basis.
3. Validate building and road Z against that same terrain basis.
4. Keep updating this file every work session so the next conversation can resume from the same state quickly.
