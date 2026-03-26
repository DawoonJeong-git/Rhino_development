# Security Build Log

This file is append-only.

Each significant work session should add:

- date
- what changed
- what was verified
- what remains
- what the next session should do

---

## 2026-03-26

### Summary

Started the dedicated security completion track and documented it for continuity across conversations.

### Changes Completed

- hardened static file serving path validation
- tightened deployment defaults for bind host and Docker host publishing
- strengthened frontend progress token generation
- updated baseline verification with a static path guard regression check
- aligned deployment/security docs with safer defaults
- created dedicated security build planning, tracker, and log documents

### Verification

- `cmd /c npm.cmd run verify:baseline` passed after the hardening changes

### Open Items

- choose the single default access model for this build
- add outbound API timeout and abort handling
- tighten CSP in planned slices
- expand security regression coverage

### Recommended Next Session

- implement outbound fetch timeout/abort helper
- apply it to the highest-value external API calls first
- update tracker and append the next log entry

---

## 2026-03-26 Session 2

### Summary

Advanced the security completion track by locking the default access model and adding shared outbound fetch timeout protection.

### Changes Completed

- chose `Cloudflare Tunnel plus Cloudflare Access` as the default access model for this build
- documented `reverse proxy plus strict IP allowlist` as the fallback access path
- added a shared outbound fetch timeout/abort helper
- applied timeout protection to the current third-party API calls
- expanded baseline verification with an outbound fetch timeout regression probe
- updated the security tracker to reflect the current phase and decisions

### Verification

- `cmd /c npm.cmd run verify:baseline` passed after the fetch hardening changes

### Open Items

- define the first CSP hardening slice
- expand security verification coverage further
- tune provider-specific timeout values if real flows show false positives
- improve user-facing timeout failure messages where needed

### Recommended Next Session

- run and confirm baseline verification
- define the smallest safe CSP hardening step
- update the tracker and append the next log entry

---

## 2026-03-26 Session 3

### Summary

Completed the first low-risk CSP hardening slice and verified that the default and handoff policies now diverge intentionally.

### Changes Completed

- removed inline script allowance from the default CSP
- kept a separate relaxed CSP for the EUM handoff routes that still need inline auto-submit behavior
- expanded baseline verification so the default hub route rejects inline scripts while the handoff route preserves its required exception
- updated the security tracker to move the active focus toward the remaining browser hardening work

### Verification

- `cmd /c npm.cmd run verify:baseline` passed after the CSP hardening changes

### Open Items

- review whether inline style allowance can be reduced without breaking popup and print flows
- expand security verification coverage further
- tune provider-specific timeout values if real flows show false positives
- improve user-facing timeout failure messages where needed

### Recommended Next Session

- inspect popup and print rendering paths for inline style dependency
- decide the smallest safe next CSP reduction step
- update the tracker and append the next log entry

---

## 2026-03-26 Session 4

### Summary

Completed the next CSP reduction step by moving popup and print windows to an external stylesheet and removing inline style allowance from the default policy.

### Changes Completed

- introduced `public/popup.css` for popup and print window styling
- refactored popup rendering to use a shared external-stylesheet document renderer
- removed inline style allowance from the default CSP
- kept handoff routes on the relaxed policy because they still embed inline styles and auto-submit scripts
- expanded baseline verification so popup stylesheet delivery and stricter default style policy are checked

### Verification

- `cmd /c npm.cmd run verify:baseline` passed after the popup stylesheet and CSP changes

### Open Items

- review whether handoff pages can be refactored to remove inline style and inline script dependence
- expand security verification coverage further
- tune provider-specific timeout values if real flows show false positives
- improve user-facing timeout failure messages where needed

### Recommended Next Session

- inspect the handoff routes for the smallest safe de-inline strategy
- decide whether to replace auto-submit script with a non-inline alternative
- update the tracker and append the next log entry

---

## 2026-03-26 Session 5

### Summary

Finished removing inline dependencies from the handoff routes, which means the default and handoff pages no longer need CSP inline allowances.

### Changes Completed

- replaced handoff inline styles with `public/handoff.css`
- replaced handoff inline auto-submit behavior with `public/handoff-auto-submit.js`
- removed the separate relaxed handoff CSP requirement
- verified that the default and handoff responses both work without inline script/style allowances
- updated baseline verification to check the new no-inline posture

### Verification

- `cmd /c npm.cmd run verify:baseline` passed after the handoff de-inline changes

### Open Items

- review whether third-party frontend assets should be self-hosted for stricter CSP
- expand security verification coverage further
- tune provider-specific timeout values if real flows show false positives
- improve user-facing timeout failure messages where needed

### Recommended Next Session

- decide whether the security track should include self-hosting third-party frontend assets
- expand regression coverage where security-sensitive behavior is still thin
- update the tracker and append the next log entry

---

## 2026-03-26 Session 6

### Summary

Improved how upstream security-sensitive failures are exposed to users by mapping them to safer and more consistent public errors.

### Changes Completed

- added public error normalization for upstream timeout and provider failure cases
- mapped upstream timeout failures to `504`
- mapped upstream provider failures to `502`
- kept original details in server logs while reducing raw upstream leakage in API responses
- expanded baseline verification with public error normalization coverage

### Verification

- `cmd /c npm.cmd run verify:baseline` passed after the public error normalization changes

### Open Items

- review whether third-party frontend assets should be self-hosted for stricter CSP
- expand security verification coverage further
- tune provider-specific timeout values if real flows show false positives
- improve user-facing messaging for upstream timeout failures where route-specific guidance would help

### Recommended Next Session

- inspect the `unpkg` dependency path and decide whether self-hosting is worth including in this security track
- expand targeted regression coverage where security-sensitive behavior is still thin
- update the tracker and append the next log entry

---

## 2026-03-26 Session 7

### Summary

Closed the remaining default-path third-party frontend dependency by self-hosting Leaflet and tightening the default CSP to same-origin browser resources only.

### Changes Completed

- installed `leaflet@1.9.4` as a pinned local dependency
- copied the Leaflet runtime assets into `public/vendor/leaflet`
- switched the main feature page to load Leaflet from local asset paths instead of `unpkg`
- removed `unpkg` and unused Cloudflare browser-side host allowances from the default CSP
- added baseline verification coverage for self-hosted Leaflet assets and the stricter CSP posture
- updated the tracker and plan so future sessions resume from the remaining closure work instead of the CDN decision

### Verification

- `cmd /c npm.cmd run verify:baseline` passed after the local-asset and CSP changes

### Open Items

- expand security verification coverage beyond the current baseline
- tune provider-specific timeout values if real parcel flows show false positives
- improve user-facing timeout failure messages where route-specific guidance would help
- write the final remaining-risk and release-gate summary for acquaintance-only sharing

### Recommended Next Session

- decide whether to include a deployment-side validation pass before closing the security track
- update the tracker and append the next log entry

---

## 2026-03-26 Session 8

### Summary

Added an explicit release-gate layer for acquaintance-only sharing and backed it with an automated deployment-security verification command.

### Changes Completed

- created `docs/security-release-gates.md` as the pre-share decision document
- added `npm run verify:deployment-security`
- implemented `scripts/verify-deployment-security.mjs` to check safe bind defaults, allowlist fallback examples, release-gate docs, and local deployment files when present
- added a `--root` option so the deployment-security verifier can inspect a separate deployment clone directly
- updated deployment docs so the new verification command sits in the release flow
- updated the tracker and plan so future sessions continue from real deployment validation and timeout tuning
- strict runtime checks for the actual share target should be added if config-level deployment blockers still need to be surfaced automatically

### Verification

- `cmd /c npm.cmd run verify:deployment-security` passed after the new release-gate files were added
- `cmd /c npm.cmd run verify:baseline` also passed after the deployment-security verification path was added

### Open Items

- run the release gates against the real share target before distributing the URL
- tune provider-specific timeout values if real parcel flows show false positives
- improve user-facing timeout failure messages where route-specific guidance would help
- decide whether an operator-only smoke checklist is still needed before closure

### Recommended Next Session

- run `npm run verify:deployment-security`
- compare the release gates against the actual deployment clone or VPS configuration
- update the tracker and append the next log entry

---

## 2026-03-26 Session 9

### Summary

Validated the real deployment clone against the release-gate flow and surfaced the remaining runtime-config blockers that still need to be fixed before acquaintance sharing.

### Changes Completed

- synced the latest security-related files into `C:\SpaceWork_deploy`
- re-ran the deployment-security verifier against `C:\SpaceWork_deploy` and confirmed the non-strict release-gate checks now pass
- re-ran `npm run verify:baseline` inside `C:\SpaceWork_deploy` and confirmed the current security baseline still passes there
- extended `scripts/verify-deployment-security.mjs` with `--strict-runtime`
- documented the strict-runtime command in the release-gate and deployment docs
- used strict runtime verification against `C:\SpaceWork_deploy` to surface the remaining real-share blockers

### Verification

- `node scripts/verify-deployment-security.mjs --root C:\SpaceWork_deploy` passed
- `cmd /c npm.cmd run verify:baseline` passed in `C:\SpaceWork_deploy`
- `node scripts/verify-deployment-security.mjs --root C:\SpaceWork_deploy --strict-runtime` failed as expected and exposed two remaining blockers
- `cmd /c npm.cmd run verify:deployment-security` still passed in `C:\SpaceWork_develop`

### Open Items

- `C:\SpaceWork_deploy\config.local.json` still points `VWORLD_API_DOMAIN` at `http://localhost:3000`
- `C:\SpaceWork_deploy\config.local.json` still points `TERRAIN_CONTOUR_PATH` at `C:\Rhino_develop\data\contours`, which does not exist
- provider-specific timeout values still need review against more real parcel runs
- decide whether an operator-only smoke checklist is still needed before closure

### Recommended Next Session

- update the real deployment clone runtime config with the actual HTTPS share origin
- update the real deployment clone runtime config to use an existing contour dataset path
- rerun `node scripts/verify-deployment-security.mjs --root C:\SpaceWork_deploy --strict-runtime`

---

## 2026-03-26 Session 10

### Summary

Cleared the real-share runtime blockers in the deployment clone and confirmed that the stricter release-gate checks now pass.

### Changes Completed

- discovered the actual Cloudflare Tunnel hostname from `C:\Users\wjdek\.cloudflared\config.yml`
- updated `C:\SpaceWork_deploy\config.local.json` to use `https://app.spaceswork.net`
- updated `C:\SpaceWork_deploy\config.local.json` to use `C:\SpaceWork_deploy\data\contours`
- hardened the deployment-security verifier to tolerate UTF-8 BOM in JSON files
- reran strict runtime verification for `C:\SpaceWork_deploy` and confirmed it passes
- restarted the deployment clone with `deploy\run-home-site.bat`
- verified local health at `http://127.0.0.1:3000/api/health`

### Verification

- `node scripts/verify-deployment-security.mjs --root C:\SpaceWork_deploy --strict-runtime` passed
- `cmd /c npm.cmd run verify:baseline` passed in `C:\SpaceWork_deploy`
- `cmd /c npm.cmd run verify:deployment-security` passed in `C:\SpaceWork_develop`
- `GET http://127.0.0.1:3000/api/health` returned `ok: true` after restart

### Open Items

- run one allowed-user external smoke through `https://app.spaceswork.net`
- confirm blocked access is denied outside the trusted path
- review provider-specific timeout values against more real parcel runs
- decide whether an operator-only smoke checklist is still needed before closure

### Recommended Next Session

- test the actual Access-protected hostname from an allowed identity
- test the same hostname from a blocked path or blocked identity
- keep the tracker updated with the Access smoke result
