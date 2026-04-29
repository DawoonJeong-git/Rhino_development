# Web Deployment Checklist

## 1. Local Config

Set these in `config.local.json` and do not commit real values:

- `PORT`
- `BIND_HOST`
- `VWORLD_API_KEY`
- `VWORLD_API_DOMAIN`
- `PUBLIC_BASE_URL`
- `PUBLIC_ENABLED_FEATURES`
- `ADS_TXT_LINES`
- `JUSO_CONFIRM_KEY`
- `JUSO_COORD_CONFIRM_KEY`
- `BUILDING_HUB_SERVICE_KEY`
- `LAW_API_OC`
- `TERRAIN_DEM_PATH`
- `TERRAIN_CONTOUR_PATH`
- `TERRAIN_CONTOUR_CRS`
- `SKP_EXPORT_ENGINE`
- `SKP_EXPORTER_CLI`
- `USE_NOMINATIM_FALLBACK`

Recommended:

- keep `BIND_HOST` on loopback or leave it unset
- keep `VWORLD_API_DOMAIN` aligned with the registered HTTPS origin
- set `PUBLIC_BASE_URL` to `https://spaceswork.net/test` in `develop`
- set `PUBLIC_BASE_URL` to `https://spaceswork.net/main` in `deploy`
- keep `PUBLIC_ENABLED_FEATURES` limited to released features
- do not expose service keys in frontend code

## 2. Runtime Shape

- `C:\SpaceWork_develop` runs the test server on `127.0.0.1:3001`
- `C:\SpaceWork_deploy` runs the production server on `127.0.0.1:3000`
- Cloudflare Tunnel routes `/test` to port `3001`
- Cloudflare Tunnel routes `/main` and `/` to port `3000`
- router ports stay closed

## 3. Verification Before Release

Run these from `C:\SpaceWork_develop`:

- `npm.cmd run verify:deployment-security`
- `npm.cmd run verify:baseline`
- `npm.cmd run verify:dxf`

For the selected production clone, run:

- `powershell -ExecutionPolicy Bypass -File deploy\update-home-prod.ps1`

That update script already runs release verification against:

- `http://127.0.0.1:3000/main`
- the configured public production origin when available

Optional strict runtime check:

- `node scripts/verify-deployment-security.mjs --root C:\SpaceWork_deploy --strict-runtime`

## 4. Browser QA Before Release

Then run the live QA flow:

- address search from the top search bar
- map click to land summary and land detail popup
- map click to building summary and building detail popup
- `100m`, `200m`, `1000m` range preview
- direct range selection preview
- OBJ download
- 3DM download in Rhino 6
- DXF download in CAD
- SKP payload download
- handoff links
- hub `/main` to feature route transition
- mobile-width layout for the side panel

## 5. Operational Checks

- verify `/api/config` and `/api/health` through the running path
- confirm the production domain is registered in VWorld
- confirm building-register keys are approved for the deployed policy
- keep one rollback Git commit ready
- keep one known-good parcel test set for regression checks
- check `docs/security-release-gates.md` before sharing the URL outside the core team
- rerun `npm.cmd run verify:baseline` after any route, UI, or security change
