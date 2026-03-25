# NGII Contour Source Setup

This app can now use a local official contour source file for map contour display.

Supported source formats:
- contour root directory that contains regional `.shp` files
- `.shp` shapefile base path with matching `.dbf`
- `.geojson`
- `.json` FeatureCollection

Recommended source:
- Official NGII / VWorld contour export based on the national digital topographic map

Config:
- `TERRAIN_CONTOUR_PATH`
- `TERRAIN_CONTOUR_CRS`

Example:

```json
{
  "TERRAIN_CONTOUR_PATH": "/opt/site-context-planner/data/contours",
  "TERRAIN_CONTOUR_CRS": "EPSG:5179"
}
```

Notes:
- The official contour dataset referenced from the public data portal is published in `EPSG:5179`.
- The server transforms contour coordinates to `EPSG:4326` before sending them to the browser.
- When a directory is configured, the server scans `.shp` files recursively, reads each file header bbox, and loads only the files that overlap the requested area.
- Current phase priority is map/display accuracy. Terrain heights and 3D terrain massing still rely on the existing elevation grid path.
- For deployment, do not send a nationwide shapefile directly to the browser. Keep the file on the server and clip per request, or preprocess into regional tiles.
