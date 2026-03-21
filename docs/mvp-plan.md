# Site + Building 3D Generator MVP Plan

## Goal

Build a Korea-focused planning tool that lets a user:

1. Search an address or click a location on a map
2. Select one or more actions:
   - Land info
   - Regulation info
   - Building register info
   - 3D model generation
3. Generate a site-context model containing:
   - Site boundary
   - Terrain / contour-based ground model
   - Target building footprint
   - Surrounding building masses
   - Optional road context
   - Optional lane / crosswalk context where data is available

## Recommended Product Shape

Use a web-first architecture.

- Frontend:
  - Map search
  - Parcel / building picking
  - Action panel
  - Export job panel
- Backend:
  - Spatial query orchestration
  - Geometry generation
  - File export
  - Caching of export jobs and generated files

Rhino integration should be treated as an export target, not as the core runtime.

## Why Web-First

- The hard part is data collection and geometry generation, not Rhino UI.
- Rhino can be supported later via `.3dm` export using `rhino3dm`.
- SketchUp can be supported with neutral formats first.
- This keeps the core pipeline reusable.

## Primary User Flow

1. User searches an address or clicks the map
2. System resolves coordinates and selected parcel/building
3. UI shows a right-side action panel:
   - Land info
   - Regulation info
   - Building register
   - Generate 3D
4. User clicks one action
5. System either:
   - opens official government pages, or
   - shows summarized info, or
   - starts a geometry export job

## Data Sources

### 1) Base search / geocoding

- VWorld Geocoder API
- Juso address API can be added as fallback

### 2) Parcel boundary

- VWorld continuous cadastral map
- Main geometry key: parcel polygon
- Main business key: PNU

### 3) Building geometry + building attributes

- VWorld building info
- Useful attributes:
  - building name
  - use
  - above-ground floors
  - basement floors
  - area
  - site area
  - height

### 4) Terrain

- Start with contour-driven terrain or available DEM / national map data
- Keep terrain generation modular because the terrain source may evolve

### 5) Road context

- VWorld / national base map road layers for basic road context
- Use centerline or road boundary when available

### 6) Lane / crosswalk context

- Phase 2 feature
- Prefer NGII precision road map where coverage is available
- Fall back to local open datasets only when reliable

### 7) Building register details

- Architecture HUB building register API for in-app structured data
- Official download / issuance should still link to the official service

## Feature Design

### A. Land info

Goal:

- Open official land information pages for the selected parcel

Behavior:

- Show parcel summary in-app:
  - address
  - PNU
  - parcel area
  - official land price if available
- Provide buttons:
  - Open 토지이음
  - Open 일사편리

Notes:

- Official issuance / legal documents should stay on official sites

### B. Regulation info

Goal:

- Help the user quickly understand what to inspect
- Do not over-promise legal certainty

Recommended MVP behavior:

- Show a "reference only" regulation summary
- Surface:
  - land-use district / zone / area
  - district unit plan presence
  - height-related restrictions if available
  - road contact / major basic checks where derivable
- Provide official buttons:
  - Open 토지이음 detailed parcel page
  - Open 국가법령정보센터 related laws
  - Open municipality ordinance / district plan page when available

Important rule:

- The app should not initially output a final "buildable / not buildable" verdict.
- It should output "items to verify" plus official links.

### C. Building register

Goal:

- Load structured building register information inside the app
- Also provide direct official issuance / download access

In-app summary:

- building name
- main use
- total floor area
- site area
- building area
- floor-area ratio
- building coverage ratio
- above / below ground floors
- approval date

Buttons:

- Open 세움터 / 정부24 official issuance path
- Download JSON snapshot from our app

### D. 3D generation

Goal:

- Generate planning-ready context geometry

Input options:

- range shape:
  - circle
  - rectangle
  - parcel-based
- radius / width / depth
- contour interval
- terrain mode:
  - flat
  - contour
  - mesh terrain
- building height mode:
  - use VWorld height
  - use floor count x default floor height
  - hybrid fallback
- include layers:
  - parcel boundary
  - target parcel fill
  - surrounding parcels
  - target building
  - surrounding buildings
  - contours
  - roads
  - lane / crosswalk

Output:

- `3dm` for Rhino users
- `dxf` for CAD / SketchUp interoperability
- `obj` for generic mesh workflows
- optional `json` metadata file

## Layer Convention

- `SITE_BOUNDARY`
- `SITE_PARCEL`
- `PARCEL_CONTEXT`
- `TARGET_BUILDING`
- `BUILDING_CONTEXT`
- `TERRAIN_MESH`
- `CONTOUR_MAJOR`
- `CONTOUR_MINOR`
- `ROAD_CENTERLINE`
- `ROAD_EDGE`
- `ROAD_MARKING`
- `CROSSWALK`
- `ANNOTATION`

## Geometry Rules

### Parcel

- Preserve parcel linework exactly as source geometry when possible
- Store parcel boundary separately from terrain mesh

### Buildings

- Generate solid masses from footprints
- Height priority:
  1. explicit building height
  2. floor count x default floor height
  3. user override

### Terrain

- Terrain should be clipped to the selected shape
- Contours should be generated as separate export layers
- Terrain and parcel boundary must not be merged into a single uneditable mesh if avoidable

## Legal / Policy Strategy

Because this is a low-frequency internal tool for acquaintances:

- prioritize usability over full automation
- use official links for legally sensitive outputs
- keep authoritative issuance and certificate download on government services

For the regulation module:

- summarize
- link
- warn that final confirmation must be made on official sources

## Recommended Tech Stack

### Frontend

- Next.js
- TypeScript
- MapLibre GL JS or OpenLayers
- simple side panel UI

### Backend

- Python recommended
- FastAPI
- shapely
- pyproj
- rasterio / GDAL as needed
- trimesh or equivalent mesh tooling
- ezdxf
- rhino3dm

Reason:

- Python has the strongest geometry and GIS toolchain for this problem

## MVP Scope

### Phase 1

- address search
- map click
- parcel boundary fetch
- building footprint + height fetch
- land info links
- regulation summary + links
- building register summary
- 3D export with:
  - parcel boundary
  - terrain
  - surrounding buildings
  - `3dm`
  - `dxf`
  - `obj`

### Phase 2

- lane / crosswalk support
- richer road geometry
- district-plan-aware rule cards
- direct Rhino-specific plugin helper
- smarter terrain source selection

### Phase 3

- true regulation engine
- municipality ordinance integration
- direct SketchUp native export

## Practical Recommendation

Build the first version around this simple contract:

- Input: address or clicked point
- Resolve: parcel + target building + nearby context
- Actions:
  - land info
  - regulation info
  - building register
  - generate 3D
- Output: reference links plus planning-ready geometry files

That is already a very strong MVP.
