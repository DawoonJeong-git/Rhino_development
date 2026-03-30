# Home PC Deployment Guide

## Goal

Run the app on your home Windows PC, expose it privately, and allow only specific public IP addresses to access it.

This guide assumes:

- the app runs on your own Windows PC
- a few trusted people will use it
- you already have a Git repository for the code
- you do not want to pay for a cloud server yet

For the safest day-to-day workflow on one PC, keep two folders:

- development: `C:\SpaceWork_develop`
- production: `C:\SpaceWork_deploy`

Edit code only in the development folder. Run the public website only from the production folder.

If you still have older folders such as `C:\Rhino_develop` and `C:\Rhino_deploy`, migrate them to the `SpaceWork_*` names and remove the old folders after you verify the new paths.

## High-Level Structure

Safer recommended flow:

1. run the Node app on `localhost:3000`
2. run Cloudflare Tunnel on the same PC
3. put Cloudflare Access in front of the tunnel
4. keep the Node app private behind the tunnel

```text
friend's browser
-> your domain
-> Cloudflare
-> Cloudflare Access
-> Cloudflare Tunnel on your PC
-> Node app on localhost:3000
```

Optional direct-access flow if you are not using a tunnel:

1. run the Node app on `localhost:3000`
2. run Caddy on ports `80` and `443`
3. only accept connections from approved public IP addresses

```text
friend's browser
-> your domain
-> your home router
-> your Windows PC
-> Caddy (HTTPS)
-> Node app on localhost:3000
```

For this security build, the default recommendation is:

- Cloudflare Tunnel plus Cloudflare Access

Use the direct-access allowlist flow only when the Access path is not available.

## What You Need

- your home Windows PC
- stable internet connection
- admin access to your router
- a domain or DDNS hostname
- the public IP addresses you want to allow
- Node.js installed
- Caddy installed if you want a local reverse proxy

## Important Limits

- your PC must stay on
- your app stops when the PC sleeps or reboots
- if your home public IP changes, your domain must be updated
- if your friends' public IPs change, you must update the allowlist

## Step 1. Prepare the App

Keep these files in the project:

- `Dockerfile`
- `compose.yaml`
- `.env.production.example`
- `deploy/Caddyfile.example`
- `docs/deployment-runbook.md`

For home-PC hosting, you can run the app directly with Node first.

Recommended split on one PC:

1. Keep developing in `C:\SpaceWork_develop`
2. Create a separate production clone in `C:\SpaceWork_deploy`
3. Run the public app only from `C:\SpaceWork_deploy`

Helper scripts in this repo:

- `deploy/setup-home-prod.ps1`
- `deploy/update-home-prod.ps1`
- `deploy/start-server.ps1`
- `deploy/start-cloudflare-tunnel.ps1`
- `deploy/run-home-prod-server.bat`
- `deploy/run-home-site.bat`

## Step 2. Prepare Local Secrets

Create `config.local.json` from `config.local.json.example`.

Fill in:

- `VWORLD_API_KEY`
- `VWORLD_API_DOMAIN`
- `PUBLIC_BASE_URL` if your real public HTTPS address is different from the VWorld-registered domain
- `INTERNAL_ONLY_STATIC_PATHS` if you want unfinished pages to stay localhost-only until release
- `JUSO_CONFIRM_KEY`
- `JUSO_COORD_CONFIRM_KEY` if your address search key for `addrCoordApi.do` is separate
- `BUILDING_HUB_SERVICE_KEY`
- `LAW_API_OC`
- `ADS_TXT_LINES` if you want the server to publish `/ads.txt` directly from config
- `TERRAIN_CONTOUR_PATH`
- `TERRAIN_CONTOUR_CRS`

Do not commit `config.local.json` to Git.

Important:

- keep separate `config.local.json` files in `C:\SpaceWork_develop` and `C:\SpaceWork_deploy`
- production should only read the config inside `C:\SpaceWork_deploy`
- if VWorld is only registered for `http://localhost:3000`, you can keep `VWORLD_API_DOMAIN=http://localhost:3000` even when the public site uses a Cloudflare Tunnel hostname such as `https://spaceswork.net`
- set `PUBLIC_BASE_URL` to the real public HTTPS origin when you want `deploy/update-home-prod.ps1` to run the public smoke against the tunnel hostname separately from `VWORLD_API_DOMAIN`
- keep `INTERNAL_ONLY_STATIC_PATHS` aligned with unfinished pages so they return `404` for public visitors
- if AdSense site preview needs to iframe your pages, keep the preview-safe `AD_PREVIEW_ALLOWED_PATHS` and `AD_PREVIEW_FRAME_ANCESTORS` values
- if AdSense asks for `ads.txt`, fill `ADS_TXT_LINES` with your publisher line so `/ads.txt` responds from the same origin

## Step 3. Start the App Locally

Run:

```powershell
npm install
npm run dev
```

Check:

- `http://localhost:3000`
- `http://localhost:3000/api/health`

If you are separating development and production on one PC, do this for production:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\setup-home-prod.ps1
cd C:\SpaceWork_deploy
npm.cmd install
deploy\run-home-prod-server.bat
```

The `run-home-*.bat` helpers restart a single managed server or tunnel instance and write PID/log files into `C:\SpaceWork_deploy\logs`, so rerunning them replaces the old process instead of piling up extra windows.

## Step 4. Get a Domain or DDNS Name

You need a hostname that points to your home public IP.

You can use:

- your own domain
- a DDNS service such as DuckDNS
- Cloudflare DNS if you already have a domain

## Step 5. Fix the Home IP Problem

If your ISP changes your public IP, update DNS automatically with DDNS.

Without DDNS, the link may break after your home IP changes.

## Step 6. Router Port Forwarding Is Optional

If you are already using Cloudflare Tunnel, do not open router ports.

Recommended with Cloudflare Tunnel:

- keep router port forwarding for `80` and `443` disabled
- remove old forwarding rules if they were used before
- keep Node bound to localhost only
- if you use Docker, keep `HOST_BIND_IP=127.0.0.1` on the host side and `BIND_HOST=0.0.0.0` inside the container

Only if you are not using Cloudflare Tunnel, forward these ports from your router to your Windows PC:

- `80` -> your PC
- `443` -> your PC

Also make sure your PC has a fixed local IP address such as:

```text
192.168.0.50
```

If your PC local IP changes, port forwarding will break.

## Step 7. Install and Configure Caddy

Use Caddy as the local reverse proxy in front of Node when you need it.

If Cloudflare Tunnel points directly to `localhost:3000`, Caddy is optional.

Example Caddyfile:

```caddyfile
your-domain.example {
  @blocked not remote_ip 1.2.3.4 5.6.7.8
  respond @blocked "Forbidden" 403

  reverse_proxy 127.0.0.1:3000 {
    transport http {
      read_timeout 600s
      write_timeout 600s
      dial_timeout 10s
    }
  }
}
```

Replace:

- `your-domain.example`
- allowed public IPs

## Step 8. Add a Windows Firewall Allowlist

For stronger filtering, restrict inbound traffic in Windows Firewall when direct ports are open.

Allow only the trusted public IPs on:

- TCP `80`
- TCP `443`

This is recommended even if Caddy already blocks other IPs.

If you only use Cloudflare Tunnel and keep router ports closed, this step is usually not needed for public access.

## Step 9. Keep the App Running

Run the Node app with a process manager or a scheduled task.

Simple starting point:

- use Windows Task Scheduler to start the server at logon or startup

Better later:

- NSSM or PM2 to keep the process alive

## Step 10. Test from Outside Your Home

From a mobile network or one approved remote IP, test:

- home page opens
- range selection works
- OBJ download works
- 3DM download works

Then test from a blocked IP and confirm it gets `403`.

## Step 11. Git Workflow

Recommended flow:

1. edit locally
2. test locally
3. push to Git
4. update `C:\SpaceWork_deploy`
5. restart the production app

If the home PC is the same machine you use for development, keep the public app in the separate production folder and use:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\update-home-prod.ps1
```

That update script now does the following in order:

1. pulls the latest Git commit into `C:\SpaceWork_deploy`
2. refreshes `node_modules`
3. restarts the managed production server
4. runs `node scripts/verify-release.mjs --base-url http://127.0.0.1:3000`
5. if `config.local.json` has an HTTPS `PUBLIC_BASE_URL`, also runs a public smoke against that real share origin
6. otherwise, if `config.local.json` has an HTTPS `VWORLD_API_DOMAIN`, uses that as the public smoke origin
7. that public smoke confirms the share origin serves `/api/health` and still blocks `/api/runtime-stats` with `403`

Each run now leaves a timestamped report and `latest.json` in `C:\SpaceWork_deploy\logs\verify-release`, so you can trace which commit passed or failed after each update.

Treat `C:\SpaceWork_deploy` as a read-only release clone. Edit only in `C:\SpaceWork_develop`, push to Git, then update the deploy clone through the script above so the running app, Git revision, and smoke result stay aligned.

## Step 12. Know When to Upgrade

Move off the home PC when:

- more users start using it
- uploads/downloads become slow
- your IP changes too often
- you want true 24/7 uptime
- you want simpler maintenance
