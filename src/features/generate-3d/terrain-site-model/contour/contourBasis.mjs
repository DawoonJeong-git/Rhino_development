function createContourBasis({
  normalizeContourInterval,
  resolveSourceContourInterval,
  buildLocalClipRect,
  inferSourceContourIntervalFromContourLines,
  resolveEffectiveContourBandInterval,
  resolveLocalClipBoundaryPosition,
  featureCollection,
  getLineStringsFromGeometry,
  localMetersFromLngLat,
  pointsMatchInMeters,
  closeRing,
  dedupeLocalPolygonPoints,
  mergeContourPolylinePoints,
  mergeContourPolylines,
  lineFeature,
  lngLatFromMeters,
}) {
  function buildContourLevelKey(level) {
    const numericLevel = Number(level);
    return Number(Number.isFinite(numericLevel) ? numericLevel : 0).toFixed(3);
  }

  function buildContourElevationKeySet(contourCollection) {
    return new Set(
      (contourCollection?.features || [])
        .map((feature) => Number(feature?.properties?.elevation))
        .filter((value) => Number.isFinite(value))
        .map((value) => buildContourLevelKey(value))
    );
  }

  function buildContourFeatureCountByElevation(contourCollection) {
    const counts = new Map();

    for (const feature of contourCollection?.features || []) {
      const elevation = Number(feature?.properties?.elevation);

      if (!Number.isFinite(elevation)) {
        continue;
      }

      const levelKey = buildContourLevelKey(elevation);
      counts.set(levelKey, Number(counts.get(levelKey) || 0) + 1);
    }

    return counts;
  }

  function formatContourIntervalLayerToken(interval) {
    const normalizedInterval = Number(Number(interval || 0).toFixed(3));

    if (!(normalizedInterval > 0)) {
      return "custom";
    }

    return `${String(normalizedInterval).replace(/\./g, "p")}m`;
  }

  function normalizeContourLayerNameForExport(layerName, style = "default") {
    const normalized = String(layerName || "contours")
      .trim()
      .toLowerCase();

    if (style === "dxf" || style === "object") {
      return normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    }

    return normalized || "contours";
  }

  function buildContourExportMetadata(
    siteContext,
    { generated = false, contourInterval = null } = {}
  ) {
    const resolvedInterval = normalizeContourInterval(
      generated
        ? contourInterval ??
            siteContext?.stats?.effectiveContourDisplayInterval ??
            siteContext?.options?.contourInterval
        : resolveSourceContourInterval(siteContext)
    );
    const contourKind = generated ? "generated" : "native";
    const contourExportLayer = `contours-${contourKind}-${formatContourIntervalLayerToken(
      resolvedInterval
    )}`;

    return {
      contourKind,
      contourIntervalMeters: Number(resolvedInterval.toFixed(3)),
      contourExportLayer,
      contourDxfLayer: normalizeContourLayerNameForExport(contourExportLayer, "dxf"),
      contourObjectGroup: normalizeContourLayerNameForExport(
        contourExportLayer,
        "object"
      ),
    };
  }

  function resolveContourFeatureExportLayer(siteContext, feature, style = "default") {
    const properties = feature?.properties || {};
    const metadata = buildContourExportMetadata(siteContext, {
      generated: properties.generated === true,
      contourInterval: properties.contourIntervalMeters,
    });

    return style === "default"
      ? metadata.contourExportLayer
      : normalizeContourLayerNameForExport(metadata.contourExportLayer, style);
  }

  function resolveContourLineMergeTolerance(siteContext, contourCollection = null) {
    const clipRect = buildLocalClipRect(siteContext);
    const inferredInterval = inferSourceContourIntervalFromContourLines(
      contourCollection || siteContext?.contourLines
    );
    const contourInterval =
      Number.isFinite(inferredInterval) && inferredInterval > 0
        ? inferredInterval
        : resolveEffectiveContourBandInterval(siteContext);
    const terrainStep = Number(siteContext?.terrainGrid?.step || 0);

    return Math.max(
      0.05,
      Math.min(
        0.35,
        Number.isFinite(terrainStep) && terrainStep > 0 ? terrainStep * 0.45 : 0.2,
        Number.isFinite(contourInterval) && contourInterval > 0
          ? contourInterval * 0.08
          : 0.35,
        Number(clipRect?.boundarySnapTolerance || 0.35) * 0.25
      )
    );
  }

  function buildContourMergeBucketKey(feature, elevation) {
    const properties = feature?.properties || {};

    return [
      buildContourLevelKey(elevation),
      properties.generated === true ? "generated" : "native",
      String(properties.provider || "").trim() || "unknown",
    ].join("|");
  }

  function distanceToClipRectBoundary(point, clipRect) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      !clipRect
    ) {
      return null;
    }

    const boundaryPosition = resolveLocalClipBoundaryPosition(point, clipRect, {
      direction: "ccw",
      toleranceMeters: Number.POSITIVE_INFINITY,
    });

    if (boundaryPosition) {
      return Number(Number(boundaryPosition.distance || 0).toFixed(6));
    }

    return Number(
      Math.min(
        Math.abs(Number(point[0]) - Number(clipRect.minX)),
        Math.abs(Number(point[0]) - Number(clipRect.maxX)),
        Math.abs(Number(point[1]) - Number(clipRect.minY)),
        Math.abs(Number(point[1]) - Number(clipRect.maxY))
      ).toFixed(6)
    );
  }

  function buildCanonicalContourInputEntries(
    siteContext,
    contourCollection = null,
    { includeLocalPoints = false } = {}
  ) {
    const collection = contourCollection || siteContext?.contourLines || featureCollection([]);
    const clipRect = buildLocalClipRect(siteContext);
    const entries = [];

    for (
      let featureIndex = 0;
      featureIndex < (collection?.features || []).length;
      featureIndex += 1
    ) {
      const feature = collection.features[featureIndex];
      const elevation = Number(feature?.properties?.elevation);

      if (!Number.isFinite(elevation)) {
        continue;
      }

      const source = feature?.properties?.generated === true ? "generated" : "native";

      for (
        let lineIndex = 0;
        lineIndex < getLineStringsFromGeometry(feature?.geometry).length;
        lineIndex += 1
      ) {
        const lineString = getLineStringsFromGeometry(feature?.geometry)[lineIndex];
        const localPoints = lineString
          .map((point) => localMetersFromLngLat(point, siteContext.location))
          .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

        if (localPoints.length < 2) {
          continue;
        }

        const closedInput =
          localPoints.length >= 3 &&
          pointsMatchInMeters(localPoints[0], localPoints[localPoints.length - 1], 0.001);
        const normalizedLocalPoints = closedInput
          ? closeRing(dedupeLocalPolygonPoints(localPoints, 0.001))
          : mergeContourPolylinePoints(localPoints, 0.001);

        if (normalizedLocalPoints.length < (closedInput ? 4 : 2)) {
          continue;
        }

        entries.push({
          contourId: `contour_${featureIndex + 1}_${lineIndex + 1}`,
          featureIndex: featureIndex + 1,
          lineIndex: lineIndex + 1,
          elevation: Number(elevation.toFixed(3)),
          source,
          provider: String(feature?.properties?.provider || "").trim() || "unknown",
          originalGeometryType: String(feature?.geometry?.type || "unknown"),
          closedInput,
          pointCount: normalizedLocalPoints.length,
          startBoundaryDistanceMeters: distanceToClipRectBoundary(
            normalizedLocalPoints[0],
            clipRect
          ),
          endBoundaryDistanceMeters: distanceToClipRectBoundary(
            normalizedLocalPoints[normalizedLocalPoints.length - 1],
            clipRect
          ),
          localPoints: includeLocalPoints ? normalizedLocalPoints : undefined,
        });
      }
    }

    return entries;
  }

  function buildCanonicalContourInput(siteContext, contourCollection = null) {
    const entries = buildCanonicalContourInputEntries(siteContext, contourCollection, {
      includeLocalPoints: false,
    });
    const nativeLevels = [
      ...new Set(
        entries
          .filter((entry) => entry.source === "native")
          .map((entry) => Number(entry.elevation))
          .filter(Number.isFinite)
          .sort((left, right) => left - right)
      ),
    ];
    const generatedLevels = [
      ...new Set(
        entries
          .filter((entry) => entry.source === "generated")
          .map((entry) => Number(entry.elevation))
          .filter(Number.isFinite)
          .sort((left, right) => left - right)
      ),
    ];

    return {
      nativeLevels,
      generatedLevels,
      entryCount: entries.length,
      nativeEntryCount: entries.filter((entry) => entry.source === "native").length,
      generatedEntryCount: entries.filter((entry) => entry.source === "generated").length,
      openEntryCount: entries.filter((entry) => entry.closedInput !== true).length,
      closedEntryCount: entries.filter((entry) => entry.closedInput === true).length,
      entries,
    };
  }

  function normalizeContourFeatureCollection(siteContext, contourCollection = null) {
    const collection = contourCollection || siteContext?.contourLines;

    if (!collection?.features?.length || !siteContext?.location) {
      return collection || featureCollection([]);
    }

    const mergeTolerance = resolveContourLineMergeTolerance(siteContext, collection);
    const openBuckets = new Map();
    const normalizedEntries = [];

    for (const feature of collection.features || []) {
      const elevation = Number(feature?.properties?.elevation);

      if (!Number.isFinite(elevation)) {
        continue;
      }

      const properties = {
        ...(feature?.properties || {}),
        elevation: Number(elevation.toFixed(3)),
      };

      for (const lineString of getLineStringsFromGeometry(feature.geometry)) {
        const localPoints = lineString
          .map((point) => localMetersFromLngLat(point, siteContext.location))
          .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

        if (localPoints.length < 2) {
          continue;
        }

        const closed =
          localPoints.length >= 3 &&
          pointsMatchInMeters(localPoints[0], localPoints[localPoints.length - 1], 0.001);

        if (closed) {
          const closedLoop = closeRing(dedupeLocalPolygonPoints(localPoints, 0.001));

          if (closedLoop.length >= 4) {
            normalizedEntries.push({
              properties,
              closed: true,
              localPoints: closedLoop,
              originalCoordinates:
                feature?.geometry?.type === "LineString" ? lineString : null,
              preserveOriginal:
                feature?.geometry?.type === "LineString" &&
                lineString.length >= 4 &&
                pointsMatchInMeters(
                  localPoints[0],
                  localPoints[localPoints.length - 1],
                  0.001
                ),
            });
          }

          continue;
        }

        const mergedOpenPoints = mergeContourPolylinePoints(localPoints, 0.001);

        if (mergedOpenPoints.length < 2) {
          continue;
        }

        const bucketKey = buildContourMergeBucketKey(feature, elevation);

        if (!openBuckets.has(bucketKey)) {
          openBuckets.set(bucketKey, {
            properties,
            segments: [],
          });
        }

        openBuckets.get(bucketKey).segments.push({
          localPoints: mergedOpenPoints,
          originalCoordinates: lineString,
          preserveOriginal: feature?.geometry?.type === "LineString",
        });
      }
    }

    for (const bucket of openBuckets.values()) {
      const sourcePolylines = bucket.segments.map((segment) => segment.localPoints);
      const mergedPolylines = mergeContourPolylines(sourcePolylines, mergeTolerance);
      const didMerge = mergedPolylines.length !== sourcePolylines.length;

      if (!didMerge) {
        for (const segment of bucket.segments) {
          if (segment.localPoints.length < 2) {
            continue;
          }

          normalizedEntries.push({
            properties: bucket.properties,
            closed: false,
            localPoints: segment.localPoints,
            originalCoordinates: segment.originalCoordinates,
            preserveOriginal: segment.preserveOriginal === true,
          });
        }

        continue;
      }

      for (const polyline of mergedPolylines) {
        if (polyline.length < 2) {
          continue;
        }

        normalizedEntries.push({
          properties: bucket.properties,
          closed: false,
          localPoints: polyline,
          originalCoordinates: null,
          preserveOriginal: false,
        });
      }
    }

    return featureCollection(
      normalizedEntries
        .map((entry) =>
          lineFeature(
            entry.preserveOriginal && Array.isArray(entry.originalCoordinates)
              ? entry.originalCoordinates
              : entry.localPoints.map(([xMeters, yMeters]) =>
                  lngLatFromMeters(siteContext.location, xMeters, yMeters)
                ),
            {
              ...(entry.properties || {}),
              merged: true,
              closedLoop: entry.closed === true,
            }
          )
        )
        .sort(
          (left, right) =>
            Number(left?.properties?.elevation || 0) -
              Number(right?.properties?.elevation || 0) ||
            Number(Boolean(left?.properties?.generated)) -
              Number(Boolean(right?.properties?.generated))
        )
    );
  }

  return {
    buildContourLevelKey,
    buildContourElevationKeySet,
    buildContourFeatureCountByElevation,
    formatContourIntervalLayerToken,
    normalizeContourLayerNameForExport,
    buildContourExportMetadata,
    resolveContourFeatureExportLayer,
    distanceToClipRectBoundary,
    buildCanonicalContourInputEntries,
    buildCanonicalContourInput,
    normalizeContourFeatureCollection,
  };
}

export { createContourBasis };
