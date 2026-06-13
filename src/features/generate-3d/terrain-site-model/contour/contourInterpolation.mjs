function createContourInterpolation({
  MIN_CONTOUR_INTERVAL_METERS,
  featureCollection,
  resolveSourceContourInterval,
  buildContourElevationKeySet,
  buildContourLevelKey,
  buildContourExportMetadata,
  buildNativeContourLoopEntries,
  buildRawAnchoredContourBandAssembly,
  dedupeLocalPolygonPoints,
  orientLocalPolygonCounterClockwise,
  computeRegionBounds,
  isPointInsideOrOnAnyLocalRegion,
  buildTerrainSampleGridWithExplicitStep,
  distancePointToLocalSegment,
  interpolateLocalSegmentPoint,
  pointInRing,
  createContourLinesFromTerrainGrid,
  formatErrorForLog,
  getLineStringsFromGeometry,
  localMetersFromLngLat,
  mergeContourPolylinePoints,
  pointsMatchInMeters,
  closeRing,
  buildLocalPointKey,
  lineFeature,
  lngLatFromMeters,
  buildLocalClipRect,
  simplifyLocalPolygonDouglasPeucker,
  smoothLocalPolygonChaikin,
  simplifyLocalPolylineDouglasPeucker,
  smoothLocalPolylineChaikin,
  resolveOpenContourBoundaryCandidates,
  resolveHigherContourSideCandidate,
  buildContourBandSlices,
  buildContourBandRegionsForSlices,
  buildPolygonClippingMultiPolygonFromRegions,
  buildContourBandGroupFromMultiPolygon,
  unionLocalMultiPolygons,
  normalizeContourRegionsForLevel,
  buildContourBandRegionsFromMultiPolygon,
  pruneTransientGeneratedGroupRegions,
  resolveRawAnchoredContourCleanupAreaThreshold,
  computeLocalPolygonSignedArea,
}) {
  function resolveGeneratedContourInterpolationGridStep(
    siteContext,
    contourInterval,
    sourceContourInterval = 0
  ) {
    const terrainStep = Number(siteContext?.terrainGrid?.step || 0);
    const minimumStep = Math.max(0.35, contourInterval * 0.45);
    const maximumStep = Math.max(
      minimumStep,
      Math.min(
        1.1,
        sourceContourInterval > 0 ? sourceContourInterval * 0.22 : contourInterval * 1.1
      )
    );
    const preferredStep =
      terrainStep > 0
        ? Math.max(terrainStep, contourInterval * 0.6)
        : contourInterval * 0.65;

    return Number(
      Math.min(maximumStep, Math.max(minimumStep, preferredStep)).toFixed(3)
    );
  }

  function ensureGeneratedContourDiagnostics(siteContext) {
    if (!siteContext || typeof siteContext !== "object") {
      return null;
    }

    if (!siteContext.stats || typeof siteContext.stats !== "object") {
      siteContext.stats = {
        ...(siteContext.stats || {}),
      };
    }

    if (
      !siteContext.stats.generatedContourDiagnostics ||
      typeof siteContext.stats.generatedContourDiagnostics !== "object"
    ) {
      siteContext.stats.generatedContourDiagnostics = {
        generatedContourCandidateCount: 0,
        generatedContourClosedAcceptedCount: 0,
        generatedContourOpenRejectedCount: 0,
        generatedContourNativeLevelRejectedCount: 0,
        generatedContourFallbackUsed: 0,
        generatedContourFinalExportCount: 0,
      };
    }

    return siteContext.stats.generatedContourDiagnostics;
  }

  function resetGeneratedContourDiagnostics(siteContext) {
    const diagnostics = ensureGeneratedContourDiagnostics(siteContext);

    if (!diagnostics) {
      return null;
    }

    diagnostics.generatedContourCandidateCount = 0;
    diagnostics.generatedContourClosedAcceptedCount = 0;
    diagnostics.generatedContourOpenRejectedCount = 0;
    diagnostics.generatedContourNativeLevelRejectedCount = 0;
    diagnostics.generatedContourFallbackUsed = 0;
    diagnostics.generatedContourFinalExportCount = 0;

    return diagnostics;
  }

  function incrementGeneratedContourDiagnostic(siteContext, key, amount = 1) {
    const diagnostics = ensureGeneratedContourDiagnostics(siteContext);

    if (!diagnostics || !Number.isFinite(amount) || amount === 0) {
      return;
    }

    diagnostics[key] = Number(diagnostics[key] || 0) + Number(amount);
  }

  function buildContourInterpolationGridAxisValues(minValue, maxValue, step) {
    if (
      !Number.isFinite(minValue) ||
      !Number.isFinite(maxValue) ||
      !Number.isFinite(step) ||
      step <= 0
    ) {
      return [];
    }

    const normalizedStep = Math.max(0.05, Number(step) || 0);
    let startValue = Number((Math.floor(minValue / normalizedStep) * normalizedStep).toFixed(3));
    let endValue = Number((Math.ceil(maxValue / normalizedStep) * normalizedStep).toFixed(3));

    if (!(endValue > startValue + 1e-9)) {
      endValue = Number((startValue + normalizedStep).toFixed(3));
    }

    const values = [];

    for (
      let value = startValue;
      value <= endValue + normalizedStep * 0.25;
      value = Number((value + normalizedStep).toFixed(6))
    ) {
      values.push(Number(value.toFixed(3)));
    }

    if (values.length < 2) {
      values.push(Number((values[0] + normalizedStep).toFixed(3)));
    }

    return values;
  }

  function buildLocalBoundarySegmentsFromRegions(regions) {
    const segments = [];

    for (const region of regions || []) {
      for (const ring of [region?.outerPoints, ...(region?.holePoints || [])]) {
        const closedRing = closeRing(dedupeLocalPolygonPoints(ring, 0.001));

        if (closedRing.length < 4) {
          continue;
        }

        for (let index = 1; index < closedRing.length; index += 1) {
          const startPoint = closedRing[index - 1];
          const endPoint = closedRing[index];

          if (
            !Array.isArray(startPoint) ||
            !Array.isArray(endPoint) ||
            pointsMatchInMeters(startPoint, endPoint, 0.001)
          ) {
            continue;
          }

          segments.push({
            startPoint,
            endPoint,
            minX: Math.min(startPoint[0], endPoint[0]),
            maxX: Math.max(startPoint[0], endPoint[0]),
            minY: Math.min(startPoint[1], endPoint[1]),
            maxY: Math.max(startPoint[1], endPoint[1]),
          });
        }
      }
    }

    return segments;
  }

  function distancePointToLocalBoundarySegments(point, segments) {
    if (!Array.isArray(point) || !segments?.length) {
      return 0;
    }

    const [xMeters, yMeters] = point;

    if (!Number.isFinite(xMeters) || !Number.isFinite(yMeters)) {
      return 0;
    }

    let bestDistance = Number.POSITIVE_INFINITY;

    for (const segment of segments) {
      if (
        Number.isFinite(bestDistance) &&
        (xMeters < segment.minX - bestDistance ||
          xMeters > segment.maxX + bestDistance ||
          yMeters < segment.minY - bestDistance ||
          yMeters > segment.maxY + bestDistance)
      ) {
        continue;
      }

      const distance = distancePointToLocalSegment(
        point,
        segment.startPoint,
        segment.endPoint
      );

      if (distance < bestDistance) {
        bestDistance = distance;

        if (bestDistance <= 0.001) {
          return 0;
        }
      }
    }

    return Number.isFinite(bestDistance) ? Number(bestDistance.toFixed(6)) : 0;
  }

  function buildLocalPolylineMetric(points, closed = false) {
    const normalizedPoints = closed
      ? dedupeLocalPolygonPoints(points, 0.001)
      : mergeContourPolylinePoints(points, 0.001);

    if (normalizedPoints.length < (closed ? 3 : 2)) {
      return null;
    }

    const segments = [];
    let totalLength = 0;
    const segmentCount = closed
      ? normalizedPoints.length
      : normalizedPoints.length - 1;

    for (let index = 0; index < segmentCount; index += 1) {
      const startPoint = normalizedPoints[index];
      const endPoint = closed
        ? normalizedPoints[(index + 1) % normalizedPoints.length]
        : normalizedPoints[index + 1];
      const length = Math.hypot(
        Number(endPoint?.[0] || 0) - Number(startPoint?.[0] || 0),
        Number(endPoint?.[1] || 0) - Number(startPoint?.[1] || 0)
      );

      if (!(length > 1e-9)) {
        continue;
      }

      segments.push({
        startPoint,
        endPoint,
        startDistance: totalLength,
        endDistance: totalLength + length,
        length,
      });
      totalLength += length;
    }

    if (!(totalLength > 1e-6) || !segments.length) {
      return null;
    }

    return {
      points: normalizedPoints,
      segments,
      totalLength: Number(totalLength.toFixed(6)),
      closed,
    };
  }

  function sampleLocalPolylineMetricPoint(metric, normalizedT) {
    if (!metric?.segments?.length || !(metric.totalLength > 0)) {
      return null;
    }

    const clampedT = metric.closed
      ? ((Number(normalizedT) % 1) + 1) % 1
      : Math.max(0, Math.min(1, Number(normalizedT) || 0));
    const targetDistance = clampedT * metric.totalLength;

    for (const segment of metric.segments) {
      if (targetDistance <= segment.endDistance + 1e-9) {
        const localDistance = Math.max(
          0,
          Math.min(segment.length, targetDistance - segment.startDistance)
        );
        const ratio = segment.length > 1e-9 ? localDistance / segment.length : 0;
        return interpolateLocalSegmentPoint(
          segment.startPoint,
          segment.endPoint,
          ratio
        );
      }
    }

    const lastSegment = metric.segments[metric.segments.length - 1];
    return [...(lastSegment?.endPoint || lastSegment?.startPoint || metric.points[metric.points.length - 1])];
  }

  function resampleLocalPolylineMetric(metric, sampleCount) {
    if (!metric || !Number.isInteger(sampleCount) || sampleCount < 2) {
      return [];
    }

    const points = [];

    if (metric.closed) {
      for (let index = 0; index < sampleCount; index += 1) {
        points.push(
          sampleLocalPolylineMetricPoint(metric, index / sampleCount)
        );
      }
      return points.filter(Boolean);
    }

    for (let index = 0; index < sampleCount; index += 1) {
      const divisor = Math.max(1, sampleCount - 1);
      points.push(
        sampleLocalPolylineMetricPoint(metric, index / divisor)
      );
    }

    return points.filter(Boolean);
  }

  function computeAverageLocalPointDistance(leftPoints, rightPoints) {
    if (
      !Array.isArray(leftPoints) ||
      !Array.isArray(rightPoints) ||
      leftPoints.length !== rightPoints.length ||
      !leftPoints.length
    ) {
      return Number.POSITIVE_INFINITY;
    }

    let totalDistance = 0;

    for (let index = 0; index < leftPoints.length; index += 1) {
      totalDistance += Math.hypot(
        Number(rightPoints[index]?.[0] || 0) - Number(leftPoints[index]?.[0] || 0),
        Number(rightPoints[index]?.[1] || 0) - Number(leftPoints[index]?.[1] || 0)
      );
    }

    return Number((totalDistance / leftPoints.length).toFixed(6));
  }

  function rotateLocalPoints(points, offset) {
    if (!Array.isArray(points) || !points.length) {
      return [];
    }

    const safeOffset = ((Number(offset) % points.length) + points.length) % points.length;
    return [...points.slice(safeOffset), ...points.slice(0, safeOffset)];
  }

  function reverseLocalPolylinePoints(points, closed = false) {
    const reversed = [...(points || [])].reverse();
    return closed ? reversed : reversed;
  }

  function resolveGeneratedContourPairSampleCount(lowerMetric, upperMetric) {
    const pairLength = Math.max(
      Number(lowerMetric?.totalLength || 0),
      Number(upperMetric?.totalLength || 0),
      1
    );

    return Math.max(24, Math.min(160, Math.round(pairLength / 2.5)));
  }

  function averageLocalPointSet(points) {
    if (!Array.isArray(points) || !points.length) {
      return [0, 0];
    }

    const total = points.reduce(
      (result, point) => [
        result[0] + Number(point?.[0] || 0),
        result[1] + Number(point?.[1] || 0),
      ],
      [0, 0]
    );

    return [
      Number((total[0] / points.length).toFixed(6)),
      Number((total[1] / points.length).toFixed(6)),
    ];
  }

  function computeContourLoopContainmentRatio(loopPoints, samplePoints) {
    if (!Array.isArray(loopPoints) || loopPoints.length < 3 || !Array.isArray(samplePoints)) {
      return 0;
    }

    let insideCount = 0;
    let sampleCount = 0;

    for (const point of samplePoints) {
      if (
        !Array.isArray(point) ||
        point.length < 2 ||
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1])
      ) {
        continue;
      }

      sampleCount += 1;

      if (pointInRing(point, loopPoints)) {
        insideCount += 1;
      }
    }

    return sampleCount > 0 ? Number((insideCount / sampleCount).toFixed(6)) : 0;
  }

  function computeInterpolatedBandViolationRatio(
    lowerLoopPoints,
    upperLoopPoints,
    lowerSamples,
    upperSamples
  ) {
    if (
      !Array.isArray(lowerLoopPoints) ||
      lowerLoopPoints.length < 3 ||
      !Array.isArray(upperLoopPoints) ||
      upperLoopPoints.length < 3 ||
      !Array.isArray(lowerSamples) ||
      !Array.isArray(upperSamples) ||
      lowerSamples.length !== upperSamples.length ||
      !lowerSamples.length
    ) {
      return 1;
    }

    const ratios = [0.2, 0.4, 0.6, 0.8];
    let violationCount = 0;
    let probeCount = 0;

    for (let pointIndex = 0; pointIndex < lowerSamples.length; pointIndex += 1) {
      const lowerPoint = lowerSamples[pointIndex];
      const upperPoint = upperSamples[pointIndex];

      for (const ratio of ratios) {
        const probePoint = interpolateLocalSegmentPoint(lowerPoint, upperPoint, ratio);
        const insideLower = pointInRing(probePoint, lowerLoopPoints);
        const insideUpper = pointInRing(probePoint, upperLoopPoints);
        probeCount += 1;

        if (!insideLower || insideUpper) {
          violationCount += 1;
        }
      }
    }

    return probeCount > 0 ? Number((violationCount / probeCount).toFixed(6)) : 1;
  }

  function alignOpenContourPairSamples(lowerMetric, upperMetric, sampleCount) {
    const lowerSamples = resampleLocalPolylineMetric(lowerMetric, sampleCount);
    const upperForwardSamples = resampleLocalPolylineMetric(upperMetric, sampleCount);
    const reversedUpperMetric = buildLocalPolylineMetric(
      reverseLocalPolylinePoints(upperMetric?.points || []),
      false
    );
    const upperReverseSamples = resampleLocalPolylineMetric(
      reversedUpperMetric,
      sampleCount
    );
    const forwardScore =
      computeAverageLocalPointDistance(lowerSamples, upperForwardSamples) +
      Math.hypot(
        Number(upperForwardSamples[0]?.[0] || 0) - Number(lowerSamples[0]?.[0] || 0),
        Number(upperForwardSamples[0]?.[1] || 0) - Number(lowerSamples[0]?.[1] || 0)
      ) * 0.2 +
      Math.hypot(
        Number(upperForwardSamples[upperForwardSamples.length - 1]?.[0] || 0) -
          Number(lowerSamples[lowerSamples.length - 1]?.[0] || 0),
        Number(upperForwardSamples[upperForwardSamples.length - 1]?.[1] || 0) -
          Number(lowerSamples[lowerSamples.length - 1]?.[1] || 0)
      ) * 0.2;
    const reverseScore =
      computeAverageLocalPointDistance(lowerSamples, upperReverseSamples) +
      Math.hypot(
        Number(upperReverseSamples[0]?.[0] || 0) - Number(lowerSamples[0]?.[0] || 0),
        Number(upperReverseSamples[0]?.[1] || 0) - Number(lowerSamples[0]?.[1] || 0)
      ) * 0.2 +
      Math.hypot(
        Number(upperReverseSamples[upperReverseSamples.length - 1]?.[0] || 0) -
          Number(lowerSamples[lowerSamples.length - 1]?.[0] || 0),
        Number(upperReverseSamples[upperReverseSamples.length - 1]?.[1] || 0) -
          Number(lowerSamples[lowerSamples.length - 1]?.[1] || 0)
      ) * 0.2;

    if (forwardScore <= reverseScore) {
      return {
        lowerSamples,
        upperSamples: upperForwardSamples,
        score: Number(forwardScore.toFixed(6)),
      };
    }

    return {
      lowerSamples,
      upperSamples: upperReverseSamples,
      score: Number(reverseScore.toFixed(6)),
    };
  }

  function alignClosedContourPairSamples(lowerMetric, upperMetric, sampleCount) {
    const lowerSamples = resampleLocalPolylineMetric(lowerMetric, sampleCount);
    const orientationSamples = [
      resampleLocalPolylineMetric(upperMetric, sampleCount),
      resampleLocalPolylineMetric(
        buildLocalPolylineMetric(
          reverseLocalPolylinePoints(upperMetric?.points || [], true),
          true
        ),
        sampleCount
      ),
    ].filter((samples) => samples.length === lowerSamples.length);
    let bestUpperSamples = [];
    let bestScore = Number.POSITIVE_INFINITY;

    for (const upperSamples of orientationSamples) {
      for (let offset = 0; offset < upperSamples.length; offset += 1) {
        const rotatedUpperSamples = rotateLocalPoints(upperSamples, offset);
        const score = computeAverageLocalPointDistance(
          lowerSamples,
          rotatedUpperSamples
        );

        if (score < bestScore) {
          bestScore = score;
          bestUpperSamples = rotatedUpperSamples;
        }
      }
    }

    return {
      lowerSamples,
      upperSamples: bestUpperSamples,
      score: Number(bestScore.toFixed(6)),
    };
  }

  function buildGeneratedContourBandRecordsFromNativeAreas(
    siteContext,
    sourceContourInterval
  ) {
    if (
      !siteContext?.clipBoundary ||
      !siteContext?.contourLines?.features?.length ||
      !Number.isFinite(sourceContourInterval) ||
      sourceContourInterval <= 0
    ) {
      return [];
    }

    const nativeIntervalStats = {
      ...(siteContext?.stats || {}),
    };
    nativeIntervalStats.requestedContourInterval = sourceContourInterval;
    nativeIntervalStats.effectiveContourBandInterval = sourceContourInterval;
    nativeIntervalStats.effectiveContourDisplayInterval = sourceContourInterval;
    const nativeIntervalSiteContext = {
      ...siteContext,
      options: {
        ...(siteContext?.options || {}),
        contourInterval: sourceContourInterval,
      },
      stats: nativeIntervalStats,
    };
    const nativeContourCollection = featureCollection(
      (siteContext?.contourLines?.features || []).filter(
        (feature) => feature?.properties?.generated !== true
      )
    );
    const nativeLoopEntries = buildNativeContourLoopEntries(
      siteContext,
      nativeContourCollection,
      { allowAmbiguousFallback: true }
    );
    const nativeLoopRegionsByLevel = new Map();
    const nativeLoopSegmentsByLevel = new Map();
    const nativeContourLevels = [
      ...new Set(
        nativeLoopEntries
          .map((entry) => Number(entry?.elevation))
          .filter(Number.isFinite)
          .map((value) => Number(value.toFixed(3)))
      ),
    ].sort((left, right) => left - right);
    for (const entry of nativeLoopEntries) {
      const levelKey = buildContourLevelKey(entry?.elevation);

      if (!nativeLoopRegionsByLevel.has(levelKey)) {
        nativeLoopRegionsByLevel.set(levelKey, []);
      }

      const loopPoints = dedupeLocalPolygonPoints(
        entry?.loopPoints || entry?.closedLoopPoints || [],
        0.001
      );

      if (loopPoints.length < 3) {
        continue;
      }

      nativeLoopRegionsByLevel.get(levelKey).push({
        outerPoints: orientLocalPolygonCounterClockwise(loopPoints),
        holePoints: [],
      });
    }
    for (const [levelKey, regions] of nativeLoopRegionsByLevel.entries()) {
      nativeLoopSegmentsByLevel.set(levelKey, buildLocalBoundarySegmentsFromRegions(regions));
    }
    const nativeAssembly = buildRawAnchoredContourBandAssembly(nativeIntervalSiteContext);

    if (
      !(nativeAssembly?.resolvedAreaAboveByLevel instanceof Map) ||
      nativeContourLevels.length < 2
    ) {
      return [];
    }

    const bandGroupByBottom = new Map(
      (nativeAssembly?.bandGroups || []).map((group) => [
        buildContourLevelKey(group?.bottomElevation),
        group,
      ])
    );
    const records = [];

    for (let index = 0; index < nativeContourLevels.length - 1; index += 1) {
      const bottomElevation = Number(nativeContourLevels[index].toFixed(3));
      const topElevation = Number(nativeContourLevels[index + 1].toFixed(3));

      if (!(topElevation > bottomElevation + 0.001)) {
        continue;
      }

      const levelKey = buildContourLevelKey(bottomElevation);
      const topLevelKey = buildContourLevelKey(topElevation);
      const bandGroup = bandGroupByBottom.get(levelKey) || null;
      const exactLowerRegions = nativeLoopRegionsByLevel.get(levelKey) || [];
      const exactUpperRegions = nativeLoopRegionsByLevel.get(topLevelKey) || [];
      const lowerSegments = nativeLoopSegmentsByLevel.get(levelKey) || [];
      const upperSegments = nativeLoopSegmentsByLevel.get(topLevelKey) || [];

      if (
        !bandGroup?.regions?.length ||
        !exactLowerRegions.length ||
        !exactUpperRegions.length ||
        !lowerSegments.length ||
        !upperSegments.length
      ) {
        continue;
      }

      records.push({
        bottomElevation,
        topElevation,
        regions: bandGroup.regions,
        bounds: bandGroup.bounds || computeRegionBounds(bandGroup.regions),
        lowerSegments,
        upperSegments,
      });
    }

    return records;
  }

  function resolveGeneratedContourBandRecordForPoint(point, bandRecords) {
    if (!Array.isArray(point) || point.length < 2 || !bandRecords?.length) {
      return null;
    }

    const [xMeters, yMeters] = point;

    if (!Number.isFinite(xMeters) || !Number.isFinite(yMeters)) {
      return null;
    }

    for (const record of bandRecords) {
      const bounds = record?.bounds;

      if (
        bounds &&
        (xMeters < bounds.minX - 0.001 ||
          xMeters > bounds.maxX + 0.001 ||
          yMeters < bounds.minY - 0.001 ||
          yMeters > bounds.maxY + 0.001)
      ) {
        continue;
      }

      if (isPointInsideOrOnAnyLocalRegion(point, record?.regions || [])) {
        return record;
      }
    }

    return null;
  }

  function buildTerrainGridFromNativeContourBands(
    siteContext,
    contourInterval,
    sourceContourInterval
  ) {
    if (
      !siteContext?.location ||
      !siteContext?.clipBoundary ||
      !Number.isFinite(contourInterval) ||
      contourInterval <= 0 ||
      !Number.isFinite(sourceContourInterval) ||
      !(sourceContourInterval > contourInterval + 1e-9)
    ) {
      return null;
    }

    const bandRecords = buildGeneratedContourBandRecordsFromNativeAreas(
      siteContext,
      sourceContourInterval
    );

    if (!bandRecords.length) {
      return null;
    }

    const sampleStep = resolveGeneratedContourInterpolationGridStep(
      siteContext,
      contourInterval,
      sourceContourInterval
    );
    const sampleGrid = buildTerrainSampleGridWithExplicitStep(
      siteContext.location,
      siteContext.clipBoundary,
      sampleStep
    );
    const snapDistance = Math.max(0.03, sampleGrid.step * 0.08);
    const elevations = [];
    const numericElevations = [];

    for (const row of sampleGrid.cells) {
      const elevationRow = [];

      for (const point of row) {
        if (!point.inside) {
          elevationRow.push(null);
          continue;
        }

        const localPoint = [point.x, point.y];
        const bandRecord = resolveGeneratedContourBandRecordForPoint(
          localPoint,
          bandRecords
        );

        if (!bandRecord) {
          elevationRow.push(null);
          continue;
        }

        const lowerDistance = distancePointToLocalBoundarySegments(
          localPoint,
          bandRecord.lowerSegments
        );
        const upperDistance = distancePointToLocalBoundarySegments(
          localPoint,
          bandRecord.upperSegments
        );

        if (!Number.isFinite(lowerDistance) || !Number.isFinite(upperDistance)) {
          elevationRow.push(null);
          continue;
        }

        let elevation = bandRecord.bottomElevation;

        if (upperDistance <= snapDistance) {
          elevation = bandRecord.topElevation;
        } else if (lowerDistance > snapDistance) {
          const totalDistance = lowerDistance + upperDistance;

          if (totalDistance > 1e-9) {
            const ratio = Math.max(0, Math.min(1, lowerDistance / totalDistance));
            elevation =
              bandRecord.bottomElevation +
              (bandRecord.topElevation - bandRecord.bottomElevation) * ratio;
          }
        }

        const normalizedElevation = Number(elevation.toFixed(3));
        elevationRow.push(normalizedElevation);
        numericElevations.push(normalizedElevation);
      }

      elevations.push(elevationRow);
    }

    if (!numericElevations.length) {
      return null;
    }

    const bandBottomElevations = bandRecords
      .map((record) => Number(record?.bottomElevation))
      .filter(Number.isFinite);
    const bandTopElevations = bandRecords
      .map((record) => Number(record?.topElevation))
      .filter(Number.isFinite);

    return {
      step: sampleGrid.step,
      xValues: sampleGrid.xValues,
      yValues: sampleGrid.yValues,
      elevations,
      minElevation: Number(
        Math.min(...(bandBottomElevations.length ? bandBottomElevations : numericElevations)).toFixed(
          2
        )
      ),
      maxElevation: Number(
        Math.max(...(bandTopElevations.length ? bandTopElevations : numericElevations)).toFixed(2)
      ),
    };
  }

  function buildGeneratedContourLinesFromNativeAnchorBands(siteContext, contourInterval) {
    if (
      !siteContext?.location ||
      !Number.isFinite(contourInterval) ||
      contourInterval <= 0
    ) {
      return featureCollection([]);
    }

    const sourceContourInterval = resolveSourceContourInterval(siteContext);

    if (!(sourceContourInterval > contourInterval + 1e-9)) {
      return featureCollection([]);
    }

    if (!siteContext?.clipBoundary) {
      return featureCollection([]);
    }

    const nativeContourLines = featureCollection(
      (siteContext?.contourLines?.features || []).filter(
        (feature) => feature?.properties?.generated !== true
      )
    );

    if (!(nativeContourLines?.features?.length > 0)) {
      return featureCollection([]);
    }

    const nativeElevationKeys = buildContourElevationKeySet(nativeContourLines);
    let generatedTerrainGrid = null;

    try {
      generatedTerrainGrid = buildTerrainGridFromNativeContourBands(
        siteContext,
        contourInterval,
        sourceContourInterval
      );
    } catch (error) {
      console.warn(
        `[contour-display] native contour band interpolation failed source=${sourceContourInterval} target=${contourInterval} error=${formatErrorForLog(
          error
        )}`
      );
      return featureCollection([]);
    }

    if (!generatedTerrainGrid?.elevations?.length) {
      return featureCollection([]);
    }

    const generatedContourCollection = createContourLinesFromTerrainGrid(
      siteContext.location,
      generatedTerrainGrid,
      {
        ...(siteContext?.options || {}),
        contourInterval,
      }
    );
    const features = [];
    const featureKeys = new Set();

    for (const feature of generatedContourCollection?.features || []) {
      const elevation = Number(feature?.properties?.elevation);

      if (!Number.isFinite(elevation)) {
        continue;
      }

      const levelKey = buildContourLevelKey(elevation);
      const lineStrings = getLineStringsFromGeometry(feature.geometry);

      if (nativeElevationKeys.has(levelKey)) {
        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourCandidateCount",
          Math.max(1, lineStrings.length || 0)
        );
        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourNativeLevelRejectedCount",
          Math.max(1, lineStrings.length || 0)
        );
        continue;
      }

      for (const lineString of lineStrings) {
        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourCandidateCount",
          1
        );

        const localPoints = mergeContourPolylinePoints(
          lineString
            .map((point) => localMetersFromLngLat(point, siteContext.location))
            .filter(
              (point) =>
                Array.isArray(point) &&
                Number.isFinite(point[0]) &&
                Number.isFinite(point[1])
            ),
          0.001
        );

        if (localPoints.length < 2) {
          continue;
        }

        const closedLoop =
          localPoints.length >= 3 &&
          pointsMatchInMeters(localPoints[0], localPoints[localPoints.length - 1], 0.001);
        const normalizedPoints =
          closedLoop === true
            ? closeRing(dedupeLocalPolygonPoints(localPoints, 0.001))
            : localPoints;
        const featureKey = [
          levelKey,
          normalizedPoints.map((point) => buildLocalPointKey(point, 3)).join(";"),
        ].join("|");

        if (featureKeys.has(featureKey)) {
          continue;
        }

        featureKeys.add(featureKey);
        features.push(
          lineFeature(
            normalizedPoints.map(([xMeters, yMeters]) =>
              lngLatFromMeters(siteContext.location, xMeters, yMeters)
            ),
            {
              elevation: Number(elevation.toFixed(3)),
              provider: "derived-contours-native-band",
              generated: true,
              closedLoop,
              exportDerived: "native-band-interpolation",
              sourceContourIntervalMeters: Number(sourceContourInterval.toFixed(3)),
              interpolationTerrainGridStep: Number(
                Number(generatedTerrainGrid.step || 0).toFixed(3)
              ),
              ...buildContourExportMetadata(siteContext, {
                generated: true,
                contourInterval,
              }),
            }
          )
        );

        if (closedLoop === true) {
          incrementGeneratedContourDiagnostic(
            siteContext,
            "generatedContourClosedAcceptedCount",
            1
          );
        }
      }
    }

    return featureCollection(
      features.sort(
        (left, right) =>
          Number(left?.properties?.elevation || 0) -
            Number(right?.properties?.elevation || 0) ||
          Number(Boolean(left?.properties?.generated)) -
            Number(Boolean(right?.properties?.generated))
      )
    );
  }

  function buildClosedGeneratedContourLinesFromInterpolatedGrid(
    siteContext,
    contourInterval
  ) {
    if (
      !siteContext?.location ||
      !siteContext?.clipBoundary ||
      !Number.isFinite(contourInterval) ||
      contourInterval <= 0
    ) {
      return featureCollection([]);
    }

    const sourceContourInterval = resolveSourceContourInterval(siteContext);

    if (!(sourceContourInterval > contourInterval + 1e-9)) {
      return featureCollection([]);
    }

    const nativeContourLines = featureCollection(
      (siteContext?.contourLines?.features || []).filter(
        (feature) => feature?.properties?.generated !== true
      )
    );

    if (!(nativeContourLines?.features?.length > 0)) {
      return featureCollection([]);
    }

    const nativeElevationKeys = buildContourElevationKeySet(nativeContourLines);
    const clipRect = buildLocalClipRect(siteContext);

    if (!clipRect) {
      return featureCollection([]);
    }

    let generatedTerrainGrid = null;

    try {
      generatedTerrainGrid = buildTerrainGridFromNativeContourBands(
        siteContext,
        contourInterval,
        sourceContourInterval
      );
    } catch (error) {
      console.warn(
        `[contour-export] closed interpolated contour grid failed source=${sourceContourInterval} target=${contourInterval} error=${formatErrorForLog(
          error
        )}`
      );

      return featureCollection([]);
    }

    if (!generatedTerrainGrid?.elevations?.length) {
      return featureCollection([]);
    }

    const generatedContourCollection = createContourLinesFromTerrainGrid(
      siteContext.location,
      generatedTerrainGrid,
      {
        ...(siteContext?.options || {}),
        contourInterval,
      }
    );

    const seed = Math.round(
      Math.abs(Number(siteContext?.location?.lat) * 1000) +
        Math.abs(Number(siteContext?.location?.lng) * 1000)
    );

    const features = [];
    const featureKeys = new Set();

    const simplifyTolerance = Math.max(
      0.02,
      Math.min(0.18, Number(generatedTerrainGrid.step || 0.5) * 0.12)
    );

    const smoothingMinSegment = Math.max(
      0.05,
      Math.min(0.35, Number(generatedTerrainGrid.step || 0.5) * 0.35)
    );

    const appendClosedGeneratedLoop = (
      closedLoopPoints,
      elevation,
      {
        closureMode = "unknown",
        closureFallbackUsed = false,
        closureSelectionReason = null,
      } = {}
    ) => {
      let normalizedLoop = closeRing(
        dedupeLocalPolygonPoints(closedLoopPoints || [], 0.001)
      );

      if (normalizedLoop.length < 4) {
        return false;
      }

      normalizedLoop = closeRing(
        dedupeLocalPolygonPoints(
          smoothLocalPolygonChaikin(
            simplifyLocalPolygonDouglasPeucker(
              normalizedLoop,
              simplifyTolerance
            ),
            {
              iterations: 1,
              ratio: 0.18,
              maxPointCount: 240,
              minSegmentLength: smoothingMinSegment,
            }
          ),
          0.001
        )
      );

      if (normalizedLoop.length < 4) {
        return false;
      }

      const levelKey = buildContourLevelKey(elevation);

      const featureKey = [
        levelKey,
        normalizedLoop.map((point) => buildLocalPointKey(point, 3)).join(";"),
      ].join("|");

      if (featureKeys.has(featureKey)) {
        return false;
      }

      featureKeys.add(featureKey);

      features.push(
        lineFeature(
          normalizedLoop.map(([xMeters, yMeters]) =>
            lngLatFromMeters(siteContext.location, xMeters, yMeters)
          ),
          {
            elevation: Number(elevation.toFixed(3)),
            provider: "derived-contours-interpolated-closed",
            generated: true,
            closedLoop: true,
            exportDerived: "native-band-interpolation-closed",
            contourClosureMode: closureMode,
            contourClosureFallbackUsed: closureFallbackUsed,
            contourClosureSelectionReason: closureSelectionReason,
            sourceContourIntervalMeters: Number(sourceContourInterval.toFixed(3)),
            interpolationTerrainGridStep: Number(
              Number(generatedTerrainGrid.step || 0).toFixed(3)
            ),
            ...buildContourExportMetadata(siteContext, {
              generated: true,
              contourInterval,
            }),
          }
        )
      );

      return true;
    };

    for (const feature of generatedContourCollection?.features || []) {
      const elevation = Number(feature?.properties?.elevation);

      if (!Number.isFinite(elevation)) {
        continue;
      }

      const levelKey = buildContourLevelKey(elevation);
      const lineStrings = getLineStringsFromGeometry(feature.geometry);

      if (nativeElevationKeys.has(levelKey)) {
        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourCandidateCount",
          Math.max(1, lineStrings.length || 0)
        );
        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourNativeLevelRejectedCount",
          Math.max(1, lineStrings.length || 0)
        );
        continue;
      }

      for (const lineString of lineStrings) {
        const rawLocalPoints = lineString
          .map((point) => localMetersFromLngLat(point, siteContext.location))
          .filter(
            (point) =>
              Array.isArray(point) &&
              Number.isFinite(point[0]) &&
              Number.isFinite(point[1])
          );

        if (rawLocalPoints.length < 2) {
          continue;
        }

        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourCandidateCount",
          1
        );

        const simplifiedPolyline = simplifyLocalPolylineDouglasPeucker(
          mergeContourPolylinePoints(rawLocalPoints, 0.001),
          simplifyTolerance
        );

        const smoothedPolyline = smoothLocalPolylineChaikin(simplifiedPolyline, {
          iterations: 1,
          ratio: 0.18,
          maxPointCount: 240,
          minSegmentLength: smoothingMinSegment,
        });

        if (smoothedPolyline.length < 2) {
          continue;
        }

        const isAlreadyClosed =
          smoothedPolyline.length >= 3 &&
          pointsMatchInMeters(
            smoothedPolyline[0],
            smoothedPolyline[smoothedPolyline.length - 1],
            0.001
          );

        if (isAlreadyClosed) {
          if (
            appendClosedGeneratedLoop(smoothedPolyline, elevation, {
              closureMode: "already_closed",
              closureSelectionReason: "generated_contour_closed",
            })
          ) {
            incrementGeneratedContourDiagnostic(
              siteContext,
              "generatedContourClosedAcceptedCount",
              1
            );
          }

          continue;
        }

        const closure = resolveOpenContourBoundaryCandidates(
          smoothedPolyline,
          clipRect
        );

        if (!closure?.candidateMultiPolygons?.length) {
          incrementGeneratedContourDiagnostic(
            siteContext,
            "generatedContourOpenRejectedCount",
            1
          );
          continue;
        }

        const selection = resolveHigherContourSideCandidate(
          siteContext,
          elevation,
          closure.candidateMultiPolygons,
          seed
        );

        let selectedIndex = Number.isInteger(selection?.selectedIndex)
          ? selection.selectedIndex
          : null;

        let closureFallbackUsed = false;

        if (!Number.isInteger(selectedIndex)) {
          const fallbackIndex = Number.isInteger(
            selection?.scoredCandidates?.[0]?.index
          )
            ? selection.scoredCandidates[0].index
            : null;

          if (Number.isInteger(fallbackIndex)) {
            selectedIndex = fallbackIndex;
            closureFallbackUsed = true;
          }
        }

        if (
          !Number.isInteger(selectedIndex) ||
          !Array.isArray(closure.candidatePolygons?.[selectedIndex])
        ) {
          incrementGeneratedContourDiagnostic(
            siteContext,
            "generatedContourOpenRejectedCount",
            1
          );
          continue;
        }

        if (
          appendClosedGeneratedLoop(
            closure.candidatePolygons[selectedIndex],
            elevation,
            {
              closureMode: "boundary_closed",
              closureFallbackUsed,
              closureSelectionReason:
                selection?.reason ||
                (closureFallbackUsed ? "scored_candidate_fallback" : "selected"),
            }
          )
        ) {
          incrementGeneratedContourDiagnostic(
            siteContext,
            "generatedContourClosedAcceptedCount",
            1
          );
        } else {
          incrementGeneratedContourDiagnostic(
            siteContext,
            "generatedContourOpenRejectedCount",
            1
          );
        }
      }
    }

    return featureCollection(
      features.sort(
        (left, right) =>
          Number(left?.properties?.elevation || 0) -
            Number(right?.properties?.elevation || 0) ||
          Number(Boolean(left?.properties?.generated)) -
            Number(Boolean(right?.properties?.generated))
      )
    );
  }

  function buildGridAreaAboveByLevelUncached(siteContext) {
    const rawSlices = buildContourBandSlices(siteContext);

    if (!rawSlices.length) {
      return {
        gridBandGroups: [],
        gridAreaAboveByLevel: new Map(),
        resolveAreaAboveLevel(level) {
          return [];
        },
      };
    }

    const groupedSlices = new Map();

    for (const slice of rawSlices) {
      const groupKey = `${slice.bottomElevation.toFixed(3)}|${slice.topElevation.toFixed(3)}`;

      if (!groupedSlices.has(groupKey)) {
        groupedSlices.set(groupKey, []);
      }

      groupedSlices.get(groupKey).push(slice);
    }

    const gridBandGroups = [];

    for (const [groupKey, slices] of groupedSlices.entries()) {
      const [bottomElevation, topElevation] = groupKey.split("|").map(Number);
      const interval = Math.max(
        MIN_CONTOUR_INTERVAL_METERS,
        Number((topElevation - bottomElevation).toFixed(3))
      );
      const regions = buildContourBandRegionsForSlices(slices, interval);
      const multiPolygon = buildPolygonClippingMultiPolygonFromRegions(regions);
      const bandGroup = buildContourBandGroupFromMultiPolygon(
        bottomElevation,
        topElevation,
        multiPolygon
      );

      if (!bandGroup) {
        continue;
      }

      gridBandGroups.push(bandGroup);
    }

    const gridAreaAboveByLevel = new Map();
    let cumulativeGridMultiPolygon = [];

    for (let index = gridBandGroups.length - 1; index >= 0; index -= 1) {
      const group = gridBandGroups[index];
      const groupMultiPolygon = buildPolygonClippingMultiPolygonFromRegions(
        group?.regions || []
      );

      if (!groupMultiPolygon.length) {
        continue;
      }

      cumulativeGridMultiPolygon = cumulativeGridMultiPolygon.length
        ? unionLocalMultiPolygons([groupMultiPolygon, cumulativeGridMultiPolygon])
        : groupMultiPolygon;

      if (cumulativeGridMultiPolygon.length) {
        gridAreaAboveByLevel.set(
          buildContourLevelKey(group.bottomElevation),
          cumulativeGridMultiPolygon
        );
      }
    }

    return {
      gridBandGroups,
      gridAreaAboveByLevel,
      resolveAreaAboveLevel(level) {
        return gridAreaAboveByLevel.get(buildContourLevelKey(level)) || [];
      },
    };
  }

  function buildGeneratedContourAreaAboveByLevelFromNativeBands(
    siteContext,
    contourInterval
  ) {
    if (
      !siteContext?.location ||
      !siteContext?.clipBoundary ||
      !Number.isFinite(contourInterval) ||
      contourInterval <= 0
    ) {
      return null;
    }

    const sourceContourInterval = resolveSourceContourInterval(siteContext);

    if (!(sourceContourInterval > contourInterval + 1e-9)) {
      return null;
    }

    let generatedTerrainGrid = null;

    try {
      generatedTerrainGrid = buildTerrainGridFromNativeContourBands(
        siteContext,
        contourInterval,
        sourceContourInterval
      );
    } catch (error) {
      console.warn(
        `[contour-export] native band area interpolation failed source=${sourceContourInterval} target=${contourInterval} error=${formatErrorForLog(
          error
        )}`
      );
      return null;
    }

    if (!generatedTerrainGrid?.elevations?.length) {
      return null;
    }

    const generatedAreaSiteContext = {
      ...siteContext,
      terrainGrid: generatedTerrainGrid,
      options: {
        ...(siteContext?.options || {}),
        contourInterval,
      },
      stats: {
        ...(siteContext?.stats || {}),
        requestedContourInterval: contourInterval,
        effectiveContourBandInterval: contourInterval,
        effectiveContourDisplayInterval: contourInterval,
      },
    };

    const areaResult = buildGridAreaAboveByLevelUncached(generatedAreaSiteContext);

    if (!(areaResult?.gridAreaAboveByLevel instanceof Map)) {
      return areaResult;
    }

    const generatedLevels = [...areaResult.gridAreaAboveByLevel.keys()]
      .map(Number)
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    const generatedGroups = generatedLevels.map((level, index) => {
      const regions = normalizeContourRegionsForLevel(
        generatedAreaSiteContext,
        buildContourBandRegionsFromMultiPolygon(
          areaResult.gridAreaAboveByLevel.get(buildContourLevelKey(level)) || []
        ),
        level
      );
      const multiPolygon = buildPolygonClippingMultiPolygonFromRegions(regions);

      return {
        bottomElevation: Number(level.toFixed(3)),
        topElevation: Number(
          (
            generatedLevels[index + 1] ??
            (level + contourInterval)
          ).toFixed(3)
        ),
        boundaryLoops: regions.flatMap((region) => [
          region.outerPoints,
          ...(region.holePoints || []),
        ]),
        regions,
        multiPolygon,
      };
    });
    const prunedGeneratedGroups = pruneTransientGeneratedGroupRegions(
      generatedAreaSiteContext,
      generatedGroups
    );
    const prunedAreaAboveByLevel = new Map();

    for (const group of prunedGeneratedGroups) {
      const levelKey = buildContourLevelKey(group?.bottomElevation);
      const multiPolygon =
        group?.multiPolygon || buildPolygonClippingMultiPolygonFromRegions(group?.regions || []);

      if (!multiPolygon.length) {
        continue;
      }

      prunedAreaAboveByLevel.set(levelKey, multiPolygon);
    }

    return {
      ...areaResult,
      gridBandGroups: prunedGeneratedGroups,
      gridAreaAboveByLevel: prunedAreaAboveByLevel,
      resolveAreaAboveLevel(level) {
        return prunedAreaAboveByLevel.get(buildContourLevelKey(level)) || [];
      },
    };
  }

  function buildClosedGeneratedContourLinesFromAreaAboveMap(
    siteContext,
    areaAboveByLevel,
    contourInterval,
    nativeElevationKeys = new Set()
  ) {
    if (!(areaAboveByLevel instanceof Map) || !siteContext?.location) {
      return featureCollection([]);
    }

    const features = [];
    const featureKeys = new Set();
    const generatedLoopCleanupAreaSqm = Math.max(
      1,
      Math.min(8, resolveRawAnchoredContourCleanupAreaThreshold(siteContext) * 2.5)
    );
    const generatedLevels = [...areaAboveByLevel.keys()]
      .map(Number)
      .filter(Number.isFinite)
      .sort((left, right) => left - right);

    for (const level of generatedLevels) {
      const elevation = Number(level.toFixed(3));
      const levelKey = buildContourLevelKey(elevation);
      const multiPolygon = areaAboveByLevel.get(levelKey) || [];
      const regions = normalizeContourRegionsForLevel(
        siteContext,
        buildContourBandRegionsFromMultiPolygon(multiPolygon),
        elevation
      );
      const contourLoopCount = regions.reduce(
        (count, region) => count + 1 + Number(region?.holePoints?.length || 0),
        0
      );

      if (nativeElevationKeys.has(levelKey)) {
        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourCandidateCount",
          contourLoopCount
        );
        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourNativeLevelRejectedCount",
          contourLoopCount
        );
        continue;
      }

      for (const region of regions) {
        for (const loop of [region?.outerPoints, ...(region?.holePoints || [])]) {
          incrementGeneratedContourDiagnostic(
            siteContext,
            "generatedContourCandidateCount",
            1
          );

          const closedLoop = closeRing(dedupeLocalPolygonPoints(loop, 0.001));

          if (closedLoop.length < 4) {
            continue;
          }

          if (
            Math.abs(computeLocalPolygonSignedArea(closedLoop)) < generatedLoopCleanupAreaSqm
          ) {
            continue;
          }

          const featureKey = [
            levelKey,
            closedLoop.map((point) => buildLocalPointKey(point, 3)).join(";"),
          ].join("|");

          if (featureKeys.has(featureKey)) {
            continue;
          }

          featureKeys.add(featureKey);
          features.push(
            lineFeature(
              closedLoop.map(([xMeters, yMeters]) =>
                lngLatFromMeters(siteContext.location, xMeters, yMeters)
              ),
              {
                elevation,
                provider: "derived-contours-closed",
                generated: true,
                closedLoop: true,
                exportDerived: "native-band-area-above-contour",
                ...buildContourExportMetadata(siteContext, {
                  generated: true,
                  contourInterval,
                }),
              }
            )
          );
          incrementGeneratedContourDiagnostic(
            siteContext,
            "generatedContourClosedAcceptedCount",
            1
          );
        }
      }
    }

    return featureCollection(
      features.sort(
        (left, right) =>
          Number(left?.properties?.elevation || 0) -
            Number(right?.properties?.elevation || 0) ||
          Number(Boolean(left?.properties?.generated)) -
            Number(Boolean(right?.properties?.generated))
      )
    );
  }

  function buildGeneratedClosedContourLinesFromNativeBands(siteContext, contourInterval) {
    if (
      !siteContext?.location ||
      !siteContext?.clipBoundary ||
      !Number.isFinite(contourInterval) ||
      contourInterval <= 0
    ) {
      return featureCollection([]);
    }

    const sourceContourInterval = resolveSourceContourInterval(siteContext);

    if (!(sourceContourInterval > contourInterval + 1e-9)) {
      return featureCollection([]);
    }

    const nativeContourLines = featureCollection(
      (siteContext?.contourLines?.features || []).filter(
        (feature) => feature?.properties?.generated !== true
      )
    );

    if (!(nativeContourLines?.features?.length > 0)) {
      return featureCollection([]);
    }

    const nativeElevationKeys = buildContourElevationKeySet(nativeContourLines);
    let generatedAreaResult = null;

    try {
      generatedAreaResult = buildGeneratedContourAreaAboveByLevelFromNativeBands(
        siteContext,
        contourInterval
      );
    } catch (error) {
      console.warn(
        `[contour-display] native closed-band contour build failed source=${sourceContourInterval} target=${contourInterval} error=${formatErrorForLog(
          error
        )}`
      );
      return featureCollection([]);
    }

    return buildClosedGeneratedContourLinesFromAreaAboveMap(
      siteContext,
      generatedAreaResult?.gridAreaAboveByLevel,
      contourInterval,
      nativeElevationKeys
    );
  }

  function buildGeneratedContourLinesFromResolvedAreas(siteContext, contourInterval) {
    resetGeneratedContourDiagnostics(siteContext);

    const closedInterpolatedContours =
      buildClosedGeneratedContourLinesFromInterpolatedGrid(
        siteContext,
        contourInterval
      );

    if (closedInterpolatedContours?.features?.length) {
      return closedInterpolatedContours;
    }

    const closedAreaContours = buildGeneratedClosedContourLinesFromNativeBands(
      siteContext,
      contourInterval
    );

    if (closedAreaContours?.features?.length) {
      incrementGeneratedContourDiagnostic(
        siteContext,
        "generatedContourFallbackUsed",
        1
      );
      return closedAreaContours;
    }

    if (siteContext?.options?.allowOpenGeneratedContourFallback === true) {
      incrementGeneratedContourDiagnostic(
        siteContext,
        "generatedContourFallbackUsed",
        1
      );
      return buildGeneratedContourLinesFromNativeAnchorBands(
        siteContext,
        contourInterval
      );
    }

    return featureCollection([]);
  }

  return {
    buildTerrainGridFromNativeContourBands,
    buildGeneratedContourLinesFromNativeAnchorBands,
    buildClosedGeneratedContourLinesFromInterpolatedGrid,
    buildGridAreaAboveByLevelUncached,
    buildGeneratedContourAreaAboveByLevelFromNativeBands,
    buildClosedGeneratedContourLinesFromAreaAboveMap,
    buildGeneratedClosedContourLinesFromNativeBands,
    buildGeneratedContourLinesFromResolvedAreas,
  };
}

export { createContourInterpolation };
