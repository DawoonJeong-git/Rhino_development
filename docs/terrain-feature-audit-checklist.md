# Terrain Feature Audit Checklist

## Purpose

Use this checklist before and after terrain-core fixes so we judge the same features in the same order.

The goal is not "looks a bit better".
The goal is:

1. Native contours remain the source of truth.
2. Generated contours fit between native levels without overlap.
3. Terrain bands follow the same contour plan that exports use.
4. Buildings and roads remain consistent across formats.

## Representative cases

Run these first:

1. Muak-dong 5m
2. Muak-dong 1m
3. Hillside 1m

Commands:

```powershell
node scripts\inspect-terrain-case.mjs --lat 37.574627 --lng 126.959388 --radius 100 --contour-interval 5 --output tmp_audit_muak_5m_clean.json
node scripts\inspect-terrain-case.mjs --lat 37.574627 --lng 126.959388 --radius 100 --contour-interval 1 --output tmp_audit_muak_1m_clean.json
node scripts\inspect-terrain-case.mjs --lat 37.57705 --lng 126.962095 --radius 100 --contour-interval 1 --output tmp_audit_hillside_1m_clean.json
node scripts\summarize-terrain-audit.mjs tmp_audit_muak_5m_clean.json tmp_audit_muak_1m_clean.json tmp_audit_hillside_1m_clean.json
```

## Global checks

### Preview

Command:

```powershell
cmd /c npm.cmd run verify:ui
```

Pass criteria:

1. `siteContextNote` says preview was refreshed.
2. Map refocuses to the active site bounds.
3. Export option summary reflects the currently selected building mode.

### Baseline

Command:

```powershell
cmd /c npm.cmd run verify:baseline
```

Pass criteria:

1. Baseline exits with `ok: true`.
2. Export queue, cache, road merge, and SKP contour checks stay green.

## Terrain checks

### 5m native contour preservation

Inspect:

1. `terrainPipeline.exportMissingNativeElevations`
2. `terrainPipeline.renderableMissingNativeBottomElevations`
3. `comparisons.threeDmContourCurves`
4. `comparisons.skpContourCurves`

Pass criteria:

1. `exportMissingNativeElevations = []`
2. `renderableMissingNativeBottomElevations` is empty or contains only the true terminal top cap
3. `3dm` and `skp` contour counts match
4. 5m terrain edges visually sit on the 5m contour loops

### 1m and 0.1m interval completeness

Inspect:

1. `terrainPipeline.canonicalContourInput.generatedLevels`
2. `terrainPipeline.renderableBandGroups.bottomElevations`
3. `terrainPipeline.exportContours.generatedFeatureCount`

Pass criteria:

1. Every interval between native anchors is filled
2. No native level disappears from export
3. Renderable band bottoms cover the full interval range except the terminal top cap

### Generated contour quality

Inspect:

1. Exported `3dm` contour layer
2. Exported `skp` contour layer
3. Any user-reported problem areas at zoomed-in scale

Fail immediately if any of these appear:

1. Overlapping contours
2. Self-crossing contours
3. Vertical or right-angle artifacts where the source terrain should be smooth
4. Duplicate generated contours at the same level

### Terrain mass integrity

Inspect:

1. `3dm` terrain layer
2. `skp` terrain layer
3. Individual terrace faces after explode / isolate in Rhino or SketchUp

Fail immediately if any of these appear:

1. Fragmented floating face pieces
2. Phantom covers over empty cutouts
3. Different terraces occupying the same XY area
4. Outer site boundary drifting away from the chosen clip boundary

## Building checks

Modes:

1. `default`
2. `remove-overlap`

Rules:

1. Building Z always follows raw contour terrain
2. `default` keeps building/terrain overlap
3. `remove-overlap` removes terrain that overlaps buildings

Pass criteria:

1. Building Z stays the same between the two modes
2. Only terrain carve behavior changes
3. Buildings do not sink below the raw contour-based terrace level

## Road checks

Inspect:

1. `siteContext.stats.roadCount`
2. `exports.threeDm.summary.layers.roads.objects`
3. `comparisons.skpRoadSolids`
4. Visual placement against terrain

Pass criteria:

1. Roads exist in source, 3DM, and SKP when road source exists
2. Roads follow the terrain cut correctly
3. No full-block road fill appears unless it exists in source geometry

## Decision rules

### Pass

Use `pass` only when:

1. Numeric checks pass
2. Visual spot-check passes
3. No user-reported artifact remains in the representative area

### Partial

Use `partial` when:

1. Core counts and intervals are correct
2. But visual artifacts or local geometry defects remain

### Fail

Use `fail` when:

1. Native levels disappear
2. Generated contours overlap or self-cross
3. Terrain bands fracture into invalid masses
4. Buildings or roads no longer align with terrain
