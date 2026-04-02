# Terrain Feature Audit - 2026-04-02

## Scope

This audit checks whether the implemented terrain workflow matches the intended feature set, not just whether a single export happens to look better.

Reference workflow:

1. Native 5m contours are canonical.
2. 1m contours are generated between native anchors.
3. Terrain bands use the same contour plan that contour exports use.
4. Building and road behavior must remain consistent across `3dm` and `skp`.

Reusable process:

- `docs/terrain-feature-audit-checklist.md`

## Representative evidence

Commands used during this audit:

```powershell
node scripts\inspect-terrain-case.mjs --lat 37.574627 --lng 126.959388 --radius 100 --contour-interval 5 --output tmp_audit_muak_5m_clean.json
node scripts\inspect-terrain-case.mjs --lat 37.574627 --lng 126.959388 --radius 100 --contour-interval 1 --output tmp_audit_muak_1m_clean.json
node scripts\inspect-terrain-case.mjs --lat 37.57705 --lng 126.962095 --radius 100 --contour-interval 1 --output tmp_audit_hillside_1m_clean.json
node scripts\summarize-terrain-audit.mjs tmp_audit_muak_5m_clean.json tmp_audit_muak_1m_clean.json tmp_audit_hillside_1m_clean.json
cmd /c npm.cmd run verify:baseline
cmd /c npm.cmd run verify:ui
```

## Current status

| Feature | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Preview button | Pass | `verify:ui` passed at `2026-04-02T05:46:30Z` and returned the refreshed preview note | Current smoke path works. |
| Building mode UI | Pass | UI now shows the two intended modes: `default` and `remove-overlap` | Labels and summary text match the intended two-mode model. |
| Building placement rule | Partial | Server normalizes to `default/remove-overlap`, and baseline regression covers carve behavior | Real export spot-check still needed to confirm no building sinks below raw-contour terrace in difficult cases. |
| 5m native contour preservation | Pass | Muak 5m: source/export contours `11 -> 11`, `exportMissingNativeElevations = []`, `3dm/skp contours = 11/11` | Only the true top cap remains outside renderable bottoms (`90m`). |
| 5m terrain band coverage | Pass | Muak 5m: renderable bands `8/8`, bottoms `50..85`, tops `55..90` | Canonical 5m path is stable on the representative case. |
| 1m interval completeness | Pass | Muak 1m: `46` export contours, `35` generated, renderable bands `40/40`; Hillside 1m: `67` export contours, `48` generated, renderable bands `50/50` | No native elevation disappears from export in either case. |
| 1m contour closure/completeness | Pass | Muak 1m: closed export curves `46/46`; Hillside 1m: `67/67` | Open or missing interval curves are no longer the primary issue. |
| 1m contour smoothness and non-overlap | Partial | Internal fixes removed self-intersecting band loops, but the user still reports local jagged, overlapping, and spiky generated contours | This is now the main open contour-quality problem. |
| Terrain mass integrity | Partial | Self-intersection repair reduced fragment-causing invalid loops, but the user still reports fragmented terrace faces and phantom covers in some exports | Requires another file-level Rhino/SketchUp validation round. |
| Road export presence | Pass | Muak 5m roads `3dm/skp = 3/3`; Muak 1m `7/7`; Hillside 1m `70/70` | Roads now survive export again. |
| Road placement quality | Partial | Source and exported roads exist, but the user still suspects terrain/road attachment errors in malformed terrain regions | Needs direct visual recheck together with terrain fixes. |
| 3DM/SKP contour parity | Pass | Counts match on all representative cases: `11/11`, `46/46`, `67/67` | Good sign that both formats now see the same contour plan. |

## Representative case summary

| Case | Requested | Source | Status | Native levels | Export contours | Bands | 3DM/SKP contours | Roads | Notes |
| --- | ---: | ---: | --- | --- | ---: | --- | --- | --- | --- |
| Muak 5m | 5m | 5m | pass | `50, 55, 60, 65, 70, 75, 80, 85, 90` | `11` (`0` generated) | `8/8` | `11/11` | `3/3` | Top-cap only missing `90m` |
| Muak 1m | 1m | 5m | pass | `50, 55, 60, 65, 70, 75, 80, 85, 90` | `46` (`35` generated) | `40/40` | `46/46` | `7/7` | Top-cap only missing `90m` |
| Hillside 1m | 1m | 5m | pass | `85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135` | `67` (`48` generated) | `50/50` | `67/67` | `70/70` | Top-cap only missing `135m` |

## What is actually solved

1. The system no longer drops native levels in the representative `5m` and `1m` cases.
2. The contour family used by export is now consistent across `3dm` and `skp` in the representative cases.
3. Roads are present again in both `3dm` and `skp`.
4. Preview and baseline smoke checks are green.

## What is still not good enough

1. Generated `1m` contours can still look too jagged or locally overlap in user-inspected exports.
2. Some terrace masses can still look fragmented or covered by phantom faces in difficult regions even after loop repair.
3. Building placement logic is covered by code-level regression, but it still needs one more file-level confirmation in real exports after the new two-mode UX change.
4. Road placement quality still depends on terrain quality in the problematic regions, so it is not fully closed just because road objects exist again.

## Next priorities

1. Audit and reduce local jagged or overlapping generated contours in the user-reported `1m` problem zones.
2. Re-open the exact terrace layers that still show fragmented faces and trace which band loop or subtraction step creates them.
3. Re-run file-level checks for `default` vs `remove-overlap` building modes with the same site and confirm that only terrain carve changes while building Z remains fixed.
4. Re-check roads only after the remaining terrain mass issues are resolved in the same problem area.
