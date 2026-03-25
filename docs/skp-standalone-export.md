# SKP Standalone Export

This project treats `.skp` export as a standalone conversion step. Do not assume `SketchUp.exe` is installed on the server.

## Runtime config

Set the following values:

```env
SKP_EXPORT_ENGINE=standalone-cli
SKP_EXPORTER_CLI=/absolute/path/to/skp-exporter
```

`SKP_EXPORTER_CLI` must point to a standalone executable that can create a latest-compatible `.skp` file without launching the SketchUp desktop app.

## API paths

Use these server endpoints when integrating an external SKP exporter:

1. `POST /api/export-skp-payload`
Returns a JSON envelope with export stats and the raw SketchUp payload.

2. `POST /api/export-model` with `options.exportFormat = "skp-payload"`
Downloads the raw payload as `site-context-*.skp.json`.

3. `POST /api/export-model` with `options.exportFormat = "skp"`
Runs the configured standalone CLI and returns the final `.skp` file.

## CLI contract

The standalone exporter is expected to support:

```bash
skp-exporter --input site-context.json --output site-context.skp
```

The server writes the payload JSON to a temp directory, invokes the CLI, and waits for the output file to appear.

## Payload shape

The raw payload is JSON with this structure:

```json
{
  "units": "meters",
  "groups": [
    {
      "layer": "terrain",
      "name": "TERRAIN",
      "faces": [],
      "polylines": [],
      "solids": []
    }
  ]
}
```

Each group may contain:

- `faces`: planar face loops
- `polylines`: open or closed polylines
- `solids`: extruded prism definitions with outer and hole loops

## Notes

- `skp-payload` uses the same contour-preservation rules as `skp`.
- Native/source contour lines are preserved for display geometry.
- Terrain band intervals may still be relaxed internally for stability when the requested interval is too dense, such as `0.1m`.
