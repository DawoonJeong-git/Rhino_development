# Home PC Deployment Guide

## Goal

Run the app on your home Windows PC, expose it to the web, and allow only specific public IP addresses to access it.

This guide assumes:

- the app runs on your own Windows PC
- a few trusted people will use it
- you already have a Git repository for the code
- you do not want to pay for a cloud server yet

## High-Level Structure

Your home PC will do three jobs:

1. run the Node app on `localhost:3000`
2. run Caddy on ports `80` and `443`
3. only accept connections from approved public IP addresses

The flow is:

```text
friend's browser
-> your domain
-> your home router
-> your Windows PC
-> Caddy (HTTPS)
-> Node app on localhost:3000
```

## What You Need

- your home Windows PC
- stable internet connection
- admin access to your router
- a domain or DDNS hostname
- the public IP addresses you want to allow
- Node.js installed
- Caddy installed

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

## Step 2. Prepare Local Secrets

Create `config.local.json` from `config.local.json.example`.

Fill in:

- `VWORLD_API_KEY`
- `VWORLD_API_DOMAIN`
- `JUSO_CONFIRM_KEY`
- `BUILDING_HUB_SERVICE_KEY`
- `LAW_API_OC`
- `TERRAIN_CONTOUR_PATH`
- `TERRAIN_CONTOUR_CRS`

Do not commit `config.local.json` to Git.

## Step 3. Start the App Locally

Run:

```powershell
npm install
npm run dev
```

Check:

- `http://localhost:3000`
- `http://localhost:3000/api/health`

## Step 4. Get a Domain or DDNS Name

You need a hostname that points to your home public IP.

You can use:

- your own domain
- a DDNS service such as DuckDNS
- Cloudflare DNS if you already have a domain

## Step 5. Fix the Home IP Problem

If your ISP changes your public IP, update DNS automatically with DDNS.

Without DDNS, the link may break after your home IP changes.

## Step 6. Set Router Port Forwarding

Forward these ports from your router to your Windows PC:

- `80` -> your PC
- `443` -> your PC

Also make sure your PC has a fixed local IP address such as:

```text
192.168.0.50
```

If your PC local IP changes, port forwarding will break.

## Step 7. Install and Configure Caddy

Use Caddy as the HTTPS reverse proxy in front of Node.

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

For stronger filtering, also restrict inbound traffic in Windows Firewall.

Allow only the trusted public IPs on:

- TCP `80`
- TCP `443`

This is recommended even if Caddy already blocks other IPs.

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
4. pull changes on the home PC
5. restart the app

If the home PC is the same machine you use for development, steps 4 and 5 are just:

```powershell
git pull
npm run dev
```

## Step 12. Know When to Upgrade

Move off the home PC when:

- more users start using it
- uploads/downloads become slow
- your IP changes too often
- you want true 24/7 uptime
- you want simpler maintenance
