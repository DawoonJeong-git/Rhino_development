import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  build3dmFromSiteContext,
  buildCanonicalContourInput,
  buildContourBandGroups,
  buildCumulativeContourBandGroups,
  buildOpenContourClosureDiagnostics,
  buildRawAnchoredContourBandDiagnostics,
  buildRoadContourSurfaceGroups,
  buildRoadSurfaceFeatureCollection,
  buildSketchUpPayloadFromSiteContext,
  getRhino3dm,
  localMetersFromLngLat,
  prepareSiteContextForExport,
  resolveContourTerrainRenderPlan,
} from "../server.mjs";

const DEFAULT_BASE_URL = process.env.SITE_CONTEXT_BASE_URL || "http://127.0.0.1:3000";
const DEFAULT_OPTIONS = {
  radius: 120,
  includeBuildings: true,
  includeParcelBoundary: true,
  includeContours: true,
  includeRoads: true,
  debugRoadDiagnostics: true,
  contourInterval: 1,
  terrainMode: "contour",
  buildingPlacement: "default",
};

function parseArgs(argv) {
  const args = {
    _: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundNumber(value, digits = 3) {
  return Number(Number(value || 0).toFixed(digits));
}

function groupCounts(items, resolver) {
  const counts = new Map();

  for (const item of items || []) {
    const key = resolver(item);
    counts.set(key, Number(counts.get(key) || 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return String(left[0]).localeCompare(String(right[0]));
    })
  );
}

function getLineStringsFromGeometry(geometry) {
  if (!geometry) {
    return [];
  }

  if (geometry.type === "LineString") {
    return Array.isArray(geometry.coordinates) ? [geometry.coordinates] : [];
  }

  if (geometry.type === "MultiLineString") {
    return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  }

  return [];
}

function getPolygonCoordinateSets(geometry) {
  if (!geometry) {
    return [];
  }

  if (geometry.type === "Polygon") {
    return Array.isArray(geometry.coordinates) ? [geometry.coordinates] : [];
  }

  if (geometry.type === "MultiPolygon") {
    return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  }

  return [];
}

function computeSignedArea(points) {
  const polygon = (points || []).filter(
    (point) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1])
  );

  if (polygon.length < 3) {
    return 0;
  }

  let area = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    area += current[0] * next[1] - next[0] * current[1];
  }

  return area / 2;
}

function computeLngLatRingAreaSqm(ring, center) {
  const localPoints = (ring || [])
    .map((point) => localMetersFromLngLat(point, center))
    .filter(
      (point) =>
        Array.isArray(point) &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1])
    );

  return Math.abs(computeSignedArea(localPoints));
}

function computePolygonAreaSqm(rings, center) {
  if (!Array.isArray(rings) || !rings.length) {
    return 0;
  }

  let area = computeLngLatRingAreaSqm(rings[0], center);

  for (let ringIndex = 1; ringIndex < rings.length; ringIndex += 1) {
    area -= computeLngLatRingAreaSqm(rings[ringIndex], center);
  }

  return Math.max(0, roundNumber(area, 3));
}

function summarizeContours(contourCollection) {
  const features = contourCollection?.features || [];
  const lineStrings = features.flatMap((feature) =>
    getLineStringsFromGeometry(feature?.geometry)
  );
  const pointCounts = lineStrings.map((lineString) => lineString.length);
  const elevations = features
    .map((feature) => Number(feature?.properties?.elevation))
    .filter(Number.isFinite);

  return {
    featureCount: features.length,
    geometryTypes: groupCounts(features, (feature) => feature?.geometry?.type || "unknown"),
    lineStringCount: lineStrings.length,
    totalPointCount: pointCounts.reduce((sum, value) => sum + value, 0),
    maxLinePointCount: pointCounts.length ? Math.max(...pointCounts) : 0,
    averageLinePointCount: pointCounts.length
      ? roundNumber(
          pointCounts.reduce((sum, value) => sum + value, 0) / pointCounts.length,
          2
        )
      : 0,
    elevationRange:
      elevations.length > 0
        ? {
            min: roundNumber(Math.min(...elevations), 3),
            max: roundNumber(Math.max(...elevations), 3),
          }
        : null,
  };
}

function summarizeContourStages(contourCollection) {
  const features = contourCollection?.features || [];
  const lineStrings = features.flatMap((feature) =>
    getLineStringsFromGeometry(feature?.geometry).map((lineString) => ({
      elevation: Number(feature?.properties?.elevation),
      generated: feature?.properties?.generated === true,
      closedLoop:
        feature?.properties?.closedLoop === true ||
        (Array.isArray(lineString) &&
          lineString.length >= 3 &&
          JSON.stringify(lineString[0]) === JSON.stringify(lineString[lineString.length - 1])),
      pointCount: Array.isArray(lineString) ? lineString.length : 0,
    }))
  );
  const elevations = features
    .map((feature) => Number(feature?.properties?.elevation))
    .filter(Number.isFinite);
  const elevationCounts = Object.fromEntries(
    [...new Map(
      elevations
        .sort((left, right) => left - right)
        .map((elevation) => [elevation, elevations.filter((value) => value === elevation).length])
    ).entries()]
  );

  return {
    featureCount: features.length,
    lineStringCount: lineStrings.length,
    nativeFeatureCount: features.filter((feature) => feature?.properties?.generated !== true).length,
    generatedFeatureCount: features.filter((feature) => feature?.properties?.generated === true).length,
    closedLoopFeatureCount: features.filter((feature) => feature?.properties?.closedLoop === true).length,
    closedLineStringCount: lineStrings.filter((line) => line.closedLoop === true).length,
    totalPointCount: lineStrings.reduce((sum, line) => sum + Number(line.pointCount || 0), 0),
    elevationCounts,
    elevationRange:
      elevations.length > 0
        ? {
            min: roundNumber(Math.min(...elevations), 3),
            max: roundNumber(Math.max(...elevations), 3),
          }
        : null,
  };
}

function summarizeBandGroupsDetailed(bandGroups) {
  const groups = bandGroups || [];
  const bottoms = groups
    .map((group) => Number(group?.bottomElevation))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const tops = groups
    .map((group) => Number(group?.topElevation))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  return {
    groupCount: groups.length,
    totalRegionCount: groups.reduce(
      (sum, group) => sum + Number(group?.regions?.length || 0),
      0
    ),
    totalBoundaryLoopCount: groups.reduce(
      (sum, group) => sum + Number(group?.boundaryLoops?.length || 0),
      0
    ),
    totalHoleCount: groups.reduce(
      (sum, group) =>
        sum +
        (group?.regions || []).reduce(
          (inner, region) => inner + Number(region?.holePoints?.length || 0),
          0
        ),
      0
    ),
    bottomElevations: bottoms,
    topElevations: tops,
    bottomElevationRange:
      bottoms.length > 0
        ? {
            min: roundNumber(Math.min(...bottoms), 3),
            max: roundNumber(Math.max(...bottoms), 3),
          }
        : null,
    topElevationRange:
      tops.length > 0
        ? {
            min: roundNumber(Math.min(...tops), 3),
            max: roundNumber(Math.max(...tops), 3),
          }
        : null,
  };
}

function summarizeTerrainPipeline(exportSiteContext) {
  const sourceContourCollection = exportSiteContext?.contourLines || null;
  const exportContourCollection =
    exportSiteContext?.exportContourLines || exportSiteContext?.contourLines || null;
  const canonicalContourInput =
    exportSiteContext?.canonicalContourInput ||
    buildCanonicalContourInput(exportSiteContext, sourceContourCollection);
  const openContourClosureDiagnostics = buildOpenContourClosureDiagnostics(
    exportSiteContext,
    sourceContourCollection
  );
  const rawAnchorBandDiagnostics = buildRawAnchoredContourBandDiagnostics(
    exportSiteContext
  );
  const rawBandGroups = buildContourBandGroups(exportSiteContext);
  const cumulativeBandGroups = buildCumulativeContourBandGroups(exportSiteContext);
  const terrainPlan = resolveContourTerrainRenderPlan(exportSiteContext);
  const renderableBandGroups = terrainPlan?.bandGroups || [];
  const nativeElevations = [
    ...new Set(
      (sourceContourCollection?.features || [])
        .filter((feature) => feature?.properties?.generated !== true)
        .map((feature) => Number(feature?.properties?.elevation))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)
    ),
  ];
  const exportElevations = new Set(
    (exportContourCollection?.features || [])
      .map((feature) => Number(feature?.properties?.elevation))
      .filter(Number.isFinite)
  );
  const renderableBottoms = new Set(
    renderableBandGroups
      .map((group) => Number(group?.bottomElevation))
      .filter(Number.isFinite)
  );

  return {
    canonicalContourInput: {
      nativeLevels: canonicalContourInput?.nativeLevels || [],
      generatedLevels: canonicalContourInput?.generatedLevels || [],
      entryCount: Number(canonicalContourInput?.entryCount || 0),
      nativeEntryCount: Number(canonicalContourInput?.nativeEntryCount || 0),
      generatedEntryCount: Number(canonicalContourInput?.generatedEntryCount || 0),
      openEntryCount: Number(canonicalContourInput?.openEntryCount || 0),
      closedEntryCount: Number(canonicalContourInput?.closedEntryCount || 0),
    },
    openContourClosureDiagnostics: {
      nativeOpenContourCount: Number(
        openContourClosureDiagnostics?.nativeOpenContourCount || 0
      ),
      acceptedCount: Number(openContourClosureDiagnostics?.acceptedCount || 0),
      rejectedCount: Number(openContourClosureDiagnostics?.rejectedCount || 0),
      acceptedElevations: openContourClosureDiagnostics?.acceptedElevations || [],
      rejectedElevations: openContourClosureDiagnostics?.rejectedElevations || [],
      rejectionReasons: groupCounts(
        openContourClosureDiagnostics?.entries || [],
        (entry) =>
          entry?.closureRejectedReason ||
          (entry?.accepted ? "accepted" : entry?.selectionReason || "unknown")
      ),
      entries: openContourClosureDiagnostics?.entries || [],
    },
    rawAnchorBandDiagnostics: {
      reason: rawAnchorBandDiagnostics?.reason || null,
      interval: Number(rawAnchorBandDiagnostics?.interval || 0),
      sourceContourInterval: Number(rawAnchorBandDiagnostics?.sourceContourInterval || 0),
      minElevation: Number.isFinite(rawAnchorBandDiagnostics?.minElevation)
        ? rawAnchorBandDiagnostics.minElevation
        : null,
      maxElevation: Number.isFinite(rawAnchorBandDiagnostics?.maxElevation)
        ? rawAnchorBandDiagnostics.maxElevation
        : null,
      startLevel: Number.isFinite(rawAnchorBandDiagnostics?.startLevel)
        ? rawAnchorBandDiagnostics.startLevel
        : null,
      contourEntryCount: Number(rawAnchorBandDiagnostics?.contourEntryCount || 0),
      anchorLevels: rawAnchorBandDiagnostics?.anchorLevels || [],
      contourEntryCountsByElevation:
        rawAnchorBandDiagnostics?.contourEntryCountsByElevation || {},
      rawAreaAboveByLevel: rawAnchorBandDiagnostics?.rawAreaAboveByLevel || [],
      constrainedAnchorAreaByLevel:
        rawAnchorBandDiagnostics?.constrainedAnchorAreaByLevel || [],
      resolvedAreaAboveByLevel:
        rawAnchorBandDiagnostics?.resolvedAreaAboveByLevel || [],
      gridAreaAboveByLevel: rawAnchorBandDiagnostics?.gridAreaAboveByLevel || [],
      bandBottomElevations: rawAnchorBandDiagnostics?.bandBottomElevations || [],
      bandTopElevations: rawAnchorBandDiagnostics?.bandTopElevations || [],
      levelDiagnostics: rawAnchorBandDiagnostics?.levelDiagnostics || [],
    },
    sourceContours: summarizeContourStages(sourceContourCollection),
    exportContours: summarizeContourStages(exportContourCollection),
    rawBandGroups: summarizeBandGroupsDetailed(rawBandGroups),
    cumulativeBandGroups: summarizeBandGroupsDetailed(cumulativeBandGroups),
    renderableBandGroups: summarizeBandGroupsDetailed(renderableBandGroups),
    terrainPlan: terrainPlan
      ? {
          terrainGridStep: roundNumber(exportSiteContext?.terrainGrid?.step || 0, 3),
          interval: roundNumber(terrainPlan.interval || 0, 3),
          baseElevation: roundNumber(terrainPlan.baseElevation || 0, 3),
          minBandElevation: roundNumber(terrainPlan.minBandElevation || 0, 3),
          flatTopElevation: roundNumber(terrainPlan.flatTopElevation || 0, 3),
          useFlatFallback: terrainPlan.useFlatFallback === true,
        }
      : null,
    nativeElevations,
    exportMissingNativeElevations: nativeElevations.filter(
      (elevation) => !exportElevations.has(elevation)
    ),
    renderableMissingNativeBottomElevations: nativeElevations.filter(
      (elevation) => !renderableBottoms.has(elevation)
    ),
  };
}

function summarizeRawRoads(siteContext) {
  const features =
    siteContext?.debug?.roads?.rawCollection?.features || siteContext?.roads?.features || [];
  const polygonSets = features.flatMap((feature) =>
    getPolygonCoordinateSets(feature?.geometry)
  );

  return {
    featureCount: features.length,
    geometryTypes: groupCounts(features, (feature) => feature?.geometry?.type || "unknown"),
    sourceLayers: groupCounts(
      features,
      (feature) => String(feature?.properties?.sourceLayer || "unknown").trim() || "unknown"
    ),
    polygonFeatureCount: features.filter((feature) =>
      /Polygon/.test(String(feature?.geometry?.type || ""))
    ).length,
    polygonCount: polygonSets.length,
    polygonHoleCount: polygonSets.reduce(
      (sum, polygonRings) => sum + Math.max(0, (polygonRings?.length || 0) - 1),
      0
    ),
  };
}

function summarizeDerivedRoadSurfaces(siteContext) {
  const derived = buildRoadSurfaceFeatureCollection(
    siteContext?.roads?.features || [],
    siteContext?.location || {}
  );
  const center = siteContext?.location || {};
  const polygonAreas = (derived?.features || []).map((feature) =>
    computePolygonAreaSqm(feature?.geometry?.coordinates || [], center)
  );
  const ringCounts = (derived?.features || []).map(
    (feature) => feature?.geometry?.coordinates?.length || 0
  );
  const totalArea = polygonAreas.reduce((sum, value) => sum + value, 0);
  const clipAreaSqm = Number(siteContext?.stats?.clipAreaSqm || 0);

  return {
    featureCount: derived?.features?.length || 0,
    ringCounts,
    polygonAreasSqm: polygonAreas,
    totalAreaSqm: roundNumber(totalArea, 3),
    largestAreaSqm: polygonAreas.length ? roundNumber(Math.max(...polygonAreas), 3) : 0,
    coverageRatioToClip: clipAreaSqm > 0 ? roundNumber(totalArea / clipAreaSqm, 4) : null,
  };
}

function summarizeTerrainPlan(exportSiteContext) {
  const terrainPlan = resolveContourTerrainRenderPlan(exportSiteContext);

  if (!terrainPlan) {
    return null;
  }

  return {
    terrainGridStep: roundNumber(exportSiteContext?.terrainGrid?.step || 0, 3),
    interval: roundNumber(terrainPlan.interval || 0, 3),
    bandGroupCount: Number(terrainPlan.bandGroups?.length || 0),
    useFlatFallback: terrainPlan.useFlatFallback === true,
    baseElevation: roundNumber(terrainPlan.baseElevation || 0, 3),
    minBandElevation: roundNumber(terrainPlan.minBandElevation || 0, 3),
    flatTopElevation: roundNumber(terrainPlan.flatTopElevation || 0, 3),
    clipPolygonPointCount: Number(terrainPlan.clipPolygon?.length || 0),
  };
}

function summarizeRoadContourSurfaceGroups(exportSiteContext) {
  const groups = buildRoadContourSurfaceGroups(exportSiteContext, exportSiteContext?.location);
  const areas = groups.map((group) => Number(group?.areaSqm || 0)).filter(Number.isFinite);
  const regionCounts = groups.map((group) => Number(group?.regions?.length || 0));

  return {
    groupCount: groups.length,
    totalAreaSqm: roundNumber(areas.reduce((sum, value) => sum + value, 0), 3),
    largestAreaSqm: areas.length ? roundNumber(Math.max(...areas), 3) : 0,
    totalRegionCount: regionCounts.reduce((sum, value) => sum + value, 0),
    regionCounts,
    elevations: groups.map((group) => roundNumber(group?.elevation || 0, 3)),
  };
}

function accumulateSolidPointMetrics(metrics, points) {
  for (const point of points || []) {
    const x = Number(point?.[0]);
    const y = Number(point?.[1]);
    const z = Number(point?.[2]);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    metrics.pointCount += 1;
    metrics._uniqueXY.add(`${x.toFixed(3)},${y.toFixed(3)}`);
    metrics._uniqueX.add(x.toFixed(3));
    metrics._uniqueY.add(y.toFixed(3));

    if (Number.isFinite(z)) {
      metrics.maxAbsZ = Math.max(metrics.maxAbsZ, Math.abs(z));
    }
  }
}

function createLayerSummary() {
  return {
    groups: 0,
    polylines: 0,
    curvePolylines: 0,
    closedPolylines: 0,
    polylinePointCount: 0,
    curvePolylinePointCount: 0,
    solids: 0,
    solidOuterLoopCount: 0,
    solidHoleLoopCount: 0,
    solidPointCount: 0,
    faceCount: 0,
    maxAbsZ: 0,
    _uniqueXY: new Set(),
    _uniqueX: new Set(),
    _uniqueY: new Set(),
  };
}

function finalizeLayerSummary(summary) {
  return {
    groups: summary.groups,
    polylines: summary.polylines,
    curvePolylines: summary.curvePolylines,
    closedPolylines: summary.closedPolylines,
    polylinePointCount: summary.polylinePointCount,
    curvePolylinePointCount: summary.curvePolylinePointCount,
    solids: summary.solids,
    solidOuterLoopCount: summary.solidOuterLoopCount,
    solidHoleLoopCount: summary.solidHoleLoopCount,
    solidPointCount: summary.solidPointCount,
    faceCount: summary.faceCount,
    maxAbsZ: roundNumber(summary.maxAbsZ, 6),
    uniqueXYCount: summary._uniqueXY.size,
    uniqueXCount: summary._uniqueX.size,
    uniqueYCount: summary._uniqueY.size,
  };
}

function summarizeSketchUpPayload(payload) {
  const layerSummaries = new Map();

  for (const group of payload?.groups || []) {
    const layer = String(group?.layer || "unknown").trim() || "unknown";

    if (!layerSummaries.has(layer)) {
      layerSummaries.set(layer, createLayerSummary());
    }

    const summary = layerSummaries.get(layer);
    summary.groups += 1;
    summary.faceCount += Number(group?.faces?.length || 0);

    for (const polyline of group?.polylines || []) {
      summary.polylines += 1;
      summary.polylinePointCount += Number(polyline?.points?.length || 0);

      if (polyline?.curve === true) {
        summary.curvePolylines += 1;
        summary.curvePolylinePointCount += Number(polyline?.points?.length || 0);
      }

      if (polyline?.closed === true) {
        summary.closedPolylines += 1;
      }

      accumulateSolidPointMetrics(summary, polyline?.points || []);
    }

    for (const solid of group?.solids || []) {
      summary.solids += 1;
      summary.solidOuterLoopCount += Array.isArray(solid?.outerLoop) ? 1 : 0;
      summary.solidHoleLoopCount += Number(solid?.holeLoops?.length || 0);
      summary.solidPointCount += Number(solid?.outerLoop?.length || 0);

      for (const holeLoop of solid?.holeLoops || []) {
        summary.solidPointCount += Number(holeLoop?.length || 0);
      }

      accumulateSolidPointMetrics(summary, solid?.outerLoop || []);

      for (const holeLoop of solid?.holeLoops || []) {
        accumulateSolidPointMetrics(summary, holeLoop || []);
      }
    }
  }

  return {
    groupCount: Number(payload?.groups?.length || 0),
    layers: Object.fromEntries(
      [...layerSummaries.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([layer, summary]) => [layer, finalizeLayerSummary(summary)])
    ),
  };
}

function classifyRhinoGeometry(geometry, rhino) {
  if (!geometry) {
    return "unknown";
  }

  if (geometry instanceof rhino.Curve) {
    return "curve";
  }

  if (geometry instanceof rhino.Mesh) {
    return "mesh";
  }

  if (geometry instanceof rhino.Extrusion) {
    return "extrusion";
  }

  if (geometry instanceof rhino.Brep) {
    return "brep";
  }

  return geometry.constructor?.name || "unknown";
}

async function summarize3dm(threeDmBytes) {
  const rhino = await getRhino3dm();
  const doc = rhino.File3dm.fromByteArray(threeDmBytes);
  const objects = doc.objects();
  const layers = doc.layers();
  const geometryTypeCounts = new Map();
  const layerSummaries = new Map();
  let maxAbsZ = 0;

  for (let index = 0; index < objects.count; index += 1) {
    const object = objects.get(index);
    const geometry = object?.geometry?.();

    if (!geometry) {
      continue;
    }

    const geometryType = classifyRhinoGeometry(geometry, rhino);
    geometryTypeCounts.set(
      geometryType,
      Number(geometryTypeCounts.get(geometryType) || 0) + 1
    );

    const attributes =
      typeof object?.attributes === "function" ? object.attributes() : object?.attributes || null;
    const layerIndex = Number(attributes?.layerIndex);
    const resolvedLayer =
      Number.isInteger(layerIndex) && typeof layers?.get === "function"
        ? layers.get(layerIndex)?.name
        : null;
    const layerName = resolvedLayer || `layer:${Number.isFinite(layerIndex) ? layerIndex : "unknown"}`;

    if (!layerSummaries.has(layerName)) {
      layerSummaries.set(layerName, {
        objects: 0,
        geometryTypes: new Map(),
        curvePointCount: 0,
        curveCount: 0,
      });
    }

    const layerSummary = layerSummaries.get(layerName);
    layerSummary.objects += 1;
    layerSummary.geometryTypes.set(
      geometryType,
      Number(layerSummary.geometryTypes.get(geometryType) || 0) + 1
    );

    if (geometryType !== "curve") {
      continue;
    }

    layerSummary.curveCount += 1;
    const pointCount = Number(geometry.pointCount || 0);
    layerSummary.curvePointCount += pointCount;

    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      const point = geometry.point(pointIndex);

      if (Array.isArray(point) && Number.isFinite(point[2])) {
        maxAbsZ = Math.max(maxAbsZ, Math.abs(Number(point[2] || 0)));
      }
    }
  }

  return {
    bytes: threeDmBytes.length,
    objectCount: Number(objects.count || 0),
    geometryTypes: Object.fromEntries(
      [...geometryTypeCounts.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    ),
    curveMaxAbsZ: roundNumber(maxAbsZ, 6),
    layers: Object.fromEntries(
      [...layerSummaries.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([layerName, layerSummary]) => [
          layerName,
          {
            objects: layerSummary.objects,
            curveCount: layerSummary.curveCount,
            curvePointCount: layerSummary.curvePointCount,
            geometryTypes: Object.fromEntries(
              [...layerSummary.geometryTypes.entries()].sort((left, right) =>
                left[0].localeCompare(right[0])
              )
            ),
          },
        ])
    ),
  };
}

async function fetchJson(baseUrl, pathname, payload) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `${pathname} failed with ${response.status}: ${json?.error || "unknown error"}`
    );
  }

  return json;
}

function buildRequestOptions(args) {
  return {
    ...DEFAULT_OPTIONS,
    radius: Math.max(30, toFiniteNumber(args.radius, DEFAULT_OPTIONS.radius)),
    contourInterval: Math.max(
      0.1,
      toFiniteNumber(args["contour-interval"], DEFAULT_OPTIONS.contourInterval)
    ),
  };
}

async function loadSiteContext(args) {
  if (args["site-context"]) {
    const siteContextPath = path.resolve(String(args["site-context"]));
    const payload = JSON.parse(await readFile(siteContextPath, "utf8"));
    return {
      siteContext: payload,
      source: {
        kind: "file",
        siteContextPath,
      },
    };
  }

  const lat = toFiniteNumber(args.lat);
  const lng = toFiniteNumber(args.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("Use --site-context <path> or provide both --lat and --lng.");
  }

  const options = buildRequestOptions(args);
  const baseUrl = String(args["base-url"] || DEFAULT_BASE_URL);
  const siteContext = await fetchJson(baseUrl, "/api/site-context", {
    location: {
      lat,
      lng,
      label: String(args.name || "").trim() || undefined,
    },
    options,
  });

  if (args["save-site-context"]) {
    const outputPath = path.resolve(String(args["save-site-context"]));
    await writeFile(outputPath, JSON.stringify(siteContext, null, 2), "utf8");
  }

  return {
    siteContext,
    source: {
      kind: "live",
      baseUrl,
      location: { lat, lng },
      options,
    },
  };
}

function summarizeComparison(sourceContours, threeDm, skpPayloadSummary) {
  const summarizeLayersByPrefix = (layers, prefix) => {
    const normalizedPrefix = String(prefix || "").trim().toLowerCase();
    const matchedLayers = Object.entries(layers || {}).filter(([layerName]) =>
      String(layerName || "")
        .trim()
        .toLowerCase()
        .startsWith(normalizedPrefix)
    );

    if (!matchedLayers.length) {
      return null;
    }

    return matchedLayers.reduce((summary, [, layerMetrics]) => {
      for (const [metricName, metricValue] of Object.entries(layerMetrics || {})) {
        if (typeof metricValue === "number") {
          summary[metricName] = Number(summary[metricName] || 0) + metricValue;
        }
      }

      return summary;
    }, {});
  };
  const threeDmContourLayer = summarizeLayersByPrefix(threeDm.layers, "contours") || null;
  const skpContourLayer =
    summarizeLayersByPrefix(skpPayloadSummary.layers, "contours") || null;
  const skpTerrainLayer = skpPayloadSummary.layers?.terrain || null;
  const skpRoadLayer = skpPayloadSummary.layers?.roads || null;

  return {
    sourceContourLineStrings: sourceContours.lineStringCount,
    sourceContourPoints: sourceContours.totalPointCount,
    threeDmContourCurves: Number(threeDmContourLayer?.curveCount || 0),
    threeDmContourCurvePoints: Number(threeDmContourLayer?.curvePointCount || 0),
    skpContourCurves: Number(skpContourLayer?.curvePolylines || 0),
    skpContourCurvePoints: Number(skpContourLayer?.curvePolylinePointCount || 0),
    skpTerrainSolids: Number(skpTerrainLayer?.solids || 0),
    skpTerrainUniqueXY: Number(skpTerrainLayer?.uniqueXYCount || 0),
    skpRoadSolids: Number(skpRoadLayer?.solids || 0),
    skpRoadUniqueXY: Number(skpRoadLayer?.uniqueXYCount || 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { siteContext, source } = await loadSiteContext(args);
  const threeDmExportSiteContext = prepareSiteContextForExport(
    siteContext,
    {
      ...(siteContext?.options || {}),
      exportFormat: "3dm",
    },
    "3dm"
  );
  const skpExportSiteContext = prepareSiteContextForExport(
    siteContext,
    {
      ...(siteContext?.options || {}),
      exportFormat: "skp",
    },
    "skp"
  );
  const derivedRoadSurfaces = summarizeDerivedRoadSurfaces(siteContext);
  const terrainPlan = summarizeTerrainPlan(skpExportSiteContext);
  const terrainPipeline = summarizeTerrainPipeline(threeDmExportSiteContext);
  const roadContourSurfaceGroups = summarizeRoadContourSurfaceGroups(skpExportSiteContext);
  const threeDmSummary = await summarize3dm(
    await build3dmFromSiteContext(threeDmExportSiteContext)
  );
  const skpPayloadSummary = summarizeSketchUpPayload(
    buildSketchUpPayloadFromSiteContext(skpExportSiteContext)
  );
  const contourSummary = summarizeContours(siteContext?.contourLines);
  const result = {
    inspectedAt: new Date().toISOString(),
    source,
    siteContext: {
      selectionMode: siteContext?.selectionMode || null,
      stats: siteContext?.stats || {},
      dataSources: siteContext?.dataSources || {},
      options: siteContext?.options || {},
      debug: siteContext?.debug || null,
    },
    contours: contourSummary,
    roads: {
      raw: summarizeRawRoads(siteContext),
      derivedSurfaces: derivedRoadSurfaces,
      contourSurfaceGroups: roadContourSurfaceGroups,
    },
    exports: {
      threeDm: {
        requestedContourInterval:
          threeDmExportSiteContext?.stats?.requestedContourInterval || null,
        sourceContourInterval:
          threeDmExportSiteContext?.stats?.sourceContourInterval || null,
        effectiveContourBandInterval:
          threeDmExportSiteContext?.stats?.effectiveContourBandInterval || null,
        summary: threeDmSummary,
      },
      skp: {
        requestedContourInterval:
          skpExportSiteContext?.stats?.requestedContourInterval || null,
        sourceContourInterval:
          skpExportSiteContext?.stats?.sourceContourInterval || null,
        effectiveContourBandInterval:
          skpExportSiteContext?.stats?.effectiveContourBandInterval || null,
        terrainPlan,
        payload: skpPayloadSummary,
      },
    },
    terrainPipeline,
    comparisons: summarizeComparison(contourSummary, threeDmSummary, skpPayloadSummary),
  };

  const output = JSON.stringify(result, null, 2);

  if (args.output) {
    await writeFile(path.resolve(String(args.output)), output, "utf8");
  }

  console.log(output);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
