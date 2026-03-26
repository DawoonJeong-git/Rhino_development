# Build Execution Plan

## Purpose

This document is for the current build project.

It is not a daily ops checklist.

Current active track:

- the active build focus is the security completion track
- see `docs/security-build-plan.md`
- see `docs/security-build-tracker.md`
- see `docs/security-build-log.md`

It defines:

- what "done enough" means for this build
- what order we should implement work in
- which large decisions need to be made before deeper implementation
- what practical side effects we should check before committing to big changes

## Build Goal

Deliver a usable Korea-focused site-context planning tool that can reliably support this workflow:

1. Search an address or select directly on the map
2. Resolve parcel or multi-parcel target
3. Review land info, regulation references, and building register summary
4. Generate preview-ready site context
5. Export usable geometry and metadata for downstream planning work

The goal is not "fully automated planning judgment."

The goal is a strong decision-support tool that shortens the path from address selection to review and export.

## Realistic Target For This Build

We should treat the target as:

- private beta quality
- stable enough for repeated internal use
- deployable behind a tunnel or controlled reverse proxy
- reliable on a known regression set of real parcels

We should not treat the target as:

- fully public self-serve SaaS
- legal judgment engine
- fully generalized nationwide CAD/BIM automation platform
- large-team multi-user product

## Definition Of Done

This build is "done enough" when all of the following are true:

- address search, map selection, parcel selection, and multi-parcel selection work reliably
- land info and building register summary are usable without the user leaving the main flow too early
- official handoff links remain available for authoritative verification
- site-context preview is stable on a known parcel regression set
- `OBJ`, `3DM`, `DXF`, and `SKP payload` exports are reliable on the target parcel set
- deployment is reproducible with documented environment settings
- baseline verification and key regression checks pass before release
- the app is protected behind a controlled access path
- major failure modes are understandable from logs and user-facing errors

## Current Build Position

As of now, the project already has meaningful progress in these areas:

- web-first Node app structure
- address search and map-based selection
- parcel and multi-parcel handling
- land info and building register flows
- site-context generation
- `OBJ`, `3DM`, `DXF`, and `SKP payload` export paths
- deployment and security baseline documents
- baseline verification script

This means the project is no longer in the "idea validation" stage.

The project is in the "close the gaps, reduce risk, make it dependable" stage.

## Build Phases

### Phase 1. Core Closing

Objective:

- make the existing main flow dependable enough for repeated real use

Exit criteria:

- representative parcel regression set is defined
- export outputs are stable on that set
- top failure patterns are known
- error messages are understandable
- access path for deployment is decided

Primary work:

- strengthen external API timeout and failure handling
- establish parcel regression cases
- tighten export validation
- clean up unstable UX edges in the main flow
- close high-risk security and deployment gaps

### Phase 2. Project Beta Readiness

Objective:

- make the app usable by a small number of real testers without hand-holding on every run

Exit criteria:

- install and deploy steps are repeatable
- core feature documentation matches reality
- configuration expectations are explicit
- fallback behavior is intentional rather than accidental
- release checklist is usable by someone other than the implementer

Primary work:

- finalize docs for setup, deploy, and smoke test
- improve logging and troubleshooting
- define recommended runtime shape
- reduce ambiguity in configuration and feature flags

### Phase 3. Workflow Quality

Objective:

- improve practical value for planning work, not just technical completeness

Exit criteria:

- the user can understand what to verify next
- the app clearly separates reference info from authoritative official info
- exports feel intentional and not merely "possible"

Primary work:

- improve regulation/reference presentation
- refine export presets
- improve naming, metadata, and output clarity
- reduce friction between preview and export

### Phase 4. Expansion

Objective:

- expand only after the main flow is dependable

Candidate features:

- heritage risk workflow
- max-mass workflow
- road-detail enrichment such as lane/crosswalk context
- stronger SketchUp pipeline if still justified

Rule:

- no expansion feature should outrank unresolved instability in the main planning flow

## Decision Gates

These are the large decisions that should be treated as explicit project choices, not incidental code drift.

### Gate A. Access Model

Question:

- is this build intended to be used only by a controlled audience, or opened wider?

Recommended for this build:

- controlled access only

Why:

- the app triggers expensive and sensitive server-side workflows
- there is no need to take public-product complexity right now

Options:

- controlled tunnel / allowlist / access layer
- direct public exposure

Practical impact:

- controlled access:
  - slower for casual sharing
  - much safer and simpler for this stage
- public exposure:
  - higher abuse risk
  - more pressure for authentication, rate controls, monitoring, and support

### Gate B. SketchUp Strategy

Question:

- should this build promise native `.skp` generation as a core output, or treat `SKP payload` as the reliable path for now?

Recommended for this build:

- keep `OBJ`, `3DM`, `DXF`, and `SKP payload` as core
- treat server-side `.skp` as optional until reliability is proven

Practical impact:

- pushing `.skp` too early increases runtime dependency and debugging cost
- keeping payload-first reduces risk and keeps delivery realistic

### Gate C. Regulation Intelligence Level

Question:

- do we want a checklist-oriented reference tool, or an automated verdict engine?

Recommended for this build:

- checklist-oriented reference tool

Why:

- this matches the current product shape
- it lowers legal and expectation risk
- it is still highly valuable to users

Practical impact:

- verdict engine:
  - higher product appeal
  - much higher liability, data interpretation burden, and maintenance cost
- checklist model:
  - more conservative
  - easier to ship with confidence

### Gate D. Export Processing Model

Question:

- keep the current request/response export model, or move to an explicit job queue soon?

Recommended for this build:

- keep current direct flow unless real usage shows blocking pain

Trigger to revisit:

- repeated timeouts
- multiple concurrent users
- export size growth
- demand for resumable jobs

Practical impact:

- staying direct:
  - simpler
  - faster to finish this build
- moving to queued jobs:
  - more scalable
  - larger UI and backend rewrite

## Current Recommended Scope

We should actively finish these:

- core selection flow
- parcel and multi-parcel reliability
- land info / regulation reference / building register usefulness
- preview quality
- export quality
- controlled deployment
- regression verification

We should avoid inflating scope with these until the above are stable:

- broad public access
- strong legal verdict logic
- advanced collaboration/user-account features
- secondary showcase pages beyond placeholder level
- deep BIM/platform integrations

## Working Method For The Build

From here on, each substantial task should be handled in this order:

1. state the user or project goal
2. define the completion condition
3. identify side effects on deployment, UX, data, or runtime cost
4. decide whether the change is local or architectural
5. implement in the smallest useful slice
6. verify with scripts and targeted manual checks
7. update the build checklist

## Change Review Template

Before committing to a large change, we should explicitly answer:

1. Why are we doing this now?
2. What problem does it solve in the current build?
3. What is the smallest version that gets the benefit?
4. What existing flow might become slower, harder, or more fragile?
5. Does this add runtime dependency, deployment complexity, or user friction?
6. Can it be rolled back cleanly?
7. Is this still inside the current build scope?

## Active Checklist

### Now

- [ ] decide the access model for this build and document it as the default path
- [ ] add timeout and abort handling to outbound API calls
- [ ] create a real parcel regression set with representative edge cases
- [ ] define export acceptance checks for `OBJ`, `3DM`, `DXF`, and `SKP payload`
- [ ] improve top user-facing error messages for common failures

### Next

- [ ] tighten CSP and reduce inline/external script dependency where practical
- [ ] align README and feature docs with the actual implemented state
- [ ] refine preview/export UX to reduce confusion between preview and final output
- [ ] define a release candidate checklist for this build

### Later

- [ ] decide whether native `.skp` should graduate from optional to core
- [ ] decide whether export queue architecture is needed
- [ ] choose which expansion feature earns the next serious build investment

## Immediate Recommendation

The best next move for this build is not a flashy new feature.

It is to finish Phase 1 cleanly:

- access model
- external API resilience
- regression parcel set
- export acceptance baseline
- clearer failure handling

Once those are closed, the rest of the project becomes much easier to steer.
