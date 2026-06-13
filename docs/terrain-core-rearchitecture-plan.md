# Terrain Core Rearchitecture Plan

## Why this plan exists

Recent terrain fixes improved visible symptoms, but they also showed that the current terrain stack is too tightly coupled.

Right now one logical problem can appear in many different places:

- source contour import
- contour clipping
- open-curve closure against the clip boundary
- native contour anchoring
- interpolated contour generation
- cumulative band generation
- top-surface derivation
- road and building carve
- `3dm/skp/obj/dxf` export adapters

This means hotfixes easily solve one stage while damaging another.

We need one terrain core architecture that makes the stages explicit and gives every output format the same canonical terrain plan.

## Primary goals

1. Preserve native contour geometry as the highest-priority source of truth.
2. Make displayed contours and terrain band edges come from the same canonical contour plan.
3. Separate terrain-core logic from format-specific export logic.
4. Make every stage measurable with diagnostics and regression checks.
5. Keep `3dm` behavior stable while improving other outputs.

## Non-goals

1. We are not redesigning the entire app UI in this project.
2. We are not replacing parcel/building/road data providers.
3. We are not optimizing for minimal code churn; correctness and observability come first.

## Core principles

### 1. Native contours are canonical

- Native contour curves are not a hint.
- Native contour curves are hard terrain anchors.
- Generated 1m or 0.1m contours must fit between native levels, not replace them.

### 2. One contour plan, many outputs

- `3dm` contour curves
- `skp` contour curves
- `obj/dxf` contour curves
- terrain band boundaries
- terrain top surfaces

All of these must derive from one canonical contour plan.

### 3. Open contour handling is a first-class stage

Most current failures come from partially clipped open contours.

That stage must explicitly decide:

- how an open contour snaps to the clip boundary
- which boundary path closes it
- which side is uphill
- whether the result is valid enough to become a terrain constraint

This cannot remain hidden inside export-time heuristics.

### 4. Terrain core before format adapters

`3dm`, `skp`, `obj`, and `dxf` should not each solve terrain differently.

They should receive a shared terrain core result and only translate it into their own geometry model.

### 5. Mesh-based core, native-format outputs

The shared terrain engine should be mesh/heightfield based:

- canonical height sampler
- sampled terrain grid
- triangulated or quad terrain support for diagnostics
- building and road Z lookup
- SKP/OBJ payload generation

That mesh-like core is the system contract, not necessarily the final geometry type.

Each export adapter then translates the same terrain core into the strongest native geometry for that format:

- `3dm`: Rhino-native surfaces, Breps, and closed polysurfaces whenever the available API can construct them reliably.
- `skp`: closed softened face/edge mesh, because SketchUp is face/edge based.
- `obj`: explicit mesh.
- `dxf`: reference curves and 2D CAD evidence.

Do not lower 3DM output quality to match SKP. Do not force SKP to imitate Rhino Breps. The formats should agree on terrain height and footprint, not on internal object type.

### 6. Diagnostics are part of the architecture

If we cannot answer where a contour level disappears, the architecture is incomplete.

## Proposed architecture

### Layer A. Source Context

Responsibility:

- parcel boundary
- clip boundary
- native contour source load
- terrain grid fallback source
- building source
- road source

Output:

- raw site-context inputs, not yet normalized into terrain constraints

Rules:

- preserve original provider evidence
- never silently replace native contour data here

### Layer B. Canonical Contour Input

Responsibility:

- normalize raw contour features
- merge fragmented same-elevation segments
- preserve native/generated distinction
- preserve original elevation levels

Output:

- `canonicalContourInput`

Suggested shape:

```js
{
  nativeLevels: [85, 90, 95, ...],
  generatedLevels: [86, 87, 88, ...],
  entries: [
    {
      elevation: 90,
      source: "native",
      originalGeometryType: "LineString",
      lineStrings: [...],
      merged: true
    }
  ]
}
```

### Layer C. Boundary Closure / Side Resolution

Responsibility:

- snap open contours to clip boundary
- extend to boundary only when justified
- build both possible closed areas
- determine uphill side
- reject ambiguous closures explicitly

Output:

- `closedContourConstraints`

Suggested shape:

```js
{
  elevation: 90,
  source: "native",
  closureMode: "snap+ccw",
  confidence: "high",
  closedArea: multiPolygon,
  diagnostics: {
    startBoundaryDistance: 0,
    endBoundaryDistance: 0,
    candidateCount: 2,
    selectedCandidate: 0,
    sampledElevations: [97.2, 83.4]
  }
}
```

### Layer D. Canonical Contour Plan

Responsibility:

- combine native hard anchors and interpolated contour levels
- define which elevations must exist
- define which levels are native-only anchors and which are generated intermediates
- preserve holes and nested topology

Output:

- `canonicalContourPlan`

Required invariants:

1. Every surviving native contour level must exist in the plan.
2. If interval is finer than native spacing, inserted levels must exist only between anchors.
3. Native levels must not be shifted or smoothed away.
4. Holes must remain explicit topology, not flattened away.

### Layer E. Terrain Band Plan

Responsibility:

- convert canonical contour plan into band regions
- produce:
  - raw band groups
  - cumulative band groups
  - renderable band groups
- keep topology explicit

Output:

- `terrainBandPlan`

Required invariants:

1. `renderable band bottoms` should cover all native levels except the true terminal top when appropriate.
2. `cumulative` must not destroy holes.
3. `renderable` must not silently drop levels without diagnostics.

### Layer F. Terrain Surface / Solid Plan

Responsibility:

- top surfaces
- vertical band walls
- parcel split
- building carve
- road carve

Output:

- `terrainRenderPlan`

Important rule:

- carving operations may cut geometry, but they must not redefine contour levels.

### Layer G. Format Adapters

Responsibility:

- translate canonical contour plan and terrain render plan into:
  - Rhino objects
  - SketchUp payload
  - OBJ geometry
  - DXF entities

Rules:

1. Adapters may optimize representation.
2. Adapters may sanitize invalid solids.
3. Adapters must not invent a different contour plan.

## What should become shared core objects

These should become explicit shared outputs, even if they remain inside `server.mjs` at first:

1. `canonicalContourInput`
2. `closedContourConstraints`
3. `canonicalContourPlan`
4. `terrainBandPlan`
5. `terrainRenderPlan`

If we do not materialize these stages, the same bugs will keep moving around.

## Current known structural failures

### 1. Raw-anchor closure is not reliable across all native levels

Observed in Muak-dong:

- native levels existed from `85m` to `135m`
- raw-anchor initially only produced terrain bands from `120m`

Meaning:

- boundary closure / uphill-side resolution is still unreliable for lower open contours

### 2. Cumulative topology was flattening holes

Observed and partly fixed:

- cumulative stage stripped holes
- this removed interior terrain boundaries

Meaning:

- topology preservation must be treated as an invariant, not a convenience

### 3. Export outputs were previously too independent

Observed:

- contour display and terrain solids could diverge

Meaning:

- adapters must consume shared contour/terrain plans

## Migration strategy

### Phase 0. Freeze diagnostics

Status:

- in progress

Deliverables:

- stage-by-stage terrain inspection
- missing-native-level detection
- hole-count tracking across stages

### Phase 1. Formalize canonical contour input

Deliverables:

- one function that returns normalized native/generated contour entries
- fragmented native contour merge rules
- explicit level inventory

### Phase 2. Rewrite open-contour closure as a dedicated solver

Deliverables:

- no hidden closure decisions inside export logic
- diagnostic evidence for every accepted or rejected closure
- stable side-selection logic for low and high contour bands

### Phase 3. Build canonical contour plan

Deliverables:

- one shared contour plan for display and terrain
- native levels preserved as hard anchors
- interpolated levels generated only between anchors

### Phase 4. Build terrain band and render plans from the canonical plan

Deliverables:

- raw / cumulative / renderable plans
- hole-preserving topology
- explicit missing-level assertions

### Phase 5. Simplify format adapters

Deliverables:

- adapters consume shared plans
- fewer format-specific terrain heuristics
- `3dm` and `skp` contour coverage stays aligned

## Acceptance criteria

The rearchitecture is only successful when all are true:

1. `source native elevations` and `renderable native bottoms` match for all expected levels, except the true terminal top case.
2. `3dm` contour layer and `skp` contour layer both reflect the canonical contour plan.
3. Terrain holes survive from canonical plan through renderable plan where topologically required.
4. `preview` remains isolated from terrain export regressions.
5. `verify:baseline` and `verify:ui` continue to pass.
6. A fixed set of reference sites passes the same stage-by-stage audit.

## Immediate next implementation step

Do this next:

1. Extract or formalize a dedicated `canonicalContourInput` stage from current contour normalization.
2. Add a dedicated `openContourClosureDiagnostics` output for each native contour.
3. Replace the current implicit raw-anchor closure heuristics with an explicit closure result object.
4. Only after that remove the temporary grid backfill safety net.

## Operating rule

Until the canonical contour plan is complete:

- keep the current safety backfills if they prevent catastrophic loss
- but treat them as temporary stabilization layers
- do not mistake them for the final terrain core
