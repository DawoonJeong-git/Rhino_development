import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import process from "node:process";
import polygonClipping from "polygon-clipping";
import {
  buildProviderTimeoutConfig,
  buildParcelDataCacheKey,
  buildExportArtifactCacheKey,
  buildSearchQueryHints,
  buildSiteContextCacheKey,
  buildVWorldDomainCandidates,
  beginInteractiveSearchPriority,
  createApp,
  prepareSiteContextForExport,
  build3dmFromSiteContext,
  buildClipBoundary,
  buildRoadSurfaceFeatureCollection,
  buildSketchUpPayloadFromSiteContext,
  buildObjFromSiteContext,
  buildSkpFromSiteContextWithRetry,
  withExportJobSlot,
  fetchWithTimeout,
  getRhino3dm,
  isInternalOnlyStaticPath,
  isPathInsideDirectory,
  normalizePublicError,
  normalizeSearchResultsForQuery,
  pruneCacheEntries,
  readOrLoadResponseCache,
  endInteractiveSearchPriority,
  resetExportQueueStateForTests,
  resolveEffectiveContourBandInterval,
  resolveContourTerrainRenderPlan,
  resolveRateLimitBucket,
  resolveSketchUpTerrainSolidSimplifyTolerance,
  resolveTerrainContourPath,
  resolveVWorldSearchCategories,
  selectPreferredRoadContextCandidate,
  selectGeocodedVWorldResultForJusoCandidate,
  selectShortCircuitJusoCandidate,
  selectStrongJusoFastPathCandidates,
  sanitizeSketchUpSolidRegion,
  simplifySketchUpSolidRegion,
  buildRawAnchoredContourBandDiagnostics,
  buildTerrainPipelineDiagnostics,
  localMetersFromLngLat,
} from "./server.mjs";

const BASE_URL = process.env.SITE_CONTEXT_BASE_URL || "http://127.0.0.1:3000";
const BASELINE_MODE = process.argv.includes("--baseline");
const BASELINE_PORT = Number(process.env.VERIFY_BASELINE_PORT || 3034);
const FULL_SKP_EXPORT = /^(1|true|yes)$/i.test(
  String(process.env.VERIFY_EXPORTS_FULL_SKP || "")
);
const CASE_FILTER = new Set(
  String(process.env.VERIFY_EXPORTS_CASES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const DEFAULT_OPTIONS = {
  includeBuildings: true,
  includeParcelBoundary: true,
  includeContours: true,
  includeRoads: true,
  contourInterval: 1,
  terrainMode: "contour",
  buildingPlacement: "default",
};

const CASES = [
  {
    name: "seoul-hillside",
    location: { lat: 37.57705, lng: 126.962095 },
    options: { radius: 100 },
    expect: { maxEffective: 5, min3dmBytes: 500_000, minSkpGroups: 5, minObjLength: 100_000 },
  },
  {
    name: "gyeyang-large",
    location: { lat: 37.545659, lng: 126.716062 },
    options: { radius: 400 },
    expect: { maxEffective: 5, min3dmBytes: 500_000, minSkpGroups: 5, minObjLength: 100_000 },
  },
  {
    name: "seoul-center",
    location: { lat: 37.571991, lng: 126.980074 },
    options: { radius: 100 },
    expect: { maxEffective: 5, min3dmBytes: 100_000, minSkpGroups: 1, minObjLength: 10_000 },
  },
  {
    name: "muak-live-cache",
    siteContextPath: "tmp_muak_live_site_context.json",
    expect: { maxEffective: 5, min3dmBytes: 500_000, minSkpGroups: 5, minObjLength: 100_000 },
  },
  {
    name: "chungnam-rural",
    location: { lat: 36.427297, lng: 126.780739 },
    options: { radius: 150 },
    expect: { maxEffective: 5, min3dmBytes: 100_000, minSkpGroups: 1, minObjLength: 50_000 },
  },
].filter((testCase) => CASE_FILTER.size === 0 || CASE_FILTER.has(testCase.name));

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

function closeLocalRing(points) {
  const ring = (points || [])
    .filter(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1])
    )
    .map((point) => [Number(point[0]), Number(point[1])]);

  if (ring.length < 3) {
    return [];
  }

  const firstPoint = ring[0];
  const lastPoint = ring[ring.length - 1];

  if (
    Math.abs(firstPoint[0] - lastPoint[0]) > 1e-9 ||
    Math.abs(firstPoint[1] - lastPoint[1]) > 1e-9
  ) {
    ring.push([...firstPoint]);
  }

  return ring;
}

function computeSignedArea(points) {
  const ring = closeLocalRing(points);

  if (ring.length < 4) {
    return 0;
  }

  let area = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    area += current[0] * next[1] - next[0] * current[1];
  }

  return area / 2;
}

function orientLocalRingCounterClockwise(points) {
  const ring = closeLocalRing(points);
  return computeSignedArea(ring) >= 0 ? ring : [...ring].reverse();
}

function computeMultiPolygonAreaSqm(multiPolygon) {
  let area = 0;

  for (const polygon of multiPolygon || []) {
    if (!Array.isArray(polygon) || !polygon.length) {
      continue;
    }

    area += Math.abs(computeSignedArea(polygon[0] || []));

    for (let ringIndex = 1; ringIndex < polygon.length; ringIndex += 1) {
      area -= Math.abs(computeSignedArea(polygon[ringIndex] || []));
    }
  }

  return Math.max(0, Number(area.toFixed(6)));
}

function assertDefaultCspShape(csp, label) {
  const value = String(csp || "");

  assert.match(value, /script-src 'self'/, `${label} should keep self as a script source.`);
  assert.match(value, /style-src 'self'(;|$)/, `${label} should keep stylesheets self-hosted.`);
  assert.match(value, /connect-src 'self'/, `${label} should keep same-origin fetch access.`);
  assert.doesNotMatch(
    value,
    /unpkg\.com/i,
    `${label} should not allow third-party CDN hosts such as unpkg.`
  );
  assert.match(
    value,
    /static\.cloudflareinsights\.com/i,
    `${label} should allow Cloudflare analytics script injection when enabled.`
  );
  assert.match(
    value,
    /cloudflareinsights\.com/i,
    `${label} should allow Cloudflare analytics beacons when enabled.`
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTimeoutProbeServer() {
  const server = createHttpServer((request, response) => {
    if (request.url === "/fast") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    setTimeout(() => {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ ok: true }));
    }, 150);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Timeout probe server did not expose a TCP port.");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function isRetriableFetchError(error) {
  const message = String(error?.message || error || "");
  return /ECONNRESET|fetch failed|socket hang up|ETIMEDOUT/i.test(message);
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function fetchJson(pathname, payload = null, retryCount = 0) {
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method: payload ? "POST" : "GET",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });

    const json = await readJson(response);

    if (!response.ok) {
      throw new Error(
        `${pathname} failed with ${response.status}: ${json?.error || "unknown error"}`
      );
    }

    return json;
  } catch (error) {
    if (retryCount < 2 && isRetriableFetchError(error)) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (retryCount + 1)));
      return fetchJson(pathname, payload, retryCount + 1);
    }

    throw error;
  }
}

async function loadCaseSiteContext(testCase) {
  if (typeof testCase?.siteContextPath === "string" && testCase.siteContextPath.trim()) {
    const siteContextPath = path.resolve(testCase.siteContextPath);
    return JSON.parse(await readFile(siteContextPath, "utf8"));
  }

  return fetchJson("/api/site-context", {
    location: testCase.location,
    options: {
      ...DEFAULT_OPTIONS,
      ...(testCase.options || {}),
    },
  });
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function summarizeExportContext(siteContext, format) {
  const exportSiteContext = prepareSiteContextForExport(
    siteContext,
    {
      ...(siteContext?.options || {}),
      exportFormat: format,
    },
    format
  );
  const terrainPlan = resolveContourTerrainRenderPlan(exportSiteContext);

  return {
    exportSiteContext,
    requested: exportSiteContext.stats?.requestedContourInterval,
    source: exportSiteContext.stats?.sourceContourInterval,
    effective: exportSiteContext.stats?.effectiveContourBandInterval,
    contourCount: exportSiteContext?.contourLines?.features?.length || 0,
    terrainPlan,
  };
}

function summarizePlacementDiagnostics(exportSiteContext) {
  const diagnostics =
    exportSiteContext?.stats?.terrainPipelineDiagnostics ||
    buildTerrainPipelineDiagnostics(exportSiteContext) ||
    null;
  const buildingPlacement = diagnostics?.buildingPlacement || null;
  const roadPlacement = diagnostics?.roadPlacement || null;

  return {
    buildingPlacement: buildingPlacement
      ? {
          sampleCount: Number(buildingPlacement.sampleCount || 0),
          unresolvedCount: Number(buildingPlacement.unresolvedCount || 0),
          terrainBasisAvailableCount: Number(
            buildingPlacement.terrainBasisAvailableCount || 0
          ),
          terrainBasisMismatchCount: Number(
            buildingPlacement.terrainBasisMismatchCount || 0
          ),
          terrainBasisFallbackCount: Number(
            buildingPlacement.terrainBasisFallbackCount || 0
          ),
          terrainBasisMaxDelta: Number(
            buildingPlacement.terrainBasisMaxDelta || 0
          ),
        }
      : null,
    roadPlacement: roadPlacement
      ? {
          roadFeatureCount: Number(roadPlacement.roadFeatureCount || 0),
          groupCount: Number(roadPlacement.groupCount || 0),
          footprintAreaSqm: Number(roadPlacement.footprintAreaSqm || 0),
          coveredAreaSqm: Number(roadPlacement.coveredAreaSqm || 0),
          uncoveredAreaSqm: Number(roadPlacement.uncoveredAreaSqm || 0),
          coverageRatio: Number(roadPlacement.coverageRatio || 0),
          elevationCount: Number(roadPlacement.elevationCount || 0),
          minElevation: Number.isFinite(roadPlacement.minElevation)
            ? Number(roadPlacement.minElevation)
            : null,
          maxElevation: Number.isFinite(roadPlacement.maxElevation)
            ? Number(roadPlacement.maxElevation)
            : null,
        }
      : null,
  };
}

async function summarize3dmCurveHeights(threeDmBytes) {
  const rhino = await getRhino3dm();
  const doc = rhino.File3dm.fromByteArray(threeDmBytes);
  const objects = doc.objects();
  let curveCount = 0;
  let maxAbsZ = 0;

  for (let index = 0; index < objects.count; index += 1) {
    const geometry = objects.get(index)?.geometry?.();

    if (!(geometry instanceof rhino.Curve)) {
      continue;
    }

    curveCount += 1;
    const pointCount = Number(geometry.pointCount || 0);

    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      const point = geometry.point(pointIndex);

      if (Array.isArray(point) && Number.isFinite(point[2])) {
        maxAbsZ = Math.max(maxAbsZ, Math.abs(Number(point[2] || 0)));
      }
    }
  }

  return {
    curveCount,
    maxAbsZ: Number(maxAbsZ.toFixed(6)),
  };
}

function computeClipBounds(siteContext) {
  const ring = siteContext?.clipBoundary?.geometry?.coordinates?.[0];

  if (!Array.isArray(ring) || !siteContext?.location) {
    return null;
  }

  const points = ring
    .map((point) => localMetersFromLngLat(point, siteContext.location))
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

  if (points.length < 3) {
    return null;
  }

  return points.reduce(
    (acc, [xMeters, yMeters]) => ({
      minX: Math.min(acc.minX, xMeters),
      minY: Math.min(acc.minY, yMeters),
      maxX: Math.max(acc.maxX, xMeters),
      maxY: Math.max(acc.maxY, yMeters),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    }
  );
}

async function summarize3dmTerrainBands(threeDmBytes, exportSiteContext) {
  const clipBounds = computeClipBounds(exportSiteContext);

  if (!clipBounds) {
    return {
      bandCount: 0,
      fullFootprintBandCount: 0,
      leadingFullFootprintBandCount: 0,
      trailingFullFootprintBandCount: 0,
      trailingFullFootprintBands: [],
    };
  }

  const clipWidth = clipBounds.maxX - clipBounds.minX;
  const clipHeight = clipBounds.maxY - clipBounds.minY;
  const rhino = await getRhino3dm();
  const doc = rhino.File3dm.fromByteArray(threeDmBytes);
  const layers = doc.layers();
  const objects = doc.objects();
  const layerNames = new Map();

  for (let index = 0; index < layers.count; index += 1) {
    const layer = layers.get(index);
    layerNames.set(layer.index, layer.name);
  }

  const terrainBands = [];
  const readBBoxAxis = (point, axisIndex, axisName) => {
    const arrayValue = Number(point?.[axisIndex]);

    if (Number.isFinite(arrayValue)) {
      return arrayValue;
    }

    const upperValue = Number(point?.[axisName]);

    if (Number.isFinite(upperValue)) {
      return upperValue;
    }

    const lowerValue = Number(point?.[String(axisName || "").toLowerCase()]);
    return Number.isFinite(lowerValue) ? lowerValue : null;
  };
  const boundsFromBox = (bbox) => {
    if (!bbox) {
      return null;
    }

    const minPoint = bbox.min || bbox.Min || null;
    const maxPoint = bbox.max || bbox.Max || null;
    const minX = readBBoxAxis(minPoint, 0, "X");
    const minY = readBBoxAxis(minPoint, 1, "Y");
    const minZ = readBBoxAxis(minPoint, 2, "Z");
    const maxX = readBBoxAxis(maxPoint, 0, "X");
    const maxY = readBBoxAxis(maxPoint, 1, "Y");
    const maxZ = readBBoxAxis(maxPoint, 2, "Z");

    return [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)
      ? { minX, minY, minZ, maxX, maxY, maxZ }
      : null;
  };
  const computeGeometryBounds = (geometry) => {
    if (!geometry) {
      return null;
    }

    const edges = typeof geometry.edges === "function" ? geometry.edges() : null;

    if (edges?.count > 0) {
      let edgeBounds = null;

      for (let edgeIndex = 0; edgeIndex < edges.count; edgeIndex += 1) {
        const edge = edges.get(edgeIndex);
        const currentBounds = boundsFromBox(edge?.getBoundingBox ? edge.getBoundingBox() : null);

        if (!currentBounds) {
          continue;
        }

        if (!edgeBounds) {
          edgeBounds = { ...currentBounds };
          continue;
        }

        edgeBounds.minX = Math.min(edgeBounds.minX, currentBounds.minX);
        edgeBounds.minY = Math.min(edgeBounds.minY, currentBounds.minY);
        edgeBounds.minZ = Math.min(edgeBounds.minZ, currentBounds.minZ);
        edgeBounds.maxX = Math.max(edgeBounds.maxX, currentBounds.maxX);
        edgeBounds.maxY = Math.max(edgeBounds.maxY, currentBounds.maxY);
        edgeBounds.maxZ = Math.max(edgeBounds.maxZ, currentBounds.maxZ);
      }

      if (edgeBounds) {
        return edgeBounds;
      }
    }

    return boundsFromBox(geometry?.getBoundingBox ? geometry.getBoundingBox() : null);
  };

  for (let index = 0; index < objects.count; index += 1) {
    const object = objects.get(index);
    const attributes = object.attributes();
    const layerName = layerNames.get(attributes.layerIndex);
    const objectName = String(attributes.name || "").trim();

    if (layerName !== "terrain") {
      continue;
    }

    const geometry = object.geometry();
    const geometryBounds = computeGeometryBounds(geometry);

    if (!geometryBounds) {
      continue;
    }
    const width = Number((geometryBounds.maxX - geometryBounds.minX).toFixed(3));
    const height = Number((geometryBounds.maxY - geometryBounds.minY).toFixed(3));
    const minZ = Number(geometryBounds.minZ.toFixed(3));
    const maxZ = Number(geometryBounds.maxZ.toFixed(3));

    terrainBands.push({
      name: objectName || `terrain_${index + 1}`,
      width,
      height,
      minZ,
      maxZ,
      fullFootprint: width >= clipWidth - 0.5 && height >= clipHeight - 0.5,
    });
  }

  terrainBands.sort((left, right) => left.minZ - right.minZ || left.maxZ - right.maxZ);

  let leadingFullFootprintBandCount = 0;

  for (const band of terrainBands) {
    if (!band.fullFootprint) {
      break;
    }

    leadingFullFootprintBandCount += 1;
  }

  const trailingFullFootprintBands = terrainBands
    .slice(leadingFullFootprintBandCount)
    .filter((band) => band.fullFootprint)
    .map((band) => ({
      name: band.name,
      minZ: band.minZ,
      maxZ: band.maxZ,
      width: band.width,
      height: band.height,
    }));

  return {
    bandCount: terrainBands.length,
    fullFootprintBandCount: terrainBands.filter((band) => band.fullFootprint).length,
    leadingFullFootprintBandCount,
    trailingFullFootprintBandCount: trailingFullFootprintBands.length,
    trailingFullFootprintBands,
  };
}

function summarizeTerrainBandPlan(exportSiteContext, terrainPlan) {
  const clipBounds = computeClipBounds(exportSiteContext);
  const bandGroups = terrainPlan?.bandGroups || [];

  if (!clipBounds || !Array.isArray(bandGroups) || !bandGroups.length) {
    return {
      bandCount: 0,
      fullFootprintBandCount: 0,
      leadingFullFootprintBandCount: 0,
      trailingFullFootprintBandCount: 0,
      trailingFullFootprintBands: [],
    };
  }

  const clipWidth = clipBounds.maxX - clipBounds.minX;
  const clipHeight = clipBounds.maxY - clipBounds.minY;
  const summarizedBands = bandGroups.map((group) => {
    const bounds = group?.bounds || null;
    const width = bounds ? Number((bounds.maxX - bounds.minX).toFixed(3)) : 0;
    const height = bounds ? Number((bounds.maxY - bounds.minY).toFixed(3)) : 0;

    return {
      bottomElevation: Number(Number(group?.bottomElevation || 0).toFixed(3)),
      topElevation: Number(Number(group?.topElevation || 0).toFixed(3)),
      width,
      height,
      fullFootprint: width >= clipWidth - 0.5 && height >= clipHeight - 0.5,
    };
  });

  let leadingFullFootprintBandCount = 0;

  for (const band of summarizedBands) {
    if (!band.fullFootprint) {
      break;
    }

    leadingFullFootprintBandCount += 1;
  }

  const trailingFullFootprintBands = summarizedBands
    .slice(leadingFullFootprintBandCount)
    .filter((band) => band.fullFootprint)
    .map((band) => ({
      bottomElevation: band.bottomElevation,
      topElevation: band.topElevation,
      width: band.width,
      height: band.height,
    }));

  return {
    bandCount: summarizedBands.length,
    fullFootprintBandCount: summarizedBands.filter((band) => band.fullFootprint).length,
    leadingFullFootprintBandCount,
    trailingFullFootprintBandCount: trailingFullFootprintBands.length,
    trailingFullFootprintBands,
  };
}

function summarizeSketchUpCurveHeights(skpPayload) {
  let curvePolylineCount = 0;
  let maxAbsZ = 0;

  for (const group of skpPayload?.groups || []) {
    for (const polyline of group?.polylines || []) {
      if (polyline?.curve !== true) {
        continue;
      }

      curvePolylineCount += 1;

      for (const point of polyline?.points || []) {
        if (Array.isArray(point) && Number.isFinite(point[2])) {
          maxAbsZ = Math.max(maxAbsZ, Math.abs(Number(point[2] || 0)));
        }
      }
    }
  }

  return {
    curvePolylineCount,
    maxAbsZ: Number(maxAbsZ.toFixed(6)),
  };
}

function collectFormatFailures(testCase, result) {
  const failures = [];
  const { expect } = testCase;

  for (const [format, formatResult] of Object.entries(result.formats)) {
    if (!(formatResult.effective > 0)) {
      failures.push(`${testCase.name}/${format}: effective contour interval is invalid`);
    }

    if (formatResult.effective > expect.maxEffective) {
      failures.push(
        `${testCase.name}/${format}: effective contour interval ${formatResult.effective} exceeds ${expect.maxEffective}`
      );
    }
  }

  if (result.formats["3dm"].bytes < expect.min3dmBytes) {
    failures.push(
      `${testCase.name}/3dm: bytes ${result.formats["3dm"].bytes} below ${expect.min3dmBytes}`
    );
  }

  if (result.formats["3dm"].curveCount <= 0) {
    failures.push(`${testCase.name}/3dm: no curve objects were found in the exported file`);
  }

  if (result.formats["3dm"].curveMaxAbsZ > 0.001) {
    failures.push(
      `${testCase.name}/3dm: curve max |z| ${result.formats["3dm"].curveMaxAbsZ} should stay at 0`
    );
  }

  if (result.formats["3dm"].terrainBasisMismatchLevels > 0) {
    failures.push(
      `${testCase.name}/3dm: export-vs-terrain-basis mismatch levels ` +
        `${result.formats["3dm"].terrainBasisMismatchLevels} should be 0`
    );
  }

  if (result.formats["3dm"].terrainBands.trailingFullFootprintBandCount > 0) {
    failures.push(
      `${testCase.name}/3dm: non-leading full-footprint terrain bands detected ` +
        result.formats["3dm"].terrainBands.trailingFullFootprintBands
          .map((band) => `${band.name}@${band.minZ}-${band.maxZ}`)
          .join(", ")
    );
  }

  if (result.formats["3dm"].terrainPlanBands.trailingFullFootprintBandCount > 0) {
    failures.push(
      `${testCase.name}/3dm-plan: non-leading full-footprint terrain plan bands detected ` +
        result.formats["3dm"].terrainPlanBands.trailingFullFootprintBands
          .map((band) => `${band.bottomElevation}-${band.topElevation}`)
          .join(", ")
    );
  }

  const buildingPlacement = result.formats["3dm"].buildingPlacement;

  if (Number(buildingPlacement?.sampleCount || 0) > 0) {
    if (Number(buildingPlacement?.unresolvedCount || 0) > 0) {
      failures.push(
        `${testCase.name}/3dm: unresolved building placement samples ` +
          `${buildingPlacement.unresolvedCount}/${buildingPlacement.sampleCount}`
      );
    }

    if (Number(buildingPlacement?.terrainBasisAvailableCount || 0) <= 0) {
      failures.push(
        `${testCase.name}/3dm: no sampled building placements resolved against the terrain basis`
      );
    }

    if (Number(buildingPlacement?.terrainBasisMismatchCount || 0) > 0) {
      failures.push(
        `${testCase.name}/3dm: building terrain-basis mismatches ` +
          `${buildingPlacement.terrainBasisMismatchCount}/${buildingPlacement.sampleCount}`
      );
    }

    if (Number(buildingPlacement?.terrainBasisMaxDelta || 0) > 0.001) {
      failures.push(
        `${testCase.name}/3dm: building terrain-basis max delta ` +
          `${buildingPlacement.terrainBasisMaxDelta} should stay at 0`
      );
    }
  }

  const roadPlacement = result.formats["3dm"].roadPlacement;

  if (
    Number(roadPlacement?.roadFeatureCount || 0) > 0 &&
    Number(roadPlacement?.footprintAreaSqm || 0) > 0.001
  ) {
    if (Number(roadPlacement?.groupCount || 0) <= 0) {
      failures.push(
        `${testCase.name}/3dm: road placement produced no terrain surface groups ` +
          `for ${roadPlacement.roadFeatureCount} road features`
      );
    }

    if (Number(roadPlacement?.coverageRatio || 0) <= 0) {
      failures.push(
        `${testCase.name}/3dm: road terrain coverage ratio ` +
          `${roadPlacement.coverageRatio} should be positive`
      );
    }
  }

  if (result.formats.skp.groups < expect.minSkpGroups) {
    failures.push(
      `${testCase.name}/skp: groups ${result.formats.skp.groups} below ${expect.minSkpGroups}`
    );
  }

  if (result.formats.obj.length < expect.minObjLength) {
    failures.push(
      `${testCase.name}/obj: length ${result.formats.obj.length} below ${expect.minObjLength}`
    );
  }

  if (FULL_SKP_EXPORT && result.formats.skp.bytes < 100_000) {
    failures.push(`${testCase.name}/skp: full export bytes ${result.formats.skp.bytes} look too small`);
  }

  if (FULL_SKP_EXPORT) {
    const firstSkpAttempt = result.formats.skp.attemptIntervals?.[0];

    if (!firstSkpAttempt || !(firstSkpAttempt.effective > 0)) {
      failures.push(`${testCase.name}/skp: missing first-attempt contour interval telemetry`);
    } else if (
      Math.abs(Number(firstSkpAttempt.effective || 0) - Number(result.formats.skp.effective || 0)) >
      0.001
    ) {
      failures.push(
        `${testCase.name}/skp: first attempt effective contour interval ${firstSkpAttempt.effective} diverged from prepared ${result.formats.skp.effective}`
      );
    }
  }

  if (result.formats.skp.curvePolylineMaxAbsZ > 0.001) {
    failures.push(
      `${testCase.name}/skp: curve polyline max |z| ${result.formats.skp.curvePolylineMaxAbsZ} should stay at 0`
    );
  }

  return failures;
}

async function verifyCase(testCase) {
  const siteContext = await loadCaseSiteContext(testCase);

  const threeDm = summarizeExportContext(siteContext, "3dm");
  const skp = summarizeExportContext(siteContext, "skp");
  const obj = summarizeExportContext(siteContext, "obj");

  const threeDmBytes = await build3dmFromSiteContext(threeDm.exportSiteContext);
  const skpPayload = buildSketchUpPayloadFromSiteContext(skp.exportSiteContext);
  const objText = buildObjFromSiteContext(obj.exportSiteContext);
  const threeDmCurveSummary = await summarize3dmCurveHeights(threeDmBytes);
  const threeDmTerrainBands = await summarize3dmTerrainBands(
    threeDmBytes,
    threeDm.exportSiteContext
  );
  const threeDmTerrainPlanBands = summarizeTerrainBandPlan(
    threeDm.exportSiteContext,
    threeDm.terrainPlan
  );
  const threeDmTerrainDiagnostics =
    threeDm.exportSiteContext?.stats?.terrainPipelineDiagnostics ||
    buildTerrainPipelineDiagnostics(threeDm.exportSiteContext) ||
    null;
  const threeDmPlacementDiagnostics = summarizePlacementDiagnostics(
    threeDm.exportSiteContext
  );
  const skpCurveSummary = summarizeSketchUpCurveHeights(skpPayload);
  const skpAttemptIntervals = [];
  const skpBytes = FULL_SKP_EXPORT
    ? (await buildSkpFromSiteContextWithRetry(
        skp.exportSiteContext,
        null,
        {
          onAttemptPrepared: (attemptSiteContext, meta = {}) => {
            skpAttemptIntervals.push({
              attempt: Number(meta.attemptIndex || 0),
              requested: Number(
                attemptSiteContext?.stats?.requestedContourInterval ||
                  attemptSiteContext?.options?.contourInterval ||
                  0
              ),
              effective: Number(
                attemptSiteContext?.stats?.effectiveContourBandInterval ||
                  attemptSiteContext?.options?.contourInterval ||
                  0
              ),
            });
          },
        }
      )).length
    : 0;

  const result = {
    name: testCase.name,
    stats: {
      parcelAreaSqm: siteContext?.stats?.parcelAreaSqm || 0,
      buildingCount: siteContext?.stats?.buildingCount || 0,
      contourFeatureCount: siteContext?.contourLines?.features?.length || 0,
    },
    formats: {
      "3dm": {
        requested: threeDm.requested,
        source: threeDm.source,
        effective: threeDm.effective,
        contourCount: threeDm.contourCount,
        bytes: threeDmBytes.length,
        curveCount: threeDmCurveSummary.curveCount,
        curveMaxAbsZ: threeDmCurveSummary.maxAbsZ,
        terrainBasisMismatchLevels: Number(
          threeDmTerrainDiagnostics?.curveTerrainAlignment?.mismatchLevelCount || 0
        ),
        buildingPlacement: threeDmPlacementDiagnostics.buildingPlacement,
        roadPlacement: threeDmPlacementDiagnostics.roadPlacement,
        terrainBands: threeDmTerrainBands,
        terrainPlanBands: threeDmTerrainPlanBands,
      },
      skp: {
        requested: skp.requested,
        source: skp.source,
        effective: skp.effective,
        contourCount: skp.contourCount,
        groups: skpPayload.groups?.length || 0,
        terrainStep: skp.exportSiteContext?.terrainGrid?.step || null,
        refinedTerrainGrid: skp.exportSiteContext?.stats?.skpTerrainGridRefined === true,
        curvePolylines: skpCurveSummary.curvePolylineCount,
        curvePolylineMaxAbsZ: skpCurveSummary.maxAbsZ,
        bytes: skpBytes,
        attemptIntervals: skpAttemptIntervals,
      },
      obj: {
        requested: obj.requested,
        source: obj.source,
        effective: obj.effective,
        contourCount: obj.contourCount,
        length: objText.length,
      },
    },
  };

  const failures = collectFormatFailures(testCase, result);
  return { result, failures };
}

async function runBaselineVerification() {
  const baseUrl = `http://127.0.0.1:${BASELINE_PORT}`;
  const previousPort = process.env.PORT;
  const previousBindHost = process.env.BIND_HOST;
  process.env.PORT = String(BASELINE_PORT);
  process.env.BIND_HOST = "127.0.0.1";
  const app = await createApp();
  const server = app?.server;
  const multiParcelSelection = [
    {
      type: "Feature",
      properties: {
        pnu: "1111010100100010000",
        addr: "테스트 필지 1",
      },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [126.978, 37.5664],
          [126.97818, 37.5664],
          [126.97818, 37.56655],
          [126.978, 37.56655],
          [126.978, 37.5664],
        ]],
      },
    },
    {
      type: "Feature",
      properties: {
        pnu: "1111010100100020000",
        addr: "테스트 필지 2",
      },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [126.9782, 37.5664],
          [126.97838, 37.5664],
          [126.97838, 37.56655],
          [126.9782, 37.56655],
          [126.9782, 37.5664],
        ]],
      },
    },
  ];
  const namedMultiParcelSelection = multiParcelSelection.map((feature, index) => ({
    ...feature,
    properties: {
      ...(feature.properties || {}),
      groupName: index === 0 ? "Parcel Cluster A" : "Parcel Cluster B",
      groupLabel: index === 0 ? "Parcel Cluster A" : "Parcel Cluster B",
      groupNameSource: "custom",
    },
  }));

  try {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const healthPayload = await readJson(healthResponse);
    assert.equal(healthResponse.status, 200, "Health endpoint should respond.");
    assert.equal(healthPayload.ok, true, "Health endpoint should return ok=true.");
    assert.deepEqual(
      Object.keys(healthPayload).sort(),
      ["ok", "timestamp", "uptimeSeconds"],
      "Health payload shape changed."
    );
    const runtimeStatsResponse = await fetch(`${baseUrl}/api/runtime-stats`);
    const runtimeStatsPayload = await readJson(runtimeStatsResponse);
    assert.equal(
      runtimeStatsResponse.status,
      200,
      "Runtime stats endpoint should respond for localhost callers."
    );
    assert.equal(
      runtimeStatsPayload.ok,
      true,
      "Runtime stats endpoint should return ok=true."
    );
    assert.deepEqual(
      Object.keys(runtimeStatsPayload).sort(),
      ["caches", "exportJobs", "ok", "snapshotAt", "telemetry", "uptimeSeconds"],
      "Runtime stats payload shape changed."
    );
    assert.deepEqual(
      Object.keys(runtimeStatsPayload.exportJobs || {}).sort(),
      ["active", "activeSearchRequests", "estimatedDurationMs", "queued"],
      "Runtime stats exportJobs payload shape changed."
    );
    assert.deepEqual(
      Object.keys(runtimeStatsPayload.caches || {}).sort(),
      [
        "buildingFloorEntries",
        "buildingRegisterEntries",
        "eumLandDetailsEntries",
        "eumLandPageEntries",
        "exportArtifactEntries",
        "geocodeEntries",
        "openMeteoEntries",
        "requestProgressEntries",
        "siteContextEntries",
      ],
      "Runtime stats caches payload shape changed."
    );
    assert.ok(
      Array.isArray(runtimeStatsPayload?.telemetry?.recentSlowApiRequests),
      "Runtime stats should expose a recent slow API request list."
    );
    assert.ok(
      Array.isArray(runtimeStatsPayload?.telemetry?.recentGeocodeEvents),
      "Runtime stats should expose a recent geocode event list."
    );
    assert.ok(
      Array.isArray(runtimeStatsPayload?.telemetry?.recentUpstreamEvents),
      "Runtime stats should expose a recent upstream event list."
    );

    const configResponse = await fetch(`${baseUrl}/api/config`);
    const configPayload = await readJson(configResponse);
    assert.equal(configResponse.status, 200, "Config endpoint should respond.");
    assert.equal(
      configPayload?.map?.provider,
      "openstreetmap",
      "Map provider should stay on openstreetmap."
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(
        configPayload?.futureSources || {},
        "hasBuildingHubKey"
      ),
      "Config should expose hasBuildingHubKey flag for the UI."
    );
    assert.deepEqual(
      Object.keys(configPayload?.data || {}).sort(),
      ["hasVWorldDataKey"],
      "Config data payload shape changed."
    );
    assert.deepEqual(
      Object.keys(configPayload?.features || {}).sort(),
      ["publicEnabledFeatures"],
      "Config feature-flag payload shape changed."
    );
    assert.ok(
      Array.isArray(configPayload?.features?.publicEnabledFeatures),
      "Config should expose the public enabled feature list."
    );
    assert.ok(
      configPayload?.features?.publicEnabledFeatures?.includes("contour3dmodel"),
      "Contour 3D model should stay publicly enabled by default."
    );
    assert.ok(
      !configPayload?.features?.publicEnabledFeatures?.includes("heritage-risk"),
      "Heritage-risk should stay out of the public enabled list by default."
    );
    const workspaceContourPath = path.join(process.cwd(), "data", "contours");
    const contourPathFallback = resolveTerrainContourPath(
      "C:\\Rhino_develop\\data\\contours"
    );
    assert.equal(
      path.resolve(contourPathFallback.path),
      path.resolve(workspaceContourPath),
      "Legacy contour path settings should fall back to the workspace contour dataset."
    );
    assert.equal(
      contourPathFallback.source,
      "workspace-fallback",
      "Legacy contour path settings should be labeled as a workspace fallback."
    );
    const unrelatedContourPath = resolveTerrainContourPath(
      "C:\\missing\\custom-terrain-source"
    );
    assert.equal(
      unrelatedContourPath.source,
      "configured-missing",
      "Unrelated missing contour paths should not silently fall back to the workspace dataset."
    );
    const syntheticTerrainGrid = {
      step: 6,
      xValues: Array.from({ length: 335 }, (_, index) => index * 6),
      yValues: Array.from({ length: 335 }, (_, index) => index * 6),
      elevations: Array.from({ length: 335 }, () => Array(335).fill(0)),
      minElevation: 0,
      maxElevation: 95,
    };
    const syntheticContourBudgetSiteContext = {
      location: { lat: 37.50746, lng: 126.84247 },
      options: {
        radius: 1000,
        contourInterval: 1,
        terrainMode: "contour",
        buildingPlacement: "default",
        includeContours: true,
        includeBuildings: true,
        includeParcelBoundary: true,
        includeRoads: true,
        exportFormat: "obj",
      },
      stats: {
        requestedContourInterval: 1,
        sourceContourInterval: 5,
      },
      dataSources: {
        contours: {
          provider: "official-contours",
          interval: 5,
        },
      },
      contourLines: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { elevation: 0 },
            geometry: {
              type: "LineString",
              coordinates: [
                [126.84, 37.50],
                [126.85, 37.51],
              ],
            },
          },
          {
            type: "Feature",
            properties: { elevation: 5 },
            geometry: {
              type: "LineString",
              coordinates: [
                [126.84, 37.505],
                [126.85, 37.515],
              ],
            },
          },
        ],
      },
      terrainGrid: syntheticTerrainGrid,
    };
    const syntheticThreeDmBudgetSiteContext = {
      ...syntheticContourBudgetSiteContext,
      options: {
        ...syntheticContourBudgetSiteContext.options,
        exportFormat: "3dm",
      },
      stats: {
        ...syntheticContourBudgetSiteContext.stats,
      },
    };
    assert.notEqual(
      buildSiteContextCacheKey(
        syntheticContourBudgetSiteContext.location,
        syntheticContourBudgetSiteContext.options
      ),
      buildSiteContextCacheKey(
        syntheticThreeDmBudgetSiteContext.location,
        syntheticThreeDmBudgetSiteContext.options
      ),
      "Site-context cache keys should separate export formats when contour budgets differ."
    );
    assert.equal(
      resolveEffectiveContourBandInterval(syntheticContourBudgetSiteContext),
      5,
      "OBJ-sized contour budget should relax the wide synthetic case to 5m."
    );
    assert.equal(
      resolveEffectiveContourBandInterval(syntheticThreeDmBudgetSiteContext),
      2,
      "3DM-sized contour budget should preserve more detail for the same wide synthetic case."
    );
    const boundedCacheStore = new Map([
      [
        "expired",
        {
          cachedAt: 10,
          lastAccessedAt: 10,
          expiresAt: 20,
          value: "expired",
        },
      ],
      [
        "older",
        {
          cachedAt: 30,
          lastAccessedAt: 30,
          value: "older",
        },
      ],
      [
        "recent",
        {
          cachedAt: 40,
          lastAccessedAt: 90,
          value: "recent",
        },
      ],
      [
        "newest",
        {
          cachedAt: 50,
          lastAccessedAt: 120,
          value: "newest",
        },
      ],
    ]);
    pruneCacheEntries(boundedCacheStore, {
      now: 100,
      maxEntries: 2,
      isExpired: (entry, timestamp) => Number(entry?.expiresAt || Infinity) <= timestamp,
    });
    assert.deepEqual(
      [...boundedCacheStore.keys()],
      ["recent", "newest"],
      "Bounded cache pruning should drop expired entries first and then evict the stalest survivors."
    );
    assert.equal(
      buildParcelDataCacheKey({ pnu: "1111010100100010000" }, "eum-land-page"),
      "eum-land-page:1111010100100010000",
      "Parcel data cache keys should be scoped by the parcel PNU."
    );
    assert.equal(
      isInternalOnlyStaticPath("/contour3dmodel", {
        publicEnabledFeatures: ["contour3dmodel"],
        internalOnlyStaticPaths: ["/contour3dmodel"],
      }),
      false,
      "Public feature routes should stay open even when a stale internal-only path overlap remains."
    );
    assert.equal(
      isInternalOnlyStaticPath("/heritage-risk", {
        publicEnabledFeatures: ["contour3dmodel"],
        internalOnlyStaticPaths: ["/heritage-risk"],
      }),
      true,
      "Unreleased feature routes should stay blocked when they are not included in the public feature list."
    );
    const responseCacheStore = new Map();
    const responseCacheInFlight = new Map();
    let responseCacheLoaderCalls = 0;
    const loadCachedParcelValue = () =>
      readOrLoadResponseCache(
        responseCacheStore,
        responseCacheInFlight,
        "eum-land-page:1111010100100010000",
        async () => {
          responseCacheLoaderCalls += 1;
          await delay(20);
          return {
            calls: responseCacheLoaderCalls,
            generatedAt: "test",
          };
        },
        {
          ttlMs: 1000,
          maxEntries: 4,
        }
      );
    const [cachedParcelValueA, cachedParcelValueB] = await Promise.all([
      loadCachedParcelValue(),
      loadCachedParcelValue(),
    ]);
    assert.equal(
      responseCacheLoaderCalls,
      1,
      "Concurrent property-data cache lookups should share a single in-flight loader."
    );
    assert.deepEqual(
      cachedParcelValueA,
      cachedParcelValueB,
      "Concurrent property-data cache lookups should resolve to the same payload."
    );
    const cachedParcelValueC = await loadCachedParcelValue();
    assert.equal(
      responseCacheLoaderCalls,
      1,
      "Fresh property-data cache hits should not re-run the loader."
    );
    assert.deepEqual(
      cachedParcelValueC,
      cachedParcelValueA,
      "Fresh property-data cache hits should return the cached payload."
    );
    assert.equal(
      responseCacheInFlight.size,
      0,
      "Property-data cache should clear in-flight promises once the loader resolves."
    );
    const providerTimeoutEnvKeys = [
      "VWORLD_FETCH_TIMEOUT_MS",
      "JUSO_FETCH_TIMEOUT_MS",
      "EUM_FETCH_TIMEOUT_MS",
    ];
    const previousProviderTimeoutEnv = Object.fromEntries(
      providerTimeoutEnvKeys.map((key) => [key, process.env[key]])
    );

    for (const key of providerTimeoutEnvKeys) {
      delete process.env[key];
    }

    const localProviderTimeouts = buildProviderTimeoutConfig({
      VWORLD_FETCH_TIMEOUT_MS: 21000,
      JUSO_FETCH_TIMEOUT_MS: 19000,
    });
    assert.equal(
      localProviderTimeouts.vworld,
      21000,
      "Provider timeout config should honor local VWorld overrides."
    );
    assert.equal(
      localProviderTimeouts.juso,
      19000,
      "Provider timeout config should honor local Juso overrides."
    );
    assert.equal(
      localProviderTimeouts.eum,
      25000,
      "Provider timeout config should keep the default EUM timeout when no override is supplied."
    );

    process.env.VWORLD_FETCH_TIMEOUT_MS = "24000";
    process.env.EUM_FETCH_TIMEOUT_MS = "28000";
    const envProviderTimeouts = buildProviderTimeoutConfig({
      VWORLD_FETCH_TIMEOUT_MS: 21000,
      EUM_FETCH_TIMEOUT_MS: 26000,
    });
    assert.equal(
      envProviderTimeouts.vworld,
      24000,
      "Provider timeout config should prefer environment overrides over local config."
    );
    assert.equal(
      envProviderTimeouts.eum,
      28000,
      "Provider timeout config should read the environment override for EUM timeout values."
    );

    for (const [key, value] of Object.entries(previousProviderTimeoutEnv)) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }

    assert.deepEqual(
      buildVWorldDomainCandidates({
        vworldApiDomain: "https://spaceswork.net",
        port: 3012,
      }),
      ["https://spaceswork.net", "http://localhost:3012"],
      "VWorld requests should keep the configured domain first but also retain localhost as a fallback candidate."
    );
    const appSource = await readFile(
      path.join(process.cwd(), "public", "app.js"),
      "utf8"
    );
    assert.match(
      appSource,
      /function buildParcelLookupRequestPayload\s*\(/,
      "Frontend should centralize parcel lookup payload building."
    );
    assert.doesNotMatch(
      appSource,
      /async function loadBuildingRegisterCore[\s\S]*?siteContext[\s\S]*?async function printBuildingRegister/s,
      "Building-register requests should not post the full siteContext payload."
    );
    assert.doesNotMatch(
      appSource,
      /async function loadLandInfo[\s\S]*?siteContext[\s\S]*?async function ensureLandInfoLoaded/s,
      "Land-info requests should not post the full siteContext payload."
    );
    assert.doesNotMatch(
      appSource,
      /async function loadLandInfoDetails[\s\S]*?siteContext[\s\S]*?async function ensureLandInfoDetailsLoaded/s,
      "Land-info detail requests should not post the full siteContext payload."
    );
    assert.match(
      appSource,
      /const REQUEST_UI_PHASE_MESSAGES = Object\.freeze\(/,
      "Frontend should define request-phase copy for slow or delayed upstream states."
    );
    assert.match(
      appSource,
      /function beginRequestUiFeedback\s*\(/,
      "Frontend should manage request-phase UI feedback for long-running panel requests."
    );
    assert.match(
      appSource,
      /siteContextStatusChip|landInfoStatusChip|buildingRegisterStatusChip/,
      "Frontend should expose visible status chips for key panel requests."
    );
    assert.match(
      appSource,
      /window\.__SPACEWORK_UI_TEST__/,
      "Frontend should expose the localhost-only UI verification hook for extended browser checks."
    );

    const hubResponse = await fetch(`${baseUrl}/`);
    const hubHtml = await hubResponse.text();
    assert.equal(hubResponse.status, 200, "Main route should respond.");
    assert.match(hubHtml, /Spaceswork/, "Main page title/content should exist.");
    assert.match(
      hubHtml,
      /\/contour3dmodel/,
      "Main page should link to the feature route."
    );
    assert.match(
      hubHtml,
      /문화재 발굴 위험도 검토/,
      "Main page should still introduce the heritage-risk feature."
    );
    assert.match(
      hubHtml,
      /법규 기반 최대 매스 검토/,
      "Main page should still introduce the max-mass feature."
    );
    assert.doesNotMatch(
      hubHtml,
      /\/heritage-risk/,
      "Main page should not publicly expose the heritage-risk route before release."
    );
    assert.doesNotMatch(
      hubHtml,
      /\/max-mass/,
      "Main page should not publicly expose the max-mass route before release."
    );
    const hubCsp = hubResponse.headers.get("content-security-policy");
    assert.ok(hubCsp, "Hub page should send a CSP header.");
    assert.equal(
      hubResponse.headers.get("x-content-type-options"),
      "nosniff",
      "Hub page should send nosniff header."
    );
    assert.doesNotMatch(
      String(hubCsp),
      /style-src[^;]*'unsafe-inline'/,
      "Hub page should not allow inline styles in the default CSP."
    );
    assertDefaultCspShape(hubCsp, "Hub page CSP");
    assert.match(
      String(hubCsp),
      /frame-ancestors[^;]*ads\.google\.com/i,
      "Hub page CSP should allow Google ad preview ancestors on approved pages."
    );
    assert.notEqual(
      hubResponse.headers.get("x-frame-options"),
      "DENY",
      "Hub page should not hard-block iframe embedding when ad preview is enabled."
    );
    assert.equal(
      isPathInsideDirectory(
        path.join(process.cwd(), "public"),
        path.join(process.cwd(), "public-baseline-escape", "probe.txt")
      ),
      false,
      "Static path guard should reject sibling paths that only share the public prefix."
    );
    const timeoutProbe = await createTimeoutProbeServer();

    try {
      const fastProbeResponse = await fetchWithTimeout(
        `${timeoutProbe.baseUrl}/fast`,
        {},
        {
          requestLabel: "Fast timeout probe",
          timeoutMs: 200,
        }
      );
      assert.equal(
        fastProbeResponse.status,
        200,
        "Outbound fetch helper should allow fast responses."
      );
      await assert.rejects(
        () =>
          fetchWithTimeout(`${timeoutProbe.baseUrl}/slow`, {}, {
            requestLabel: "Slow timeout probe",
            timeoutMs: 50,
          }),
        /timed out after/i,
        "Outbound fetch helper should abort slow upstream responses."
      );
      const normalizedTimeoutError = normalizePublicError(
        new Error("Open-Meteo elevation request timed out after 15s.")
      );
      assert.equal(
        normalizedTimeoutError.statusCode,
        504,
        "Public error normalization should map upstream timeouts to 504."
      );
      assert.match(
        normalizedTimeoutError.message,
        /외부 연계 서비스 응답이 지연/,
        "Public error normalization should provide a user-safe timeout message."
      );
      const normalizedProviderError = normalizePublicError(
        new Error("VWorld data request failed with 503")
      );
      assert.equal(
        normalizedProviderError.statusCode,
        502,
        "Public error normalization should map upstream provider failures to 502."
      );
    } finally {
      await new Promise((resolve) => {
        timeoutProbe.server.close(resolve);
      });
    }

    const featureResponse = await fetch(`${baseUrl}/contour3dmodel`);
    const featureHtml = await featureResponse.text();
    assert.equal(featureResponse.status, 200, "Feature route should respond.");
    assert.match(featureHtml, /대지·건물 3D 검토/, "Feature page heading should remain visible.");
    assert.match(featureHtml, /토지 정보/, "Land-info CTA should remain visible.");
    assert.match(featureHtml, /건축물 정보/, "Building-info CTA should remain visible.");
    assert.match(featureHtml, /대지 경계/, "Parcel boundary option should remain visible.");
    assert.match(featureHtml, /모델 미리보기/, "Preview CTA should remain visible.");
    if (false) {
    assert.match(
      featureHtml,
      /대지·건물 3D 검토/,
      "Feature page heading should remain visible."
    );
    assert.match(featureHtml, /토지이음 열기/, "Land-use CTA should remain visible.");
    assert.match(featureHtml, /세움터 열기/, "Building register CTA should remain visible.");
    assert.match(featureHtml, /필지 그룹 분리/, "Split parcel option should remain visible.");
    assert.match(featureHtml, /모델 미리보기/, "Preview CTA should remain visible.");

    }
    assert.doesNotMatch(
      featureHtml,
      /unpkg\.com/i,
      "Feature page should no longer reference unpkg-hosted frontend assets."
    );
    assert.doesNotMatch(
      featureHtml,
      /pagead2\.googlesyndication\.com|googlesyndication|googleads\.g\.doubleclick\.net/i,
      "Feature page should not load paused ad network snippets."
    );
    assert.match(
      featureHtml,
      /\/vendor\/leaflet\/leaflet\.css\?v=20260326-security4/,
      "Feature page should reference the self-hosted Leaflet stylesheet."
    );
    assert.match(
      featureHtml,
      /\/vendor\/leaflet\/leaflet\.js\?v=20260326-security4/,
      "Feature page should reference the self-hosted Leaflet script."
    );

    const handoffResponse = await fetch(
      `${baseUrl}/handoff/eum?pnu=1111010100100010000&sggcd=11110&p_location=test`
    );
    const handoffCsp = handoffResponse.headers.get("content-security-policy");
    assert.equal(
      handoffResponse.status,
      200,
      "Handoff route should respond for CSP verification."
    );
    assert.doesNotMatch(
      String(handoffCsp || ""),
      /style-src[^;]*'unsafe-inline'/,
      "Handoff route should no longer require inline style allowance."
    );
    assertDefaultCspShape(handoffCsp, "Handoff CSP");
    assert.match(
      String(handoffCsp || ""),
      /frame-ancestors 'none'/,
      "Handoff route CSP should still deny third-party framing."
    );
    assert.equal(
      handoffResponse.headers.get("x-frame-options"),
      "DENY",
      "Non-preview routes should continue sending X-Frame-Options: DENY."
    );
    const popupStylesResponse = await fetch(`${baseUrl}/popup.css`);
    assert.equal(
      popupStylesResponse.status,
      200,
      "Popup stylesheet should be served for popup and print windows."
    );
    const handoffStylesResponse = await fetch(`${baseUrl}/handoff.css`);
    assert.equal(
      handoffStylesResponse.status,
      200,
      "Handoff stylesheet should be served for the handoff routes."
    );
    const handoffScriptResponse = await fetch(`${baseUrl}/handoff-auto-submit.js`);
    assert.equal(
      handoffScriptResponse.status,
      200,
      "Handoff auto-submit script should be served for the handoff routes."
    );
    const leafletStylesResponse = await fetch(`${baseUrl}/vendor/leaflet/leaflet.css`);
    assert.equal(
      leafletStylesResponse.status,
      200,
      "Self-hosted Leaflet stylesheet should be served."
    );
    const leafletScriptResponse = await fetch(`${baseUrl}/vendor/leaflet/leaflet.js`);
    assert.equal(
      leafletScriptResponse.status,
      200,
      "Self-hosted Leaflet script should be served."
    );
    const robotsResponse = await fetch(`${baseUrl}/robots.txt`);
    const robotsText = await robotsResponse.text();
    assert.equal(
      robotsResponse.status,
      200,
      "robots.txt should be served for crawler-based verification."
    );
    assert.match(
      robotsText,
      /Mediapartners-Google/i,
      "robots.txt should explicitly allow the Google publisher crawler."
    );
    const leafletMarkerResponse = await fetch(`${baseUrl}/vendor/leaflet/images/marker-icon.png`);
    assert.equal(
      leafletMarkerResponse.status,
      200,
      "Self-hosted Leaflet marker assets should be served."
    );

    const heritageResponse = await fetch(`${baseUrl}/heritage-risk`);
    const heritageHtml = await heritageResponse.text();
    assert.equal(
      heritageResponse.status,
      200,
      "Heritage route should stay available from localhost for internal review."
    );
    assert.match(
      heritageHtml,
      /data-page="heritage-risk"/,
      "Heritage route should render the placeholder page."
    );
    assert.match(
      heritageHtml,
      /\/contour3dmodel/,
      "Heritage page should link back to the live feature page."
    );

    const maxMassResponse = await fetch(`${baseUrl}/max-mass`);
    const maxMassHtml = await maxMassResponse.text();
    assert.equal(
      maxMassResponse.status,
      200,
      "Max-mass route should stay available from localhost for internal review."
    );
    assert.match(
      maxMassHtml,
      /data-page="max-mass"/,
      "Max-mass route should render the placeholder page."
    );
    assert.match(
      maxMassHtml,
      /\/contour3dmodel/,
      "Max-mass page should link back to the live feature page."
    );

    const invalidTokenResponse = await fetch(
      `${baseUrl}/api/request-progress?token=bad token`
    );
    assert.equal(invalidTokenResponse.status, 400, "Invalid progress token should be rejected.");

    const missingTokenResponse = await fetch(
      `${baseUrl}/api/request-progress?token=progress-does-not-exist`
    );
    assert.equal(
      missingTokenResponse.status,
      200,
      "Unknown progress token should resolve to an idle progress state."
    );
    const missingTokenPayload = await missingTokenResponse.json();
    assert.equal(
      missingTokenPayload?.state,
      "idle",
      "Unknown progress token should report idle state."
    );

    const modelSpecResponse = await fetch(`${baseUrl}/api/model-spec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: { lat: 37.5665, lng: 126.978 },
        options: { exportFormat: "dxf" },
        siteContext: {
          stats: {
            buildingCount: 0,
          },
        },
      }),
    });
    const modelSpecPayload = await readJson(modelSpecResponse);
    assert.equal(modelSpecResponse.status, 200, "Model spec endpoint should respond.");
    assert.ok(
      Array.isArray(modelSpecPayload.exportTargets) &&
        modelSpecPayload.exportTargets.includes("dxf"),
      "Model spec should continue listing DXF export."
    );

    const oversizedResponse = await fetch(`${baseUrl}/api/model-spec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        siteContext: "x".repeat(1_100_000),
      }),
    });
    assert.equal(oversizedResponse.status, 413, "Oversized JSON body should be rejected.");

    const oversizedPayload = await readJson(oversizedResponse);
    assert.match(
      String(oversizedPayload.error || ""),
      /허용됩니다/,
      "Oversized JSON should explain the limit."
    );

    const radiusResponse = await fetch(`${baseUrl}/api/site-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: { lat: 37.5665, lng: 126.978 },
        options: { radius: 5000 },
      }),
    });
    assert.equal(
      radiusResponse.status,
      400,
      "Out-of-range radius should be rejected before live data loading."
    );

    const radiusPayload = await readJson(radiusResponse);
    assert.match(
      String(radiusPayload.error || ""),
      /반경/,
      "Radius rejection should mention radius."
    );

    const multiParcelResponse = await fetch(`${baseUrl}/api/site-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: {
          lat: 37.56647,
          lng: 126.97819,
          selectionMode: "multi-parcel",
          selectedParcels: multiParcelSelection,
        },
        selectedParcels: multiParcelSelection,
        options: {
          radius: 80,
          includeBuildings: false,
        },
        previewOnly: true,
      }),
    });
    const multiParcelPayload = await readJson(multiParcelResponse);
    assert.equal(multiParcelResponse.status, 200, "Multi-parcel preview should respond.");
    assert.equal(
      multiParcelPayload.selectionMode,
      "multi-parcel",
      "Multi-parcel preview should preserve selection mode."
    );
    assert.equal(
      multiParcelPayload?.targetParcelGroups?.features?.length,
      2,
      "Multi-parcel preview should return the selected parcel groups."
    );
    assert.equal(
      Number(multiParcelPayload?.stats?.targetParcelCount || 0),
      2,
      "Multi-parcel preview should report the selected parcel count."
    );

    const namedMultiParcelResponse = await fetch(`${baseUrl}/api/site-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: {
          lat: 37.56647,
          lng: 126.97819,
          selectionMode: "multi-parcel",
          selectedParcels: namedMultiParcelSelection,
        },
        selectedParcels: namedMultiParcelSelection,
        options: {
          radius: 80,
          includeBuildings: false,
        },
        previewOnly: true,
      }),
    });
    const namedMultiParcelPayload = await readJson(namedMultiParcelResponse);
    assert.equal(
      namedMultiParcelResponse.status,
      200,
      "Named multi-parcel preview should respond."
    );
    assert.deepEqual(
      (namedMultiParcelPayload?.targetParcelGroups?.features || []).map(
        (feature) => feature?.properties?.groupName
      ),
      ["Parcel Cluster A", "Parcel Cluster B"],
      "Custom parcel group names should survive preview/export preparation in order."
    );

    const manualRangeClipBoundary = buildClipBoundary(
      { lat: 37.567664, lng: 126.965384 },
      { radius: 80 },
      null,
      {
        minLat: 37.56715,
        maxLat: 37.56815,
        minLng: 126.96475,
        maxLng: 126.96605,
      }
    );
    assert.equal(
      manualRangeClipBoundary?.geometry?.type,
      "Polygon",
      "Manual range clip boundary should stay polygonal."
    );
    assert.ok(
      Number.isFinite(manualRangeClipBoundary?.geometry?.coordinates?.[0]?.[0]?.[0]),
      "Manual range clip boundary should contain numeric lng/lat points."
    );
    assert.equal(
      manualRangeClipBoundary?.geometry?.coordinates?.[0]?.length,
      5,
      "Manual range clip boundary should preserve the rectangle ring."
    );
    const oversizedManualRangeResponse = await fetch(`${baseUrl}/api/site-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: {
          lat: 37.567664,
          lng: 126.965384,
          selectionMode: "range",
          customBounds: {
            minLat: 37.558664,
            maxLat: 37.576664,
            minLng: 126.951384,
            maxLng: 126.979384,
          },
        },
        customBounds: {
          minLat: 37.558664,
          maxLat: 37.576664,
          minLng: 126.951384,
          maxLng: 126.979384,
        },
        options: {
          radius: 1000,
          includeBuildings: false,
        },
      }),
    });
    assert.equal(
      oversizedManualRangeResponse.status,
      400,
      "Oversized manual range requests should be rejected before live data loading."
    );
    const oversizedManualRangePayload = await readJson(oversizedManualRangeResponse);
    assert.match(
      String(oversizedManualRangePayload.error || ""),
      /吏곸젒 吏??踰붿쐞|가로|세로/,
      "Manual range rejection should mention the direct range size limit."
    );

    const mergedRoadSurfaces = buildRoadSurfaceFeatureCollection(
      [
        {
          type: "Feature",
          properties: { sourceLayer: "raw-road-a" },
          geometry: {
            type: "Polygon",
            coordinates: [[
              [126.9780, 37.56640],
              [126.9782, 37.56640],
              [126.9782, 37.56652],
              [126.9780, 37.56652],
              [126.9780, 37.56640],
            ]],
          },
        },
        {
          type: "Feature",
          properties: { sourceLayer: "raw-road-b" },
          geometry: {
            type: "Polygon",
            coordinates: [[
              [126.978205, 37.56640],
              [126.978405, 37.56640],
              [126.978405, 37.56652],
              [126.978205, 37.56652],
              [126.978205, 37.56640],
            ]],
          },
        },
      ],
      { lat: 37.56646, lng: 126.97820 }
    );
    assert.equal(
      mergedRoadSurfaces?.features?.length,
      1,
      "Adjacent road polygons should be merged into one preview surface."
    );
    const roadSurfaceWithHole = buildRoadSurfaceFeatureCollection(
      [
        {
          type: "Feature",
          properties: { sourceLayer: "raw-road-hole" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [126.98020, 37.56700],
                [126.98060, 37.56700],
                [126.98060, 37.56740],
                [126.98020, 37.56740],
                [126.98020, 37.56700],
              ],
              [
                [126.98032, 37.56712],
                [126.98048, 37.56712],
                [126.98048, 37.56728],
                [126.98032, 37.56728],
                [126.98032, 37.56712],
              ],
            ],
          },
        },
      ],
      { lat: 37.56720, lng: 126.98040 }
    );
    assert.equal(
      roadSurfaceWithHole?.features?.length,
      1,
      "Derived road preview should keep single polygon road surfaces intact."
    );
    assert.equal(
      roadSurfaceWithHole?.features?.[0]?.geometry?.coordinates?.length,
      2,
      "Derived road preview should preserve source polygon holes instead of filling them in."
    );
    const preferredLineRoadCandidate = selectPreferredRoadContextCandidate(
      [
        {
          layer: "lt_c_upisuq151",
          geometryType: "polygon",
          result: { collection: { features: [{}] } },
          summary: {
            surfaceCoverageRatioToClip: 0.6527,
            largestSurfaceAreaSqm: 25979.151,
          },
        },
        {
          layer: "lt_l_moctlink",
          geometryType: "line",
          result: { collection: { features: [{}] } },
          summary: {
            surfaceCoverageRatioToClip: 0.0851,
            largestSurfaceAreaSqm: 1222.512,
          },
        },
      ],
      40000.48
    );
    assert.equal(
      preferredLineRoadCandidate?.layer,
      "lt_l_moctlink",
      "Broad polygon road candidates should yield to tighter line candidates in dense urban cases."
    );
    const preferredPolygonRoadCandidate = selectPreferredRoadContextCandidate(
      [
        {
          layer: "lt_c_upisuq151",
          geometryType: "polygon",
          result: { collection: { features: [{}] } },
          summary: {
            surfaceCoverageRatioToClip: 0.0704,
            largestSurfaceAreaSqm: 1999.065,
          },
        },
        {
          layer: "lt_l_moctlink",
          geometryType: "line",
          result: { collection: { features: [{}] } },
          summary: {
            surfaceCoverageRatioToClip: 0.029,
            largestSurfaceAreaSqm: 698.295,
          },
        },
      ],
      40000.48
    );
    assert.equal(
      preferredPolygonRoadCandidate?.layer,
      "lt_c_upisuq151",
      "Normal polygon road candidates should stay selected when their coverage is already bounded."
    );

    const rankedRoadResults = normalizeSearchResultsForQuery(
      [
        {
          id: "wrong-road-candidate",
          label: "강원특별자치도 강릉시 강동면 모전리 110-10",
          roadAddress: "",
          parcelAddress: "강원특별자치도 강릉시 강동면 모전리 110-10",
          lat: 37.71715,
          lng: 128.98031,
          provider: "vworld",
          searchType: "parcel",
        },
        {
          id: "city-hall",
          label: "서울특별시 중구 세종대로 110",
          roadAddress: "서울특별시 중구 세종대로 110",
          parcelAddress: "서울특별시 중구 태평로1가 31",
          lat: 37.5662952,
          lng: 126.9779451,
          provider: "juso+vworld",
          searchType: "road",
          pnu: "1114010100100310000",
          juso: {
            admCd: "1114010100",
            mtYn: "0",
            lnbrMnnm: "0031",
            lnbrSlno: "0000",
          },
        },
      ],
      "서울 중구 세종대로 110"
    );
    assert.equal(
      rankedRoadResults?.[0]?.roadAddress,
      "서울특별시 중구 세종대로 110",
      "Road-address ranking should keep the Seoul match ahead of unrelated parcel hits."
    );

    const rankedParcelResults = normalizeSearchResultsForQuery(
      [
        {
          id: "wrong-parcel-candidate",
          label: "강원특별자치도 강릉시 강동면 모전리 산 18-1",
          roadAddress: "",
          parcelAddress: "강원특별자치도 강릉시 강동면 모전리 산 18-1",
          lat: 37.7145604,
          lng: 128.991841,
          provider: "vworld",
          searchType: "parcel",
        },
        {
          id: "seoul-parcel",
          label: "서울특별시 종로구 관훈동 18-1",
          roadAddress: "",
          parcelAddress: "서울특별시 종로구 관훈동 18-1",
          lat: 37.574,
          lng: 126.984,
          provider: "vworld-data",
          searchType: "parcel",
          pnu: "1111013700100180001",
        },
      ],
      "서울 종로구 관훈동 18-1"
    );
    assert.equal(
      rankedParcelResults?.[0]?.parcelAddress,
      "서울특별시 종로구 관훈동 18-1",
      "Parcel-address ranking should favor the matching Seoul parcel over distant lookalikes."
    );

    const rankedExactParcelResults = normalizeSearchResultsForQuery(
      [
        {
          id: "wrong-pnu-priority",
          label: "서울특별시 종로구 교남동 53-2",
          roadAddress: "",
          parcelAddress: "서울특별시 종로구 교남동 53-2",
          lat: 37.569,
          lng: 126.968,
          provider: "vworld-data",
          searchType: "parcel",
          pnu: "1111017600100530002",
        },
        {
          id: "exact-without-pnu",
          label: "서울특별시 종로구 교남동 18-1",
          roadAddress: "",
          parcelAddress: "서울특별시 종로구 교남동 18-1",
          lat: 37.567703,
          lng: 126.965239,
          provider: "vworld",
          searchType: "parcel",
          pnu: "",
        },
      ],
      "서울 종로구 교남동 18-1"
    );
    assert.equal(
      rankedExactParcelResults?.[0]?.parcelAddress,
      "서울특별시 종로구 교남동 18-1",
      "Exact parcel text matches should outrank nearby PNU-backed alternatives."
    );

    const fastRoadHints = {
      normalizedQuery: "서울서초구서초대로411",
      parcelReference: null,
      mainNumber: "",
      subNumber: "",
      mtYn: "0",
      roadAddressQuery: true,
      areaQuery: "",
      normalizedAreaQuery: "",
      textTokens: ["서울", "서초구", "서초대로", "411"],
      areaTokens: ["서울", "서초구", "서초대로"],
    };
    const roadQueryThatMustNotLookLikeParcel = "\uC11C\uC6B8 \uB9C8\uD3EC\uAD6C \uC6D4\uB4DC\uCEF5\uBD81\uB85C 396";
    const roadOnlyHints = buildSearchQueryHints(roadQueryThatMustNotLookLikeParcel);
    assert.equal(
      roadOnlyHints.roadAddressQuery,
      true,
      "Road-address queries with trailing building numbers should still be recognized as road searches."
    );
    assert.equal(
      roadOnlyHints.parcelReference,
      null,
      "Road-address queries should not be misclassified as parcel references."
    );
    assert.deepEqual(
      resolveVWorldSearchCategories(roadOnlyHints),
      ["road"],
      "Road-address queries should stay on the road VWorld search path."
    );
    const fastRoadCandidates = [
      {
        id: "fast-1",
        label: "서울 서초구 서초대로 411",
        roadAddress: "서울 서초구 서초대로 411",
        parcelAddress: "서울 서초구 서초동 1321-15",
        provider: "juso",
        searchType: "road",
        pnu: "1165010800113210015",
        lat: 37.49662,
        lng: 127.02412,
        juso: {
          admCd: "1165010800",
          rnMgtSn: "116503121001",
          roadAddr: "서울 서초구 서초대로 411",
          roadAddrPart1: "서울 서초구 서초대로 411",
          jibunAddr: "서울 서초구 서초동 1321-15",
          mtYn: "0",
          lnbrMnnm: "1321",
          lnbrSlno: "15",
          buldMnnm: "00411",
          buldSlno: "00000",
        },
      },
      {
        id: "fast-2",
        label: "서울 서초구 서초대로 413",
        roadAddress: "서울 서초구 서초대로 413",
        parcelAddress: "서울 서초구 서초동 1321-16",
        provider: "juso",
        searchType: "road",
        pnu: "1165010800113210016",
        lat: 37.49668,
        lng: 127.0242,
      },
    ];
    const rawJusoFastRoadCandidates = fastRoadCandidates.map(({ lat, lng, ...item }) => item);
    const selectedRawJusoFastRoadCandidates = selectStrongJusoFastPathCandidates(
      "\uC11C\uC6B8 \uC11C\uCD08\uAD6C \uC11C\uCD08\uB300\uB85C 411",
      fastRoadHints,
      rawJusoFastRoadCandidates
    );
    assert.equal(
      selectedRawJusoFastRoadCandidates.length,
      1,
      "Strong Juso fast-path ranking should work even before raw Juso candidates are geocoded."
    );
    const selectedFastRoadCandidates = selectStrongJusoFastPathCandidates(
      "서울 서초구 서초대로 411",
      fastRoadHints,
      fastRoadCandidates
    );
    assert.equal(
      selectedFastRoadCandidates.length,
      1,
      "Strong exact road queries should short-circuit to the best Juso candidate."
    );
    assert.equal(
      selectedFastRoadCandidates[0]?.roadAddress,
      "서울 서초구 서초대로 411",
      "The strongest exact road address should be selected for the Juso fast path."
    );

    const selectedShortCircuitRoadCandidate = selectShortCircuitJusoCandidate(
      "?쒖슱 ?쒖큹援??쒖큹?濡?411",
      fastRoadHints,
      fastRoadCandidates
    );
    assert.equal(
      selectedShortCircuitRoadCandidate?.roadAddress,
      fastRoadCandidates[0].roadAddress,
      "Exact road-address matches should short-circuit to the strongest Juso result even when multiple candidates exist."
    );

    const matchedSharedVworldRoadResult = selectGeocodedVWorldResultForJusoCandidate(
      [
        {
          id: "vworld-fast-1",
          label: fastRoadCandidates[0].label,
          roadAddress: fastRoadCandidates[0].roadAddress,
          parcelAddress: fastRoadCandidates[0].parcelAddress,
          provider: "vworld",
          searchType: "road",
          lat: 37.49662,
          lng: 127.02412,
        },
        {
          id: "vworld-fast-2",
          label: fastRoadCandidates[1].label,
          roadAddress: fastRoadCandidates[1].roadAddress,
          parcelAddress: fastRoadCandidates[1].parcelAddress,
          provider: "vworld",
          searchType: "road",
          lat: 37.49668,
          lng: 127.0242,
        },
      ],
      fastRoadCandidates[0],
      fastRoadHints
    );
    assert.equal(
      matchedSharedVworldRoadResult?.roadAddress,
      fastRoadCandidates[0].roadAddress,
      "Shared VWorld road results should reuse the strongest exact match instead of re-querying."
    );

    const syntheticContourSiteContext = {
      location: { lat: 37.56647, lng: 126.97819 },
      clipBoundary: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[
            [126.978, 37.56638],
            [126.97842, 37.56638],
            [126.97842, 37.56672],
            [126.978, 37.56672],
            [126.978, 37.56638],
          ]],
        },
      },
      contourLines: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { provider: "official-contours", elevation: 10 },
            geometry: {
              type: "LineString",
              coordinates: [
                [126.97802, 37.56643],
                [126.9784, 37.56643],
              ],
            },
          },
          {
            type: "Feature",
            properties: { provider: "official-contours", elevation: 12 },
            geometry: {
              type: "LineString",
              coordinates: [
                [126.97802, 37.56655],
                [126.9784, 37.56655],
              ],
            },
          },
          {
            type: "Feature",
            properties: { provider: "official-contours", elevation: 14 },
            geometry: {
              type: "LineString",
              coordinates: [
                [126.97802, 37.56667],
                [126.9784, 37.56667],
              ],
            },
          },
        ],
      },
      terrainGrid: {
        step: 1.25,
        xValues: [0, 20, 40],
        yValues: [0, 20, 40],
        elevations: [
          [10, 10, 10],
          [12, 12, 12],
          [14, 14, 14],
        ],
        minElevation: 10,
        maxElevation: 14,
      },
      options: {
        ...DEFAULT_OPTIONS,
        radius: 80,
        includeBuildings: false,
        includeRoads: false,
        includeParcelBoundary: false,
      },
      stats: {},
      dataSources: {
        contours: {
          provider: "official-contours",
          mode: "derived",
          interval: 2,
        },
      },
      buildings: { type: "FeatureCollection", features: [] },
      roads: { type: "FeatureCollection", features: [] },
    };
    const refinedSketchUpSiteContext = prepareSiteContextForExport(
      syntheticContourSiteContext,
      syntheticContourSiteContext.options,
      "skp"
    );
    assert.equal(
      refinedSketchUpSiteContext?.stats?.skpTerrainGridRefined,
      true,
      "SKP export should refine official contour terrain sampling when native contours exist."
    );
    assert.ok(
      Number(refinedSketchUpSiteContext?.terrainGrid?.step || 0) > 0 &&
        Number(refinedSketchUpSiteContext?.terrainGrid?.step || 0) < 1.25,
      "SKP refined terrain grid should use a tighter sample step than the source grid."
    );
    assert.equal(
      refinedSketchUpSiteContext?.stats?.nativeContourTerrainGridRefined,
      true,
      "SKP export should record that native contour terrain refinement ran."
    );
    const refined3dmSiteContext = prepareSiteContextForExport(
      syntheticContourSiteContext,
      syntheticContourSiteContext.options,
      "3dm"
    );
    assert.equal(
      refined3dmSiteContext?.stats?.nativeContourTerrainGridRefined,
      true,
      "3DM export should refine official contour terrain sampling when native contours exist."
    );
    assert.ok(
      Number(refined3dmSiteContext?.terrainGrid?.step || 0) > 0 &&
        Number(refined3dmSiteContext?.terrainGrid?.step || 0) < 1.25,
      "3DM refined terrain grid should also use a tighter sample step than the source grid."
    );
    const refined3dmContourElevations = [...new Set(
      (refined3dmSiteContext?.contourLines?.features || [])
        .map((feature) => Number(feature?.properties?.elevation))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right)
    )];
    assert.deepEqual(
      refined3dmContourElevations,
      [10, 11, 12, 13, 14],
      "3DM export should keep native contour levels and add interpolated levels between them."
    );
    assert.ok(
      Number(refined3dmSiteContext?.contourLines?.features?.length || 0) >
        Number(syntheticContourSiteContext?.contourLines?.features?.length || 0),
      "3DM export should augment native contour curves instead of replacing them when a finer interval is requested."
    );
    assert.equal(
      refined3dmSiteContext?.stats?.effectiveContourDisplayInterval,
      1,
      "3DM contour curve export should match the terrain band interval so curves and terraces stay aligned."
    );
    const fragmentedContourSiteContext = cloneJsonValue({
      ...syntheticContourSiteContext,
      contourLines: {
        type: "FeatureCollection",
        features: [
          syntheticContourSiteContext.contourLines.features[0],
          {
            type: "Feature",
            properties: { provider: "official-contours", elevation: 12 },
            geometry: {
              type: "MultiLineString",
              coordinates: [
                [
                  [126.97802, 37.56655],
                  [126.97821, 37.56655],
                ],
                [
                  [126.97821, 37.56655],
                  [126.9784, 37.56655],
                ],
              ],
            },
          },
          syntheticContourSiteContext.contourLines.features[2],
        ],
      },
    });
    const fragmented3dmSiteContext = prepareSiteContextForExport(
      fragmentedContourSiteContext,
      fragmentedContourSiteContext.options,
      "3dm"
    );
    const normalized12Contours = (fragmented3dmSiteContext?.contourLines?.features || [])
      .filter((feature) => Number(feature?.properties?.elevation) === 12)
      .flatMap((feature) => getLineStringsFromGeometry(feature?.geometry || null));
    assert.equal(
      normalized12Contours.length,
      1,
      "Fragmented native contour segments at the same elevation should merge into one export curve."
    );
    assert.equal(
      normalized12Contours[0]?.length,
      3,
      "Merged contour export should keep the original shape while removing duplicate breakpoints."
    );
    const closedExportContours = refined3dmSiteContext?.exportContourLines?.features || [];
    const nativeExportContours = closedExportContours.filter(
      (feature) => feature?.properties?.generated !== true
    );
    const generatedExportContours = closedExportContours.filter(
      (feature) => feature?.properties?.generated === true
    );
    assert.ok(
      closedExportContours.length > 0,
      "3DM contour export should produce closed export contours when contour terrain bands are available."
    );
    assert.ok(
      nativeExportContours.every((feature) => feature?.properties?.closedLoop === true),
      "Native export contours should stay closed so the original contour boundaries remain exact."
    );
    assert.ok(
      generatedExportContours.length > 0,
      "3DM contour export should still include generated intermediate contours for finer requests."
    );
    assert.ok(
      generatedExportContours.every(
        (feature) =>
          feature?.properties?.closedLoop === true &&
          [
            "resolved-area-above-contour",
            "top-surface-cap-contour",
          ].includes(String(feature?.properties?.exportDerived || "").trim())
      ),
      "Generated intermediate contours should come directly from the terrain contour basis so the display curves and terrace edges stay in sync."
    );
    const refined3dmTerrainPlan = resolveContourTerrainRenderPlan(refined3dmSiteContext);
    assert.equal(
      refined3dmSiteContext?.stats?.rawAnchoredContourTerrainUsed,
      true,
      "3DM contour terrain should use the raw-contour-anchored band planner when native contours are available."
    );
    assert.equal(
      refined3dmSiteContext?.stats?.rawAnchoredNativeContourLevelCount,
      3,
      "Raw-contour terrain anchoring should use only the native contour levels as hard terrain anchors."
    );
    const raw10ContourFeature = syntheticContourSiteContext.contourLines.features.find(
      (feature) => Number(feature?.properties?.elevation) === 10
    );
    const raw10ContourLocalPoints = (raw10ContourFeature?.geometry?.coordinates || []).map(
      (point) => localMetersFromLngLat(point, syntheticContourSiteContext.location)
    );
    const rawAnchored10Band = (refined3dmTerrainPlan?.bandGroups || []).find(
      (group) => Math.abs(Number(group?.bottomElevation || 0) - 10) <= 1e-9
    );
    const refined3dmRawAnchorDiagnostics = buildRawAnchoredContourBandDiagnostics(
      refined3dmSiteContext
    );
    const rawAnchored10BandDiagnostic = (
      refined3dmRawAnchorDiagnostics?.levelDiagnostics || []
    ).find((entry) => Math.abs(Number(entry?.bottomElevation || 0) - 10) <= 1e-9);
    assert.ok(
      rawAnchored10Band,
      "3DM terrain plan should contain the band whose lower boundary is the lowest raw native contour."
    );
    assert.ok(
      rawAnchored10BandDiagnostic,
      "Raw-anchor diagnostics should describe the lowest native terrain band."
    );
    assert.equal(
      rawAnchored10BandDiagnostic?.exactBottomAnchor,
      true,
      "The lowest native contour should stay an exact terrain anchor when a finer contour interval is requested."
    );
    const raw10ContourY = raw10ContourLocalPoints[0]?.[1];
    const raw10ContourMinX = Math.min(...raw10ContourLocalPoints.map((point) => point[0]));
    const raw10ContourMaxX = Math.max(...raw10ContourLocalPoints.map((point) => point[0]));
    assert.ok(
      (rawAnchored10Band?.boundaryLoops || []).some((loop) =>
        (loop || []).some((point, index) => {
          const nextPoint = loop[(index + 1) % loop.length];

          if (!nextPoint) {
            return false;
          }

          const segmentMinX = Math.min(Number(point?.[0] || 0), Number(nextPoint?.[0] || 0));
          const segmentMaxX = Math.max(Number(point?.[0] || 0), Number(nextPoint?.[0] || 0));
          return (
            Math.abs(Number(point?.[1] || 0) - raw10ContourY) <= 0.5 &&
            Math.abs(Number(nextPoint?.[1] || 0) - raw10ContourY) <= 0.5 &&
            segmentMinX <= raw10ContourMinX + 0.5 &&
            segmentMaxX >= raw10ContourMaxX - 0.5
          );
        })
      ),
      "The lowest raw native contour should lie directly on a terrain-band boundary edge even for a finer interval request."
    );
    const raw12ContourFeature = syntheticContourSiteContext.contourLines.features.find(
      (feature) => Number(feature?.properties?.elevation) === 12
    );
    const raw12ContourLocalPoints = (raw12ContourFeature?.geometry?.coordinates || []).map(
      (point) => localMetersFromLngLat(point, syntheticContourSiteContext.location)
    );
    const rawAnchored12Band = (refined3dmTerrainPlan?.bandGroups || []).find(
      (group) => Math.abs(Number(group?.bottomElevation || 0) - 12) <= 1e-9
    );
    assert.ok(
      rawAnchored12Band,
      "3DM terrain plan should contain the band whose lower boundary is the raw 12m contour."
    );
    const raw12ContourY = raw12ContourLocalPoints[0]?.[1];
    const raw12ContourMinX = Math.min(...raw12ContourLocalPoints.map((point) => point[0]));
    const raw12ContourMaxX = Math.max(...raw12ContourLocalPoints.map((point) => point[0]));
    assert.ok(
      (rawAnchored12Band?.boundaryLoops || []).some((loop) =>
        (loop || []).some((point, index) => {
          const nextPoint = loop[(index + 1) % loop.length];

          if (!nextPoint) {
            return false;
          }

          const segmentMinX = Math.min(Number(point?.[0] || 0), Number(nextPoint?.[0] || 0));
          const segmentMaxX = Math.max(Number(point?.[0] || 0), Number(nextPoint?.[0] || 0));
          return (
            Math.abs(Number(point?.[1] || 0) - raw12ContourY) <= 0.5 &&
            Math.abs(Number(nextPoint?.[1] || 0) - raw12ContourY) <= 0.5 &&
            segmentMinX <= raw12ContourMinX + 0.5 &&
            segmentMaxX >= raw12ContourMaxX - 0.5
          );
        })
      ),
      "The raw 12m contour should lie directly on a terrain-band boundary edge."
    );
    const exact3dmSiteContext = prepareSiteContextForExport(
      syntheticContourSiteContext,
      {
        ...syntheticContourSiteContext.options,
        contourInterval: 2,
      },
      "3dm"
    );
    const exact3dmTerrainPlan = resolveContourTerrainRenderPlan(exact3dmSiteContext);
    assert.equal(
      exact3dmSiteContext?.stats?.rawAnchoredExactNativeIntervalUsed,
      true,
      "When the requested interval matches the source contour interval, 3DM terrain should use the exact native contour band path."
    );
    assert.equal(
      exact3dmSiteContext?.stats?.rawAnchoredGridFallbackBandCount,
      0,
      "Exact native contour terrain should not need fallback grid bands."
    );
    assert.deepEqual(
      (exact3dmTerrainPlan?.bandGroups || []).map((group) => Number(group?.bottomElevation)),
      [10, 12],
      "Exact native contour terrain should keep every native bottom band when the request matches the source interval."
    );
    const exact12Band = (exact3dmTerrainPlan?.bandGroups || []).find(
      (group) => Math.abs(Number(group?.bottomElevation || 0) - 12) <= 1e-9
    );
    assert.ok(
      exact12Band,
      "Exact native contour terrain should keep the 12m band as a real terrain step."
    );
    assert.ok(
      (exact12Band?.boundaryLoops || []).some((loop) =>
        (loop || []).some((point, index) => {
          const nextPoint = loop[(index + 1) % loop.length];

          if (!nextPoint) {
            return false;
          }

          const segmentMinX = Math.min(Number(point?.[0] || 0), Number(nextPoint?.[0] || 0));
          const segmentMaxX = Math.max(Number(point?.[0] || 0), Number(nextPoint?.[0] || 0));
          return (
            Math.abs(Number(point?.[1] || 0) - raw12ContourY) <= 0.5 &&
            Math.abs(Number(nextPoint?.[1] || 0) - raw12ContourY) <= 0.5 &&
            segmentMinX <= raw12ContourMinX + 0.5 &&
            segmentMaxX >= raw12ContourMaxX - 0.5
          );
        })
      ),
      "Exact native contour terrain should place the raw 12m contour directly on the exact 12m terrain boundary."
    );
    const syntheticBuildingPlacementSiteContext = cloneJsonValue({
      ...syntheticContourSiteContext,
      contourLines: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { provider: "synthetic-test", elevation: 10 },
            geometry: {
              type: "LineString",
              coordinates: [
                [126.97802, 37.56643],
                [126.9784, 37.56643],
              ],
            },
          },
          {
            type: "Feature",
            properties: { provider: "synthetic-test", elevation: 15 },
            geometry: {
              type: "LineString",
              coordinates: [
                [126.97802, 37.56655],
                [126.9784, 37.56655],
              ],
            },
          },
          {
            type: "Feature",
            properties: { provider: "synthetic-test", elevation: 20 },
            geometry: {
              type: "LineString",
              coordinates: [
                [126.97802, 37.56667],
                [126.9784, 37.56667],
              ],
            },
          },
        ],
      },
      terrainGrid: {
        step: 1.25,
        xValues: [0, 20, 40],
        yValues: [0, 20, 40],
        elevations: [
          [10, 10, 10],
          [21, 21, 21],
          [20, 20, 20],
        ],
        minElevation: 10,
        maxElevation: 21,
      },
      options: {
        ...syntheticContourSiteContext.options,
        contourInterval: 5,
        buildingPlacement: "default",
        includeBuildings: true,
      },
      dataSources: {
        contours: {
          provider: "synthetic-test",
          mode: "derived",
          interval: 5,
        },
      },
      buildings: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {
              buildingId: "B-1",
              buildingName: "Band Overlap Placement",
              heightMeters: 15,
              isTarget: true,
            },
            geometry: {
              type: "Polygon",
              coordinates: [[
                [126.97808, 37.566435],
                [126.9782, 37.566435],
                [126.9782, 37.566585],
                [126.97808, 37.566585],
                [126.97808, 37.566435],
              ]],
            },
          },
        ],
      },
    });
    const preparedBuildingPlacementSiteContext = prepareSiteContextForExport(
      syntheticBuildingPlacementSiteContext,
      syntheticBuildingPlacementSiteContext.options,
      "3dm"
    );
    const preparedBuildingPlacementDefaultSiteContext = prepareSiteContextForExport(
      syntheticBuildingPlacementSiteContext,
      {
        ...syntheticBuildingPlacementSiteContext.options,
        buildingPlacement: "default",
      },
      "3dm"
    );
    const preparedBuildingPlacementRemoveOverlapSiteContext = prepareSiteContextForExport(
      syntheticBuildingPlacementSiteContext,
      {
        ...syntheticBuildingPlacementSiteContext.options,
        buildingPlacement: "remove-overlap",
      },
      "3dm"
    );
    const buildingPlacementDebug =
      preparedBuildingPlacementSiteContext?.buildings?.features?.[0]?.properties
        ?.buildingPlacementDebug;
    const buildingPlacementStatsDebug =
      preparedBuildingPlacementSiteContext?.stats?.buildingPlacementDebug?.[0];
    const defaultPlacementDebug =
      preparedBuildingPlacementDefaultSiteContext?.buildings?.features?.[0]?.properties
        ?.buildingPlacementDebug;
    const removeOverlapPlacementDebug =
      preparedBuildingPlacementRemoveOverlapSiteContext?.buildings?.features?.[0]?.properties
        ?.buildingPlacementDebug;
    assert.equal(
      buildingPlacementDebug?.source,
      "dominant-band-overlap",
      "Contour-terrain building placement should prefer the actual terrace band overlap over cell-averaged terrain samples."
    );
    assert.equal(
      buildingPlacementDebug?.bandDominantElevation,
      15,
      "Contour-terrain building placement should capture the dominant elevation from the exact terrace band overlap."
    );
    assert.equal(
      buildingPlacementDebug?.cellOverlapDominantElevation,
      20,
      "The synthetic placement regression should still expose the misleading higher cell-overlap elevation."
    );
    assert.equal(
      buildingPlacementDebug?.finalBaseElevation,
      15,
      "Contour-terrain building placement should keep the building on the matching 5m terrace instead of floating it one band too high."
    );
    assert.equal(
      buildingPlacementDebug?.terrainBasisElevation,
      15,
      "Building placement diagnostics should expose the terrain-basis elevation used for the terrace comparison."
    );
    assert.equal(
      buildingPlacementDebug?.terrainBasisDelta,
      0,
      "Building placement diagnostics should report zero delta when the selected base elevation matches the terrain basis."
    );
    assert.equal(
      buildingPlacementDebug?.terrainBasisAligned,
      true,
      "Building placement diagnostics should mark the placement as terrain-basis-aligned when the base elevation matches the terrace."
    );
    assert.equal(
      buildingPlacementStatsDebug?.source,
      "dominant-band-overlap",
      "Prepared export stats should expose the same dominant terrace source as the per-building placement debug."
    );
    assert.equal(
      buildingPlacementStatsDebug?.finalBaseElevation,
      15,
      "Prepared export stats should keep building placement diagnostics aligned with the exported building base elevation."
    );
    assert.equal(
      buildingPlacementStatsDebug?.terrainBasisDelta,
      0,
      "Prepared export stats should retain the terrain-basis delta for the sampled building placement diagnostics."
    );
    assert.equal(
      defaultPlacementDebug?.finalBaseElevation,
      15,
      "Default building-terrain mode should still keep building Z on the raw contour terrace."
    );
    assert.equal(
      removeOverlapPlacementDebug?.finalBaseElevation,
      15,
      "Remove-overlap mode should not change building Z away from the raw contour terrace."
    );
    assert.equal(
      defaultPlacementDebug?.overlapMode,
      "default",
      "Default building-terrain mode should be reported as default."
    );
    assert.equal(
      removeOverlapPlacementDebug?.overlapMode,
      "remove-overlap",
      "Remove-overlap building-terrain mode should be reported distinctly."
    );
    const buildingGeometry =
      syntheticBuildingPlacementSiteContext?.buildings?.features?.[0]?.geometry?.coordinates?.[0] ||
      [];
    const buildingLocalRing = orientLocalRingCounterClockwise(
      buildingGeometry.map((point) =>
        localMetersFromLngLat(point, syntheticBuildingPlacementSiteContext.location)
      )
    );
    const buildingMultiPolygon = [[buildingLocalRing]];
    const defaultTerrainPlan = resolveContourTerrainRenderPlan(
      preparedBuildingPlacementDefaultSiteContext
    );
    const removeOverlapTerrainPlan = resolveContourTerrainRenderPlan(
      preparedBuildingPlacementRemoveOverlapSiteContext
    );
    const defaultOverlapAreaSqm = computeMultiPolygonAreaSqm(
      polygonClipping.intersection(
        buildingMultiPolygon,
        defaultTerrainPlan?.bandGroups
          ?.filter(
            (group) =>
              Number.isFinite(group?.topElevation) &&
              group.topElevation >
                Number(defaultPlacementDebug?.finalBaseElevation || 0) + 1e-9 &&
              Array.isArray(group?.multiPolygon) &&
              group.multiPolygon.length
          )
          .flatMap((group) => group.multiPolygon || [])
      ) || []
    );
    const removeOverlapAreaSqm = computeMultiPolygonAreaSqm(
      polygonClipping.intersection(
        buildingMultiPolygon,
        removeOverlapTerrainPlan?.bandGroups
          ?.filter(
            (group) =>
              Number.isFinite(group?.topElevation) &&
              group.topElevation >
                Number(removeOverlapPlacementDebug?.finalBaseElevation || 0) + 1e-9 &&
              Array.isArray(group?.multiPolygon) &&
              group.multiPolygon.length
          )
          .flatMap((group) => group.multiPolygon || [])
      ) || []
    );
    assert.ok(
      defaultOverlapAreaSqm > 0.001,
      "Default building-terrain mode should keep overlapping terrain above the building base."
    );
    assert.ok(
      removeOverlapAreaSqm <= 0.001,
      "Remove-overlap building-terrain mode should carve overlapping terrain above the building base."
    );
    const syntheticRoadPlacementSiteContext = cloneJsonValue({
      ...syntheticBuildingPlacementSiteContext,
      options: {
        ...syntheticBuildingPlacementSiteContext.options,
        includeBuildings: false,
        includeRoads: true,
      },
      buildings: {
        type: "FeatureCollection",
        features: [],
      },
      roads: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {
              roadId: "R-1",
              roadName: "Terrain Basis Road",
              surfaceDerived: true,
            },
            geometry: {
              type: "Polygon",
              coordinates: [[
                [126.97822, 37.56664],
                [126.97825, 37.56664],
                [126.97825, 37.56666],
                [126.97822, 37.56666],
                [126.97822, 37.56664],
              ]],
            },
          },
        ],
      },
    });
    const preparedRoadPlacementSiteContext = prepareSiteContextForExport(
      syntheticRoadPlacementSiteContext,
      syntheticRoadPlacementSiteContext.options,
      "3dm"
    );
    const roadPlacementDiagnostics = buildTerrainPipelineDiagnostics(
      preparedRoadPlacementSiteContext
    )?.roadPlacement;
    assert.equal(
      roadPlacementDiagnostics?.roadFeatureCount,
      1,
      "Road placement diagnostics should report the synthetic road footprint."
    );
    assert.ok(
      Number(roadPlacementDiagnostics?.groupCount || 0) >= 1,
      "Road placement diagnostics should produce at least one terrain surface group for the road footprint."
    );
    assert.ok(
      Number(roadPlacementDiagnostics?.coverageRatio || 0) > 0.99,
      "Road placement diagnostics should cover the full synthetic road footprint with terrain-basis surfaces."
    );
    assert.ok(
      Number(roadPlacementDiagnostics?.uncoveredAreaSqm || 0) <= 0.01,
      "Road placement diagnostics should leave essentially no uncovered road footprint in the synthetic regression."
    );
    assert.ok(
      Number(roadPlacementDiagnostics?.elevationCount || 0) >= 1,
      "Road placement diagnostics should record at least one terrain elevation for the synthetic road footprint."
    );
    const syntheticFlatFallbackBuildingSiteContext = cloneJsonValue({
      ...syntheticContourSiteContext,
      contourLines: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { provider: "synthetic-test", elevation: 30 },
            geometry: {
              type: "LineString",
              coordinates: [
                [126.97802, 37.56655],
                [126.9784, 37.56655],
              ],
            },
          },
        ],
      },
      terrainGrid: {
        step: 1,
        xValues: [0, 20, 40],
        yValues: [0, 20, 40],
        elevations: [
          [30, 30, 30],
          [30, 30, 30],
          [30, 30, 30],
        ],
        minElevation: 30,
        maxElevation: 30,
      },
      options: {
        ...syntheticContourSiteContext.options,
        includeBuildings: true,
        includeRoads: false,
        contourInterval: 1,
      },
      dataSources: {
        contours: {
          provider: "synthetic-test",
          mode: "derived",
          interval: 1,
        },
      },
      buildings: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {
              buildingId: "B-flat",
              buildingName: "Flat Fallback Placement",
              heightMeters: 10,
              isTarget: true,
            },
            geometry: {
              type: "Polygon",
              coordinates: [[
                [126.97818, 37.5665],
                [126.97822, 37.5665],
                [126.97822, 37.56654],
                [126.97818, 37.56654],
                [126.97818, 37.5665],
              ]],
            },
          },
        ],
      },
      roads: {
        type: "FeatureCollection",
        features: [],
      },
    });
    const preparedFlatFallbackBuildingSiteContext = prepareSiteContextForExport(
      syntheticFlatFallbackBuildingSiteContext,
      syntheticFlatFallbackBuildingSiteContext.options,
      "3dm"
    );
    const flatFallbackBuildingPlacementDebug =
      preparedFlatFallbackBuildingSiteContext?.stats?.buildingPlacementDebug?.[0];
    assert.equal(
      flatFallbackBuildingPlacementDebug?.finalBaseElevation,
      30,
      "Flat fallback contour terrain should still place the building on the flat contour cap elevation."
    );
    assert.equal(
      flatFallbackBuildingPlacementDebug?.terrainBasisElevation,
      30,
      "Flat fallback contour terrain should expose the flat contour cap as the building terrain basis."
    );
    assert.equal(
      flatFallbackBuildingPlacementDebug?.terrainBasisDelta,
      0,
      "Flat fallback contour terrain should keep building placement aligned with the flat terrain basis."
    );
    assert.equal(
      flatFallbackBuildingPlacementDebug?.terrainBasisAligned,
      true,
      "Flat fallback contour terrain should mark building placement as terrain-basis-aligned."
    );
    const refinedSketchUpPayload = buildSketchUpPayloadFromSiteContext(
      refinedSketchUpSiteContext
    );
    const refinedContourCurves = (refinedSketchUpPayload.groups || [])
      .filter((group) => group?.layer === "contours")
      .flatMap((group) => group?.polylines || [])
      .map((polyline) => polyline?.curve === true);
    assert.ok(
      refinedContourCurves.length > 0,
      "SKP payload should still contain contour polylines."
    );
    assert.ok(
      refinedContourCurves.every(Boolean),
      "SKP contour polylines should be exported as curves."
    );
    const stairStepSketchUpSource = cloneJsonValue({
      ...syntheticContourSiteContext,
      contourLines: {
        type: "FeatureCollection",
        features: [],
      },
      terrainGrid: {
        step: 1,
        xValues: [0, 1, 2, 3, 4],
        yValues: [0, 1, 2, 3, 4],
        elevations: [
          [10, 10, 10, 10, 10],
          [10, 11, 11, 11, 11],
          [10, 11, 12, 12, 12],
          [10, 11, 12, 13, 13],
          [10, 11, 12, 13, 14],
        ],
        minElevation: 10,
        maxElevation: 14,
      },
      options: {
        ...syntheticContourSiteContext.options,
        radius: 120,
        contourInterval: 1,
      },
      dataSources: {
        contours: {
          provider: "synthetic-test",
          mode: "derived",
          interval: 1,
        },
      },
    });
    const stairStepSketchUpSiteContext = prepareSiteContextForExport(
      stairStepSketchUpSource,
      stairStepSketchUpSource.options,
      "skp"
    );
    const stairStepTolerance = resolveSketchUpTerrainSolidSimplifyTolerance(
      stairStepSketchUpSiteContext
    );
    assert.equal(
      stairStepTolerance,
      0,
      "SKP contour terrain should preserve original terrace loops and only sanitize invalid solids."
    );
    const rawStairStepRegion = {
      outerPoints: [
        [0, 0],
        [5, 0],
        [5, 1],
        [4, 1],
        [4, 2],
        [3, 2],
        [3, 3],
        [2, 3],
        [2, 4],
        [1, 4],
        [1, 5],
        [0, 5],
      ],
      holePoints: [],
    };
    const simplifiedStairStepRegion = simplifySketchUpSolidRegion(
      rawStairStepRegion,
      stairStepTolerance
    );
    assert.ok(
      simplifiedStairStepRegion?.outerPoints?.length > 0,
      "SKP region simplifier should keep a valid outer loop."
    );
    assert.deepEqual(
      simplifiedStairStepRegion,
      rawStairStepRegion,
      "SKP contour terrain should preserve stair-step terrace vertices when the loop is already valid."
    );
    const rawStairStepBounds = rawStairStepRegion.outerPoints.reduce(
      (bounds, [xMeters, yMeters]) => ({
        minX: Math.min(bounds.minX, xMeters),
        maxX: Math.max(bounds.maxX, xMeters),
        minY: Math.min(bounds.minY, yMeters),
        maxY: Math.max(bounds.maxY, yMeters),
      }),
      {
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      }
    );
    const simplifiedStairStepBounds = simplifiedStairStepRegion.outerPoints.reduce(
      (bounds, [xMeters, yMeters]) => ({
        minX: Math.min(bounds.minX, xMeters),
        maxX: Math.max(bounds.maxX, xMeters),
        minY: Math.min(bounds.minY, yMeters),
        maxY: Math.max(bounds.maxY, yMeters),
      }),
      {
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      }
    );
    assert.deepEqual(
      simplifiedStairStepBounds,
      rawStairStepBounds,
      "SKP region simplifier should preserve the original loop bounds."
    );
    assert.ok(
      simplifiedStairStepRegion.outerPoints.every(
        ([xMeters, yMeters]) =>
          Math.abs(xMeters - Math.round(xMeters)) <= 0.001 &&
          Math.abs(yMeters - Math.round(yMeters)) <= 0.001
      ),
      "SKP region simplifier should not invent rounded corner coordinates for rectilinear loops."
    );
    const rectilinearBoundaryRegion = {
      outerPoints: [
        [0, 0],
        [10, 0],
        [10, 4],
        [10, 8],
        [6, 8],
        [2, 8],
        [0, 8],
        [0, 4],
      ],
      holePoints: [],
    };
    const simplifiedRectilinearBoundary = simplifySketchUpSolidRegion(
      rectilinearBoundaryRegion,
      stairStepTolerance
    );
    assert.deepEqual(
      simplifiedRectilinearBoundary,
      rectilinearBoundaryRegion,
      "SKP contour terrain should preserve the full rectilinear range boundary instead of collapsing it."
    );
    const stairStepSketchUpPayload = buildSketchUpPayloadFromSiteContext(
      stairStepSketchUpSiteContext
    );
    assert.ok(
      (stairStepSketchUpPayload?.groups || []).some(
        (group) =>
          group?.layer === "terrain" && Number(group?.solids?.length || 0) > 0
      ),
      "Synthetic stair-step SKP terrain should still generate terrain solids."
    );
    assert.ok(
      (stairStepSketchUpPayload?.groups || []).some(
        (group) =>
          group?.layer === "terrain" &&
          Number(group?.solids?.length || 0) > 0 &&
          group?.mergeSolids === true &&
          group?.softenEdges === true
      ),
      "SKP terrain payload should request merged solids with softened coplanar edges to reduce visible grid seams."
    );
    const sketchUpDirtyRegion = {
      outerPoints: [
        [0, 0],
        [2, 0],
        [2, 0.01],
        [2, 2],
        [0, 2],
      ],
      holePoints: [
        [
          [0.5, 0.5],
          [0.58, 0.5],
          [0.58, 0.56],
          [0.5, 0.56],
        ],
      ],
    };
    const cleanedSketchUpRegion = sanitizeSketchUpSolidRegion(sketchUpDirtyRegion, {
      minAreaMeters: 0.02,
      minSegmentMeters: 0.04,
      minHoleAreaMeters: 0.03,
      minHoleSegmentMeters: 0.05,
      repairTolerance: 0.12,
    });
    assert.ok(
      cleanedSketchUpRegion?.outerPoints?.length >= 3,
      "SKP solid sanitizer should keep a valid outer loop for mildly noisy regions."
    );
    assert.equal(
      cleanedSketchUpRegion?.holePoints?.length || 0,
      0,
      "SKP solid sanitizer should drop tiny hole loops that often trigger SketchUp cleanup."
    );
    const tinySketchUpSliver = sanitizeSketchUpSolidRegion(
      {
        outerPoints: [
          [0, 0],
          [0.05, 0],
          [0.05, 0.01],
          [0, 0.01],
        ],
        holePoints: [],
      },
      {
        minAreaMeters: 0.02,
        minSegmentMeters: 0.04,
        minHoleAreaMeters: 0.03,
        minHoleSegmentMeters: 0.05,
        repairTolerance: 0.12,
      }
    );
    assert.equal(
      tinySketchUpSliver,
      null,
      "SKP solid sanitizer should drop tiny sliver regions before they reach SketchUp."
    );
    const refinedDxfSiteContext = prepareSiteContextForExport(
      syntheticContourSiteContext,
      syntheticContourSiteContext.options,
      "dxf"
    );
    const refinedDxfContourElevations = [...new Set(
      (refinedDxfSiteContext?.contourLines?.features || [])
        .map((feature) => Number(feature?.properties?.elevation))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right)
    )];
    assert.equal(
      refinedDxfSiteContext?.stats?.effectiveContourDisplayInterval,
      1,
      "DXF export should align contour curve display with the actual terrain band interval."
    );
    assert.deepEqual(
      refinedDxfContourElevations,
      [10, 11, 12, 13, 14],
      "DXF export should keep native contour levels and add interpolated levels between them."
    );
    assert.ok(
      syntheticContourSiteContext.contourLines.features.every((sourceFeature) =>
        (refinedDxfSiteContext?.contourLines?.features || []).some(
          (refinedFeature) =>
            Number(refinedFeature?.properties?.elevation) ===
              Number(sourceFeature?.properties?.elevation) &&
            JSON.stringify(refinedFeature?.geometry || null) ===
              JSON.stringify(sourceFeature?.geometry || null)
        )
      ),
      "DXF export should preserve the native official contour geometries while adding only the missing intermediate contours."
    );
    const exportMutationSourceSiteContext = cloneJsonValue({
      ...syntheticContourSiteContext,
      options: {
        ...syntheticContourSiteContext.options,
        includeBuildings: true,
      },
      debugBundle: {
        nested: {
          stage: "source",
        },
      },
      buildings: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {
              buildingId: "B-1",
              buildingName: "Mutation Check",
              heightMeters: 12,
            },
            geometry: {
              type: "Polygon",
              coordinates: [[
                [126.97808, 37.56647],
                [126.97818, 37.56647],
                [126.97818, 37.56657],
                [126.97808, 37.56657],
                [126.97808, 37.56647],
              ]],
            },
          },
        ],
      },
    });
    const exportMutationOriginalSnapshot = cloneJsonValue(exportMutationSourceSiteContext);
    const exportMutationPreparedSiteContext = prepareSiteContextForExport(
      exportMutationSourceSiteContext,
      exportMutationSourceSiteContext.options,
      "skp"
    );
    assert.equal(
      exportMutationSourceSiteContext?.terrainGrid?.step,
      exportMutationOriginalSnapshot?.terrainGrid?.step,
      "prepareSiteContextForExport should not mutate the source terrain grid."
    );
    assert.equal(
      exportMutationSourceSiteContext?.buildings?.features?.[0]?.properties?.buildingPlacementDebug,
      undefined,
      "prepareSiteContextForExport should not write building placement debug info back onto the source siteContext."
    );
    assert.notStrictEqual(
      exportMutationPreparedSiteContext?.debugBundle?.nested,
      exportMutationSourceSiteContext?.debugBundle?.nested,
      "prepareSiteContextForExport should deep-clone unknown nested top-level fields as well."
    );
    exportMutationPreparedSiteContext.debugBundle.nested.stage = "prepared";
    assert.equal(
      exportMutationSourceSiteContext?.debugBundle?.nested?.stage,
      "source",
      "prepareSiteContextForExport should keep custom nested fields detached from the source siteContext."
    );
    assert.notEqual(
      exportMutationPreparedSiteContext?.buildings?.features?.[0]?.properties?.buildingPlacementDebug,
      undefined,
      "prepareSiteContextForExport should still attach building placement debug info on the export copy."
    );
    const serverOwnedSiteContext = await fetchJson("/api/site-context", {
      location: syntheticContourSiteContext.location,
      options: syntheticContourSiteContext.options,
    });
    const serverOwnedPayloadSiteContext = prepareSiteContextForExport(
      serverOwnedSiteContext,
      {
        ...serverOwnedSiteContext.options,
        exportFormat: "skp-payload",
      },
      "skp-payload"
    );
    const maliciousSiteContext = cloneJsonValue(serverOwnedSiteContext);

    if (maliciousSiteContext?.contourLines?.features?.[0]?.geometry?.coordinates?.[0]) {
      maliciousSiteContext.contourLines.features[0].geometry.coordinates[0][0] += 0.01;
      maliciousSiteContext.contourLines.features[0].geometry.coordinates[1][0] += 0.01;
    }

    const maliciousPayloadSiteContext = prepareSiteContextForExport(
      maliciousSiteContext,
      {
        ...maliciousSiteContext.options,
        exportFormat: "skp-payload",
      },
      "skp-payload"
    );
    assert.notEqual(
      buildExportArtifactCacheKey(serverOwnedPayloadSiteContext, "skp-payload"),
      buildExportArtifactCacheKey(maliciousPayloadSiteContext, "skp-payload"),
      "Export cache keys should change when geometry changes even if request counts stay the same."
    );
    const legacyOnlyExportResponse = await fetch(`${baseUrl}/api/export-skp-payload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        siteContext: serverOwnedSiteContext,
      }),
    });
    const legacyOnlyExportPayload = await readJson(legacyOnlyExportResponse);
    assert.equal(
      legacyOnlyExportResponse.status,
      400,
      "Export payload request should no longer accept siteContext-only legacy bodies."
    );
    assert.match(
      String(legacyOnlyExportPayload?.error || ""),
      /location|coord|좌표/i,
      "Legacy export body rejection should explain that a direct location payload is required."
    );

    const rogueTopLevelBounds = {
      south: 37.4,
      west: 126.7,
      north: 37.8,
      east: 127.1,
    };

    const exportCacheRequestBody = {
      location: serverOwnedSiteContext.location,
      options: {
        ...serverOwnedSiteContext.options,
        buildingPlacement: "remove-overlap",
        exportFormat: "skp-payload",
      },
    };
    const maliciousExportResponse = await fetch(`${baseUrl}/api/export-skp-payload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: serverOwnedSiteContext.location,
        siteContext: maliciousSiteContext,
        options: {
          ...serverOwnedSiteContext.options,
          exportFormat: "skp-payload",
        },
      }),
    });
    const maliciousExportPayload = await readJson(maliciousExportResponse);
    assert.equal(
      maliciousExportResponse.status,
      200,
      "Export payload request with a fake client siteContext should still respond."
    );
    const topLevelBoundsResponse = await fetch(`${baseUrl}/api/export-skp-payload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: serverOwnedSiteContext.location,
        options: {
          ...serverOwnedSiteContext.options,
          exportFormat: "skp-payload",
        },
        customBounds: rogueTopLevelBounds,
      }),
    });
    const topLevelBoundsPayload = await readJson(topLevelBoundsResponse);
    assert.equal(
      topLevelBoundsResponse.status,
      200,
      "Export payload request should ignore unsupported top-level geometry keys."
    );
    const exportWithoutSiteContextResponse = await fetch(`${baseUrl}/api/export-skp-payload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: serverOwnedSiteContext.location,
        options: {
          ...serverOwnedSiteContext.options,
          exportFormat: "skp-payload",
        },
      }),
    });
    const exportWithoutSiteContextPayload = await readJson(exportWithoutSiteContextResponse);
    assert.equal(
      exportWithoutSiteContextResponse.status,
      200,
      "Export payload request without a client siteContext should respond."
    );
    assert.ok(
      Array.isArray(exportWithoutSiteContextPayload?.payload?.groups),
      "Export payload request without a client siteContext should still return payload groups."
    );
    assert.deepEqual(
      maliciousExportPayload?.payload?.groups,
      exportWithoutSiteContextPayload?.payload?.groups,
      "Export payload generation should ignore client-supplied siteContext geometry and use the server-owned context."
    );
    assert.deepEqual(
      topLevelBoundsPayload?.payload?.groups,
      exportWithoutSiteContextPayload?.payload?.groups,
      "Export payload generation should ignore unsupported top-level geometry fields and use only location/options."
    );

    const firstExportCacheResponse = await fetch(`${baseUrl}/api/export-skp-payload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(exportCacheRequestBody),
    });
    const firstExportCachePayload = await readJson(firstExportCacheResponse);
    assert.equal(
      firstExportCacheResponse.status,
      200,
      "First export payload request should respond."
    );
    assert.equal(
      firstExportCacheResponse.headers.get("x-export-cache"),
      "miss",
      "First export payload response should be a cache miss."
    );
    assert.ok(
      Array.isArray(firstExportCachePayload?.payload?.groups),
      "First export payload response should include groups."
    );

    const secondExportCacheResponse = await fetch(`${baseUrl}/api/export-skp-payload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(exportCacheRequestBody),
    });
    assert.equal(
      secondExportCacheResponse.status,
      200,
      "Second export payload request should respond."
    );
    assert.equal(
      secondExportCacheResponse.headers.get("x-export-cache"),
      "hit",
      "Repeated export payload response should reuse the export cache."
    );
    assert.equal(
      resolveRateLimitBucket("/api/export-model", "POST"),
      null,
      "Export requests should rely on the export queue instead of a time-window rate-limit bucket."
    );

    resetExportQueueStateForTests();

    const queueProbeConfig = {
      maxConcurrentExportJobs: 1,
      exportJobQueueTimeoutMs: 5000,
      maxPendingExportJobsPerClient: 2,
    };
    const queueEvents = [];
    const firstQueuedJob = withExportJobSlot(
      queueProbeConfig,
      async () => {
        await delay(140);
        return "first";
      },
      {
        clientIp: "198.51.100.10",
      }
    );

    await delay(20);

    const secondQueuedJob = withExportJobSlot(
      queueProbeConfig,
      async () => {
        await delay(40);
        return "second";
      },
      {
        clientIp: "198.51.100.20",
        onQueued: (details) => {
          queueEvents.push({
            job: "second",
            position: details.position,
          });
        },
      }
    );

    await delay(20);

    const thirdQueuedJob = withExportJobSlot(
      queueProbeConfig,
      async () => "third",
      {
        clientIp: "198.51.100.30",
        onQueued: (details) => {
          queueEvents.push({
            job: "third",
            position: details.position,
          });
        },
      }
    );

    await Promise.all([firstQueuedJob, secondQueuedJob, thirdQueuedJob]);

    const thirdQueuePositions = queueEvents
      .filter((entry) => entry.job === "third")
      .map((entry) => entry.position);
    assert.equal(
      thirdQueuePositions[0],
      2,
      "A later queued export job should initially receive its queue position."
    );
    assert.ok(
      thirdQueuePositions.includes(1),
      "Queued export jobs should be notified when their queue position improves."
    );

    const perClientPendingProbe = withExportJobSlot(
      queueProbeConfig,
      async () => {
        await delay(120);
        return "hold";
      },
      {
        clientIp: "203.0.113.55",
      }
    );
    await delay(20);

    const sameClientQueuedProbe = withExportJobSlot(
      queueProbeConfig,
      async () => "queued",
      {
        clientIp: "203.0.113.55",
      }
    );
    await delay(20);

    let repeatedClientError = null;

    try {
      await withExportJobSlot(
        queueProbeConfig,
        async () => "blocked",
        {
          clientIp: "203.0.113.55",
        }
      );
    } catch (error) {
      repeatedClientError = error;
    }

    const normalizedRepeatedClientError = normalizePublicError(repeatedClientError);
    assert.equal(
      normalizedRepeatedClientError?.statusCode,
      429,
      "A single client should not be able to pile up unlimited queued exports."
    );
    assert.match(
      String(normalizedRepeatedClientError?.message || ""),
      /진행 중이거나 대기 중인 모델 파일 작업/i,
      "Per-client export queue rejection should explain that an export is already pending."
    );

    await Promise.all([perClientPendingProbe, sameClientQueuedProbe]);

    resetExportQueueStateForTests();

    const graceReleaseConfig = {
      maxConcurrentExportJobs: 1,
      exportJobQueueTimeoutMs: 2000,
      maxPendingExportJobsPerClient: 1,
    };
    beginInteractiveSearchPriority();
    endInteractiveSearchPriority(graceReleaseConfig);
    const graceQueuedAt = Date.now();
    const graceReleasedResult = await withExportJobSlot(
      graceReleaseConfig,
      async () => "released-after-search-grace",
      {
        clientIp: "198.51.100.90",
      }
    );
    const graceWaitMs = Date.now() - graceQueuedAt;
    assert.equal(
      graceReleasedResult,
      "released-after-search-grace",
      "A queued export should resume automatically after the search-priority grace period."
    );
    assert.ok(
      graceWaitMs >= 600,
      "A queued export should remain paused briefly during the search-priority grace period."
    );
    assert.ok(
      graceWaitMs < 1800,
      "A queued export should resume before the queue timeout once the grace period ends."
    );

    resetExportQueueStateForTests();

    const queuedAbortConfig = {
      maxConcurrentExportJobs: 1,
      exportJobQueueTimeoutMs: 5000,
      maxPendingExportJobsPerClient: 1,
    };
    const slotHolder = withExportJobSlot(
      queuedAbortConfig,
      async () => {
        await delay(120);
        return "slot-holder";
      },
      {
        clientIp: "198.51.100.200",
      }
    );
    await delay(20);

    let abortedQueuedJobRan = false;
    const queuedAbortController = new AbortController();
    const abortedQueuedJob = withExportJobSlot(
      queuedAbortConfig,
      async () => {
        abortedQueuedJobRan = true;
        return "should-not-run";
      },
      {
        clientIp: "203.0.113.99",
        signal: queuedAbortController.signal,
      }
    );
    await delay(20);
    queuedAbortController.abort();

    let abortedQueuedError = null;
    try {
      await abortedQueuedJob;
    } catch (error) {
      abortedQueuedError = error;
    }

    const normalizedQueuedAbortError = normalizePublicError(abortedQueuedError);
    assert.equal(
      normalizedQueuedAbortError?.statusCode,
      499,
      "A queued export should be removed immediately when the client disconnects."
    );
    assert.equal(
      abortedQueuedJobRan,
      false,
      "A disconnected queued export should never start work after it has been aborted."
    );

    const replacementQueuedJob = withExportJobSlot(
      queuedAbortConfig,
      async () => "replacement-after-abort",
      {
        clientIp: "203.0.113.99",
      }
    );
    const [, replacementQueuedResult] = await Promise.all([
      slotHolder,
      replacementQueuedJob,
    ]);
    assert.equal(
      replacementQueuedResult,
      "replacement-after-abort",
      "A replacement export from the same client should be allowed once the aborted queued job is cleaned up."
    );

    resetExportQueueStateForTests();

    console.log(
      JSON.stringify(
        {
          ok: true,
          verifiedAt: new Date().toISOString(),
          mode: "baseline",
          port: BASELINE_PORT,
          checks: [
            "hub-route",
            "feature-route",
            "heritage-route",
            "max-mass-route",
            "health-shape",
            "runtime-stats-shape",
            "config-shape",
            "terrain-contour-path-fallback",
            "site-context-cache-export-format",
            "bounded-cache-pruning",
            "property-data-cache-dedupe",
            "provider-timeout-config",
            "vworld-domain-candidates",
            "parcel-lookup-lite-client",
            "ui-request-status-feedback",
            "ui-verification-hook",
            "security-headers",
            "csp-no-inline-default",
            "self-hosted-frontend-assets",
            "static-path-guard",
            "outbound-fetch-timeout",
            "public-error-normalization",
            "progress-token-guard",
            "model-spec",
            "body-size-limit",
            "site-radius-limit",
            "multi-parcel-preview",
            "multi-parcel-custom-groups",
            "manual-range-clip-boundary",
            "manual-range-size-limit",
            "road-surface-merge",
            "search-ranking-tokens",
            "skp-terrain-refine",
            "skp-contour-curves",
            "export-prep-no-mutation",
            "export-cache-key-geometry",
            "export-rejects-legacy-site-context-only",
            "export-ignores-client-site-context",
            "export-ignores-top-level-geometry-keys",
            "export-without-site-context",
            "export-cache-hit",
            "export-queue-progress-updates",
            "export-pending-per-client-limit",
            "export-search-priority-grace-release",
            "export-queued-client-abort-cleanup",
          ],
        },
        null,
        2
      )
    );
  } finally {
    if (typeof previousPort === "string") {
      process.env.PORT = previousPort;
    } else {
      delete process.env.PORT;
    }

    if (typeof previousBindHost === "string") {
      process.env.BIND_HOST = previousBindHost;
    } else {
      delete process.env.BIND_HOST;
    }

    if (server?.listening) {
      await new Promise((resolve) => {
        server.close(resolve);
      });
    } else {
      await delay(50);
    }
  }
}

async function main() {
  if (BASELINE_MODE) {
    await runBaselineVerification();
    return;
  }

  assert(CASES.length > 0, "No verification cases selected.");
  const health = await fetchJson("/api/health");
  assert.equal(health?.ok, true, "Health check failed.");

  const results = [];
  const failures = [];

  for (const testCase of CASES) {
    const startedAt = Date.now();
    const { result, failures: caseFailures } = await verifyCase(testCase);
    result.elapsedMs = Date.now() - startedAt;
    results.push(result);
    failures.push(...caseFailures);
  }

  const summary = {
    health,
    verifiedAt: new Date().toISOString(),
    fullSkpExport: FULL_SKP_EXPORT,
    cases: results,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failures.length) {
    console.error("\nVerification failures:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
