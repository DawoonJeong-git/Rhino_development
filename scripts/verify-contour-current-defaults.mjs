import {
  build3dmFromSiteContext,
  buildSketchUpPayloadFromSiteContext,
  buildSmoothTerrainHeightModel,
  getRhino3dm,
  localMetersFromLngLat,
  prepareSiteContextForExport,
  resolveContourTerrainRenderPlan,
} from "../server.mjs";

const BASE_URL =
  process.env.SITE_CONTEXT_BASE_URL || "http://127.0.0.1:3001/test";

const CASE = {
  name: "muak-82-current-5m",
  location: {
    lat: 37.577034,
    lng: 126.961612,
    label: "서울특별시 종로구 무악동 82",
    parcelAddress: "서울특별시 종로구 무악동 82",
    pnu: "1111018700100820000",
  },
  options: {
    shape: "rectangle",
    radius: 100,
    contourInterval: 5,
    terrainMode: "contour",
    terrainPipelineMode: "current",
    buildingPlacement: "default",
    exportFormat: "3dm",
    includeContours: true,
    includeBuildings: true,
    includeRoads: true,
    includeParcelBoundary: true,
    splitParcelBoundary: false,
  },
};

const GOLDEN = Object.freeze({
  nativeFeatureCount: 11,
  nativeLineStringCount: 20,
  nativeElevations: [85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135],
  stepped: {
    minBytes: 1_000_000,
    maxBytes: 1_500_000,
    absoluteGroupCount: 10,
    absorbedBaseLikeGroupCount: 1,
    modelTerrainObjectCount: 13,
    contourCurveCount: 20,
    skpGroupCount: 44,
    skpContourCurveCount: 20,
    baseSolidCount: 1,
    contourSolidCount: 12,
  },
  smooth: {
    minBytes: 1_700_000,
    maxBytes: 2_500_000,
    modelTerrainObjectCount: 6,
    contourCurveCount: 20,
    skpGroupCount: 43,
    skpTerrainFaceCount: 3688,
    skpContourCurveCount: 20,
  },
});

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNumberEquals(actual, expected, label) {
  assertCondition(
    Number(actual) === Number(expected),
    `${label} expected ${expected}, got ${actual}`
  );
}

function assertNumberRange(actual, minValue, maxValue, label) {
  const numericValue = Number(actual);
  assertCondition(
    Number.isFinite(numericValue) &&
      numericValue >= Number(minValue) &&
      numericValue <= Number(maxValue),
    `${label} expected ${minValue}..${maxValue}, got ${actual}`
  );
}

function assertArrayEquals(actual, expected, label) {
  const normalizedActual = (actual || []).map((value) => Number(value));
  const normalizedExpected = (expected || []).map((value) => Number(value));
  assertCondition(
    normalizedActual.length === normalizedExpected.length &&
      normalizedActual.every((value, index) => value === normalizedExpected[index]),
    `${label} expected [${normalizedExpected.join(", ")}], got [${normalizedActual.join(", ")}]`
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

function getContourBoundaryConflictFeatures(siteContext) {
  const features = [];
  const seenKeys = new Set();

  for (const collection of [siteContext?.contourLines]) {
    for (const feature of collection?.features || []) {
      const elevation = Number(feature?.properties?.elevation);

      if (!Number.isFinite(elevation) || !feature?.geometry) {
        continue;
      }

      const key = `${Number(elevation).toFixed(3)}:${JSON.stringify(
        feature.geometry
      )}`;

      if (seenKeys.has(key)) {
        continue;
      }

      seenKeys.add(key);
      features.push(feature);
    }
  }

  return features;
}

async function fetchSiteContext() {
  const response = await fetch(`${BASE_URL}/api/site-context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: CASE.location,
      options: {
        ...CASE.options,
        terrainSurfaceMode: "stepped",
      },
    }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `site-context failed with ${response.status}: ${payload?.error || "unknown error"}`
    );
  }

  return payload;
}

function summarizeMultiPolygonArea(multiPolygon) {
  let area = 0;

  for (const polygon of multiPolygon || []) {
    const rings = Array.isArray(polygon) ? polygon : [];
    const ringArea = (ring) => {
      let value = 0;

      for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];
        value += current[0] * next[1] - next[0] * current[1];
      }

      return Math.abs(value / 2);
    };

    area += ringArea(rings[0] || []);

    for (let index = 1; index < rings.length; index += 1) {
      area -= ringArea(rings[index] || []);
    }
  }

  return Math.max(0, Number(area.toFixed(3)));
}

function summarizePolygonBounds(polygon) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const ring of polygon || []) {
    for (const point of ring || []) {
      if (!Array.isArray(point) || point.length < 2) {
        continue;
      }

      minX = Math.min(minX, Number(point[0]));
      minY = Math.min(minY, Number(point[1]));
      maxX = Math.max(maxX, Number(point[0]));
      maxY = Math.max(maxY, Number(point[1]));
    }
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

function boundsNearlyMatch(left, right, toleranceMeters = 0.03) {
  if (!left || !right) {
    return false;
  }

  return (
    Math.abs(Number(left.minX) - Number(right.minX)) <= toleranceMeters &&
    Math.abs(Number(left.minY) - Number(right.minY)) <= toleranceMeters &&
    Math.abs(Number(left.maxX) - Number(right.maxX)) <= toleranceMeters &&
    Math.abs(Number(left.maxY) - Number(right.maxY)) <= toleranceMeters
  );
}

function findRepeatedContourPolygons(absoluteGroups) {
  const previous = [];
  const repeated = [];

  for (const [groupIndex, group] of (absoluteGroups || []).entries()) {
    for (const [polygonIndex, polygon] of (group?.multiPolygon || []).entries()) {
      const signature = {
        groupIndex,
        polygonIndex,
        topElevation: Number(group?.topElevation),
        area: summarizeMultiPolygonArea([polygon]),
        bounds: summarizePolygonBounds(polygon),
      };
      const matchingPrevious = previous.find(
        (entry) =>
          Math.abs(Number(entry.area || 0) - Number(signature.area || 0)) <= 0.02 &&
          boundsNearlyMatch(entry.bounds, signature.bounds)
      );

      if (matchingPrevious) {
        repeated.push({
          ...signature,
          previousGroupIndex: matchingPrevious.groupIndex,
          previousTopElevation: matchingPrevious.topElevation,
        });
      }

      previous.push(signature);
    }
  }

  return repeated;
}

function buildContourRingKey(ring) {
  return (ring || [])
    .map((point) =>
      Array.isArray(point)
        ? `${Number(point[0]).toFixed(3)},${Number(point[1]).toFixed(3)}`
        : ""
    )
    .filter(Boolean)
    .sort()
    .join(";");
}

function findAdjacentSharedContourRings(absoluteGroups) {
  const groups = (absoluteGroups || []).map((group) => ({
    topElevation: Number(group?.topElevation),
    rings: (group?.multiPolygon || []).flatMap((polygon, polygonIndex) =>
      (polygon || []).map((ring, ringIndex) => ({
        polygonIndex,
        ringIndex,
        key: buildContourRingKey(ring),
      }))
    ),
  }));
  const shared = [];

  for (let index = 0; index < groups.length - 1; index += 1) {
    const lowerGroup = groups[index];
    const upperGroup = groups[index + 1];

    for (const lowerRing of lowerGroup.rings) {
      for (const upperRing of upperGroup.rings) {
        if (lowerRing.key && lowerRing.key === upperRing.key) {
          shared.push({
            lowerTopElevation: lowerGroup.topElevation,
            upperTopElevation: upperGroup.topElevation,
            lowerRing: {
              polygonIndex: lowerRing.polygonIndex,
              ringIndex: lowerRing.ringIndex,
            },
            upperRing: {
              polygonIndex: upperRing.polygonIndex,
              ringIndex: upperRing.ringIndex,
            },
          });
        }
      }
    }
  }

  return shared;
}

function distancePointToSegment(point, startPoint, endPoint) {
  const dx = Number(endPoint[0]) - Number(startPoint[0]);
  const dy = Number(endPoint[1]) - Number(startPoint[1]);
  const squaredLength = dx * dx + dy * dy;
  const ratio =
    squaredLength > 0
      ? Math.max(
          0,
          Math.min(
            1,
            ((Number(point[0]) - Number(startPoint[0])) * dx +
              (Number(point[1]) - Number(startPoint[1])) * dy) /
              squaredLength
          )
        )
      : 0;
  const projectedX = Number(startPoint[0]) + dx * ratio;
  const projectedY = Number(startPoint[1]) + dy * ratio;

  return Math.hypot(Number(point[0]) - projectedX, Number(point[1]) - projectedY);
}

function distancePointToRing(point, ring) {
  let bestDistance = Infinity;

  for (let index = 0; index < (ring || []).length; index += 1) {
    bestDistance = Math.min(
      bestDistance,
      distancePointToSegment(
        point,
        ring[index],
        ring[(index + 1) % ring.length]
      )
    );
  }

  return bestDistance;
}

function doRingsTouch(leftRing, rightRing, toleranceMeters = 0.03) {
  const left = (leftRing || []).filter(Array.isArray);
  const right = (rightRing || []).filter(Array.isArray);

  if (left.length < 2 || right.length < 2) {
    return false;
  }

  return (
    left.some((point) => distancePointToRing(point, right) <= toleranceMeters) ||
    right.some((point) => distancePointToRing(point, left) <= toleranceMeters)
  );
}

function findBoundaryTouchingRegionHoles(absoluteGroups) {
  const touchingHoles = [];

  for (const [groupIndex, group] of (absoluteGroups || []).entries()) {
    for (const [regionIndex, region] of (group?.regions || []).entries()) {
      for (const [holeIndex, holePoints] of (region?.holePoints || []).entries()) {
        if (doRingsTouch(region?.outerPoints || [], holePoints)) {
          touchingHoles.push({
            groupIndex,
            regionIndex,
            holeIndex,
            topElevation: Number(group?.topElevation),
          });
        }
      }
    }
  }

  return touchingHoles;
}

function closeLocalRing(ring) {
  const points = (ring || []).filter(
    (point) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(Number(point[0])) &&
      Number.isFinite(Number(point[1]))
  );

  if (points.length < 2) {
    return points;
  }

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];

  if (
    Math.abs(Number(firstPoint[0]) - Number(lastPoint[0])) <= 0.001 &&
    Math.abs(Number(firstPoint[1]) - Number(lastPoint[1])) <= 0.001
  ) {
    return points;
  }

  return [...points, firstPoint];
}

function distancePointToMultiPolygonBoundary(point, multiPolygon) {
  let bestDistance = Infinity;

  for (const polygon of multiPolygon || []) {
    for (const ring of polygon || []) {
      bestDistance = Math.min(bestDistance, distancePointToRing(point, ring));
    }
  }

  return bestDistance;
}

function sampleLocalLineMidpoints(points, stepMeters = 0.5) {
  const samples = [];

  for (let index = 1; index < (points || []).length; index += 1) {
    const startPoint = points[index - 1];
    const endPoint = points[index];
    const length = Math.hypot(
      Number(endPoint[0]) - Number(startPoint[0]),
      Number(endPoint[1]) - Number(startPoint[1])
    );
    const sampleCount = Math.max(1, Math.ceil(length / stepMeters));
    const sampleLengthMeters = sampleCount > 0 ? length / sampleCount : 0;

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const ratio = (sampleIndex + 0.5) / sampleCount;
      samples.push({
        point: [
          Number(startPoint[0]) + (Number(endPoint[0]) - Number(startPoint[0])) * ratio,
          Number(startPoint[1]) + (Number(endPoint[1]) - Number(startPoint[1])) * ratio,
        ],
        lengthMeters: sampleLengthMeters,
      });
    }
  }

  return samples;
}

function findAdjacentInternalBoundaryOverlaps(
  absoluteGroups,
  clipPolygon,
  {
    toleranceMeters = 0.12,
    clipToleranceMeters = 0.25,
    overlapLengthThresholdMeters = 1.2,
  } = {}
) {
  const clipMultiPolygon =
    Array.isArray(clipPolygon) && clipPolygon.length >= 3
      ? [[clipPolygon]]
      : [];
  const overlaps = [];

  for (let groupIndex = 0; groupIndex < (absoluteGroups || []).length - 1; groupIndex += 1) {
    const lowerGroup = absoluteGroups[groupIndex];
    const upperGroup = absoluteGroups[groupIndex + 1];
    let checkedLengthMeters = 0;
    let hitLengthMeters = 0;
    let hitCount = 0;
    let sampleCount = 0;

    for (const polygon of lowerGroup?.multiPolygon || []) {
      for (const ring of polygon || []) {
        for (const sample of sampleLocalLineMidpoints(closeLocalRing(ring))) {
          if (
            clipMultiPolygon.length &&
            distancePointToMultiPolygonBoundary(sample.point, clipMultiPolygon) <=
              clipToleranceMeters
          ) {
            continue;
          }

          checkedLengthMeters += Number(sample.lengthMeters || 0);
          sampleCount += 1;

          if (
            distancePointToMultiPolygonBoundary(
              sample.point,
              upperGroup?.multiPolygon || []
            ) <= toleranceMeters
          ) {
            hitLengthMeters += Number(sample.lengthMeters || 0);
            hitCount += 1;
          }
        }
      }
    }

    const overlapLengthMeters = Number(hitLengthMeters.toFixed(3));
    const overlapRatio =
      sampleCount > 0 ? Number((hitCount / sampleCount).toFixed(4)) : 0;

    if (
      overlapLengthMeters >= overlapLengthThresholdMeters &&
      overlapRatio >= 0.01
    ) {
      overlaps.push({
        lowerTopElevation: Number(lowerGroup?.topElevation),
        upperTopElevation: Number(upperGroup?.topElevation),
        overlapLengthMeters,
        overlapRatio,
        checkedLengthMeters: Number(checkedLengthMeters.toFixed(3)),
      });
    }
  }

  return overlaps;
}

function findForeignRawContourBoundaryOverlaps(
  siteContext,
  absoluteGroups,
  {
    toleranceMeters = 0.12,
    overlapRatioThreshold = 0.12,
    overlapLengthThresholdMeters = 1.2,
  } = {}
) {
  const groupRings = (absoluteGroups || []).map((group) => ({
    topElevation: Number(group?.topElevation),
    rings: (group?.multiPolygon || []).flatMap((polygon) => polygon || []),
  }));
  const overlaps = [];

  for (const [featureIndex, feature] of getContourBoundaryConflictFeatures(
    siteContext
  ).entries()) {
    const elevation = Number(feature?.properties?.elevation);

    if (!Number.isFinite(elevation)) {
      continue;
    }

    for (const [lineIndex, lineString] of getLineStringsFromGeometry(
      feature?.geometry
    ).entries()) {
      const localPoints = lineString.map((point) =>
        localMetersFromLngLat(point, siteContext.location)
      );
      const samples = sampleLocalLineMidpoints(localPoints);

      if (samples.length < 2) {
        continue;
      }

      for (const group of groupRings) {
        if (!(group.topElevation > elevation + 0.001)) {
          continue;
        }

        let hitCount = 0;
        let hitLengthMeters = 0;

        for (const sample of samples) {
          const distance = Math.min(
            ...group.rings.map((ring) => distancePointToRing(sample.point, ring))
          );

          if (distance <= toleranceMeters) {
            hitCount += 1;
            hitLengthMeters += Number(sample.lengthMeters || 0);
          }
        }

        const overlapRatio = hitCount / samples.length;
        const overlapLengthMeters = Number(hitLengthMeters.toFixed(3));

        if (
          overlapRatio >= overlapRatioThreshold ||
          (
            overlapLengthMeters >= overlapLengthThresholdMeters &&
            overlapRatio >= 0.01
          )
        ) {
          overlaps.push({
            featureIndex,
            lineIndex,
            elevation,
            upperTopElevation: group.topElevation,
            overlapRatio: Number(overlapRatio.toFixed(3)),
            overlapLengthMeters,
          });
        }
      }
    }
  }

  return overlaps;
}

function summarizeNativeContourInput(siteContext) {
  const features = siteContext?.contourLines?.features || [];
  const lineStringCount = features.reduce(
    (sum, feature) => sum + getLineStringsFromGeometry(feature?.geometry).length,
    0
  );
  const nativeElevations = [
    ...new Set(
      features
        .filter((feature) => feature?.properties?.generated !== true)
        .map((feature) => Number(feature?.properties?.elevation))
        .filter(Number.isFinite)
    ),
  ].sort((left, right) => left - right);

  return {
    featureCount: features.length,
    lineStringCount,
    nativeElevations,
  };
}

function createSketchUpMetricSummary() {
  return {
    pointCount: 0,
    zMin: Infinity,
    zMax: -Infinity,
    uniqueXY: new Set(),
  };
}

function accumulateSketchUpPoints(summary, points) {
  for (const point of points || []) {
    if (!Array.isArray(point) || point.length < 3) {
      continue;
    }

    const [x, y, z] = point.map(Number);

    if (![x, y, z].every(Number.isFinite)) {
      continue;
    }

    summary.pointCount += 1;
    summary.zMin = Math.min(summary.zMin, z);
    summary.zMax = Math.max(summary.zMax, z);
    summary.uniqueXY.add(`${x.toFixed(3)},${y.toFixed(3)}`);
  }
}

function finalizeSketchUpMetricSummary(summary) {
  return {
    pointCount: summary.pointCount,
    uniqueXYCount: summary.uniqueXY.size,
    zMin: summary.zMin === Infinity ? null : Number(summary.zMin.toFixed(3)),
    zMax: summary.zMax === -Infinity ? null : Number(summary.zMax.toFixed(3)),
  };
}

function summarizeSketchUpGroup(group) {
  const summary = createSketchUpMetricSummary();

  for (const face of group?.faces || []) {
    accumulateSketchUpPoints(summary, face);
  }

  for (const polyline of group?.polylines || []) {
    accumulateSketchUpPoints(summary, polyline?.points || []);
  }

  for (const solid of group?.solids || []) {
    const heightMeters = Number(solid?.heightMeters);
    const loops = [solid?.outerLoop || [], ...(solid?.holeLoops || [])];

    for (const loop of loops) {
      accumulateSketchUpPoints(summary, loop);

      if (!Number.isFinite(heightMeters)) {
        continue;
      }

      accumulateSketchUpPoints(
        summary,
        loop.map((point) =>
          Array.isArray(point)
            ? [point[0], point[1], Number(point[2]) + heightMeters]
            : point
        )
      );
    }
  }

  return {
    layer: String(group?.layer || ""),
    name: String(group?.name || ""),
    faceCount: Number(group?.faces?.length || 0),
    polylineCount: Number(group?.polylines?.length || 0),
    curvePolylineCount: Number(
      (group?.polylines || []).filter((polyline) => polyline?.curve === true)
        .length
    ),
    solidCount: Number(group?.solids?.length || 0),
    mergeSolids: group?.mergeSolids === true,
    softenEdges: group?.softenEdges === true,
    metadata: group?.metadata || null,
    ...finalizeSketchUpMetricSummary(summary),
  };
}

function summarizeSketchUpPayload(payload) {
  const groups = (payload?.groups || []).map(summarizeSketchUpGroup);
  const contourGroups = groups.filter((group) =>
    group.layer.startsWith("contours")
  );

  return {
    groupCount: Number(payload?.groups?.length || 0),
    terrainGroups: groups.filter((group) => group.layer === "terrain"),
    contourGroups,
    contourCurveCount: contourGroups.reduce(
      (sum, group) => sum + group.curvePolylineCount,
      0
    ),
    contourZMin: contourGroups.reduce(
      (minValue, group) =>
        Number.isFinite(group.zMin) ? Math.min(minValue, group.zMin) : minValue,
      Infinity
    ),
    contourZMax: contourGroups.reduce(
      (maxValue, group) =>
        Number.isFinite(group.zMax) ? Math.max(maxValue, group.zMax) : maxValue,
      -Infinity
    ),
  };
}

async function summarize3dm(bytes) {
  const rhino = await getRhino3dm();
  const doc = rhino.File3dm.fromByteArray(bytes);
  const layers = doc.layers();
  const objects = doc.objects();
  const summary = {};
  const roundCoord = (value) =>
    Number.isFinite(Number(value)) ? Number(Number(value).toFixed(3)) : null;
  const summarizeBoundingBox = (geometry) => {
    const bbox =
      geometry && typeof geometry.getBoundingBox === "function"
        ? geometry.getBoundingBox()
        : null;

    if (!bbox?.min || !bbox?.max) {
      return null;
    }

    return {
      minX: roundCoord(bbox.min[0]),
      maxX: roundCoord(bbox.max[0]),
      minY: roundCoord(bbox.min[1]),
      maxY: roundCoord(bbox.max[1]),
      minZ: roundCoord(bbox.min[2]),
      maxZ: roundCoord(bbox.max[2]),
    };
  };

  for (let index = 0; index < objects.count; index += 1) {
    const object = objects.get(index);
    const attributes =
      typeof object?.attributes === "function"
        ? object.attributes()
        : object?.attributes;
    const layerIndex = Number(attributes?.layerIndex);
    const layerName = Number.isInteger(layerIndex)
      ? layers.get(layerIndex)?.name
      : "unknown";
    const objectName =
      typeof attributes?.name === "function" ? attributes.name() : attributes?.name;
    const geometry = object.geometry();
    const isCurve = geometry instanceof rhino.Curve;
    const geometryType =
      geometry instanceof rhino.Curve
        ? "curve"
        : geometry instanceof rhino.Mesh
          ? "mesh"
          : geometry instanceof rhino.Extrusion
            ? "extrusion"
            : geometry instanceof rhino.Brep
              ? "brep"
              : geometry?.constructor?.name || "unknown";
    const entry = (summary[layerName] ||= {
      objects: 0,
      names: [],
      geometryTypes: {},
      curveCount: 0,
      curvePointCount: 0,
      zMin: Infinity,
      zMax: -Infinity,
      objectBounds: [],
    });

    entry.objects += 1;
    entry.geometryTypes[geometryType] =
      Number(entry.geometryTypes[geometryType] || 0) + 1;

    if (objectName) {
      entry.names.push(String(objectName));
    }

    const objectBounds = summarizeBoundingBox(geometry);

    if (objectBounds) {
      entry.objectBounds.push({
        name: objectName ? String(objectName) : "",
        ...objectBounds,
      });
    }

    if (!isCurve) {
      continue;
    }

    entry.curveCount += 1;
    entry.curvePointCount += Number(geometry.pointCount || 0);

    for (let pointIndex = 0; pointIndex < Number(geometry.pointCount || 0); pointIndex += 1) {
      const point = geometry.point(pointIndex);

      if (Array.isArray(point) && Number.isFinite(point[2])) {
        entry.zMin = Math.min(entry.zMin, Number(point[2]));
        entry.zMax = Math.max(entry.zMax, Number(point[2]));
      }
    }
  }

  for (const entry of Object.values(summary)) {
    entry.names = [...new Set(entry.names)];

    if (entry.zMin === Infinity) {
      entry.zMin = null;
      entry.zMax = null;
    }
  }

  return summary;
}

function getFeatureOuterRing(feature) {
  const geometry = feature?.geometry || feature;

  if (geometry?.type === "Polygon") {
    return geometry.coordinates?.[0] || [];
  }

  if (geometry?.type === "MultiPolygon") {
    return geometry.coordinates?.[0]?.[0] || [];
  }

  if (
    Array.isArray(geometry?.coordinates?.[0]) &&
    Array.isArray(geometry.coordinates[0][0])
  ) {
    return geometry.coordinates[0];
  }

  if (Array.isArray(geometry) && Array.isArray(geometry[0])) {
    return geometry;
  }

  return [];
}

function computeLocalClipBounds(siteContext) {
  const localPoints = getFeatureOuterRing(siteContext?.clipBoundary)
    .map((point) => localMetersFromLngLat(point, siteContext.location))
    .filter(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        Number.isFinite(Number(point[0])) &&
        Number.isFinite(Number(point[1]))
    );

  if (localPoints.length < 3) {
    return null;
  }

  return {
    minX: Math.min(...localPoints.map((point) => Number(point[0]))),
    maxX: Math.max(...localPoints.map((point) => Number(point[0]))),
    minY: Math.min(...localPoints.map((point) => Number(point[1]))),
    maxY: Math.max(...localPoints.map((point) => Number(point[1]))),
  };
}

function isLocalPointOnClipBounds(point, bounds, toleranceMeters = 0.5) {
  if (!bounds || !Array.isArray(point)) {
    return false;
  }

  const [xMeters, yMeters] = point.map(Number);
  const tolerance = Math.max(0.001, Number(toleranceMeters) || 0.001);

  return (
    Number.isFinite(xMeters) &&
    Number.isFinite(yMeters) &&
    xMeters >= bounds.minX - tolerance &&
    xMeters <= bounds.maxX + tolerance &&
    yMeters >= bounds.minY - tolerance &&
    yMeters <= bounds.maxY + tolerance &&
    (Math.abs(xMeters - bounds.minX) <= tolerance ||
      Math.abs(xMeters - bounds.maxX) <= tolerance ||
      Math.abs(yMeters - bounds.minY) <= tolerance ||
      Math.abs(yMeters - bounds.maxY) <= tolerance)
  );
}

function collectBoundaryContourElevationSamples(siteContext) {
  const bounds = computeLocalClipBounds(siteContext);

  if (!bounds) {
    return [];
  }

  const toleranceMeters = Math.max(
    0.12,
    Math.min(0.75, Number(siteContext?.terrainGrid?.step || 0) * 0.35 || 0.25)
  );
  const samples = [];
  const seen = new Set();

  for (const feature of siteContext?.contourLines?.features || []) {
    if (feature?.properties?.generated === true) {
      continue;
    }

    const elevation = Number(feature?.properties?.elevation);

    if (!Number.isFinite(elevation)) {
      continue;
    }

    for (const lineString of getLineStringsFromGeometry(feature?.geometry)) {
      for (const lngLat of lineString || []) {
        const localPoint = localMetersFromLngLat(lngLat, siteContext.location);

        if (!isLocalPointOnClipBounds(localPoint, bounds, toleranceMeters)) {
          continue;
        }

        const key = `${Number(elevation).toFixed(3)}:${Number(
          localPoint[0]
        ).toFixed(3)},${Number(localPoint[1]).toFixed(3)}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        samples.push({
          point: localPoint,
          elevation,
        });
      }
    }
  }

  return samples;
}

function summarizeSmoothBoundaryContourSurfaceAlignment(
  smoothTerrainHeightModel,
  exportSiteContext
) {
  const samples = collectBoundaryContourElevationSamples(exportSiteContext);

  if (!samples.length) {
    return {
      checkedCount: 0,
      maxDelta: null,
      mismatches: [],
    };
  }

  assertCondition(
    typeof smoothTerrainHeightModel?.heightAtLocalPoint === "function",
    "smooth height model should expose a sampleable terrain resolver"
  );

  const mismatches = [];
  let maxDelta = 0;

  for (const sample of samples) {
    const [xMeters, yMeters] = sample.point;
    const zMeters = Number(
      smoothTerrainHeightModel.heightAtLocalPoint(xMeters, yMeters)
    );
    const delta = Math.abs(zMeters - Number(sample.elevation));

    if (!Number.isFinite(delta)) {
      mismatches.push({
        x: Number(xMeters.toFixed(3)),
        y: Number(yMeters.toFixed(3)),
        expected: Number(sample.elevation.toFixed(3)),
        actual: null,
        delta: null,
      });
      continue;
    }

    maxDelta = Math.max(maxDelta, delta);

    if (delta > 0.75) {
      mismatches.push({
        x: Number(xMeters.toFixed(3)),
        y: Number(yMeters.toFixed(3)),
        expected: Number(sample.elevation.toFixed(3)),
        actual: Number(zMeters.toFixed(3)),
        delta: Number(delta.toFixed(3)),
      });
    }
  }

  return {
    checkedCount: samples.length,
    maxDelta: Number(maxDelta.toFixed(3)),
    mismatches,
  };
}

async function verifyStepped(siteContext, nativeSummary) {
  const exportSiteContext = prepareSiteContextForExport(
    siteContext,
    {
      ...CASE.options,
      terrainSurfaceMode: "stepped",
      exportFormat: "3dm",
    },
    "3dm"
  );
  const terrainPlan = resolveContourTerrainRenderPlan(exportSiteContext);
  const absoluteGroups = terrainPlan?.absoluteContourGroups || [];
  const absorbedBaseLikeGroupCount = Number(
    exportSiteContext?.stats?.absoluteContourBaseAbsorbedGroupCount ||
      terrainPlan?.absoluteContourBaseAbsorption?.absorbedGroupCount ||
      0
  );
  const expectedContourModelLevelCount = Math.max(
    0,
    nativeSummary.nativeElevations.length - absorbedBaseLikeGroupCount
  );
  const diagnostics = exportSiteContext?.stats?.terrainPipelineDiagnostics || {};
  const nativeExportAlignment = diagnostics.nativeExportAlignment || {};
  const curveTerrainAlignment = diagnostics.curveTerrainAlignment || {};
  const bandBoundaryAlignment = diagnostics.bandBoundaryAlignment || {};
  const areas = absoluteGroups.map((group) =>
    summarizeMultiPolygonArea(group?.multiPolygon || [])
  );
  const finalArtifactAreaThreshold = Number(
    exportSiteContext?.stats?.absoluteContourFinalArtifactAreaThreshold || 1
  );
  const tinyContourPolygons = absoluteGroups.flatMap((group, groupIndex) =>
    (group?.multiPolygon || [])
      .map((polygon, polygonIndex) => ({
        groupIndex,
        polygonIndex,
        topElevation: Number(group?.topElevation),
        area: summarizeMultiPolygonArea([polygon]),
      }))
      .filter(
        (entry) =>
          entry.area > 0 &&
          entry.area < Math.max(0.001, finalArtifactAreaThreshold - 0.001)
      )
  );
  const repeatedContourPolygons = findRepeatedContourPolygons(absoluteGroups);
  const adjacentSharedRings = findAdjacentSharedContourRings(absoluteGroups);
  const boundaryTouchingRegionHoles =
    findBoundaryTouchingRegionHoles(absoluteGroups);
  const boundaryOverlapGroups = [
    ...(terrainPlan?.absoluteContourBaseAbsorption?.absorbedGroups || []),
    ...absoluteGroups,
  ].filter((group) => group?.multiPolygon?.length);
  const adjacentInternalBoundaryOverlaps = findAdjacentInternalBoundaryOverlaps(
    boundaryOverlapGroups,
    terrainPlan?.clipPolygon || []
  );
  const foreignRawContourBoundaryOverlaps =
    findForeignRawContourBoundaryOverlaps(exportSiteContext, absoluteGroups);
  const nearDuplicateAdjacentAreas = areas
    .slice(1)
    .map((area, index) => ({
      lower: areas[index],
      upper: area,
      lowerIndex: index,
      upperIndex: index + 1,
      delta: Math.abs(area - areas[index]),
      ratio:
        Math.abs(area - areas[index]) /
        Math.max(1, Math.max(Math.abs(area), Math.abs(areas[index]))),
    }))
    .filter(
      (pair) =>
        Math.min(pair.lower, pair.upper) > 50 &&
        pair.delta <= Math.max(1, Math.max(pair.lower, pair.upper) * 0.005)
    );
  const uniqueAreaCount = new Set(areas.map((area) => area.toFixed(3))).size;
  const maxArea = areas.length ? Math.max(...areas) : 0;
  const minArea = areas.length ? Math.min(...areas.filter((area) => area > 0)) : 0;
  const bytes = await build3dmFromSiteContext(exportSiteContext);
  const model = await summarize3dm(bytes);
  const terrainNames = model.MODEL_TERRAIN?.names || [];
  const terrainObjectBounds = model.MODEL_TERRAIN?.objectBounds || [];
  const baseModelBounds = terrainObjectBounds.find(
    (entry) => entry.name === "TERRAIN_BASE_MODEL"
  );
  const contourModelBounds = terrainObjectBounds.filter((entry) =>
    String(entry.name || "").startsWith("TERRAIN_CONTOUR_MODEL")
  );
  const minContourModelZ = contourModelBounds.reduce(
    (minValue, entry) =>
      Number.isFinite(Number(entry.minZ))
        ? Math.min(minValue, Number(entry.minZ))
        : minValue,
    Infinity
  );
  const contourCurveLayer = model.CURVE_CONTOUR || {};
  const skpExportSiteContext = prepareSiteContextForExport(
    siteContext,
    {
      ...CASE.options,
      terrainSurfaceMode: "stepped",
      exportFormat: "skp-payload",
    },
    "skp-payload"
  );
  const skpPayload = summarizeSketchUpPayload(
    buildSketchUpPayloadFromSiteContext(skpExportSiteContext)
  );
  const skpTerrainNames = skpPayload.terrainGroups.map((group) => group.name);

  assertCondition(
    absoluteGroups.length + absorbedBaseLikeGroupCount >=
      nativeSummary.nativeElevations.length,
    `stepped absolute contour groups ${absoluteGroups.length} plus absorbed base-like groups ${absorbedBaseLikeGroupCount} should cover native levels ${nativeSummary.nativeElevations.length}`
  );
  assertCondition(
    Number(exportSiteContext?.stats?.absoluteContourRawAcceptedCount || 0) >=
      nativeSummary.lineStringCount,
    `stepped raw contour accepted count ${exportSiteContext?.stats?.absoluteContourRawAcceptedCount || 0} should preserve native line strings ${nativeSummary.lineStringCount}`
  );
  assertCondition(
    Number(exportSiteContext?.stats?.absoluteContourNestedDroppedLevelCount || 0) === 0,
    `stepped contour generation dropped nested levels: ${exportSiteContext?.stats?.absoluteContourNestedDroppedLevelCount || 0}`
  );
  assertCondition(
    Number(nativeExportAlignment.mismatchLevelCount || 0) === 0,
    `native/export contour level mismatch: ${(nativeExportAlignment.mismatchLevels || []).join(", ")}`
  );
  assertCondition(
    Number(curveTerrainAlignment.mismatchLevelCount || 0) === 0,
    `curve/terrain contour level mismatch: ${(curveTerrainAlignment.mismatchLevels || []).join(", ")}`
  );
  assertCondition(
    Number(bandBoundaryAlignment.mismatchLevelCount || 0) === 0,
    `band boundary contour level mismatch: ${(bandBoundaryAlignment.mismatchLevels || []).join(", ")}`
  );
  assertCondition(
    uniqueAreaCount >= 3 && maxArea > minArea * 3,
    `stepped contour footprint areas look collapsed: ${areas.join(", ")}`
  );
  assertCondition(
    tinyContourPolygons.length === 0,
    `stepped contour terrain contains tiny closure artifacts: ${tinyContourPolygons
      .map(
        (entry) =>
          `group=${entry.groupIndex + 1} polygon=${entry.polygonIndex + 1} top=${entry.topElevation} area=${entry.area}`
      )
      .join(", ")}`
  );
  assertCondition(
    repeatedContourPolygons.length === 0,
    `stepped contour terrain repeats identical polygons across levels: ${repeatedContourPolygons
      .map(
        (entry) =>
          `group=${entry.groupIndex + 1} top=${entry.topElevation} repeats group=${entry.previousGroupIndex + 1} top=${entry.previousTopElevation} area=${entry.area}`
      )
      .join(", ")}`
  );
  assertCondition(
    nearDuplicateAdjacentAreas.length === 0,
    `stepped adjacent contour footprints look duplicated: ${nearDuplicateAdjacentAreas
      .map(
        (pair) =>
          `${pair.lowerIndex}->${pair.upperIndex} ${pair.lower.toFixed(3)}=${pair.upper.toFixed(3)}`
      )
      .join(", ")}`
  );
  assertCondition(
    adjacentSharedRings.length === 0,
    `stepped adjacent contour levels share identical boundary rings: ${adjacentSharedRings
      .map(
        (entry) =>
          `${entry.lowerTopElevation}->${entry.upperTopElevation} lower(${entry.lowerRing.polygonIndex},${entry.lowerRing.ringIndex}) upper(${entry.upperRing.polygonIndex},${entry.upperRing.ringIndex})`
      )
      .join(", ")}`
  );
  assertCondition(
    boundaryTouchingRegionHoles.length === 0,
    `stepped contour regions contain holes touching the outer boundary: ${boundaryTouchingRegionHoles
      .map(
        (entry) =>
          `group=${entry.groupIndex + 1} region=${entry.regionIndex + 1} hole=${entry.holeIndex + 1} top=${entry.topElevation}`
      )
      .join(", ")}`
  );
  assertCondition(
    adjacentInternalBoundaryOverlaps.length === 0,
    `stepped adjacent contour levels share internal boundary segments: ${adjacentInternalBoundaryOverlaps
      .map(
        (entry) =>
          `${entry.lowerTopElevation}->${entry.upperTopElevation} length=${entry.overlapLengthMeters}m ratio=${entry.overlapRatio}`
      )
      .join(", ")}`
  );
  assertCondition(
    foreignRawContourBoundaryOverlaps.length === 0,
    `stepped upper contour levels reuse lower raw contour boundaries: ${foreignRawContourBoundaryOverlaps
      .map(
        (entry) =>
          `${entry.elevation}->${entry.upperTopElevation} feature=${entry.featureIndex} line=${entry.lineIndex} ratio=${entry.overlapRatio} length=${entry.overlapLengthMeters}m`
      )
      .join(", ")}`
  );
  assertCondition(
    terrainNames.includes("TERRAIN_BASE_MODEL"),
    "stepped 3dm should include separate TERRAIN_BASE_MODEL"
  );
  assertCondition(
    baseModelBounds &&
      contourModelBounds.every(
        (entry) =>
          entry.minX >= baseModelBounds.minX - 0.01 &&
          entry.maxX <= baseModelBounds.maxX + 0.01 &&
          entry.minY >= baseModelBounds.minY - 0.01 &&
          entry.maxY <= baseModelBounds.maxY + 0.01
      ),
    `stepped contour terrain exceeded model boundary: ${contourModelBounds
      .filter(
        (entry) =>
          !baseModelBounds ||
          entry.minX < baseModelBounds.minX - 0.01 ||
          entry.maxX > baseModelBounds.maxX + 0.01 ||
          entry.minY < baseModelBounds.minY - 0.01 ||
          entry.maxY > baseModelBounds.maxY + 0.01
      )
      .map(
        (entry) =>
          `${entry.name} x=${entry.minX}..${entry.maxX} y=${entry.minY}..${entry.maxY}`
      )
      .join(", ")}`
  );
  assertCondition(
    !baseModelBounds ||
      !Number.isFinite(minContourModelZ) ||
      Number(baseModelBounds.maxZ) <= minContourModelZ - 0.0005,
    `stepped base model should stay below contour model, got base maxZ=${baseModelBounds?.maxZ} contour minZ=${Number.isFinite(minContourModelZ) ? minContourModelZ : "none"}`
  );
  assertCondition(
    Number(model.MODEL_TERRAIN?.geometryTypes?.mesh || 0) === 0,
    "stepped 3dm terrain should not include mesh fallback objects"
  );
  assertCondition(
    terrainNames.filter((name) => name.startsWith("TERRAIN_CONTOUR_MODEL_")).length >=
      expectedContourModelLevelCount,
    "stepped 3dm should include one contour model per non-base-like native contour level"
  );
  assertCondition(
    Number(contourCurveLayer.curveCount || 0) >= nativeSummary.lineStringCount,
    `stepped CURVE_CONTOUR count ${contourCurveLayer.curveCount || 0} should preserve native line strings ${nativeSummary.lineStringCount}`
  );
  assertCondition(
    Math.abs(Number(contourCurveLayer.zMin || 0)) <= 0.001 &&
      Math.abs(Number(contourCurveLayer.zMax || 0)) <= 0.001,
    `stepped CURVE_CONTOUR z range should stay flat at 0, got ${contourCurveLayer.zMin}..${contourCurveLayer.zMax}`
  );
  assertCondition(
    skpTerrainNames.includes("TERRAIN_BASE_MODEL"),
    "stepped SKP payload should include separate TERRAIN_BASE_MODEL"
  );
  assertCondition(
    skpTerrainNames.includes("TERRAIN_CONTOUR_MODEL"),
    "stepped SKP payload should include TERRAIN_CONTOUR_MODEL"
  );
  assertCondition(
    Number(
      skpPayload.terrainGroups.find((group) => group.name === "TERRAIN_CONTOUR_MODEL")
        ?.solidCount || 0
    ) >= expectedContourModelLevelCount,
    "stepped SKP payload should include contour solids for non-base-like native contour levels"
  );
  assertCondition(
    skpPayload.contourCurveCount >= nativeSummary.lineStringCount,
    `stepped SKP contour curve count ${skpPayload.contourCurveCount} should preserve native line strings ${nativeSummary.lineStringCount}`
  );
  assertCondition(
    Math.abs(Number(skpPayload.contourZMin || 0)) <= 0.001 &&
      Math.abs(Number(skpPayload.contourZMax || 0)) <= 0.001,
    `stepped SKP contour curves should stay flat at 0, got ${skpPayload.contourZMin}..${skpPayload.contourZMax}`
  );

  return {
    bytes: bytes.length,
    absoluteGroupCount: absoluteGroups.length,
    absorbedBaseLikeGroupCount,
    footprintAreas: areas,
    adjacentSharedRingCount: adjacentSharedRings.length,
    boundaryTouchingRegionHoleCount: boundaryTouchingRegionHoles.length,
    adjacentInternalBoundaryOverlapCount: adjacentInternalBoundaryOverlaps.length,
    foreignRawContourBoundaryOverlapCount:
      foreignRawContourBoundaryOverlaps.length,
    modelTerrainObjectCount: Number(model.MODEL_TERRAIN?.objects || 0),
    contourCurveCount: Number(contourCurveLayer.curveCount || 0),
    skpPayload: {
      groupCount: skpPayload.groupCount,
      terrainGroups: skpPayload.terrainGroups.map((group) => ({
        name: group.name,
        faceCount: group.faceCount,
        solidCount: group.solidCount,
        zMin: group.zMin,
        zMax: group.zMax,
      })),
      contourCurveCount: skpPayload.contourCurveCount,
    },
  };
}

async function verifySmooth(siteContext, nativeSummary) {
  const exportSiteContext = prepareSiteContextForExport(
    siteContext,
    {
      ...CASE.options,
      terrainSurfaceMode: "smooth",
      exportFormat: "3dm",
    },
    "3dm"
  );
  const bytes = await build3dmFromSiteContext(exportSiteContext);
  const model = await summarize3dm(bytes);
  const smoothTerrainHeightModel = buildSmoothTerrainHeightModel(
    exportSiteContext,
    exportSiteContext.location,
    0
  );
  const boundaryContourSurfaceAlignment =
    summarizeSmoothBoundaryContourSurfaceAlignment(
      smoothTerrainHeightModel,
      exportSiteContext
    );
  const terrainNames = model.MODEL_TERRAIN?.names || [];
  const terrainObjectBounds = model.MODEL_TERRAIN?.objectBounds || [];
  const surfaceBounds = terrainObjectBounds.find(
    (entry) => entry.name === "MODEL_TERRAIN_SURFACE"
  );
  const contourCurveLayer = model.CURVE_CONTOUR || {};
  const skpExportSiteContext = prepareSiteContextForExport(
    siteContext,
    {
      ...CASE.options,
      terrainSurfaceMode: "smooth",
      exportFormat: "skp-payload",
    },
    "skp-payload"
  );
  const skpPayload = summarizeSketchUpPayload(
    buildSketchUpPayloadFromSiteContext(skpExportSiteContext)
  );
  const skpTerrainMesh = skpPayload.terrainGroups.find(
    (group) => group.name === "TERRAIN_MESH"
  );

  assertCondition(
    terrainNames.includes("MODEL_TERRAIN_SURFACE"),
    "smooth 3dm should include MODEL_TERRAIN_SURFACE"
  );
  assertCondition(
    surfaceBounds &&
      Number(surfaceBounds.minZ) <= Math.min(...nativeSummary.nativeElevations) + 0.5 &&
      Number(surfaceBounds.maxZ) >= Math.max(...nativeSummary.nativeElevations) - 0.5,
    `smooth 3dm terrain surface should span native contour elevations ${Math.min(
      ...nativeSummary.nativeElevations
    )}..${Math.max(...nativeSummary.nativeElevations)}, got ${surfaceBounds?.minZ}..${surfaceBounds?.maxZ}`
  );
  assertCondition(
    terrainNames.includes("MODEL_TERRAIN_SMOOTH_BOTTOM"),
    "smooth 3dm should include MODEL_TERRAIN_SMOOTH_BOTTOM"
  );
  assertCondition(
    terrainNames.filter((name) => name.startsWith("MODEL_TERRAIN_SMOOTH_SIDE_")).length >= 4,
    "smooth 3dm should include closed side wall surfaces"
  );
  assertCondition(
    Number(contourCurveLayer.curveCount || 0) >= nativeSummary.lineStringCount,
    `smooth CURVE_CONTOUR count ${contourCurveLayer.curveCount || 0} should preserve native line strings ${nativeSummary.lineStringCount}`
  );
  assertCondition(
    Math.abs(Number(contourCurveLayer.zMin || 0)) <= 0.001 &&
      Math.abs(Number(contourCurveLayer.zMax || 0)) <= 0.001,
    `smooth CURVE_CONTOUR z range should stay flat at 0, got ${contourCurveLayer.zMin}..${contourCurveLayer.zMax}`
  );
  assertCondition(
    boundaryContourSurfaceAlignment.checkedCount > 0,
    "smooth boundary contour alignment should sample native contours touching the model boundary"
  );
  assertCondition(
    boundaryContourSurfaceAlignment.mismatches.length === 0,
    `smooth terrain surface drifted from boundary-touching native contours: ${boundaryContourSurfaceAlignment.mismatches
      .slice(0, 8)
      .map(
        (entry) =>
          `(${entry.x},${entry.y}) expected=${entry.expected} actual=${entry.actual} delta=${entry.delta}`
      )
      .join(", ")}`
  );
  assertCondition(
    skpTerrainMesh,
    "smooth SKP payload should include TERRAIN_MESH"
  );
  assertCondition(
    skpTerrainMesh?.metadata?.closedMass === true,
    "smooth SKP TERRAIN_MESH should be a closed mass"
  );
  assertCondition(
    Number(skpTerrainMesh?.faceCount || 0) > Number(skpTerrainMesh?.metadata?.topFaceCount || 0),
    "smooth SKP TERRAIN_MESH should include side and bottom faces"
  );
  assertCondition(
    skpPayload.contourCurveCount >= nativeSummary.lineStringCount,
    `smooth SKP contour curve count ${skpPayload.contourCurveCount} should preserve native line strings ${nativeSummary.lineStringCount}`
  );
  assertCondition(
    Math.abs(Number(skpPayload.contourZMin || 0)) <= 0.001 &&
      Math.abs(Number(skpPayload.contourZMax || 0)) <= 0.001,
    `smooth SKP contour curves should stay flat at 0, got ${skpPayload.contourZMin}..${skpPayload.contourZMax}`
  );

  return {
    bytes: bytes.length,
    modelTerrainObjectCount: Number(model.MODEL_TERRAIN?.objects || 0),
    contourCurveCount: Number(contourCurveLayer.curveCount || 0),
    boundaryContourSurfaceAlignment,
    skpPayload: {
      groupCount: skpPayload.groupCount,
      terrainMesh: {
        faceCount: Number(skpTerrainMesh?.faceCount || 0),
        zMin: skpTerrainMesh?.zMin ?? null,
        zMax: skpTerrainMesh?.zMax ?? null,
        closedMass: skpTerrainMesh?.metadata?.closedMass === true,
      },
      contourCurveCount: skpPayload.contourCurveCount,
    },
  };
}

function assertGoldenDefaults(nativeSummary, stepped, smooth) {
  assertNumberEquals(
    nativeSummary.featureCount,
    GOLDEN.nativeFeatureCount,
    "native contour feature count"
  );
  assertNumberEquals(
    nativeSummary.lineStringCount,
    GOLDEN.nativeLineStringCount,
    "native contour line string count"
  );
  assertArrayEquals(
    nativeSummary.nativeElevations,
    GOLDEN.nativeElevations,
    "native contour elevations"
  );

  assertNumberRange(
    stepped.bytes,
    GOLDEN.stepped.minBytes,
    GOLDEN.stepped.maxBytes,
    "stepped 3dm byte size"
  );
  assertNumberEquals(
    stepped.absoluteGroupCount,
    GOLDEN.stepped.absoluteGroupCount,
    "stepped absolute contour group count"
  );
  assertNumberEquals(
    stepped.absorbedBaseLikeGroupCount,
    GOLDEN.stepped.absorbedBaseLikeGroupCount,
    "stepped absorbed base-like group count"
  );
  assertNumberEquals(
    stepped.modelTerrainObjectCount,
    GOLDEN.stepped.modelTerrainObjectCount,
    "stepped 3dm terrain object count"
  );
  assertNumberEquals(
    stepped.contourCurveCount,
    GOLDEN.stepped.contourCurveCount,
    "stepped 3dm contour curve count"
  );
  assertNumberEquals(
    stepped.skpPayload?.groupCount,
    GOLDEN.stepped.skpGroupCount,
    "stepped skp payload group count"
  );
  assertNumberEquals(
    stepped.skpPayload?.contourCurveCount,
    GOLDEN.stepped.skpContourCurveCount,
    "stepped skp payload contour curve count"
  );

  const steppedBase = stepped.skpPayload?.terrainGroups?.find(
    (group) => group.name === "TERRAIN_BASE_MODEL"
  );
  const steppedContours = stepped.skpPayload?.terrainGroups?.find(
    (group) => group.name === "TERRAIN_CONTOUR_MODEL"
  );
  assertNumberEquals(
    steppedBase?.solidCount,
    GOLDEN.stepped.baseSolidCount,
    "stepped skp base solid count"
  );
  assertNumberEquals(
    steppedContours?.solidCount,
    GOLDEN.stepped.contourSolidCount,
    "stepped skp contour solid count"
  );

  assertNumberRange(
    smooth.bytes,
    GOLDEN.smooth.minBytes,
    GOLDEN.smooth.maxBytes,
    "smooth 3dm byte size"
  );
  assertNumberEquals(
    smooth.modelTerrainObjectCount,
    GOLDEN.smooth.modelTerrainObjectCount,
    "smooth 3dm terrain object count"
  );
  assertNumberEquals(
    smooth.contourCurveCount,
    GOLDEN.smooth.contourCurveCount,
    "smooth 3dm contour curve count"
  );
  assertNumberEquals(
    smooth.skpPayload?.groupCount,
    GOLDEN.smooth.skpGroupCount,
    "smooth skp payload group count"
  );
  assertNumberEquals(
    smooth.skpPayload?.terrainMesh?.faceCount,
    GOLDEN.smooth.skpTerrainFaceCount,
    "smooth skp terrain face count"
  );
  assertNumberEquals(
    smooth.skpPayload?.contourCurveCount,
    GOLDEN.smooth.skpContourCurveCount,
    "smooth skp payload contour curve count"
  );
  assertCondition(
    smooth.skpPayload?.terrainMesh?.closedMass === true,
    "smooth skp terrain mesh should remain closed"
  );
}

async function main() {
  const siteContext = await fetchSiteContext();
  const nativeSummary = summarizeNativeContourInput(siteContext);

  assertCondition(
    nativeSummary.nativeElevations.length >= 3,
    "test case should include multiple native contour levels"
  );

  const stepped = await verifyStepped(siteContext, nativeSummary);
  const smooth = await verifySmooth(siteContext, nativeSummary);
  assertGoldenDefaults(nativeSummary, stepped, smooth);

  console.log(
    JSON.stringify(
      {
        ok: true,
        verifiedAt: new Date().toISOString(),
        baseUrl: BASE_URL,
        case: CASE.name,
        nativeSummary,
        stepped,
        smooth,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
