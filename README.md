# SpaceWork Workflow

This repository now supports two local roles on the same PC:

- `C:\SpaceWork_develop`
  Full working copy for feature work, Git history, and the public test path.
- `C:\SpaceWork_deploy`
  Runtime-focused working copy for the public production path on Cloudflare.

## Public Paths

- Production hub: `https://spaceswork.net/main`
- Test hub: `https://spaceswork.net/test`

The Node app reads the route prefix from `ROUTE_BASE_PATH`.

- Production start helpers set `ROUTE_BASE_PATH=/main`
- Test start helpers set `ROUTE_BASE_PATH=/test`

## Folder Roles

### `C:\SpaceWork_develop`

Use this folder for:

- feature work
- Git commits and pushes
- local verification
- the Cloudflare test route

User-facing buttons in both `deploy` folders:

- `CLICK_1_START_BOTH_WEB.bat`
- `CLICK_2_GIT_PUSH_DEVELOP.bat`
- `CLICK_3_GIT_PULL_DEPLOY.bat`

The same three button files are kept in:

- `C:\SpaceWork_develop\deploy`
- `C:\SpaceWork_deploy\deploy`

What they do:

- `CLICK_1_START_BOTH_WEB.bat`
  - starts `https://spaceswork.net/main`
  - starts `https://spaceswork.net/test`
- `CLICK_2_GIT_PUSH_DEVELOP.bat`
  - stages, commits, and pushes from `C:\SpaceWork_develop`
- `CLICK_3_GIT_PULL_DEPLOY.bat`
  - pulls into `C:\SpaceWork_deploy`
  - restarts production
  - runs verification

### `C:\SpaceWork_deploy`

Use this folder for:

- pulling the selected Git version
- running the production server
- running the Cloudflare tunnel
- production-only verification

Internal PowerShell helpers still exist under `deploy\`, but they are support files for the three `CLICK_...` buttons.

## Git Flow

Use this simple release flow:

1. Edit and test in `C:\SpaceWork_develop`
2. Confirm the version at `https://spaceswork.net/test`
3. Commit and push the selected version to Git
4. Move to `C:\SpaceWork_deploy`
5. Run `deploy\CLICK_3_GIT_PULL_DEPLOY.bat`
6. Confirm the production version at `https://spaceswork.net/main`

## Cloudflare Tunnel

The Cloudflare tunnel configuration is stored outside this repo:

- `C:\Users\wjdek\.cloudflared\config.yml`

Use path-based ingress so one hostname can serve both apps.
An example file is included at:

- `deploy/cloudflared-config.example.yml`

Key idea:

- `/main` routes to `http://127.0.0.1:3000`
- `/test` routes to `http://127.0.0.1:3001`
- `/` routes to production so the app can redirect to `/main/`

Cloudflare documents that ingress rules can match hostname, path, or both:
<https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/>

## Deploy Worktree Cleanup

`C:\SpaceWork_deploy` can stay runtime-only by using sparse checkout.
This repo now includes:

- `deploy/configure-runtime-sparse-checkout.ps1`
- `deploy/runtime-sparse-checkout.txt`

Run once in `C:\SpaceWork_deploy` if needed:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\configure-runtime-sparse-checkout.ps1
```

`deploy\setup-home-prod.ps1` and `deploy\update-home-prod.ps1` now reapply the runtime sparse layout automatically when possible.

## Local Config Notes

`config.local.json` is local-only and is not committed.

Important values:

- `PORT`
- `ROUTE_BASE_PATH`
- `VWORLD_API_DOMAIN`
- `PUBLIC_BASE_URL`
- `PUBLIC_ENABLED_FEATURES`
- `TERRAIN_CONTOUR_PATH`

Recommended values:

- `C:\SpaceWork_deploy\config.local.json`
  - `PORT`: `3000`
  - `ROUTE_BASE_PATH`: optional, wrappers already set `/main`
  - `PUBLIC_BASE_URL`: `https://spaceswork.net/main`
- `C:\SpaceWork_develop\config.local.json`
  - `PORT`: `3001`
  - `ROUTE_BASE_PATH`: optional, wrappers already set `/test`
  - `PUBLIC_BASE_URL`: `https://spaceswork.net/test`

If `VWORLD_API_DOMAIN` is only used for origin registration, keep it as the HTTPS origin only, not the path:

- `https://spaceswork.net`

## Production Update Command

Use this command in `C:\SpaceWork_deploy` after a selected version is pushed:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\update-home-prod.ps1
```

This script now does the following:

1. `git fetch`
2. `git pull --ff-only`
3. reapply the runtime sparse checkout when configured
4. `npm.cmd install`
5. restart the managed production server on `/main`
6. run verification against `http://127.0.0.1:3000/main`

## Notes

- `CLICK_1_START_BOTH_WEB.bat` is the main daily start button.
- `CLICK_2_GIT_PUSH_DEVELOP.bat` always pushes from `C:\SpaceWork_develop`.
- `CLICK_3_GIT_PULL_DEPLOY.bat` always pulls into `C:\SpaceWork_deploy`.
- `deploy\start-server.ps1`, `deploy\start-cloudflare-tunnel.ps1`, and `deploy\update-home-prod.ps1` are the internal support files behind the three buttons.
- Runtime logs and PID files in `logs\` are local artifacts.
- Large `tmp_*`, `*.obj`, `*.3dm`, and `*.log` files are disposable local outputs.
