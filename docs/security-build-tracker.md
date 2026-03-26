# Security Build Tracker

## How To Use This File

This is the live source of truth for the current security build.

When work continues in another conversation, resume from this file first.

Update this file whenever:

- a decision is made
- a security task is completed
- the current priority changes
- a new blocker or risk is found

## Current Objective

Complete the security problem-solving build for the current project stage.

## Current Phase

- Active phase: `S4 Verification And Closure`

## Current Status Snapshot

### Completed

- [x] static path traversal guard hardened
- [x] Docker and bind host defaults tightened
- [x] progress token generation strengthened
- [x] baseline verification updated with static path guard regression coverage
- [x] safer deployment guidance documented
- [x] recommended access model locked to Cloudflare Tunnel plus Cloudflare Access, with reverse proxy allowlist as fallback
- [x] outbound fetch timeout and abort handling added with shared helper
- [x] baseline verification expanded for outbound fetch timeout behavior
- [x] first CSP hardening slice completed by removing inline script allowance from the default policy and isolating handoff exceptions
- [x] popup and print windows moved to external stylesheet so the default CSP no longer needs inline style allowance
- [x] handoff pages moved to external stylesheet and external auto-submit script so they no longer need inline allowances either
- [x] upstream timeout and provider failures now map to safer public 502/504 responses
- [x] Leaflet frontend assets are now self-hosted so the default CSP no longer needs `unpkg`
- [x] unused third-party browser-side CSP allowances removed from script, style, and connect directives
- [x] acquaintance-only release gates documented for controlled sharing
- [x] deployment-side verification command added for bind/access/release-gate defaults
- [x] explicit remaining-risk summary documented for acquaintance-only sharing
- [x] real deployment clone updated with the latest security release-gate files
- [x] real deployment clone passes non-strict release-gate verification and baseline verification
- [x] real deployment clone runtime config aligned with the actual share domain and contour dataset path
- [x] strict runtime release-gate verification passes on the real deployment clone
- [x] real deployment clone was restarted after the runtime config change and local health responds

### In Progress

- [ ] run one external allowed-user smoke test through Cloudflare Access
- [ ] confirm blocked access is denied outside the trusted path
- [ ] review provider-specific timeout values against real parcel flows

### Not Started

- [ ] security-focused regression expansion beyond the current baseline

## Decision Status

### Decided

- `controlled access only` is the recommended stance for this build
- `public-by-default deployment` is not acceptable for this stage
- `SKP payload` remains safer than overcommitting to native `.skp` in security-sensitive deployment decisions
- `Cloudflare Tunnel plus Cloudflare Access` is the default access path for this build
- `reverse proxy plus strict IP allowlist` is the fallback path when Access is not available
- outbound fetch timeout behavior should use one shared helper unless a specific endpoint needs different retry logic
- practical third-party frontend assets in the default user path should be self-hosted when that removes CSP exceptions cleanly

### Pending

- [ ] decide whether the real deployment clone needs one more operator-focused smoke checklist beyond the current release gates

## Active Risks

- controlled sharing still depends on Cloudflare Access or an equivalent allowlist being configured correctly at deploy time
- the external Access policy has not yet been re-smoke-tested from an allowed identity and a blocked path after the latest restart
- some provider-specific timeouts may still need tuning based on real usage

## Next 5 Tasks

1. run an allowed-user browser smoke through `https://app.spaceswork.net`
2. verify a blocked path still fails outside Cloudflare Access or the allowlist
3. review provider-specific timeout values against real parcel flows
4. expand security verification coverage beyond the current baseline
5. decide whether an operator-only smoke checklist is still needed after the current release gates

## Resume From Here

If another conversation picks this up, start here:

1. read `docs/security-build-plan.md`
2. read this tracker
3. read the latest entry in `docs/security-build-log.md`
4. continue from `Next 5 Tasks` unless the user reprioritizes
