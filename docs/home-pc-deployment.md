# Home PC Deployment Guide

## Goal

Run the app on your home Windows PC and expose only the Cloudflare paths for test and production.

Current target:

- production hub: `https://spaceswork.net/main`
- test hub: `https://spaceswork.net/test`

## Two-Folder Structure

Use these folders on the same PC:

- `C:\SpaceWork_develop`
  - feature work
  - Git commits and pushes
  - local test runtime
  - Cloudflare test path
- `C:\SpaceWork_deploy`
  - selected production clone
  - local production runtime
  - Cloudflare production path

Edit code only in `C:\SpaceWork_develop`.
Run the public production site only from `C:\SpaceWork_deploy`.

## Runtime Shape

The final local shape is:

```text
browser
-> https://spaceswork.net/test
-> Cloudflare Tunnel
-> 127.0.0.1:3001
-> develop server with /test

browser
-> https://spaceswork.net/main
-> Cloudflare Tunnel
-> 127.0.0.1:3000
-> deploy server with /main
```

The root path should also stay pointed at production so the app can redirect `/` to `/main/`.

## What You Need

- your home Windows PC
- Node.js
- a Cloudflare Tunnel that already serves `spaceswork.net`
- `C:\Users\wjdek\.cloudflared\config.yml`
- the contour dataset referenced by `TERRAIN_CONTOUR_PATH`

Recommended access posture:

- Cloudflare Tunnel is always on
- Cloudflare Access protects the hostname when external sharing is needed
- router ports `80` and `443` stay closed
- the Node server stays on loopback only

## User Buttons

Keep the same three user-facing button files in both of these folders:

- `C:\SpaceWork_develop\deploy`
- `C:\SpaceWork_deploy\deploy`

Buttons:

- `CLICK_1_START_BOTH_WEB.bat`
- `CLICK_2_GIT_PUSH_DEVELOP.bat`
- `CLICK_3_GIT_PULL_DEPLOY.bat`

These buttons always target the same fixed folders, so you can click them from either location.

## Local Config

Create `config.local.json` in both folders from `config.local.json.example`.

Use separate values for each folder:

- `C:\SpaceWork_develop\config.local.json`
  - `PORT`: `3001`
  - `PUBLIC_BASE_URL`: `https://spaceswork.net/test`
- `C:\SpaceWork_deploy\config.local.json`
  - `PORT`: `3000`
  - `PUBLIC_BASE_URL`: `https://spaceswork.net/main`

Shared notes:

- keep `BIND_HOST` on loopback or omit it
- keep `VWORLD_API_DOMAIN` as the registered HTTPS origin
- keep `PUBLIC_ENABLED_FEATURES` limited to released pages
- do not commit `config.local.json`

## Cloudflare Config

Use path-based ingress rules.

An example file is included here:

- `deploy/cloudflared-config.example.yml`

Expected mapping:

- `/main` -> `http://127.0.0.1:3000`
- `/test` -> `http://127.0.0.1:3001`
- `/` -> `http://127.0.0.1:3000`

## Daily Workflow

1. Start the test runtime from `C:\SpaceWork_develop`
2. Validate the selected build on `/test`
3. Commit and push the selected version
4. Update `C:\SpaceWork_deploy`
5. Validate the released build on `/main`

Daily buttons:

- `CLICK_1_START_BOTH_WEB.bat`
  - starts both `/main` and `/test`
- `CLICK_2_GIT_PUSH_DEVELOP.bat`
  - stages, commits, and pushes the develop folder
- `CLICK_3_GIT_PULL_DEPLOY.bat`
  - pulls into the deploy folder, restarts production, and verifies it

The managed `run-home-*` helpers replace the previous process and keep logs in `C:\SpaceWork_deploy\logs`.

## Network Rules

Keep these rules in place:

- do not open router ports for this app
- do not expose the Node port directly
- keep the runtime bound to loopback only
- prefer Cloudflare Access instead of home-network allowlists

## Outside Testing

Before sharing a build externally, confirm:

- `https://spaceswork.net/test` serves the current test build
- `https://spaceswork.net/main` serves the released build
- `/api/health` works through the main path
- heavy routes and exports still complete from the public path
