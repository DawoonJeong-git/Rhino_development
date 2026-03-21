# Deployment Runbook

## Recommended Shape

This app should run as a long-lived Node server, not as a static-only host and not as a serverless function.

Recommended target:

- Linux VM or VPS
- Docker-capable host
- Reverse proxy with HTTPS
- Mounted contour dataset directory

## Why

The app depends on:

- long-running Node HTTP requests for `/api/site-context` and `/api/export-model`
- local contour dataset access through `TERRAIN_CONTOUR_PATH`
- binary downloads for OBJ and 3DM exports
- external API keys that should stay server-side

## Step 1. Prepare Production Inputs

You need:

- production domain
- server or VPS with Docker
- contour dataset directory copied to the server
- production environment variables

Required environment variables:

- `PORT`
- `VWORLD_API_KEY`
- `VWORLD_API_DOMAIN`
- `JUSO_CONFIRM_KEY`
- `BUILDING_HUB_SERVICE_KEY`
- `LAW_API_OC`
- `TERRAIN_CONTOUR_PATH`
- `TERRAIN_CONTOUR_CRS`
- `USE_NOMINATIM_FALLBACK`

You can start from:

- `.env.production.example`
- `compose.yaml`
- `deploy/Caddyfile.example`

## Step 2. Copy the Contour Dataset

Copy the contour dataset to a stable directory on the server, for example:

```bash
/opt/site-context-planner/data/contours
```

Set:

```bash
TERRAIN_CONTOUR_PATH=/opt/site-context-planner/data/contours
TERRAIN_CONTOUR_CRS=EPSG:5179
```

## Step 3. Build the Container

```bash
docker build -t site-context-planner:latest .
```

Or with Compose:

```bash
cp .env.production.example .env.production
# edit .env.production
docker compose up -d --build
```

## Step 4. Run the Container

Example:

```bash
docker run -d \
  --name site-context-planner \
  -p 3000:3000 \
  -e PORT=3000 \
  -e VWORLD_API_KEY=... \
  -e VWORLD_API_DOMAIN=https://your-domain.example \
  -e JUSO_CONFIRM_KEY=... \
  -e BUILDING_HUB_SERVICE_KEY=... \
  -e LAW_API_OC=... \
  -e TERRAIN_CONTOUR_PATH=/app/data/contours \
  -e TERRAIN_CONTOUR_CRS=EPSG:5179 \
  -e USE_NOMINATIM_FALLBACK=true \
  -v /opt/site-context-planner/data/contours:/app/data/contours:ro \
  --restart unless-stopped \
  site-context-planner:latest
```

## Step 5. Reverse Proxy

Put Nginx or Caddy in front of the app and proxy to:

```text
http://127.0.0.1:3000
```

Important proxy settings:

- allow larger response bodies for OBJ and 3DM downloads
- increase upstream read timeout for long exports
- enable HTTPS

If you use Caddy, start from:

```text
deploy/Caddyfile.example
```

## Step 6. Verify Health

Check:

- `GET /api/health`
- `GET /api/config`
- `POST /api/site-context`
- `POST /api/export-model` for OBJ
- `POST /api/export-model` for 3DM

## Step 7. Final QA

Run these before public release:

- one dense terrain site
- one flat site
- one site with many buildings
- one site with no buildings
- Rhino 6 open test for 3DM
- browser test for range preview, OBJ, and 3DM download

## Step 8. Rollback Plan

Keep:

- the previous container image tag
- the previous contour dataset snapshot
- one known-good test location and expected outputs
