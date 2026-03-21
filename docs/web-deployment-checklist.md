# Web Deployment Checklist

## 1. Environment Variables

Set these in the deployment environment instead of committing real values:

- `PORT`
- `VWORLD_API_KEY`
- `VWORLD_API_DOMAIN`
- `JUSO_CONFIRM_KEY`
- `BUILDING_HUB_SERVICE_KEY`
- `LAW_API_OC`
- `TERRAIN_DEM_PATH`
- `USE_NOMINATIM_FALLBACK`

Recommended:

- Set `VWORLD_API_DOMAIN` to the real production origin.
- Keep `USE_NOMINATIM_FALLBACK=true` only as a safety net, not as the main search path.
- Do not expose service keys in frontend code.

## 2. Production Runtime

- Run the Node server behind HTTPS.
- Put the app behind a reverse proxy so large 3D export responses are handled safely.
- Enable gzip or brotli for HTML, JS, CSS, and JSON responses.
- Keep request logs for `/api/geocode`, `/api/reverse-geocode`, `/api/land-info`, `/api/land-info-details`, `/api/building-register`, `/api/site-context`, and `/api/export-model`.

## 3. External API Safety

- Expect temporary failures from VWorld, Juso, BuildingHub, Open-Meteo, and OpenTopoData.
- Add response caching for repeated parcel lookups and repeated 3D range previews.
- Add simple rate limiting per client IP for heavy endpoints, especially `/api/site-context` and `/api/export-model`.
- Monitor terrain fallback frequency so large-radius exports can be tuned before users notice.

## 4. Browser QA Before Release

- Address search from the top search bar
- Map click -> address -> land summary -> land detail popup
- Map click -> building summary -> building detail popup
- `100m`, `200m`, `1000m` range preview
- OBJ download
- 3DM download in Rhino 6
- Target building highlight color
- Floating building check against terrain
- Popup blocking behavior on Chrome and Edge
- Mobile-width layout for the side panel

## 5. Operational Checks

- Verify health with `/api/config`
- Confirm the production domain is registered in VWorld
- Confirm building register keys are approved for the deployed server IP/domain policy
- Keep a rollback build for the last known-good version
- Capture one real parcel test set and reuse it as a regression checklist after each deployment
