function createContourExport({
  resolveSourceContourInterval,
  resolveRequestedContourDisplayInterval,
  resolveRawAnchoredContourCleanupAreaThreshold,
  resolveTerrainPipelineMode,
  normalizeContourRegionsForLevel,
  buildContourBandRegionsFromMultiPolygon,
  buildRawAnchoredContourBandAssembly,
  getCachedCumulativeContourBandGroups,
  getCachedContourTopSurfaceGroups,
  featureCollection,
  createContourLinesFromTerrainGrid,
  getLineStringsFromGeometry,
  localMetersFromLngLat,
  pointsMatchInMeters,
  closeRing,
  dedupeLocalPolygonPoints,
  mergeContourPolylinePoints,
  buildLocalPointKey,
  lineFeature,
  lngLatFromMeters,
  computeLocalPolygonSignedArea,
  buildNativeContourLoopEntries,
  normalizeContourFeatureCollection,
  buildGeneratedContourAreaAboveByLevelFromNativeBands,
  buildGeneratedContourLinesFromResolvedAreas,
  buildContourLevelKey,
  buildContourElevationKeySet,
  buildContourExportMetadata,
}) {
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

  function incrementGeneratedContourDiagnostic(siteContext, key, amount = 1) {
    const diagnostics = ensureGeneratedContourDiagnostics(siteContext);

    if (!diagnostics || !Number.isFinite(amount) || amount === 0) {
      return;
    }

    diagnostics[key] = Number(diagnostics[key] || 0) + Number(amount);
  }

  function setGeneratedContourDiagnostic(siteContext, key, value) {
    const diagnostics = ensureGeneratedContourDiagnostics(siteContext);

    if (!diagnostics) {
      return;
    }

    diagnostics[key] = Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function setGeneratedContourFinalExportCount(siteContext, contourCollection) {
    const generatedFeatureCount = Number(
      (contourCollection?.features || []).filter(
        (feature) => feature?.properties?.generated === true
      ).length || 0
    );

    setGeneratedContourDiagnostic(
      siteContext,
      "generatedContourFinalExportCount",
      generatedFeatureCount
    );
  }

  function filterGeneratedContoursForFinalExport(siteContext, contourCollection) {
    if (!contourCollection?.features?.length || !siteContext?.location) {
      return contourCollection || featureCollection([]);
    }

    const acceptedFeatures = [];

    for (const feature of contourCollection.features) {
      if (feature?.properties?.generated !== true) {
        acceptedFeatures.push(feature);
        continue;
      }

      const lineStrings = getLineStringsFromGeometry(feature?.geometry);

      if (feature?.properties?.closedLoop !== true || !lineStrings.length) {
        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourOpenRejectedCount",
          Math.max(1, lineStrings.length || 0)
        );
        continue;
      }

      const hasOnlyClosedGeometry = lineStrings.every((lineString) => {
        const localPoints = lineString
          .map((point) => localMetersFromLngLat(point, siteContext.location))
          .filter(
            (point) =>
              Array.isArray(point) &&
              Number.isFinite(point[0]) &&
              Number.isFinite(point[1])
          );

        if (
          localPoints.length < 3 ||
          !pointsMatchInMeters(localPoints[0], localPoints[localPoints.length - 1], 0.001)
        ) {
          return false;
        }

        return closeRing(dedupeLocalPolygonPoints(localPoints, 0.001)).length >= 4;
      });

      if (!hasOnlyClosedGeometry) {
        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourOpenRejectedCount",
          Math.max(1, lineStrings.length || 0)
        );
        continue;
      }

      acceptedFeatures.push(feature);
    }

    return featureCollection(acceptedFeatures);
  }

  function buildClosedNativeContourLinesForDisplay(siteContext, contourCollection = null) {
    if (!siteContext?.location) {
      return contourCollection || featureCollection([]);
    }

    const normalizedNativeInput = normalizeContourFeatureCollection(
      siteContext,
      contourCollection || siteContext?.contourLines || featureCollection([])
    );
    const nativeLoopEntries = buildNativeContourLoopEntries(
      siteContext,
      normalizedNativeInput,
      {
        allowAmbiguousFallback: true,
      }
    );

    if (!nativeLoopEntries.length) {
      return featureCollection(
        (normalizedNativeInput?.features || []).filter(
          (feature) => feature?.properties?.generated !== true
        )
      );
    }

    return featureCollection(
      nativeLoopEntries
        .map((entry) =>
          lineFeature(
            entry.closedLoopPoints.map(([xMeters, yMeters]) =>
              lngLatFromMeters(siteContext.location, xMeters, yMeters)
            ),
            {
              elevation: Number(Number(entry.elevation).toFixed(3)),
              provider: "official-contours-closed",
              generated: false,
              closedLoop: true,
              exportDerived: entry.closureFallbackUsed
                ? "native-source-closed-display-fallback"
                : "native-source-closed",
              closureSelectionReason: entry.closureSelectionReason || null,
              closureFallbackUsed: entry.closureFallbackUsed === true,
              ...buildContourExportMetadata(siteContext, {
                generated: false,
                contourInterval: resolveSourceContourInterval(siteContext),
              }),
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

  function buildAugmentedContourLinesForExport(siteContext, contourInterval) {
    const nativeContourLines = buildClosedNativeContourLinesForDisplay(
      siteContext,
      siteContext?.contourLines
    );

    if (
      !siteContext?.terrainGrid?.elevations?.length ||
      !Number.isFinite(contourInterval) ||
      contourInterval <= 0
    ) {
      return nativeContourLines;
    }

    const generatedContours = buildGeneratedContourLinesFromResolvedAreas(
      siteContext,
      contourInterval
    );

    const nativeElevationKeys = buildContourElevationKeySet(nativeContourLines);
    const generatedFeatures = (generatedContours?.features || []).filter((feature) => {
      const elevation = Number(feature?.properties?.elevation);

      if (!Number.isFinite(elevation)) {
        return false;
      }

      return !nativeElevationKeys.has(buildContourLevelKey(elevation));
    });

    if (!generatedFeatures.length) {
      return nativeContourLines;
    }

    return featureCollection([
      ...(nativeContourLines?.features || []),
      ...generatedFeatures.map((feature) => ({
        ...feature,
        properties: {
          ...(feature?.properties || {}),
          provider:
            String(feature?.properties?.provider || "").trim() || "derived-contours",
          generated: true,
          exportDerived:
            String(feature?.properties?.exportDerived || "").trim() ||
            "generated-terrain-grid-fallback",
          ...buildContourExportMetadata(siteContext, {
            generated: true,
            contourInterval,
          }),
        },
      })),
    ]);
  }

  function buildLegacyAugmentedContourLinesForExport(siteContext, contourInterval) {
    const nativeContourLines = siteContext?.contourLines || featureCollection([]);

    if (
      !siteContext?.terrainGrid?.elevations?.length ||
      !Number.isFinite(contourInterval) ||
      contourInterval <= 0
    ) {
      return nativeContourLines;
    }

    const generatedContours = createContourLinesFromTerrainGrid(
      siteContext.location,
      siteContext.terrainGrid,
      {
        ...(siteContext?.options || {}),
        contourInterval,
      }
    );
    const nativeElevationKeys = buildContourElevationKeySet(nativeContourLines);
    const generatedFeatures = (generatedContours?.features || []).filter((feature) => {
      const elevation = Number(feature?.properties?.elevation);

      if (!Number.isFinite(elevation)) {
        return false;
      }

      return !nativeElevationKeys.has(buildContourLevelKey(elevation));
    });

    if (!generatedFeatures.length) {
      return nativeContourLines;
    }

    return featureCollection([
      ...(nativeContourLines?.features || []),
      ...generatedFeatures.map((feature) => ({
        ...feature,
        properties: {
          ...(feature?.properties || {}),
          provider:
            String(feature?.properties?.provider || "").trim() || "derived-contours",
          generated: true,
          exportDerived:
            String(feature?.properties?.exportDerived || "").trim() ||
            "generated-terrain-grid-fallback",
          ...buildContourExportMetadata(siteContext, {
            generated: true,
            contourInterval,
          }),
        },
      })),
    ]);
  }

  function appendReusableContourFeatureToExportCollection({
    siteContext,
    feature,
    features,
    featureKeys,
    registerLevelFeatureAppend = null,
    propertyOverrides = null,
  }) {
    const elevation = Number(feature?.properties?.elevation);
    const generated = feature?.properties?.generated === true;
    const lineStrings = getLineStringsFromGeometry(feature?.geometry);

    if (!Number.isFinite(elevation) || !siteContext?.location) {
      return false;
    }

    if (generated && feature?.properties?.closedLoop !== true) {
      incrementGeneratedContourDiagnostic(
        siteContext,
        "generatedContourOpenRejectedCount",
        Math.max(1, lineStrings.length || 0)
      );
      return false;
    }

    const levelKey = buildContourLevelKey(elevation);
    let appended = false;

    for (const lineString of lineStrings) {
      const localPoints = lineString
        .map((point) => localMetersFromLngLat(point, siteContext.location))
        .filter(
          (point) =>
            Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
        );

      if (localPoints.length < 2) {
        if (generated) {
          incrementGeneratedContourDiagnostic(
            siteContext,
            "generatedContourOpenRejectedCount",
            1
          );
        }
        continue;
      }

      const geometryClosed =
        localPoints.length >= 3 &&
        pointsMatchInMeters(localPoints[0], localPoints[localPoints.length - 1], 0.001);
      const closedLoop =
        generated === true
          ? true
          : feature?.properties?.closedLoop === true || geometryClosed;

      if (generated && geometryClosed !== true) {
        incrementGeneratedContourDiagnostic(
          siteContext,
          "generatedContourOpenRejectedCount",
          1
        );
        continue;
      }

      const normalizedPoints =
        closedLoop === true
          ? closeRing(dedupeLocalPolygonPoints(localPoints, 0.001))
          : mergeContourPolylinePoints(localPoints, 0.001);

      if ((closedLoop === true && normalizedPoints.length < 4) || normalizedPoints.length < 2) {
        if (generated) {
          incrementGeneratedContourDiagnostic(
            siteContext,
            "generatedContourOpenRejectedCount",
            1
          );
        }
        continue;
      }

      const featureKey = [
        levelKey,
        normalizedPoints.map((point) => buildLocalPointKey(point, 3)).join(";"),
      ].join("|");

      if (featureKeys.has(featureKey)) {
        continue;
      }

      featureKeys.add(featureKey);
      registerLevelFeatureAppend?.(levelKey);
      features.push(
        lineFeature(
          normalizedPoints.map(([xMeters, yMeters]) =>
            lngLatFromMeters(siteContext.location, xMeters, yMeters)
          ),
          {
            ...(feature?.properties || {}),
            elevation: Number(elevation.toFixed(3)),
            closedLoop,
            ...buildContourExportMetadata(siteContext, {
              generated: feature?.properties?.generated === true,
              contourInterval: feature?.properties?.contourIntervalMeters,
            }),
            ...(propertyOverrides || {}),
          }
        )
      );
      appended = true;
    }

    return appended;
  }

  function buildLegacyClosedContourExportCollection(siteContext) {
    const cumulativeGroups = getCachedCumulativeContourBandGroups(siteContext);

    if (!cumulativeGroups.length || !siteContext?.location) {
      const fallbackCollection = filterGeneratedContoursForFinalExport(
        siteContext,
        siteContext?.contourLines || featureCollection([])
      );
      setGeneratedContourFinalExportCount(siteContext, fallbackCollection);
      return fallbackCollection;
    }

    const nativeElevationKeys = new Set(
      (siteContext?.contourLines?.features || [])
        .filter((feature) => feature?.properties?.generated !== true)
        .map((feature) => Number(feature?.properties?.elevation))
        .filter((value) => Number.isFinite(value))
        .map((value) => buildContourLevelKey(value))
    );
    const features = [];
    const featureKeys = new Set();
    const appendedFeatureCountsByLevel = new Map();
    const reusableGeneratedFeatures = (siteContext?.contourLines?.features || []).filter(
      (feature) => shouldReuseGeneratedExportContourFeature(feature)
    );

    const registerLevelFeatureAppend = (levelKey) => {
      appendedFeatureCountsByLevel.set(
        levelKey,
        Number(appendedFeatureCountsByLevel.get(levelKey) || 0) + 1
      );
    };

    const appendClosedLoopFeature = (
      loop,
      elevation,
      generated,
      exportDerived,
      provider
    ) => {
      const closedLoop = closeRing(dedupeLocalPolygonPoints(loop, 0.001));

      if (closedLoop.length < 4) {
        return;
      }

      const levelKey = buildContourLevelKey(elevation);
      const featureKey = [
        levelKey,
        closedLoop.map((point) => buildLocalPointKey(point, 3)).join(";"),
      ].join("|");

      if (featureKeys.has(featureKey)) {
        return;
      }

      featureKeys.add(featureKey);
      registerLevelFeatureAppend(levelKey);
      features.push(
        lineFeature(
          closedLoop.map(([xMeters, yMeters]) =>
            lngLatFromMeters(siteContext.location, xMeters, yMeters)
          ),
          {
            elevation: Number(elevation.toFixed(3)),
            provider,
            generated,
            closedLoop: true,
            exportDerived,
            ...buildContourExportMetadata(siteContext, {
              generated,
              contourInterval: generated
                ? null
                : resolveSourceContourInterval(siteContext),
            }),
          }
        )
      );
    };

    for (const group of cumulativeGroups) {
      const elevation = Number(group?.bottomElevation);

      if (!Number.isFinite(elevation)) {
        continue;
      }

      const levelKey = buildContourLevelKey(elevation);

      if (!nativeElevationKeys.has(levelKey)) {
        continue;
      }

      for (const loop of group?.boundaryLoops || []) {
        appendClosedLoopFeature(
          loop,
          elevation,
          false,
          "native-source-closed",
          "official-contours-closed"
        );
      }
    }

    for (const feature of reusableGeneratedFeatures) {
      appendReusableContourFeatureToExportCollection({
        siteContext,
        feature,
        features,
        featureKeys,
        registerLevelFeatureAppend,
      });
    }

    for (const group of cumulativeGroups) {
      const elevation = Number(group?.bottomElevation);

      if (!Number.isFinite(elevation)) {
        continue;
      }

      const levelKey = buildContourLevelKey(elevation);

      if (
        nativeElevationKeys.has(levelKey) ||
        Number(appendedFeatureCountsByLevel.get(levelKey) || 0) > 0
      ) {
        continue;
      }

      for (const loop of group?.boundaryLoops || []) {
        appendClosedLoopFeature(
          loop,
          elevation,
          true,
          "resolved-area-above-contour",
          "derived-contours-closed"
        );
      }
    }

    const exportCollection = featureCollection(
      features.sort(
        (left, right) =>
          Number(left?.properties?.elevation || 0) -
            Number(right?.properties?.elevation || 0) ||
          Number(Boolean(left?.properties?.generated)) -
            Number(Boolean(right?.properties?.generated))
      )
    );

    setGeneratedContourFinalExportCount(siteContext, exportCollection);

    return exportCollection;
  }

  function buildClosedContourExportCollection(siteContext) {
    if (!siteContext?.location) {
      const fallbackCollection = filterGeneratedContoursForFinalExport(
        siteContext,
        siteContext?.contourLines || featureCollection([])
      );
      setGeneratedContourFinalExportCount(siteContext, fallbackCollection);
      return fallbackCollection;
    }

    const requestedContourInterval = resolveRequestedContourDisplayInterval(siteContext);
    const sourceContourInterval = resolveSourceContourInterval(siteContext);
    const nativeElevationKeys = new Set(
      (siteContext?.contourLines?.features || [])
        .filter((feature) => feature?.properties?.generated !== true)
        .map((feature) => Number(feature?.properties?.elevation))
        .filter((value) => Number.isFinite(value))
        .map((value) => buildContourLevelKey(value))
    );
    const features = [];
    const featureKeys = new Set();
    const appendedFeatureCountsByLevel = new Map();
    const nativeLoopEntries = buildNativeContourLoopEntries(
      siteContext,
      siteContext?.contourLines,
      { allowAmbiguousFallback: true }
    );
    const nativeLoopLevels = new Set(
      nativeLoopEntries.map((entry) => buildContourLevelKey(entry.elevation))
    );
    const reusableGeneratedFeatures = (siteContext?.contourLines?.features || []).filter(
      (feature) => shouldReuseGeneratedExportContourFeature(feature)
    );
    const shouldBuildGeneratedBandArea =
      reusableGeneratedFeatures.length === 0 &&
      Number.isFinite(requestedContourInterval) &&
      requestedContourInterval > 0 &&
      Number.isFinite(sourceContourInterval) &&
      sourceContourInterval > requestedContourInterval + 1e-9;
    const generatedBandAreaResult = shouldBuildGeneratedBandArea
        ? buildGeneratedContourAreaAboveByLevelFromNativeBands(
            siteContext,
            requestedContourInterval
          )
        : null;
    const preferredGeneratedAreaAboveByLevel =
      generatedBandAreaResult?.gridAreaAboveByLevel instanceof Map
        ? generatedBandAreaResult.gridAreaAboveByLevel
        : null;

    const registerLevelFeatureAppend = (levelKey) => {
      appendedFeatureCountsByLevel.set(
        levelKey,
        Number(appendedFeatureCountsByLevel.get(levelKey) || 0) + 1
      );
    };

    const appendNativeEntryFeature = (entry) => {
      const levelKey = buildContourLevelKey(entry.elevation);
      const featureKey = [
        levelKey,
        entry.loopPoints.map((point) => buildLocalPointKey(point, 3)).join(";"),
      ].join("|");

      if (featureKeys.has(featureKey)) {
        return false;
      }

      featureKeys.add(featureKey);
      registerLevelFeatureAppend(levelKey);
      features.push(
        lineFeature(
          entry.closedLoopPoints.map(([xMeters, yMeters]) =>
            lngLatFromMeters(siteContext.location, xMeters, yMeters)
          ),
          {
            elevation: Number(Number(entry.elevation).toFixed(3)),
            provider: "official-contours-closed",
            generated: false,
            closedLoop: true,
            exportDerived: entry.closureFallbackUsed
              ? "native-source-closed-display-fallback"
              : "native-source-closed",
            closureSelectionReason: entry.closureSelectionReason || null,
            closureFallbackUsed: entry.closureFallbackUsed === true,
            ...buildContourExportMetadata(siteContext, {
              generated: false,
              contourInterval: resolveSourceContourInterval(siteContext),
            }),
          }
        )
      );

      return true;
    };

    const appendFeaturesFromMultiPolygon = (
      multiPolygon,
      elevation,
      exportDerived = "resolved-area-above-contour"
    ) => {
      if (!Array.isArray(multiPolygon) || !multiPolygon.length) {
        return;
      }

      const levelKey = buildContourLevelKey(elevation);
      const generated = !nativeElevationKeys.has(levelKey);
      const generatedLoopCleanupAreaSqm = generated
        ? Math.max(
            1,
            Math.min(
              8,
              resolveRawAnchoredContourCleanupAreaThreshold(siteContext) * 2.5
            )
          )
        : 0;
      const regions = normalizeContourRegionsForLevel(
        siteContext,
        buildContourBandRegionsFromMultiPolygon(multiPolygon),
        elevation
      );

      for (const region of regions) {
        for (const loop of [region?.outerPoints, ...(region?.holePoints || [])]) {
          const closedLoop = closeRing(dedupeLocalPolygonPoints(loop, 0.001));

          if (closedLoop.length < 4) {
            continue;
          }

          if (
            generated &&
            Math.abs(computeLocalPolygonSignedArea(closedLoop)) <
              generatedLoopCleanupAreaSqm
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
          registerLevelFeatureAppend(levelKey);
          features.push(
            lineFeature(
              closedLoop.map(([xMeters, yMeters]) =>
                lngLatFromMeters(siteContext.location, xMeters, yMeters)
              ),
              {
                elevation: Number(Number(elevation).toFixed(3)),
                provider: generated ? "derived-contours-closed" : "official-contours-closed",
                generated,
                closedLoop: true,
                exportDerived,
                ...buildContourExportMetadata(siteContext, {
                  generated,
                  contourInterval: generated
                    ? null
                    : resolveSourceContourInterval(siteContext),
                }),
              }
            )
          );
        }
      }
    };
    for (const entry of nativeLoopEntries) {
      appendNativeEntryFeature(entry);
    }

    for (const feature of reusableGeneratedFeatures) {
      appendReusableContourFeatureToExportCollection({
        siteContext,
        feature,
        features,
        featureKeys,
        registerLevelFeatureAppend,
      });
    }

    const rawAnchorAssembly = buildRawAnchoredContourBandAssembly(siteContext);

    if (rawAnchorAssembly?.resolvedAreaAboveByLevel instanceof Map) {
      const generatedAreaAboveByLevel =
        preferredGeneratedAreaAboveByLevel || rawAnchorAssembly.resolvedAreaAboveByLevel;
      const resolvedLevels = [...generatedAreaAboveByLevel.keys()]
        .map(Number)
        .filter(Number.isFinite)
        .sort((left, right) => left - right);

      for (const level of resolvedLevels) {
        const levelKey = buildContourLevelKey(level);

        if (
          nativeLoopLevels.has(levelKey) ||
          Number(appendedFeatureCountsByLevel.get(levelKey) || 0) > 0
        ) {
          continue;
        }

        appendFeaturesFromMultiPolygon(
          generatedAreaAboveByLevel.get(levelKey) || [],
          level,
          preferredGeneratedAreaAboveByLevel
            ? "native-band-area-above-contour"
            : "resolved-area-above-contour"
        );
      }

      const highestTopSurfaceGroup = getCachedContourTopSurfaceGroups(siteContext)
        .filter(
          (group) =>
            Number.isFinite(Number(group?.elevation)) && Array.isArray(group?.multiPolygon)
        )
        .sort((left, right) => Number(left.elevation) - Number(right.elevation))
        .at(-1);

      if (highestTopSurfaceGroup?.multiPolygon?.length) {
        const topLevelKey = buildContourLevelKey(highestTopSurfaceGroup.elevation);

        if (Number(appendedFeatureCountsByLevel.get(topLevelKey) || 0) === 0) {
          appendFeaturesFromMultiPolygon(
            highestTopSurfaceGroup.multiPolygon,
            Number(highestTopSurfaceGroup.elevation),
            "top-surface-cap-contour"
          );
        }
      }
    }

    if (features.length) {
      const exportCollection = featureCollection(
        features.sort(
          (left, right) =>
            Number(left?.properties?.elevation || 0) -
              Number(right?.properties?.elevation || 0) ||
            Number(Boolean(left?.properties?.generated)) -
              Number(Boolean(right?.properties?.generated))
        )
      );

      setGeneratedContourFinalExportCount(siteContext, exportCollection);

      return exportCollection;
    }

    const cumulativeGroups = getCachedCumulativeContourBandGroups(siteContext);

    if (!cumulativeGroups.length) {
      const fallbackCollection = filterGeneratedContoursForFinalExport(
        siteContext,
        siteContext?.contourLines || featureCollection([])
      );
      setGeneratedContourFinalExportCount(siteContext, fallbackCollection);
      return fallbackCollection;
    }

    for (const group of cumulativeGroups) {
      const elevation = Number(group?.bottomElevation);

      if (!Number.isFinite(elevation)) {
        continue;
      }

      const levelKey = buildContourLevelKey(elevation);
      const generated = !nativeElevationKeys.has(levelKey);

      for (const loop of group?.boundaryLoops || []) {
        const closedLoop = closeRing(dedupeLocalPolygonPoints(loop, 0.001));

        if (closedLoop.length < 4) {
          continue;
        }

        features.push(
          lineFeature(
            closedLoop.map(([xMeters, yMeters]) =>
              lngLatFromMeters(siteContext.location, xMeters, yMeters)
            ),
            {
              elevation: Number(elevation.toFixed(3)),
              provider: generated ? "derived-contours-closed" : "official-contours-closed",
              generated,
              closedLoop: true,
              exportDerived: "cumulative-contour-boundary",
              ...buildContourExportMetadata(siteContext, {
                generated,
                contourInterval: generated
                  ? null
                  : resolveSourceContourInterval(siteContext),
              }),
            }
          )
        );
      }
    }

    const exportCollection = featureCollection(
      features.sort(
        (left, right) =>
          Number(left?.properties?.elevation || 0) -
            Number(right?.properties?.elevation || 0) ||
          Number(Boolean(left?.properties?.generated)) -
            Number(Boolean(right?.properties?.generated))
      )
    );

    setGeneratedContourFinalExportCount(siteContext, exportCollection);

    return exportCollection;
  }

  function getExportContourFeatureCollection(siteContext) {
    if (siteContext?.exportContourLines) {
      return siteContext.exportContourLines;
    }

    const fallbackCollection = filterGeneratedContoursForFinalExport(
      siteContext,
      siteContext?.contourLines || featureCollection([])
    );

    if (resolveTerrainPipelineMode(siteContext) === "legacy" && siteContext) {
      siteContext.exportContourLines = fallbackCollection;
    }

    setGeneratedContourFinalExportCount(siteContext, fallbackCollection);

    return fallbackCollection;
  }

  function shouldReuseGeneratedExportContourFeature(feature) {
    if (feature?.properties?.generated !== true) {
      return false;
    }

    const exportDerived = String(feature?.properties?.exportDerived || "")
      .trim()
      .toLowerCase();
    const provider = String(feature?.properties?.provider || "")
      .trim()
      .toLowerCase();

    return (
      exportDerived === "native-band-interpolation" ||
      exportDerived === "native-band-area-above-contour" ||
      exportDerived === "generated-terrain-aligned" ||
      exportDerived === "generated-terrain-grid-fallback" ||
      exportDerived === "resolved-area-above-contour" ||
      exportDerived === "top-surface-cap-contour" ||
      provider === "derived-contours-resolved-area" ||
      provider === "derived-contours-native-band"
    );
  }

  return {
    buildClosedNativeContourLinesForDisplay,
    buildAugmentedContourLinesForExport,
    buildLegacyAugmentedContourLinesForExport,
    appendReusableContourFeatureToExportCollection,
    buildLegacyClosedContourExportCollection,
    buildClosedContourExportCollection,
    getExportContourFeatureCollection,
    shouldReuseGeneratedExportContourFeature,
  };
}

export { createContourExport };
