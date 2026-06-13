# Development Status

Last updated: 2026-06-14

## Workflow

- Modify and verify in `develop`.
- Commit and push with `git`.
- Fast-forward `C:\SpaceWork_deploy`.
- Run web deployment and verify the public URLs.

## Progress Tracking

- Primary document: this file
- Progress snapshot command:
  - `node scripts/report-terrain-progress.mjs --case seoul-hillside,gyeyang-large,muak-live-cache`
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
  - Added export-side placement summaries and regression gates for synthetic building/road terrain-basis alignment
  - Fixed flat-fallback road placement so contour-road surfaces still cover road footprints when top-surface groups are empty
  - Fixed flat-fallback building placement so sampled buildings resolve against the same flat terrain cap basis
  - Replaced cumulative contour-band union's array-concatenation fallback with the normalized local-union helper so boolean failures do not inflate into whole-site slab bands
  - Added a cached `muak-live-cache` terrain export regression case so the known Muak hillside failure mode is checked every export verification run
  - Switched native export curves to prefer closed raw contour loops instead of terrain-basis area boundaries
  - Added display-only closure fallback for ambiguous native open contours so export curves no longer disappear at native source levels
  - Added native contour export alignment diagnostics and made them the export verification gate instead of forcing native levels to mirror terrain-basis loop counts
  - Added an initial smooth contour terrain surface mode that uses raw contour-derived interpolation grids as mesh terrain instead of contour-band stair solids
  - Added UI selection for contour terrain surface style: stepped / smooth
  - Upgraded smooth 3DM terrain export to create a Rhino NURBS surface first, with mesh fallback only if surface creation fails
  - Split 3DM layers into `MODEL_*` and `CURVE_*` names, with clearer contour/site-boundary/building/road colors
  - Added unbroken bottom model-boundary, building, and road reference curves to 3DM exports
  - Added a closed smooth-terrain mass mesh under the NURBS surface so continuous 3DM terrain has side and bottom volume
  - Rebased smooth-mode building and road placement on the same smooth terrain Z sampler used by the NURBS surface
  - Increased `CURVE_PARCEL_CONTEXT` contrast so context parcel curves are visible in Rhino
  - Upgraded smooth SKP terrain export to use a denser softened mesh derived from the same smooth terrain height model, while keeping 3DM NURBS quality as the reference target
  - Added smooth-mode SKP road meshes and building placement alignment so exported SKP elements sit on the continuous terrain surface instead of floating above it
  - Fixed the smooth 3DM regression where the added volume mesh could read visually as a box: the NURBS surface now remains the visible top surface, while the companion mesh supplies only the side and bottom volume
  - Switched the default terrain pipeline to the current contour engine so stepped exports do not fall back to the legacy single-slab path unless explicitly selected
  - Set the 3D geometry architecture rule: the shared terrain core stays mesh/heightfield based, while export adapters emit native geometry per format (`3dm` surfaces/Breps, `skp` softened face mesh, `obj` mesh, `dxf` curves)
  - Added a rollback-safe async export job path for large model downloads: the original synchronous `/api/export-model` path remains intact, while `/api/export-jobs` runs large exports in a worker process with status polling and delayed download
  - Fixed large smooth contour terrain so `1000m` exports keep local contour relief instead of collapsing to a single high elevation; large smooth terrain now uses local contour-distance heightfield sampling rather than the global contour-area constraint
  - Switched stepped terrain solids to cumulative contour-band footprints so the lower mass fills as a continuous terrain block instead of leaving voids between thin band slices
  - Removed threshold-based collapse fallback from smooth terrain generation; continuous terrain now preserves the actual contour-derived heightfield values and disables extra elevation averaging before writing the Rhino NURBS surface
  - Rebuilt smooth SKP terrain as a closed face-shell mass: the exporter now derives the side and bottom faces from the actual top mesh boundary, so continuous terrain exports are closed SketchUp-style site-model masses instead of loose top surfaces with sparse side walls
  - Reworked native `5m` smooth 3DM terrain sampling so the surface height comes from distance interpolation between the adjacent original contour bands instead of generic nearest-contour/grid averaging
  - Changed smooth 3DM terrain surfaces to degree-1 NURBS grids and raised the control-point cap so sampled contour heights are preserved instead of being flattened by high-order control-point smoothing
  - Changed native `5m` stepped terrain band assembly to use the selected raw contour area-above stack directly, avoiding a second grid-reference clipping pass that could distort the original contour-based solid
  - Changed the default contour model settings to native `5m` interval and smooth/continuous terrain surface mode across the UI and server option normalization
  - Re-centered native contour high-side selection on raw contour topology when the terrain grid is flat or unreliable, so stepped and smooth terrain use the actual nested contour relationship instead of collapsing to rectangular grid slabs
  - Changed stepped terrain rendering so the area below the lowest native contour is one base mass, and only the contour-derived bands above that level are stacked
  - Added a smooth highest-contour cap and topology-safe candidate handling so native `5m` smooth terrain keeps the top contour elevation instead of falling back to a flat grid patch
  - Verified a synthetic nested native `5m` case: stepped 3DM now exports one base mass plus `10-15m` / `15-20m` contour bands, and smooth 3DM/SKP terrain preserves a `0-20m` continuous height range with the `20m` cap present
  - Closed the curve/model sync gap for ambiguous native open contours: terrain band assembly now keeps the same fallback contour candidates that bottom reference curves can display, so a visible contour curve is not silently omitted from stepped or smooth terrain
  - Verified a synthetic ambiguous open-contour case: the previously rejected `10m` contour now enters terrain basis as `terrain_fallback:ambiguous_higher_side` and produces a stepped `10-15m` 3DM terrain band
  - Strengthened stepped terrain basis completeness: native closed/display contour loops are merged into the terrain assembly before band construction, so visible `5m` contour loops become mandatory terrain boundaries instead of optional diagnostic curves
  - Verified synthetic stepped open-contour stack with `10m` and `15m` visible contours: terrain basis now keeps both levels and produces consecutive `10-15m` / `15-20m` bands
  - Changed stepped terrain rendering strategy from sequential band stacking to raw-line absolute-Z contour solids: each raw contour LineString is forced into a terrain footprint and extruded from the base plane to its own elevation, so a missing intermediate band can no longer shift every contour level above it
  - Tightened the stepped raw-contour rule: raw contour LineStrings are no longer allowed to disappear just because export contour closure or higher-side selection was ambiguous; the terrain builder now uses selected candidates, candidate fallback, or chord fallback before rejecting a line
  - Corrected raw-line stepped output so each layer is only one contour interval thick (`topElevation - interval` to `topElevation`) instead of extruding every contour down to the base plane
  - Grouped same-elevation raw contour lines into one terrain layer while preserving all raw line diagnostics; large outside-side candidates are intersected to keep multiple voids open, while compact candidates are unioned into the same layer
  - Added bottom-up stepped terrain containment: the model rectangle is the initial base footprint, each higher contour level is clipped to the immediately lower footprint, and equal/overlapping footprints are treated as valid containment rather than a dropped layer
  - Added containment-side recovery for repeated or boundary-sharing contour footprints, so a selected outside-side candidate can flip back to the side that actually overlaps the lower terrain layer instead of silently disappearing
  - Corrected same-elevation contour grouping to use the current lower footprint as its reference area, not the full model range; this keeps large-range exports from misclassifying local contour sides and builds one non-overlapping footprint per Z level
  - Added a Z-level closure pass for stepped terrain: same-elevation raw contours are resolved as one layer inside the immediately lower footprint, closed loops are reserved first, and open contours are closed only inside the remaining same-level working domain
  - Reconnected stepped building/road placement to the same absolute-Z top-surface groups used by final terrain solids, so placement overlap prefers the visible terrain surface over parallel grid/sample fallbacks
  - Switched stepped contour reference curves to the same absolute-Z level footprints used by the final terrain solids, so same-elevation closed curves are resolved before mass creation instead of overlapping as raw native loops
  - Split stepped terrain output into a separate full-rectangle `TERRAIN_BASE_MODEL` below the contour stack and `TERRAIN_CONTOUR_MODEL` geometry above it, so the base no longer fills the lowest contour layer as a joined complement shape
  - Removed the contour interval, terrain engine, and building-terrain processing controls from the UI; exports now force native `5m`, current terrain engine, and default building placement internally
  - Regression guard from the option-removal cleanup: keep `5m` as the request/UI default, but do not turn shared numeric helpers such as `normalizeContourInterval()` into hard-coded constants, because contour elevations and level keys must continue to use their real Z values
  - Restored stepped open-contour closure inside the lower footprint so each clipped contour considers both the closed candidate and its same-domain complement; this recovers the full native `5m` contour stack while keeping `TERRAIN_BASE_MODEL` separate from `TERRAIN_CONTOUR_MODEL`
  - Aligned SKP contour reference curves with 3DM by preferring `curveContourLines` for payload polylines; stepped SKP now preserves the same native `5m` bottom contour curves instead of emitting only the normalized terrain-construction contours
  - Added `verify:contour-defaults` SKP payload checks for stepped and smooth terrain: stepped SKP must include `TERRAIN_BASE_MODEL`, `TERRAIN_CONTOUR_MODEL`, and flat native contour curves; smooth SKP must include a closed `TERRAIN_MESH` with side and bottom faces
  - Verified real 100m SKP output after the contour-curve fix: stepped SKP payload keeps 19 contour curves and the actual `.skp` export completes successfully
  - Verified 1000m SKP payloads through async export jobs: smooth exports as a closed `TERRAIN_MESH` over the full 25-335m range, and stepped exports as one base solid plus 1186 contour solids with 1198 flat contour curves
  - Added strict golden checks to `verify:contour-defaults` for the native `5m` Muak-dong 82 case: native contour counts/elevations, stepped 3DM/SKP counts, smooth 3DM/SKP counts, SKP terrain face count, and closed smooth SKP mass status are now locked.
  - Added `[export-timing]` logs to split export time into queue wait, site-context build, export preparation, and format generation time without changing generated geometry.
  - Set smooth 3DM terrain surface, side, and bottom Brep/surface object attributes to `wireDensity=-1` so Rhino displays the continuous terrain with fewer internal surface wires while preserving the same geometry and SKP payload.
  - Added `verify:predeploy-terrain` as the pre-deploy terrain gate and documented it in the deployment runbook.
  - Added `[prepare-timing]` logs plus shared caches for contour render plans, absolute contour level curves, and refined native contour terrain grids; repeated 5m exports now reuse the same derived terrain basis without changing 3DM/SKP geometry.
  - Added closed contour export collection and terrain diagnostics caches, and skipped generated native-band area calculation when the requested contour interval already matches the source interval; repeated stepped 5m export preparation now drops from seconds to sub-second timing while preserving the golden 3DM/SKP outputs.
  - Optimized native `5m` stepped 3DM cold export preparation without changing golden geometry: absolute-Z level curves are built directly before fallback closed-contour export curves, raw contour band assemblies are cached, and native-interval paths skip grid-reference area generation that is unnecessary when source/request intervals match.
  - Verified the optimized Muak-dong 82 public `/test` stepped 3DM export: `verify:predeploy-terrain` passes, output remains `1,222,263` bytes, server internal cold export timing is about `23.7s`, and repeated identical downloads hit the preprepared export cache in about `1.3s`.
  - Further reduced native `5m` stepped 3DM cold export by skipping export-time native terrain-grid refinement only for stepped 3DM at the native source interval. The Muak-dong 82 regression still passes terrain level/footprint/object/curve/road-coverage checks; the output is not byte-identical (`1,218,103` bytes), but the public `/test` cold download dropped to about `11.5s` with server internal timing about `10.4s`.
  - Closed the current feature-preserving optimization round: native-interval checks and empty grid-reference results are centralized in helpers, building placement now evaluates lower-priority fallback samplers only when the terrain-basis overlap path cannot resolve Z, `verify:predeploy-terrain` still passes, and the public `/test` stepped 3DM cold download remains about `11.9s` (`1,218,103` bytes, server internal `10.5s`).
  - Fixed the smooth terrain outer-boundary interpolation drift: generated footprint/closure boundaries are no longer allowed to win contour-height snapping over native raw contour segments, so boundary-touching native contours keep their own elevation on the continuous height model.
  - Added smooth boundary-contour regression coverage to `verify:contour-defaults`; the Muak-dong 82 native `5m` case now samples boundary-touching contour points and fails if the smooth height model drifts from the raw contour elevation.
  - Final pre-release terrain gate passed on 2026-06-14: `verify:predeploy-terrain` passes for stepped 3DM/SKP and smooth 3DM/SKP, smooth boundary alignment checks `53` samples with `0` mismatches and max delta `0.479m`, and smooth SKP remains a closed terrain mass.
  - Updated the UI smoke verification to match the current supported export formats after DXF/OBJ removal; `/test` UI smoke now downloads a 3DM model successfully from the live form flow.
- `In Progress`
  - Turning live-case placement diagnostics into stricter export-side failures where upstream data is actually available
  - Validating native `5m` smooth and stepped 3DM output on real upstream-fed parcels
  - Validating full large-range SKP binary exports with buildings and roads after the payload route is stable
  - Moving smooth 3DM volume from mesh side/bottom helper geometry toward Rhino-native Brep/surface adapter output
- `Next`
  - Validate buildings and roads against the final terrain basis, not parallel fallback logic
  - Add explicit export-side checks for building/road terrain-base mismatches
  - Keep reducing band-boundary mismatch noise so the diagnostics point only at real geometry errors
  - Add full regression coverage for smooth contour terrain exports after the baseline route-prefix conflict is cleaned up
  - Add automated SKP payload/export regression coverage for smooth terrain face smoothing and smooth road/building Z alignment

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
4. Use the same closed contour basis at its absolute Z elevation to extrude contour terrain solids.
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

### Export geometry architecture

- Shared terrain generation stays mesh/heightfield based.
- `3dm` adapters may emit Rhino-native surfaces/Breps where the format benefits from them.
- Native `5m` smooth 3DM terrain samples heights from adjacent contour-band boundaries and writes a degree-1 NURBS surface so the visible surface preserves sampled contour elevations.
- `skp` smooth terrain is a SketchUp-style closed face-shell mass: top terrain mesh, side walls, and bottom cap must share the same boundary edges so the result behaves as a site-model mass rather than a loose surface.

### Source terrain and contour loading

- `buildSiteContext()` loads parcel, terrain grid, contours, buildings, roads.
- `resolveTerrainContext()` prefers official contour files and derives a terrain grid from them.

### Export contour preparation

- `prepareSiteContextForExport()` may refine the terrain grid and may augment display contours for finer requested intervals.
- `normalizeContourFeatureCollection()` merges and normalizes contour inputs.
- `buildClosedContourExportCollection()` now assembles export curves from the terrain contour basis first, then uses native closed loops only as level-gap fallback.

### Terrain solid generation

- `buildRawAnchoredContourBandAssembly()` builds higher-side contour areas from native contour inputs.
- Native closed/open contour higher-side selection now prefers raw contour containment/topology when available, with terrain-grid sampling used as a secondary signal rather than the only decision source.
- Ambiguous native open contours are no longer display-only: when a contour has usable closure candidates but no decisive higher-side signal, terrain assembly records a `terrain_fallback:*` candidate and lets the cumulative terrain constraints keep it aligned with neighboring contour levels.
- Displayable native contour loops are also injected into terrain assembly as `display_loop_fallback:*` candidates when the stricter raw-anchor selector missed them. For native `5m` stepped terrain, a visible contour level must therefore be present in the terrain basis before stacking.
- `buildContourBandGroups()` mixes raw-anchored groups with grid fallback when needed.
- `getCachedCumulativeContourBandGroups()` and `getCachedRenderableContourBandGroups()` derive cumulative and renderable band groups.
- Stepped render output now prefers `absoluteContourGroups` derived directly from raw `contourLines`; `3dm`, `obj`, and `skp` adapters place each layer at its absolute contour elevation with one effective contour-interval thickness.
- The raw absolute-Z path records `absoluteContourRawLineStringCount`, `absoluteContourRawAcceptedCount`, and `absoluteContourRawRejectedReasons` so any remaining dropped contour is visible as a hard diagnostic instead of a visual surprise.
- Same-elevation raw contour lines are combined into a single layer group before export, and each stepped layer uses a thickness equal to the effective contour interval.
- Absolute-Z stepped groups are constrained bottom-up: the base starts as the full model boundary, each level must remain inside or overlapping the level below it, and repeated/identical footprints are preserved as valid stacked layers.
- Same-Z contour candidates are clipped and classified against the immediately lower footprint before boolean combination, so the construction logic prevents overlapping same-level solids instead of detecting overlaps after export.
- Same-Z closure now treats closed and open contours together: closed loops reserve their own regions inside the lower footprint first, open contour closures run against the lower footprint domain with those reserved regions removed, and the final level footprint is assembled from those non-overlapping parts.
- `addRhinoContourBandTerrain()` uses the absolute-Z contour groups when available, with the older renderable band groups kept as fallback.
- `resolveContourTerrainRenderPlan()` uses the lowest native contour band as the top of the base mass when native bands exist, avoiding repeated grid-derived slabs below the actual contour terrain.
- Native `5m` smooth terrain uses the same contour band basis, interpolates between adjacent contour boundaries, and adds a highest-contour cap for the innermost/top region.

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
9. Promoted placement diagnostics into export verification where safe:
   - `verify:exports` now carries 3DM building/road placement summaries in the result object
   - export verification now fails if sampled building placements disagree with the terrain basis
   - baseline synthetic road regression now fails if the road footprint is not covered by terrain-basis surfaces
10. Fixed flat contour-road fallback:
   - when contour top-surface groups are empty but the terrain falls back to a flat contour cap, road surfaces now intersect against that flat cap instead of disappearing
   - road coverage diagnostics now clamp numeric over-coverage so `coverageRatio` stays within the real footprint
11. Fixed flat contour-building fallback:
   - when contour band overlap is unavailable but the terrain falls back to a flat contour cap, building placement now treats that flat cap as the terrain basis
   - export verification now fails if sampled buildings never resolve against the terrain basis
12. Hardened cumulative contour-band union:
   - `buildCumulativeContourBandGroups()` now uses `unionLocalMultiPolygons()` instead of falling back to raw array concatenation when polygon boolean union fails
   - this specifically targets mid-stack whole-site slab bands like the ones seen in Muak 3DM exports
13. Added a cached Muak regression case:
   - `verify:exports` and `report-terrain-progress` now include `muak-live-cache`
   - this uses `tmp_muak_live_site_context.json` so the known hillside geometry can be checked without depending on a fresh upstream geocode/provider lookup
14. Re-centered export contour curves on native contour closure:
   - native source elevations now export from `buildNativeContourLoopEntries(..., { allowAmbiguousFallback: true })` before any terrain-basis-derived loops are considered
   - terrain-basis-derived contour loops are now reserved for non-native generated levels only
15. Added native contour export alignment telemetry:
   - diagnostics now report whether native source elevations exported the expected count of `native-source-closed` loops
   - `verify:exports` now fails on native contour export alignment mismatches rather than treating export-vs-terrain-basis count differences as the primary correctness gate

## Latest Snapshot

Source:

- `node scripts/report-terrain-progress.mjs --case seoul-hillside,gyeyang-large,muak-live-cache`
- generated at `2026-04-18T17:34:58.654Z`

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
- `muak-live-cache`
  - requested/source/effective interval: `1 / 5 / 1`
  - native open contours: `16`
  - accepted closures: `12`
  - rejected closures: `4`
  - native closed loops: `strict 12 / display 16 / fallback 4`
  - terrain-basis contours: `85 features / 56 levels`
  - source/cumulative/renderable/top-surface bands: `55 / 55 / 55 / 55`
  - native export alignment mismatch level count: `0`
  - export-vs-terrain-basis mismatch level count: `7`
  - export-vs-band-boundary mismatch level count: `6`

Placement notes:

- Local progress snapshots may still show `buildingPlacement.sampleCount = 0` or `roadPlacement.roadFeatureCount = 0` when upstream building/road providers are unavailable in the local environment.
- The placement diagnostics themselves are covered by baseline synthetic regressions, and `verify:baseline` / `verify:exports` are green after this change.

Interpretation:

- The export contour path is now structurally tied to the terrain basis instead of reusing a separate display contour path.
- `seoul-hillside` now satisfies the intended rule at the export-vs-terrain-basis level.
- `gyeyang-large` now also satisfies the export-vs-terrain-basis rule even with `effective=2m`.
- The next real issue is no longer contour-basis alignment itself; it is downstream Z placement validation for buildings and roads.
- We now have the diagnostics needed to tell whether a building base elevation matched the terrain basis and how much of the road footprint actually received terrain-basis coverage.
- After promoting placement gates, `seoul-center` exposed a real flat-fallback road bug (`roadCoverage=0` with `roadFeatureCount=3`), and that fallback is now fixed so current `verify:exports` is green again.
- `seoul-center` also exposed that flat-fallback buildings were still using sampled Z without a terrain-basis reference (`terrainBasisAvailableCount=0`), and that is now fixed so current `verify:exports` reports `terrainBasisAvailableCount=3`.
- `muak-live-cache` is now part of the default export regression set, and current verification shows `3dm terrainBands.trailingFullFootprintBandCount = 0` there after the cumulative-union fix.
- `muak-live-cache` now also shows `nativeExportAlignment.mismatchLevelCount = 0`, while `curveTerrainAlignment` is intentionally non-zero because native source curves are no longer forced to imitate terrain-basis loop counts at native elevations.

## What This Turn Still Does Not Claim

- This does not mean the terrain algorithm is fully fixed.
- This is a structural alignment step plus stronger instrumentation.
- The remaining work is to validate building/road Z against that same basis on real upstream-fed cases and catch those failures automatically.
- Synthetic placement regressions are now stricter, but real-case road/building gates still depend on upstream data availability in the verification environment.

## Next Steps

1. Capture real upstream-fed building/road placement diagnostics from representative parcels and set tighter live-case failure thresholds.
2. Keep export contour curves flat on the bottom reference plane across 3DM/SKP/OBJ and verify that with tests.
3. Reduce band-boundary mismatch noise so terrain diagnostics focus on true geometry errors instead of expected cumulative-vs-boundary differences.
4. Keep updating this file every work session so the next conversation can resume from the same state quickly.
5. Validate the new smooth contour terrain surface mode on representative real parcels and promote the synthetic smooth-mode check into automated regression coverage.
