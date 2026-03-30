# Web Deployment Checklist

## 1. Environment Variables

Set these in the deployment environment instead of committing real values:

- `PORT`
- `VWORLD_API_KEY`
- `VWORLD_API_DOMAIN`
- `PUBLIC_BASE_URL`
- `INTERNAL_ONLY_STATIC_PATHS`
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

- Keep `VWORLD_API_DOMAIN` aligned with the VWorld-registered origin.
- Set `PUBLIC_BASE_URL` to the real public HTTPS share origin when it differs from `VWORLD_API_DOMAIN`.
- Keep `INTERNAL_ONLY_STATIC_PATHS` listing unfinished pages so they stay blocked on the public origin.
- Keep `AD_PREVIEW_ALLOWED_PATHS` and `AD_PREVIEW_FRAME_ANCESTORS` configured if AdSense or Google ad preview needs iframe access.
- Publish `/ads.txt` before submitting the site to AdSense when your publisher line is ready.
- Keep `USE_NOMINATIM_FALLBACK=true` only as a safety net, not as the main search path.
- Do not expose service keys in frontend code.
- Leave `SKP_EXPORTER_CLI` empty unless the deployed host actually includes a standalone SKP exporter binary.

## 2. Production Runtime

- Run the Node server behind HTTPS.
- Publish the app port on `127.0.0.1` by default and expose it publicly only through a trusted reverse proxy, tunnel, or access layer.
- Put the app behind a reverse proxy so large 3D export responses are handled safely.
- Mount the contour dataset into the container instead of baking nationwide shapefiles into the image.
- Enable gzip or brotli for HTML, JS, CSS, and JSON responses.
- Keep request logs for `/api/geocode`, `/api/reverse-geocode`, `/api/land-info`, `/api/land-info-details`, `/api/building-register`, `/api/site-context`, and `/api/export-model`.

## 3. External API Safety

- Expect temporary failures from VWorld, Juso, BuildingHub, Open-Meteo, and OpenTopoData.
- Add response caching for repeated parcel lookups and repeated 3D range previews.
- Add simple rate limiting per client IP for heavy endpoints, especially `/api/site-context` and `/api/export-model`.
- Monitor terrain fallback frequency so large-radius exports can be tuned before users notice.

## 4. Browser QA Before Release

Run these first from the repo root:

- `npm run verify:deployment-security`
- `npm run verify:baseline`
- `npm run verify:dxf`
- `npm run verify:release -- --base-url http://127.0.0.1:3000`
- when the public share origin is live, also run `npm run verify:release -- --base-url http://127.0.0.1:3000 --public-base-url https://your-domain.example`

The baseline script verifies the local hub route, feature route, health/config shape, security headers, progress-token guard, body-size limit, and radius limit without depending on live external APIs.

The deployment-security script verifies the controlled-sharing defaults for bind settings, Compose exposure, release-gate docs, and local deployment files when they exist.

The release bundle covers:

- `verify:baseline`
- `verify-live-site-context`
- extended browser UI smoke for address + DXF, multi-parcel, manual range + 3DM, and `1km` + SKP
- timestamped JSON reports in `logs/verify-release` for deployment traceability
- optional public-domain security smoke for `health open + runtime-stats blocked`
- optional public-domain browser smoke when `--public-base-url` is provided

Then run any additional live browser QA you still want beyond the automated bundle:

- Address search from the top search bar
- Map click -> address -> land summary -> land detail popup
- Map click -> building summary -> building detail popup
- `100m`, `200m`, `1000m` range preview
- Direct range selection preview
- OBJ download
- 3DM download in Rhino 6
- DXF download in CAD
- SKP payload download
- `토지이음 열기` handoff
- `세움터 열기` handoff
- Target building highlight color
- Floating building check against terrain
- Hub `/` -> feature `/contour3dmodel` route transition
- Popup blocking behavior on Chrome and Edge
- Mobile-width layout for the side panel

## 5. Operational Checks

- If you use Compose variable substitution for ports or bind mounts, start with `docker compose --env-file .env.production up -d --build`.
- Verify health with `/api/config`
- Confirm the production domain is registered in VWorld
- Confirm building register keys are approved for the deployed server IP/domain policy
- Keep a rollback build for the last known-good version
- Capture one real parcel test set and reuse it as a regression checklist after each deployment
- Check `docs/security-release-gates.md` before sharing the URL outside the core team
- Re-run `npm run verify:baseline` after any route/UI/security change
