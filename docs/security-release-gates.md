# Security Release Gates

## Purpose

This document is the release gate for the current security build.

Use it right before sharing the app with acquaintances.

If any hard stop below fails, do not share the URL yet.

## Target Release Shape

This build is acceptable for:

- acquaintance-only sharing
- controlled access through Cloudflare Tunnel plus Cloudflare Access
- fallback controlled access through a reverse proxy plus an explicit IP allowlist

This build is not acceptable for:

- open public indexing
- public-by-default home router exposure
- anonymous internet traffic without an access layer

## Gate 1. Access Path

Release only if one of these is true:

- Cloudflare Tunnel is active and Cloudflare Access protects the hostname
- a reverse proxy is in front of the app and only an explicit IP allowlist can reach it

For this project stage, the recommended path is:

- Cloudflare Tunnel plus Cloudflare Access

Fallback only when Access is not available:

- reverse proxy plus strict allowlist

## Gate 2. Exposure Defaults

Release only if the runtime bind shape matches one of these safe patterns.

Docker pattern:

- `HOST_BIND_IP=127.0.0.1`
- `BIND_HOST=0.0.0.0`
- external access happens only through Tunnel, Access, or a trusted proxy

Direct Node pattern:

- `BIND_HOST=127.0.0.1`
- or omit `BIND_HOST` and rely on the server default
- external access happens only through Tunnel, Access, or a trusted proxy

Network rule:

- if Cloudflare Tunnel is being used, keep router ports closed unless there is a deliberate reason to open them

## Gate 3. Automated Verification

Run these from the repo root:

```bash
npm run verify:baseline
npm run verify:deployment-security
```

Release only if both commands pass.

If you want to validate a separate deployment clone from the development workspace, run:

```bash
node scripts/verify-deployment-security.mjs --root C:\SpaceWork_deploy
```

If you want to validate the actual runtime values on the share target more strictly, run:

```bash
node scripts/verify-deployment-security.mjs --root C:\SpaceWork_deploy --strict-runtime
```

If the public share origin is live, also run:

```bash
npm run verify:public-origin -- --base-url https://your-domain.example
```

The strict runtime mode is intended to catch real-share blockers such as:

- `VWORLD_API_DOMAIN` still pointing at `localhost`
- missing contour dataset paths in the actual runtime config

`verify:baseline` covers:

- core routes
- security headers and CSP posture
- path traversal guard
- outbound timeout handling
- public error normalization
- request token and body/radius protections

`verify:deployment-security` covers:

- safe Compose defaults
- safe example env/config values
- allowlist fallback example presence
- access-layer documentation presence
- local `.env.production` and `config.local.json` values when those files exist

`verify:public-origin` covers:

- public health reachability on the real share origin
- public `403` protection for `/api/runtime-stats`

## Gate 4. Live Smoke Before Sharing

Run at least one real parcel flow after the latest deploy:

- address search
- parcel selection
- land summary and detail handoff
- building summary and detail handoff
- `100m` preview
- OBJ export
- 3DM export

Release only if this flow completes without obvious timeout loops, broken popups, or export failures.

## Gate 5. Rollback Readiness

Release only if all of these are true:

- the previous known-good deploy can be restored
- one known-good parcel test case is recorded
- the current deployment path is written down in the deployment docs

## Hard Stops

Do not share the app if any of these are true:

- router ports are open while relying on Cloudflare Tunnel privacy
- the site can be reached directly without Cloudflare Access or an allowlist
- `HOST_BIND_IP` is not loopback in the Docker deployment
- direct Node runtime is bound to `0.0.0.0` or another non-loopback host
- `npm run verify:baseline` fails
- `npm run verify:deployment-security` fails
- there is no rollback target

## Known Remaining Risks

Even after all gates pass, these risks still remain:

- a misconfigured Cloudflare Access policy or stale allowlist can still expose the app too broadly
- allowed users can still overuse heavy export or context routes even if anonymous access is blocked
- upstream public APIs can still throttle, timeout, or change behavior
- provider-specific timeout values may still need tuning after more real parcel runs

For the current build stage, these remaining risks are acceptable for controlled acquaintance-only sharing, but not for broad public release.
