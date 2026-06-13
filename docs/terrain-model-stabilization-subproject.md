# Terrain Model Stabilization Subproject

## Why this exists

Recent fixes exposed that the current terrain/export stack is no longer safe to handle as isolated hotfixes.
We need one stabilization subproject that treats preview, road surfaces, 3DM contour integrity, and SKP terrain generation as one connected system.

The root architecture reset for this work now lives in:

- `docs/terrain-core-rearchitecture-plan.md`

## Scope

This subproject covers four issues:

1. Model preview is not reliably working in real use.
2. Roads can appear as filled surfaces outside the true road area.
3. `3dm` currently behaves best and must not regress.
4. `skp` terrain is over-processed and can become grid-like, jagged, or over-rounded.

## Current architecture snapshot

### 1. Preview path

- UI preview button: `public/app.js`
  - `generateModelSpec()`
  - `loadSiteContext()`
  - `updateContextLayers()`
- Server path: `POST /api/site-context`
  - `buildSiteContext()` in `server.mjs`
- Important detail:
  - current "model preview" is not a true 3D model render.
  - it loads site-context and redraws map layers.

### 2. Road path

- source loading: `resolveRoadContext()` in `server.mjs`
- derived preview/export road surfaces:
  - `buildRoadFeatureFootprintMultiPolygon()`
  - `buildRoadSurfaceFeatureCollection()`
  - `buildRoadContourSurfaceGroups()`
- risk:
  - source road polygons and our polygon-union/surface derivation are different stages.
  - every road bug must first be classified as:
    - source geometry issue
    - surface-derivation issue
    - contour-intersection issue

### 3. 3DM path

- export entry: `build3dmFromSiteContext()` in `server.mjs`
- terrain solids:
  - `resolveContourTerrainRenderPlan()`
  - `addRhinoContourBandTerrain()`
- contour display lines:
  - raw `siteContext.contourLines` are added separately as Rhino curves.
- key fact:
  - `3dm` is not only terrain solids.
  - it also preserves contour display curves as independent geometry.

### 4. SKP path

- export entry: `buildSkpFromSiteContext()` in `server.mjs`
- payload builder:
  - `buildSketchUpPayloadFromSiteContext()`
- conversion model:
  - this is not `3dm -> skp`.
  - server builds an independent `skp-payload` JSON.
  - then a standalone SKP exporter CLI converts that payload to `.skp`.
- key fact:
  - if SKP looks grid-like, the problem is likely already present in our payload generation path.

## Guardrails

### Do not casually modify these paths

- `build3dmFromSiteContext()`
- `addRhinoContourBandTerrain()`
- raw contour curve export in the 3DM path

### Rules for all changes

1. `3dm` is the reference output until a better canonical terrain core is proven.
2. Any SKP terrain change must prove that it does not change 3DM contour count, curve heights, or terrain band behavior unexpectedly.
3. Any road change must preserve raw source evidence and derived result evidence side by side.
4. Preview fixes must be isolated from export-geometry fixes whenever possible.
5. The shared terrain core may be mesh/heightfield based, but final export geometry must be format-native:
   - `3dm` should prefer Rhino surfaces, Breps, and closed polysurfaces.
   - `skp` should use closed softened face/edge meshes.
   - SKP limitations must not force 3DM to downgrade from Rhino-native geometry.

## Problem statements and hypotheses

## Initial evidence

### Probe A. Downtown road case with no source contour lines in `siteContext`

Observed from the first saved case probe:

- `siteContext.stats.contourCount = 0`
- but export-prepared `3dm` and `skp` both generated `136` contour display curves
- this happens because `prepareSiteContextForExport()` regenerates `contourLines` from `terrainGrid` when native contour display lines are absent

Implication:

- some jagged or grid-like contour problems are likely created during export preparation, not in the original site-context itself

### Probe B. Official contour case with real source contour lines

Observed from the hillside probe:

- source contour line strings: `19`
- `3dm` contour curves: `19`
- `skp` contour curve polylines: `19`
- source contour points: `1468`
- `3dm` contour curve points: `1468`
- `skp` contour curve polyline points: `1468`

Implication:

- when real source contour lines exist, both `3dm` and `skp` contour display geometry can already preserve them one-to-one
- therefore the main SKP problem is not the contour curve layer itself
- it is much more likely in the terrain solid reconstruction path

### Probe B. Same hillside case, SKP terrain solid inflation

Observed from the same probe:

- `skp` terrain layer produced `210` solids and `22,338` solid points
- `3dm` terrain layer produced `108` terrain extrusions
- `skp` terrain grid step was refined to `0.9`

Implication:

- SKP terrain is currently the most aggressively reconstructed output
- this explains why SKP can look more grid-like or over-processed than 3DM even when contour display curves are correct

### A. Preview failure

Observed concern:

- users report the preview feature is not functioning reliably.

Current likely interpretation:

- the preview button only refreshes site-context and map layers.
- therefore failures may be:
  - request/response failure
  - stale UI state
  - layer rendering failure
  - mismatch between what users expect and what preview currently does

Immediate task:

- reproduce with a failing user case and capture:
  - request payload
  - response status
  - returned `siteContext`
  - visible layer state

### B. Roads covering non-road area

Observed concern:

- some places show road surfaces spilling into non-road areas.

Known confirmed bug already found:

- polygon holes were previously dropped in `buildRoadFeatureFootprintMultiPolygon()`.

Remaining open question:

- after preserving holes, are there still false road surfaces caused by:
  - overly aggressive polygon union
  - near-merge bridge logic
  - bad source polygons
  - contour-surface intersection stage

Immediate task:

- for each failing address, compare:
  - raw road source features
  - derived road surface polygons
  - final contour road surface groups

### C. 3DM jagged contour cases

Observed concern:

- `3dm` is mostly good, but some contours become saw-toothed or spiky.

Important caution:

- the 3DM pipeline already works better than other formats.
- this means we should diagnose, not rewrite.

Likely sources to audit:

- official contour source itself
- contour-to-grid derivation
- band-region loop merging
- display curve creation from fallback/generated contours

Immediate task:

- capture examples where:
  - raw contour feature is smooth
  - exported Rhino display curve becomes jagged
- if jaggedness exists only in terrain solids and not display curves, the problem is in terrain-band generation, not contour preservation.

### D. SKP grid-like terrain and over-processing

Observed concern:

- SKP terrain appears grid-like.
- some boundaries become too jagged.
- other boundaries become too rounded.

Current architectural interpretation:

- SKP contour display polylines can preserve source curves.
- SKP terrain solids are being reconstructed from contour-band regions and terrain-grid driven logic.
- that reconstruction is the highest-risk area.

Primary hypothesis:

- SKP terrain shape is being degraded by over-reliance on:
  - terrain-grid refinement
  - contour band polygon generation
  - polygon simplification/sanitization
  - region splitting after contour reconstruction

Desired direction:

- preserve original contour curve shape as much as possible.
- use repair only when geometry is invalid for SketchUp.
- treat smoothing as an exception, not a default behavior.

## Workstreams

### Workstream 1. Preview reliability

Deliverables:

- failing preview cases list
- preview request/response trace
- UI state checklist
- regression test for real preview failure mode

## End-to-End verification rule

Terrain changes must now be checked as one connected pipeline, not as isolated hotfixes.

For every failing case, we should capture and compare these stages together:

1. source `siteContext.contourLines`
2. export-prepared `contourLines`
3. export-only `exportContourLines`
4. raw contour band groups
5. cumulative contour band groups
6. renderable terrain band groups
7. final `3dm` contour layer
8. final `skp` contour/terrain payload

The practical tool for this is:

- `node scripts/inspect-terrain-case.mjs --site-context <path>`

The output must answer at least these questions:

- Which native contour elevations exist in the source?
- Which native contour elevations survive into export contours?
- Which native contour elevations survive into renderable terrain band bottoms?
- How many internal holes exist in raw, cumulative, and renderable band stages?
- Does `3dm` keep the same contour coverage as the export contour plan?
- Does `skp` preserve the same contour coverage while avoiding terrain over-fragmentation?

If a change improves one format but breaks one of the stages above, the change is not complete.

### Workstream 2. Road provenance audit

Deliverables:

- "raw vs derived vs final" comparison for each failing road case
- source-data blame vs algorithm blame classification
- regression cases for polygon holes, union overflow, and near-merge overflow

### Workstream 3. 3DM preservation audit

Deliverables:

- locked regression set of reference addresses
- curve count, point count, z-height, and terrain object checks
- explicit protected invariants for 3DM

### Workstream 4. SKP terrain redesign

Deliverables:

- precise map of which SKP groups come from raw curves vs derived solids
- payload comparison between good 3DM case and bad SKP case
- revised strategy that prefers contour-preserving solids over grid-like reconstruction

## Regression strategy

### Mandatory reference set

Keep a small but fixed set of addresses:

- dense downtown road case
- steep hillside contour case
- orthogonal parcel boundary case
- multi-parcel split case

### Required checks before merge

1. Preview smoke passes.
2. `verify:baseline` passes.
3. 3DM regression snapshot stays within expected invariants.
4. SKP payload regression shows no new simplification drift.
5. Road case comparison confirms no new surface overflow.

## Immediate next actions

1. Reproduce the preview failure with one concrete address and one concrete symptom.
2. Add a road-debug probe that dumps:
   - raw road features
   - derived road surface collection
   - contour road surface groups
3. Add a 3DM/SKP comparison probe for one shared failing site.
4. Freeze 3DM behavior with explicit regression assertions before any larger SKP refactor.
5. Only then redesign SKP terrain generation.

## Decision

Treat this as a stabilization subproject, not a hotfix stream.

The operating rule is:

- preserve `3dm`
- diagnose roads with source-vs-derived evidence
- rebuild SKP around contour preservation
- separate preview reliability from geometry-generation reliability
