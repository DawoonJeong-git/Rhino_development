function createContourClosure({
  buildCanonicalContourInputEntries,
  buildContourLevelKey,
  distanceToClipRectBoundary,
  mergeContourPolylinePoints,
  snapLocalPointToClipBoundary,
  extendLocalPointToClipBoundary,
  snapLocalPointToRectBoundary,
  extendLocalPointToRectBoundary,
  pointsMatchInMeters,
  buildLocalClipBoundaryPath,
  buildLocalRectBoundaryPath,
  dedupeLocalPolygonPoints,
  buildLocalMultiPolygonFromOpenRing,
  intersectLocalMultiPolygon,
  filterTinyLocalMultiPolygonArtifacts,
  differenceLocalMultiPolygon,
  resolveEffectiveContourBandInterval,
  sampleLocalMultiPolygonElevation,
  buildNativeContourAnchorSiteContext,
  computeLocalMultiPolygonArea,
  computeLocalMultiPolygonBounds,
  buildContourBandRegionsFromMultiPolygon,
  isPointInsideOrOnAnyLocalRegion,
  summarizeLocalMultiPolygonTerrainSupport,
  boundsOverlap,
  estimateLocalMultiPolygonOverlapAreaFromRegions,
  buildLocalClipRect,
  closeRing,
  buildLocalPointKey,
}) {
  function buildOpenContourSideMultiPolygons(localPoints, clipRect) {
    return resolveOpenContourBoundaryCandidates(localPoints, clipRect).candidateMultiPolygons;
  }

  function resolveOpenContourBoundaryCandidates(localPoints, clipRect) {
    const contourPoints = mergeContourPolylinePoints(localPoints, 0.001);

    if (contourPoints.length < 2) {
      return {
        contourPoints,
        candidatePolygons: [],
        candidateMultiPolygons: [],
        rejectedReason: "too_few_points",
      };
    }

    const startDirection = [
      Number(contourPoints[0][0]) - Number(contourPoints[1][0]),
      Number(contourPoints[0][1]) - Number(contourPoints[1][1]),
    ];
    const endDirection = [
      Number(contourPoints[contourPoints.length - 1][0]) -
        Number(contourPoints[contourPoints.length - 2][0]),
      Number(contourPoints[contourPoints.length - 1][1]) -
        Number(contourPoints[contourPoints.length - 2][1]),
    ];
    const snappedStartPoint =
      snapLocalPointToClipBoundary(
        contourPoints[0],
        clipRect,
        clipRect.boundarySnapTolerance
      ) ||
      extendLocalPointToClipBoundary(contourPoints[0], startDirection, clipRect) ||
      snapLocalPointToRectBoundary(
        contourPoints[0],
        clipRect,
        clipRect.boundarySnapTolerance
      ) ||
      extendLocalPointToRectBoundary(contourPoints[0], startDirection, clipRect);
    const snappedEndPoint =
      snapLocalPointToClipBoundary(
        contourPoints[contourPoints.length - 1],
        clipRect,
        clipRect.boundarySnapTolerance
      ) ||
      extendLocalPointToClipBoundary(
        contourPoints[contourPoints.length - 1],
        endDirection,
        clipRect
      ) ||
      snapLocalPointToRectBoundary(
        contourPoints[contourPoints.length - 1],
        clipRect,
        clipRect.boundarySnapTolerance
      ) ||
      extendLocalPointToRectBoundary(
        contourPoints[contourPoints.length - 1],
        endDirection,
        clipRect
      );

    if (
      !snappedStartPoint ||
      !snappedEndPoint ||
      pointsMatchInMeters(
        snappedStartPoint,
        snappedEndPoint,
        Math.max(0.01, clipRect.boundarySnapTolerance * 0.1)
      )
    ) {
      return {
        contourPoints,
        snappedStartPoint,
        snappedEndPoint,
        candidatePolygons: [],
        candidateMultiPolygons: [],
        rejectedReason:
          !snappedStartPoint || !snappedEndPoint
            ? "boundary_extension_failed"
            : "shared_boundary_endpoint",
      };
    }

    const snappedContourPoints = [...contourPoints];
    const endpointTolerance = Math.max(0.001, clipRect.boundarySnapTolerance * 0.05);

    if (
      snappedStartPoint &&
      !pointsMatchInMeters(snappedStartPoint, snappedContourPoints[0], endpointTolerance)
    ) {
      snappedContourPoints.unshift(snappedStartPoint);
    } else if (snappedStartPoint) {
      snappedContourPoints[0] = snappedStartPoint;
    }

    if (
      snappedEndPoint &&
      !pointsMatchInMeters(
        snappedEndPoint,
        snappedContourPoints[snappedContourPoints.length - 1],
        endpointTolerance
      )
    ) {
      snappedContourPoints.push(snappedEndPoint);
    } else if (snappedEndPoint) {
      snappedContourPoints[snappedContourPoints.length - 1] = snappedEndPoint;
    }
    const ccwClipBoundaryPath = buildLocalClipBoundaryPath(
      snappedEndPoint,
      snappedStartPoint,
      clipRect,
      "ccw"
    );
    const cwClipBoundaryPath = buildLocalClipBoundaryPath(
      snappedEndPoint,
      snappedStartPoint,
      clipRect,
      "cw"
    );
    const ccwBoundaryPath = ccwClipBoundaryPath.length
      ? ccwClipBoundaryPath
      : buildLocalRectBoundaryPath(snappedEndPoint, snappedStartPoint, clipRect, "ccw");
    const cwBoundaryPath = cwClipBoundaryPath.length
      ? cwClipBoundaryPath
      : buildLocalRectBoundaryPath(snappedEndPoint, snappedStartPoint, clipRect, "cw");
    const candidatePolygons = [
      dedupeLocalPolygonPoints(
        [...snappedContourPoints, ...ccwBoundaryPath.slice(1)],
        0.001
      ),
      dedupeLocalPolygonPoints(
        [...snappedContourPoints, ...cwBoundaryPath.slice(1)],
        0.001
      ),
    ];

    const candidateMultiPolygons = candidatePolygons
      .map((polygon) => buildLocalMultiPolygonFromOpenRing(polygon))
      .map((multiPolygon) =>
        clipRect?.multiPolygon?.length
          ? intersectLocalMultiPolygon(multiPolygon, clipRect.multiPolygon, {
              suppressFailureLog: true,
            })
          : multiPolygon
      )
      .map((multiPolygon) => filterTinyLocalMultiPolygonArtifacts(multiPolygon, 0.02))
      .filter((multiPolygon) => multiPolygon.length);

    return {
      contourPoints,
      snappedStartPoint,
      snappedEndPoint,
      snappedContourPoints,
      ccwBoundaryPath,
      cwBoundaryPath,
      candidatePolygons,
      candidateMultiPolygons,
      rejectedReason: candidateMultiPolygons.length ? null : "no_candidate_polygons",
    };
  }

  function buildClosedContourSideMultiPolygons(localPoints, clipRect) {
    const polygon = dedupeLocalPolygonPoints(localPoints, 0.001);

    if (polygon.length < 3) {
      return [];
    }

    const insideMultiPolygon = buildLocalMultiPolygonFromOpenRing(polygon);

    if (!insideMultiPolygon.length) {
      return [];
    }

    const clippedInsideMultiPolygon = clipRect?.multiPolygon?.length
      ? intersectLocalMultiPolygon(insideMultiPolygon, clipRect.multiPolygon, {
          suppressFailureLog: true,
        })
      : insideMultiPolygon;
    const normalizedInsideMultiPolygon = filterTinyLocalMultiPolygonArtifacts(
      clippedInsideMultiPolygon,
      0.02
    );

    if (!normalizedInsideMultiPolygon.length) {
      return [];
    }

    return [
      normalizedInsideMultiPolygon,
      differenceLocalMultiPolygon(clipRect.multiPolygon, normalizedInsideMultiPolygon),
    ].filter((multiPolygon) => multiPolygon.length);
  }

  function selectHigherContourSideMultiPolygon(
    siteContext,
    elevation,
    candidateMultiPolygons,
    seed,
    referenceMultiPolygon = null
  ) {
    return resolveHigherContourSideCandidate(
      siteContext,
      elevation,
      candidateMultiPolygons,
      seed,
      referenceMultiPolygon
    ).selectedMultiPolygon;
  }

  function selectLegacyHigherContourSideMultiPolygon(
    siteContext,
    elevation,
    candidateMultiPolygons,
    seed
  ) {
    const comparisonTolerance = Math.max(
      0.02,
      resolveEffectiveContourBandInterval(siteContext) * 0.12
    );
    const scoredCandidates = (candidateMultiPolygons || [])
      .map((multiPolygon) => ({
        multiPolygon,
        sampleElevation: sampleLocalMultiPolygonElevation(siteContext, multiPolygon, seed),
      }))
      .filter(
        (candidate) =>
          candidate.multiPolygon?.length && Number.isFinite(candidate.sampleElevation)
      )
      .sort((left, right) => right.sampleElevation - left.sampleElevation);

    if (!scoredCandidates.length) {
      return null;
    }

    const definitelyHigher = scoredCandidates.filter(
      (candidate) => candidate.sampleElevation > elevation + comparisonTolerance
    );

    if (definitelyHigher.length) {
      return definitelyHigher[0].multiPolygon;
    }

    if (
      scoredCandidates.length > 1 &&
      Math.abs(
        Number(scoredCandidates[0].sampleElevation || 0) -
          Number(scoredCandidates[1].sampleElevation || 0)
      ) <= comparisonTolerance * 0.5
    ) {
      return null;
    }

    return scoredCandidates[0].multiPolygon;
  }

  function sampleContourEntryLocalPoints(entry) {
    const points = Array.isArray(entry?.localPoints) ? entry.localPoints : [];

    if (points.length <= 24) {
      return points;
    }

    const stride = Math.max(1, Math.floor(points.length / 24));
    const samples = [];

    for (let index = 0; index < points.length; index += stride) {
      samples.push(points[index]);

      if (samples.length >= 24) {
        break;
      }
    }

    return samples;
  }

  function summarizeContourTopologySupport(
    siteContext,
    elevation,
    candidateMultiPolygon,
    clipAreaSqm
  ) {
    const regions = buildContourBandRegionsFromMultiPolygon(candidateMultiPolygon);

    if (!regions.length || typeof isPointInsideOrOnAnyLocalRegion !== "function") {
      return null;
    }

    const entries = buildCanonicalContourInputEntries(
      siteContext,
      siteContext?.contourLines,
      { includeLocalPoints: true }
    ).filter(
      (entry) =>
        entry?.source === "native" &&
        Number.isFinite(entry?.elevation) &&
        Math.abs(Number(entry.elevation) - Number(elevation)) > 1e-6
    );
    let higherWeight = 0;
    let lowerWeight = 0;
    let sampledContourCount = 0;

    for (const entry of entries) {
      const samplePoints = sampleContourEntryLocalPoints(entry);

      if (!samplePoints.length) {
        continue;
      }

      const insideCount = samplePoints.filter((point) =>
        isPointInsideOrOnAnyLocalRegion(point, regions)
      ).length;
      const insideRatio = insideCount / samplePoints.length;

      if (insideRatio <= 0.08) {
        continue;
      }

      sampledContourCount += 1;

      if (Number(entry.elevation) > Number(elevation)) {
        higherWeight += insideRatio;
      } else {
        lowerWeight += insideRatio;
      }
    }

    const candidateAreaSqm = computeLocalMultiPolygonArea(candidateMultiPolygon);
    const areaRatio = clipAreaSqm > 0 ? candidateAreaSqm / clipAreaSqm : 0;
    const score =
      higherWeight * 3 -
      lowerWeight * 2 -
      Math.min(0.25, Math.max(0, areaRatio) * 0.08);

    return {
      sampledContourCount,
      higherWeight,
      lowerWeight,
      areaRatio,
      score,
    };
  }

  function resolveHigherContourSideCandidate(
    siteContext,
    elevation,
    candidateMultiPolygons,
    seed,
    referenceMultiPolygon = null
  ) {
    const selectionSiteContext = buildNativeContourAnchorSiteContext(siteContext);
    const comparisonTolerance = Math.max(
      0.02,
      resolveEffectiveContourBandInterval(siteContext) * 0.12
    );
    const normalizedReferenceMultiPolygon = Array.isArray(referenceMultiPolygon)
      ? referenceMultiPolygon
      : [];
    const referenceAreaSqm = normalizedReferenceMultiPolygon.length
      ? computeLocalMultiPolygonArea(normalizedReferenceMultiPolygon)
      : 0;
    const referenceBounds =
      referenceAreaSqm > 0
        ? computeLocalMultiPolygonBounds(normalizedReferenceMultiPolygon)
        : null;
    const referenceRegions =
      referenceAreaSqm > 0
        ? buildContourBandRegionsFromMultiPolygon(normalizedReferenceMultiPolygon)
        : [];
    const clipAreaSqm = Number(
      selectionSiteContext?.stats?.clipAreaSqm || siteContext?.stats?.clipAreaSqm || 0
    );
    const rawCandidates = (candidateMultiPolygons || [])
      .map((multiPolygon, index) => ({
        index,
        multiPolygon,
        sampleElevation: sampleLocalMultiPolygonElevation(
          selectionSiteContext,
          multiPolygon,
          seed
        ),
        terrainSupport: summarizeLocalMultiPolygonTerrainSupport(
          selectionSiteContext,
          multiPolygon,
          elevation,
          Math.max(0.15, comparisonTolerance * 0.9)
        ),
        topologySupport: summarizeContourTopologySupport(
          siteContext,
          elevation,
          multiPolygon,
          clipAreaSqm
        ),
        referenceMatch:
          referenceAreaSqm > 0
            ? (() => {
                const candidateAreaSqm = computeLocalMultiPolygonArea(multiPolygon);
                const candidateBounds =
                  candidateAreaSqm > 0 ? computeLocalMultiPolygonBounds(multiPolygon) : null;

                if (!(candidateAreaSqm > 0)) {
                  return null;
                }

                const overlapMultiPolygon = intersectLocalMultiPolygon(
                  multiPolygon,
                  normalizedReferenceMultiPolygon,
                  { suppressFailureLog: true }
                );
                let overlapAreaSqm = computeLocalMultiPolygonArea(overlapMultiPolygon);

                if (
                  !(overlapAreaSqm > 0) &&
                  candidateBounds &&
                  referenceBounds &&
                  boundsOverlap(candidateBounds, referenceBounds, 0.001)
                ) {
                  const candidateRegions = buildContourBandRegionsFromMultiPolygon(multiPolygon);
                  const estimatedOverlapAreaSqm =
                    estimateLocalMultiPolygonOverlapAreaFromRegions(
                      candidateRegions,
                      referenceRegions
                    );

                  if (estimatedOverlapAreaSqm > overlapAreaSqm) {
                    overlapAreaSqm = Math.min(
                      candidateAreaSqm,
                      referenceAreaSqm,
                      estimatedOverlapAreaSqm
                    );
                  }
                }

                const coverageRatio =
                  referenceAreaSqm > 0 ? overlapAreaSqm / referenceAreaSqm : 0;
                const precisionRatio =
                  candidateAreaSqm > 0 ? overlapAreaSqm / candidateAreaSqm : 0;
                const unionAreaSqm = Math.max(
                  overlapAreaSqm,
                  candidateAreaSqm + referenceAreaSqm - overlapAreaSqm
                );
                const iouRatio = unionAreaSqm > 0 ? overlapAreaSqm / unionAreaSqm : 0;
                const areaDeltaRatio =
                  Math.abs(candidateAreaSqm - referenceAreaSqm) /
                  Math.max(referenceAreaSqm, 1);
                const fullClipPenalty =
                  clipAreaSqm > 0 &&
                  candidateAreaSqm >= clipAreaSqm * 0.995 &&
                  referenceAreaSqm <= clipAreaSqm * 0.94
                    ? 0.3
                    : 0;

                return {
                  overlapAreaSqm,
                  coverageRatio,
                  precisionRatio,
                  iouRatio,
                  areaDeltaRatio,
                  score:
                    coverageRatio * 0.5 +
                    precisionRatio * 0.3 +
                    iouRatio * 0.2 -
                    Math.min(0.35, areaDeltaRatio * 0.14) -
                    fullClipPenalty,
                };
              })()
            : null,
      }))
      .filter(
        (candidate) =>
          candidate.multiPolygon?.length &&
          (Number.isFinite(candidate.sampleElevation) || candidate.topologySupport)
      );
    const scoredCandidates = [...rawCandidates].sort((left, right) => {
      const leftSampleElevation = Number.isFinite(left.sampleElevation)
        ? left.sampleElevation
        : Number.NEGATIVE_INFINITY;
      const rightSampleElevation = Number.isFinite(right.sampleElevation)
        ? right.sampleElevation
        : Number.NEGATIVE_INFINITY;

      return rightSampleElevation - leftSampleElevation;
    });

    if (referenceAreaSqm > 0) {
      const earlyReferenceScoredCandidates = rawCandidates
        .filter((candidate) => candidate.referenceMatch)
        .sort((left, right) => {
          const leftScore = Number(left.referenceMatch?.score || Number.NEGATIVE_INFINITY);
          const rightScore = Number(right.referenceMatch?.score || Number.NEGATIVE_INFINITY);

          if (rightScore !== leftScore) {
            return rightScore - leftScore;
          }

          const leftOverlap = Number(left.referenceMatch?.overlapAreaSqm || 0);
          const rightOverlap = Number(right.referenceMatch?.overlapAreaSqm || 0);

          if (rightOverlap !== leftOverlap) {
            return rightOverlap - leftOverlap;
          }

          return right.sampleElevation - left.sampleElevation;
        });
      const bestReferenceCandidate = earlyReferenceScoredCandidates[0] || null;
      const nextReferenceCandidate = earlyReferenceScoredCandidates[1] || null;
      const bestReferenceScore = Number(
        bestReferenceCandidate?.referenceMatch?.score || Number.NEGATIVE_INFINITY
      );
      const nextReferenceScore = Number(
        nextReferenceCandidate?.referenceMatch?.score || Number.NEGATIVE_INFINITY
      );
      const bestReferenceCoverage = Number(
        bestReferenceCandidate?.referenceMatch?.coverageRatio || 0
      );
      const bestReferencePrecision = Number(
        bestReferenceCandidate?.referenceMatch?.precisionRatio || 0
      );
      const bestReferenceIou = Number(
        bestReferenceCandidate?.referenceMatch?.iouRatio || 0
      );
      const bestReferenceOverlap = Number(
        bestReferenceCandidate?.referenceMatch?.overlapAreaSqm || 0
      );
      const referenceNearComplete =
        bestReferenceCandidate &&
        bestReferenceOverlap >= Math.max(1, referenceAreaSqm * 0.985);
      const strongReferenceMatch =
        bestReferenceCandidate &&
        (
          referenceNearComplete ||
          bestReferenceCoverage >= 0.72 ||
          bestReferencePrecision >= 0.72 ||
          bestReferenceIou >= 0.52 ||
          bestReferenceScore >= 0.5
        ) &&
        (
          referenceNearComplete ||
          bestReferenceScore >= nextReferenceScore + 0.03
        );

      if (strongReferenceMatch) {
        return {
          selectedIndex: bestReferenceCandidate.index,
          selectedMultiPolygon: bestReferenceCandidate.multiPolygon,
          scoredCandidates,
          reason: "strong_grid_reference_match",
          comparisonTolerance,
        };
      }
    }

    const topologyCandidates = rawCandidates
      .filter((candidate) => candidate.topologySupport)
      .sort((left, right) => {
        const leftScore = Number(left.topologySupport?.score || Number.NEGATIVE_INFINITY);
        const rightScore = Number(right.topologySupport?.score || Number.NEGATIVE_INFINITY);

        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }

        const leftHigher = Number(left.topologySupport?.higherWeight || 0);
        const rightHigher = Number(right.topologySupport?.higherWeight || 0);

        if (rightHigher !== leftHigher) {
          return rightHigher - leftHigher;
        }

        const leftArea = Number(left.topologySupport?.areaRatio || 0);
        const rightArea = Number(right.topologySupport?.areaRatio || 0);
        return leftArea - rightArea;
      });
    const bestTopologyCandidate = topologyCandidates[0] || null;
    const nextTopologyCandidate = topologyCandidates[1] || null;
    const bestTopologyScore = Number(
      bestTopologyCandidate?.topologySupport?.score || Number.NEGATIVE_INFINITY
    );
    const nextTopologyScore = Number(
      nextTopologyCandidate?.topologySupport?.score || Number.NEGATIVE_INFINITY
    );
    const bestTopologyHigher = Number(
      bestTopologyCandidate?.topologySupport?.higherWeight || 0
    );
    const nextTopologyHigher = Number(
      nextTopologyCandidate?.topologySupport?.higherWeight || 0
    );
    const bestTopologyLower = Number(
      bestTopologyCandidate?.topologySupport?.lowerWeight || 0
    );
    const nextTopologyLower = Number(
      nextTopologyCandidate?.topologySupport?.lowerWeight || 0
    );
    const useTopologySelection =
      bestTopologyCandidate &&
      topologyCandidates.length > 1 &&
      (bestTopologyScore >= nextTopologyScore + 0.15 ||
        bestTopologyHigher >= nextTopologyHigher + 0.2 ||
        bestTopologyLower + 0.2 <= nextTopologyLower);

    if (useTopologySelection) {
      return {
        selectedIndex: bestTopologyCandidate.index,
        selectedMultiPolygon: bestTopologyCandidate.multiPolygon,
        scoredCandidates,
        reason: "native_contour_topology",
        comparisonTolerance,
      };
    }

    const terrainSupportCandidates = rawCandidates
      .filter(
        (candidate) =>
          candidate.terrainSupport &&
          Number(candidate.terrainSupport.sampleCount || 0) >= 3
      )
      .sort((left, right) => {
        const leftScore = Number(left.terrainSupport?.score || Number.NEGATIVE_INFINITY);
        const rightScore = Number(right.terrainSupport?.score || Number.NEGATIVE_INFINITY);

        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }

        const leftAboveRatio = Number(left.terrainSupport?.aboveRatio || 0);
        const rightAboveRatio = Number(right.terrainSupport?.aboveRatio || 0);

        if (rightAboveRatio !== leftAboveRatio) {
          return rightAboveRatio - leftAboveRatio;
        }

        return right.sampleElevation - left.sampleElevation;
      });
    const bestTerrainSupportCandidate = terrainSupportCandidates[0] || null;
    const nextTerrainSupportCandidate = terrainSupportCandidates[1] || null;
    const bestTerrainSupportScore = Number(
      bestTerrainSupportCandidate?.terrainSupport?.score || Number.NEGATIVE_INFINITY
    );
    const nextTerrainSupportScore = Number(
      nextTerrainSupportCandidate?.terrainSupport?.score || Number.NEGATIVE_INFINITY
    );
    const bestTerrainAboveRatio = Number(
      bestTerrainSupportCandidate?.terrainSupport?.aboveRatio || 0
    );
    const nextTerrainAboveRatio = Number(
      nextTerrainSupportCandidate?.terrainSupport?.aboveRatio || 0
    );
    const useTerrainSupportSelection =
      bestTerrainSupportCandidate &&
      (bestTerrainAboveRatio >= 0.6 || bestTerrainSupportScore >= 0.22) &&
      (
        bestTerrainSupportScore >= nextTerrainSupportScore + 0.08 ||
        bestTerrainAboveRatio >= nextTerrainAboveRatio + 0.12
      );

    if (useTerrainSupportSelection) {
      return {
        selectedIndex: bestTerrainSupportCandidate.index,
        selectedMultiPolygon: bestTerrainSupportCandidate.multiPolygon,
        scoredCandidates,
        reason: "terrain_grid_support",
        comparisonTolerance,
      };
    }

    if (referenceAreaSqm > 0) {
      const referenceScoredCandidates = rawCandidates
        .filter((candidate) => candidate.referenceMatch)
        .sort((left, right) => {
          const leftScore = Number(left.referenceMatch?.score || Number.NEGATIVE_INFINITY);
          const rightScore = Number(right.referenceMatch?.score || Number.NEGATIVE_INFINITY);

          if (rightScore !== leftScore) {
            return rightScore - leftScore;
          }

          const leftOverlap = Number(left.referenceMatch?.overlapAreaSqm || 0);
          const rightOverlap = Number(right.referenceMatch?.overlapAreaSqm || 0);

          if (rightOverlap !== leftOverlap) {
            return rightOverlap - leftOverlap;
          }

          return right.sampleElevation - left.sampleElevation;
        });
      const bestReferenceCandidate = referenceScoredCandidates[0] || null;
      const nextReferenceCandidate = referenceScoredCandidates[1] || null;
      const bestReferenceScore = Number(
        bestReferenceCandidate?.referenceMatch?.score || Number.NEGATIVE_INFINITY
      );
      const nextReferenceScore = Number(
        nextReferenceCandidate?.referenceMatch?.score || Number.NEGATIVE_INFINITY
      );
      const bestReferenceCoverage = Number(
        bestReferenceCandidate?.referenceMatch?.coverageRatio || 0
      );
      const bestReferencePrecision = Number(
        bestReferenceCandidate?.referenceMatch?.precisionRatio || 0
      );
      const bestReferenceIou = Number(bestReferenceCandidate?.referenceMatch?.iouRatio || 0);
      const bestReferenceOverlap = Number(
        bestReferenceCandidate?.referenceMatch?.overlapAreaSqm || 0
      );
      const nextReferenceOverlap = Number(
        nextReferenceCandidate?.referenceMatch?.overlapAreaSqm || 0
      );
      const sampleSelectedIndex = scoredCandidates[0]?.index ?? null;
      const sampleSelectedCandidate =
        sampleSelectedIndex === null
          ? null
          : referenceScoredCandidates.find((candidate) => candidate.index === sampleSelectedIndex) ||
            null;
      const sampleSelectedReferenceScore = Number(
        sampleSelectedCandidate?.referenceMatch?.score || Number.NEGATIVE_INFINITY
      );
      const ambiguousSampleTie =
        scoredCandidates.length > 1 &&
        Math.abs(
          Number(scoredCandidates[0].sampleElevation || 0) -
            Number(scoredCandidates[1].sampleElevation || 0)
        ) <= comparisonTolerance * 0.5;
      const useReferenceSelection =
        bestReferenceCandidate &&
        (bestReferenceCoverage >= 0.55 ||
          bestReferencePrecision >= 0.35 ||
          bestReferenceIou >= 0.28 ||
          bestReferenceScore >= 0.32) &&
        (bestReferenceScore >= sampleSelectedReferenceScore + 0.08 ||
          bestReferenceScore >= nextReferenceScore + 0.05);
      const useReferenceTieBreak =
        bestReferenceCandidate &&
        ambiguousSampleTie &&
        (bestReferenceCoverage >= 0.18 ||
          bestReferencePrecision >= 0.12 ||
          bestReferenceIou >= 0.09 ||
          bestReferenceScore >= 0.14) &&
        (bestReferenceScore >= nextReferenceScore + 0.02 ||
          bestReferenceOverlap >= nextReferenceOverlap * 1.08 + 5);

      if (useReferenceSelection || useReferenceTieBreak) {
        return {
          selectedIndex: bestReferenceCandidate.index,
          selectedMultiPolygon: bestReferenceCandidate.multiPolygon,
          scoredCandidates,
          reason: useReferenceSelection
            ? "grid_reference_match"
            : "grid_reference_tiebreak",
          comparisonTolerance,
        };
      }
    }

    if (!scoredCandidates.length) {
      return {
        selectedIndex: null,
        selectedMultiPolygon: null,
        scoredCandidates,
        reason: "no_scored_candidates",
        comparisonTolerance,
      };
    }

    const definitelyHigher = scoredCandidates.filter(
      (candidate) => candidate.sampleElevation > elevation + comparisonTolerance
    );

    if (definitelyHigher.length) {
      return {
        selectedIndex: definitelyHigher[0].index,
        selectedMultiPolygon: definitelyHigher[0].multiPolygon,
        scoredCandidates,
        reason: "definitely_higher",
        comparisonTolerance,
      };
    }

    if (
      scoredCandidates.length > 1 &&
      Math.abs(
        Number(scoredCandidates[0].sampleElevation || 0) -
          Number(scoredCandidates[1].sampleElevation || 0)
      ) <= comparisonTolerance * 0.5
    ) {
      return {
        selectedIndex: null,
        selectedMultiPolygon: null,
        scoredCandidates,
        reason: "ambiguous_higher_side",
        comparisonTolerance,
      };
    }

    return {
      selectedIndex: scoredCandidates[0].index,
      selectedMultiPolygon: scoredCandidates[0].multiPolygon,
      scoredCandidates,
      reason: "highest_sample_fallback",
      comparisonTolerance,
    };
  }

  function buildOpenContourClosureDiagnostics(siteContext, contourCollection = null) {
    const clipRect = buildLocalClipRect(siteContext);

    if (!clipRect) {
      return {
        nativeOpenContourCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        acceptedElevations: [],
        rejectedElevations: [],
        entries: [],
      };
    }

    const seed = Math.round(
      Math.abs(Number(siteContext?.location?.lat) * 1000) +
        Math.abs(Number(siteContext?.location?.lng) * 1000)
    );
    const canonicalEntries = buildCanonicalContourInputEntries(siteContext, contourCollection, {
      includeLocalPoints: true,
    });
    const diagnosticEntries = canonicalEntries
      .filter((entry) => entry.source === "native" && entry.closedInput !== true)
      .map((entry) => {
        const closure = resolveOpenContourBoundaryCandidates(entry.localPoints || [], clipRect);
        const selection = resolveHigherContourSideCandidate(
          siteContext,
          entry.elevation,
          closure.candidateMultiPolygons,
          seed
        );

        return {
          contourId: entry.contourId,
          elevation: entry.elevation,
          pointCount: entry.pointCount,
          startBoundaryDistanceMeters: entry.startBoundaryDistanceMeters,
          endBoundaryDistanceMeters: entry.endBoundaryDistanceMeters,
          snappedStartBoundaryDistanceMeters: distanceToClipRectBoundary(
            closure.snappedStartPoint,
            clipRect
          ),
          snappedEndBoundaryDistanceMeters: distanceToClipRectBoundary(
            closure.snappedEndPoint,
            clipRect
          ),
          candidateCount: Number(closure.candidateMultiPolygons?.length || 0),
          candidateSampleElevations: (selection.scoredCandidates || []).map((candidate) =>
            Number(Number(candidate?.sampleElevation || 0).toFixed(3))
          ),
          selectedCandidateIndex: Number.isInteger(selection.selectedIndex)
            ? selection.selectedIndex
            : null,
          selectedBoundaryDirection:
            selection.selectedIndex === 0
              ? "ccw"
              : selection.selectedIndex === 1
                ? "cw"
                : null,
          accepted: Boolean(selection.selectedMultiPolygon?.length),
          closureRejectedReason: closure.rejectedReason,
          selectionReason: selection.reason,
        };
      });

    return {
      nativeOpenContourCount: diagnosticEntries.length,
      acceptedCount: diagnosticEntries.filter((entry) => entry.accepted).length,
      rejectedCount: diagnosticEntries.filter((entry) => !entry.accepted).length,
      acceptedElevations: [
        ...new Set(
          diagnosticEntries
            .filter((entry) => entry.accepted)
            .map((entry) => Number(entry.elevation))
            .sort((left, right) => left - right)
        ),
      ],
      rejectedElevations: [
        ...new Set(
          diagnosticEntries
            .filter((entry) => !entry.accepted)
            .map((entry) => Number(entry.elevation))
            .sort((left, right) => left - right)
        ),
      ],
      entries: diagnosticEntries,
    };
  }

  function buildRawAnchoredContourEntries(
    siteContext,
    clipRect,
    contourCollection = null,
    { resolveReferenceAreaAboveLevel = null, includeSelectionDiagnostics = false } = {}
  ) {
    const seed = Math.round(
      Math.abs(Number(siteContext?.location?.lat) * 1000) +
        Math.abs(Number(siteContext?.location?.lng) * 1000)
    );
    const entries = [];
    const canonicalEntries = buildCanonicalContourInputEntries(
      siteContext,
      contourCollection,
      { includeLocalPoints: true }
    ).filter((entry) => entry.source === "native");

    for (const entry of canonicalEntries) {
      const elevation = Number(entry?.elevation);
      const localPoints = Array.isArray(entry?.localPoints) ? entry.localPoints : [];

      if (!Number.isFinite(elevation) || localPoints.length < 2) {
        continue;
      }

      const closedContour = entry.closedInput === true;
      const contourPoints = closedContour
        ? dedupeLocalPolygonPoints(localPoints, 0.001)
        : mergeContourPolylinePoints(localPoints, 0.001);
      const candidateMultiPolygons = closedContour
        ? buildClosedContourSideMultiPolygons(contourPoints, clipRect)
        : buildOpenContourSideMultiPolygons(contourPoints, clipRect);
      const referenceAreaAbove =
        typeof resolveReferenceAreaAboveLevel === "function"
          ? resolveReferenceAreaAboveLevel(elevation)
          : [];
      const selection = resolveHigherContourSideCandidate(
        siteContext,
        elevation,
        candidateMultiPolygons,
        seed,
        referenceAreaAbove
      );
      let selectedCandidateIndex = Number.isInteger(selection.selectedIndex)
        ? selection.selectedIndex
        : null;
      let higherSideMultiPolygon = selection.selectedMultiPolygon;
      let terrainFallbackUsed = false;
      let selectionReason = selection.reason;

      if (!higherSideMultiPolygon?.length && candidateMultiPolygons.length) {
        const scoredFallback = Array.isArray(selection.scoredCandidates)
          ? selection.scoredCandidates[0]
          : null;
        const fallbackIndex = Number.isInteger(scoredFallback?.index)
          ? scoredFallback.index
          : 0;
        const fallbackMultiPolygon =
          scoredFallback?.multiPolygon?.length
            ? scoredFallback.multiPolygon
            : candidateMultiPolygons[Math.min(fallbackIndex, candidateMultiPolygons.length - 1)] ||
              candidateMultiPolygons[0];

        if (fallbackMultiPolygon?.length) {
          selectedCandidateIndex = fallbackIndex;
          higherSideMultiPolygon = fallbackMultiPolygon;
          terrainFallbackUsed = true;
          selectionReason = `terrain_fallback:${selection.reason || "candidate_0"}`;
        }
      }

      if (higherSideMultiPolygon?.length) {
        entries.push({
          elevation: Number(elevation.toFixed(3)),
          closedInput: closedContour,
          localPoints,
          multiPolygon: higherSideMultiPolygon,
          terrainFallbackUsed,
          ...(includeSelectionDiagnostics
            ? {
                selectionReason,
                selectedCandidateIndex,
                candidateSummaries: (selection.scoredCandidates || []).map((candidate) => ({
                  index: candidate.index,
                  sampleElevation: Number(Number(candidate.sampleElevation || 0).toFixed(3)),
                  areaSqm: Number(
                    computeLocalMultiPolygonArea(candidate.multiPolygon || []).toFixed(3)
                  ),
                  bounds: computeLocalMultiPolygonBounds(candidate.multiPolygon || []),
                  terrainSupport: candidate.terrainSupport
                    ? {
                        sampleCount: Number(candidate.terrainSupport.sampleCount || 0),
                        aboveRatio: Number(
                          Number(candidate.terrainSupport.aboveRatio || 0).toFixed(4)
                        ),
                        belowRatio: Number(
                          Number(candidate.terrainSupport.belowRatio || 0).toFixed(4)
                        ),
                        averageDelta: Number(
                          Number(candidate.terrainSupport.averageDelta || 0).toFixed(4)
                        ),
                        score: Number(Number(candidate.terrainSupport.score || 0).toFixed(4)),
                      }
                    : null,
                  topologySupport: candidate.topologySupport
                    ? {
                        sampledContourCount: Number(
                          candidate.topologySupport.sampledContourCount || 0
                        ),
                        higherWeight: Number(
                          Number(candidate.topologySupport.higherWeight || 0).toFixed(4)
                        ),
                        lowerWeight: Number(
                          Number(candidate.topologySupport.lowerWeight || 0).toFixed(4)
                        ),
                        areaRatio: Number(
                          Number(candidate.topologySupport.areaRatio || 0).toFixed(4)
                        ),
                        score: Number(
                          Number(candidate.topologySupport.score || 0).toFixed(4)
                        ),
                      }
                    : null,
                  referenceMatch: candidate.referenceMatch
                    ? {
                        overlapAreaSqm: Number(
                          Number(candidate.referenceMatch.overlapAreaSqm || 0).toFixed(3)
                        ),
                        coverageRatio: Number(
                          Number(candidate.referenceMatch.coverageRatio || 0).toFixed(4)
                        ),
                        precisionRatio: Number(
                          Number(candidate.referenceMatch.precisionRatio || 0).toFixed(4)
                        ),
                        iouRatio: Number(
                          Number(candidate.referenceMatch.iouRatio || 0).toFixed(4)
                        ),
                        areaDeltaRatio: Number(
                          Number(candidate.referenceMatch.areaDeltaRatio || 0).toFixed(4)
                        ),
                        score: Number(Number(candidate.referenceMatch.score || 0).toFixed(4)),
                      }
                    : null,
                })),
                referenceAreaSqm: Number(computeLocalMultiPolygonArea(referenceAreaAbove).toFixed(3)),
              }
            : {}),
          ...(includeSelectionDiagnostics
            ? {
                terrainSupport: selection.scoredCandidates
                  .find((candidate) => candidate.index === selection.selectedIndex)
                  ?.terrainSupport || null,
              }
            : {}),
        });
      }
    }

    return entries;
  }

  function buildNativeContourLoopEntries(
    siteContext,
    contourCollection = null,
    { allowAmbiguousFallback = false } = {}
  ) {
    if (!siteContext?.location) {
      return [];
    }

    const seed = Math.round(
      Math.abs(Number(siteContext?.location?.lat) * 1000) +
        Math.abs(Number(siteContext?.location?.lng) * 1000)
    );
    const clipRect = buildLocalClipRect(siteContext);

    if (!clipRect) {
      return [];
    }

    const entries = [];
    const entryKeys = new Set();
    const canonicalNativeEntries = buildCanonicalContourInputEntries(
      siteContext,
      contourCollection,
      { includeLocalPoints: true }
    ).filter((entry) => entry.source === "native");

    for (const entry of canonicalNativeEntries) {
      let closedLoopPoints = [];
      let closureFallbackUsed = false;
      let closureSelectionReason = null;

      if (entry.closedInput === true) {
        closedLoopPoints = closeRing(dedupeLocalPolygonPoints(entry.localPoints || [], 0.001));
        closureSelectionReason = "already_closed";
      } else {
        const closure = resolveOpenContourBoundaryCandidates(entry.localPoints || [], clipRect);
        const selection = resolveHigherContourSideCandidate(
          siteContext,
          entry.elevation,
          closure.candidateMultiPolygons,
          seed
        );
        let selectedIndex = Number.isInteger(selection.selectedIndex)
          ? selection.selectedIndex
          : null;

        if (
          !Number.isInteger(selectedIndex) &&
          allowAmbiguousFallback &&
          Array.isArray(closure.candidatePolygons) &&
          closure.candidatePolygons.length
        ) {
          const scoredFallbackIndex = Number.isInteger(selection?.scoredCandidates?.[0]?.index)
            ? selection.scoredCandidates[0].index
            : null;
          selectedIndex = Number.isInteger(scoredFallbackIndex) ? scoredFallbackIndex : 0;
          closureFallbackUsed = true;
        }

        if (Number.isInteger(selectedIndex)) {
          closedLoopPoints = closeRing(
            dedupeLocalPolygonPoints(
              closure.candidatePolygons?.[selectedIndex] || [],
              0.001
            )
          );
          closureSelectionReason = closureFallbackUsed
            ? `display_fallback:${selection.reason || "candidate_0"}`
            : selection.reason || "selected";
        }
      }

      const loopPoints = dedupeLocalPolygonPoints(closedLoopPoints, 0.001);

      if (loopPoints.length < 3) {
        continue;
      }

      const levelKey = buildContourLevelKey(entry.elevation);
      const entryKey = [
        levelKey,
        loopPoints.map((point) => buildLocalPointKey(point, 3)).join(";"),
      ].join("|");

      if (entryKeys.has(entryKey)) {
        continue;
      }

      entryKeys.add(entryKey);
      entries.push({
        elevation: Number(Number(entry.elevation).toFixed(3)),
        closedInput: entry.closedInput === true,
        sourceLinePoints: entry.localPoints || [],
        loopPoints,
        closedLoopPoints: closeRing(loopPoints),
        closureFallbackUsed,
        closureSelectionReason,
      });
    }

    return entries;
  }

  return {
    buildOpenContourSideMultiPolygons,
    resolveOpenContourBoundaryCandidates,
    buildClosedContourSideMultiPolygons,
    selectHigherContourSideMultiPolygon,
    selectLegacyHigherContourSideMultiPolygon,
    resolveHigherContourSideCandidate,
    buildOpenContourClosureDiagnostics,
    buildRawAnchoredContourEntries,
    buildNativeContourLoopEntries,
  };
}

export { createContourClosure };
