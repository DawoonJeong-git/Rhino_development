# Security Build Plan

## Purpose

This document is the strategy document for the current security completion track.

The goal is not general product expansion.

The goal is to finish the security hardening and security-related build decisions needed for this project stage.

This document should stay relatively stable.

If work continues in a different conversation, this file explains the target state and decision structure.

## Current Security Goal

Finish the security problem-solving build to the point where the app is:

- safe enough for controlled real use
- not casually exposed by deployment mistakes
- resilient against obvious misuse and avoidable abuse
- understandable to maintain when security-related issues appear

## What "Security Completion" Means For This Project

Security completion for this build does not mean enterprise perfection.

It means we close the meaningful risks that can realistically cause trouble in the current architecture and deployment shape.

For this build, "done enough" means:

- high-risk path traversal and similar direct server issues are closed
- deployment defaults do not accidentally expose the app
- access path is explicitly controlled
- request limits and heavy endpoint protections are in place
- outbound dependency calls fail safely
- CSP and browser security posture are hardened to a reasonable level
- secrets stay server-side and configuration expectations are documented
- regression checks exist for the most important security behaviors

## Already Completed

- static file path guard hardened
- default bind and Docker host publish settings tightened
- progress token generation strengthened on the frontend
- baseline verification updated with static path guard regression coverage
- deployment and security docs aligned with safer defaults
- default access model locked to Cloudflare Tunnel plus Cloudflare Access
- shared outbound fetch timeout and abort helper added
- baseline verification expanded with outbound fetch timeout coverage
- first CSP hardening slice completed by splitting the default and handoff policies
- popup and print flows moved to external CSS so the default CSP no longer needs inline style allowance
- handoff routes moved to external CSS and external auto-submit script so they no longer need inline allowances
- upstream timeout and provider failures now normalize to safer public 502/504 responses
- Leaflet frontend assets are self-hosted so the default CSP no longer needs `unpkg`
- unused third-party browser-side CSP allowances removed from the default policy
- acquaintance-only security release gates documented
- deployment-side verification command added for controlled-sharing defaults
- remaining-risk summary written for the current sharing model
- real deployment clone updated and revalidated with the current release-gate baseline
- real deployment clone runtime config aligned with the actual share origin and contour dataset path
- strict runtime release-gate verification passed on the real share target

## Security Build Scope

### In Scope

- app server hardening
- deployment exposure hardening
- controlled access decisions
- browser security hardening
- outbound API failure safety
- regression and verification coverage for security-sensitive behavior
- documentation that preserves security build context across conversations

### Out Of Scope

- full account system
- public multi-tenant SaaS security model
- formal compliance program
- enterprise IAM or audit stack
- advanced SOC-style monitoring

## Security Phases

### Phase S1. Exposure Control

Objective:

- prevent accidental or overly broad exposure

Done when:

- recommended access model is explicitly chosen
- deploy docs match that model
- default runtime settings are safe
- public exposure is not the accidental default

Primary work:

- decide controlled access path
- make access posture explicit in docs
- keep safe host binding defaults

### Phase S2. Runtime Hardening

Objective:

- reduce exploitability and unsafe failure modes in the running app

Done when:

- outbound fetches use timeout or abort handling
- common abuse paths are rate-limited or constrained
- heavy jobs have clear concurrency limits
- error handling avoids unnecessary leakage

Primary work:

- add fetch abort/timeout wrappers
- review heavy routes and edge cases
- improve security-oriented error handling where needed

### Phase S3. Browser And Response Hardening

Objective:

- reduce client-side exploit surface

Done when:

- CSP is tightened beyond the current baseline where practical
- inline allowances are reduced intentionally, not left by convenience
- third-party script/style dependency is reviewed

Primary work:

- audit inline script/style usage
- reduce `unsafe-inline` where realistic
- evaluate self-hosting or isolating external frontend dependencies

### Phase S4. Verification And Closure

Objective:

- make security work repeatable, reviewable, and resumable

Done when:

- core security checks are documented
- regression checks cover the top risks
- tracker and session logs are current
- outstanding risks are explicitly listed rather than forgotten

Primary work:

- expand security verification coverage
- maintain decision log
- maintain append-only session log

## Decision Gates

### Gate S1. Access Model

Question:

- how should this build be accessed in practice?

Recommended:

- controlled access only
- default path for this build: Cloudflare Tunnel plus Cloudflare Access

Fallback only when needed:

- reverse proxy plus strict IP allowlist

Preferred options:

- Cloudflare Tunnel plus access layer
- reverse proxy plus allowlist
- private network only

Avoid for this build:

- direct public exposure without a clear access control layer

Practical impact:

- controlled access adds some friction when sharing the app
- but it sharply lowers abuse, support, and incident risk
- Tunnel plus Access keeps the app private by default and fits the current project stage best
- reverse proxy plus allowlist is acceptable when Access is unavailable, but it is more brittle when tester IPs change

### Gate S2. CSP Hardening Depth

Question:

- how aggressively should we tighten CSP in this build?

Recommended:

- tighten in stages, starting with low-risk removals

Practical impact:

- shallow hardening:
  - lower implementation cost
  - smaller security gain
- deep hardening:
  - better XSS posture
  - may require popup, handoff, and frontend markup rewrites

### Gate S3. Export Architecture Change

Question:

- should security concerns force an early move to queued background exports?

Recommended:

- not yet, unless current direct export behavior becomes a concrete security or stability problem

Practical impact:

- staying direct keeps this build smaller
- moving early to queue architecture expands scope significantly

## Required Working Rules

For this security build, every meaningful session should update the docs.

We will use:

- `docs/security-build-plan.md`:
  stable strategy and decision structure
- `docs/security-build-tracker.md`:
  current source of truth for status, checklist, and next actions
- `docs/security-build-log.md`:
  append-only session log for continuity across conversations

## Immediate Next Priorities

1. run the final external Cloudflare Access smoke after the latest restart
2. review provider-specific timeout values against real parcel flows
3. expand security verification coverage beyond the current baseline
4. decide whether an operator-only smoke checklist is still needed before closure
