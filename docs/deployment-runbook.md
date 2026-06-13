# Deployment Runbook

## Final Shape

This project now uses one home PC and one Cloudflare hostname with two paths.

- test: `https://spaceswork.net/test`
- production: `https://spaceswork.net/main`

Folder split:

- `C:\SpaceWork_develop`
  Full working copy for feature work, Git commits, and the test route.
- `C:\SpaceWork_deploy`
  Runtime-focused working copy for the production route.

## Release Order

Use this exact sequence for each release:

1. Edit and test in `C:\SpaceWork_develop`
2. Run `deploy\CLICK_1_START_BOTH_WEB.bat`
3. Confirm the selected version at `http://127.0.0.1:3001/test`
4. If Cloudflare test routing is active, confirm the same build at `https://spaceswork.net/test`
5. Commit and push the selected version from `C:\SpaceWork_develop`
6. Move to `C:\SpaceWork_deploy`
7. Run `powershell -ExecutionPolicy Bypass -File deploy\update-home-prod.ps1`
8. Confirm the production build at `http://127.0.0.1:3000/main`
9. Confirm the public production build at `https://spaceswork.net/main`

## Required Local Inputs

Keep these ready before release:

- `config.local.json` in both folders
- the contour dataset directory referenced by `TERRAIN_CONTOUR_PATH`
- `C:\Users\wjdek\.cloudflared\config.yml`
- `deploy/cloudflared-config.example.yml` as the routing reference

Recommended local settings:

- `C:\SpaceWork_develop\config.local.json`
  - `PORT`: `3001`
  - `PUBLIC_BASE_URL`: `https://spaceswork.net/test`
- `C:\SpaceWork_deploy\config.local.json`
  - `PORT`: `3000`
  - `PUBLIC_BASE_URL`: `https://spaceswork.net/main`

`ROUTE_BASE_PATH` can stay out of `config.local.json` because the shared start button and PowerShell helpers already set it:

- `deploy\CLICK_1_START_BOTH_WEB.bat` starts `/test` on port `3001`
- `deploy\CLICK_1_START_BOTH_WEB.bat` starts `/main` on port `3000`

## Cloudflare Routing

Cloudflare Tunnel should route:

- `/test` to `http://127.0.0.1:3001`
- `/main` to `http://127.0.0.1:3000`
- `/` to `http://127.0.0.1:3000`

Keep router port forwarding closed unless you intentionally choose a different access model.

## Verification

Run these in `C:\SpaceWork_develop` before promoting a build:

```powershell
npm.cmd run verify:predeploy-terrain
npm.cmd run verify:baseline
```

`verify:contour-defaults` is the hard regression gate for the native 5m
contour terrain work. It locks the Muak-dong 82 golden case across stepped and
smooth terrain, 3DM geometry, SKP payload geometry, flat reference contour
curves, and closed smooth SKP terrain mass counts. Run it after every terrain,
export, UI option, or optimization change before checking the public `/test`
page.

Run the production update from `C:\SpaceWork_deploy`:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\update-home-prod.ps1
```

That script now:

1. pulls the selected Git branch
2. reapplies the runtime sparse checkout
3. refreshes dependencies
4. restarts the production server on `/main`
5. runs release verification against `http://127.0.0.1:3000/main`

The default release UI gate is the smoke suite. The extended UI suite includes
larger multi-parcel/SKP flows and should be run explicitly as a long-running QA
check when needed:

```powershell
npm.cmd run verify:ui:extended -- --base-url http://127.0.0.1:3001/test
```

If you want a stricter runtime-only check on the production clone, run:

```powershell
node scripts/verify-deployment-security.mjs --root C:\SpaceWork_deploy --strict-runtime
```

## Rollback

If production fails after release:

1. reset the deploy clone to the previous known-good Git commit
2. rerun `powershell -ExecutionPolicy Bypass -File deploy\update-home-prod.ps1`
3. recheck `https://spaceswork.net/main`

Keep one known-good parcel test case and its expected results so rollback validation stays fast.
