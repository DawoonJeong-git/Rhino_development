import { createServer } from "node:http";
import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import earcut from "earcut";
import polygonClipping from "polygon-clipping";
import proj4 from "proj4";
import * as shapefile from "shapefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const configPath = path.join(__dirname, "config.local.json");
const METERS_PER_DEGREE_LAT = 111_320;
const OPEN_METEO_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const OPEN_METEO_MAX_POINTS_PER_REQUEST = 100;
const SITE_CONTEXT_CACHE_TTL_MS = 1000 * 60 * 10;
const TERRAIN_SOURCE_SPATIAL_RESOLUTION_METERS = 90;
const MIN_CONTOUR_INTERVAL_METERS = 1;
const TERRAIN_GRID_MIN_STEP_METERS = 10;
const DEFAULT_TERRAIN_CONTOUR_CRS = "EPSG:5179";
const RHINO6_FILE3DM_VERSION = 6;
const REQUEST_PROGRESS_TTL_MS = 1000 * 60 * 20;
const openMeteoElevationCache = new Map();
const siteContextCache = new Map();
const terrainContourCatalogCache = new Map();
const terrainContourDatasetCache = new Map();
const requestProgressStore = new Map();
const contourBandGroupCache = new WeakMap();
const contourTopSurfaceCache = new WeakMap();
let rhino3dmInstancePromise = null;

proj4.defs(
  "EPSG:5179",
  "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs +type=crs"
);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function formatErrorForLog(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logServerError(context, error) {
  console.error(
    `[${new Date().toISOString()}] ${context}\n${formatErrorForLog(error)}`
  );
}

process.on("unhandledRejection", (reason) => {
  logServerError("Unhandled promise rejection", reason);
});

process.on("uncaughtExceptionMonitor", (error, origin) => {
  logServerError(`Uncaught exception monitor (${origin})`, error);
});

async function loadLocalConfig() {
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeConfigString(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return "";
  }

  if (
    normalized.startsWith("__PUT_") ||
    normalized.startsWith("{{") ||
    normalized.startsWith("<<")
  ) {
    return "";
  }

  return normalized;
}

function normalizeContourInterval(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return MIN_CONTOUR_INTERVAL_METERS;
  }

  return Math.max(
    MIN_CONTOUR_INTERVAL_METERS,
    Number(numericValue.toFixed(3))
  );
}

function quantizeAbsoluteElevation(height, interval) {
  if (!Number.isFinite(height)) {
    return height;
  }

  const normalizedInterval = normalizeContourInterval(interval);
  const bandIndex = Math.floor(height / normalizedInterval + 1e-9);

  return Number((bandIndex * normalizedInterval).toFixed(3));
}

function resolveTerrainSampleStep(widthMeters, heightMeters, options = {}) {
  const longestSide = Math.max(widthMeters, heightMeters);
  const areaSquareMeters = Math.max(1, widthMeters * heightMeters);
  const contourInterval = normalizeContourInterval(options.contourInterval);
  const preferredStep =
    contourInterval <= 1
      ? 10
      : contourInterval <= 2
        ? 12
        : contourInterval <= 5
          ? 18
          : contourInterval <= 10
            ? 24
            : contourInterval <= 20
              ? 32
              : 40;
  const pointBudget =
    longestSide >= 1600 ? 2401 : longestSide >= 900 ? 2209 : 1849;
  const budgetLimitedStep = Math.sqrt(areaSquareMeters / pointBudget);
  const lowerBound = Math.max(
    TERRAIN_GRID_MIN_STEP_METERS,
    Number(budgetLimitedStep.toFixed(3))
  );
  const upperBound =
    longestSide >= 1600
      ? TERRAIN_SOURCE_SPATIAL_RESOLUTION_METERS / 1.5
      : longestSide >= 900
        ? TERRAIN_SOURCE_SPATIAL_RESOLUTION_METERS / 2
        : TERRAIN_SOURCE_SPATIAL_RESOLUTION_METERS / 3;

  return Number(
    Math.min(upperBound, Math.max(lowerBound, preferredStep)).toFixed(3)
  );
}

function buildSiteContextCacheKey(location = {}, options = {}) {
  return JSON.stringify({
    lat: Number(location.lat || 0).toFixed(6),
    lng: Number(location.lng || 0).toFixed(6),
    radius: Math.max(30, Number(options.radius) || 120),
    contourInterval: normalizeContourInterval(options.contourInterval),
    terrainMode: options.terrainMode || "contour",
    includeContours: options.includeContours !== false,
    includeBuildings: options.includeBuildings !== false,
    includeParcelBoundary: options.includeParcelBoundary !== false,
    includeRoads: options.includeRoads === true,
  });
}

function buildRuntimeConfig(localConfig) {
  return {
    port: Number(process.env.PORT || localConfig.PORT || 3000),
    vworldApiKey: normalizeConfigString(
      process.env.VWORLD_API_KEY || localConfig.VWORLD_API_KEY || ""
    ),
    vworldApiDomain: normalizeConfigString(
      process.env.VWORLD_API_DOMAIN || localConfig.VWORLD_API_DOMAIN || ""
    ),
    jusoConfirmKey: normalizeConfigString(
      process.env.JUSO_CONFIRM_KEY || localConfig.JUSO_CONFIRM_KEY || ""
    ),
    buildingHubServiceKey: normalizeConfigString(
      process.env.BUILDING_HUB_SERVICE_KEY ||
        localConfig.BUILDING_HUB_SERVICE_KEY ||
        ""
    ),
    lawApiOc: normalizeConfigString(
      process.env.LAW_API_OC || localConfig.LAW_API_OC || ""
    ),
    terrainDemPath: normalizeConfigString(
      process.env.TERRAIN_DEM_PATH || localConfig.TERRAIN_DEM_PATH || ""
    ),
    terrainContourPath: normalizeConfigString(
      process.env.TERRAIN_CONTOUR_PATH || localConfig.TERRAIN_CONTOUR_PATH || ""
    ),
    terrainContourCrs: normalizeConfigString(
      process.env.TERRAIN_CONTOUR_CRS ||
        localConfig.TERRAIN_CONTOUR_CRS ||
        DEFAULT_TERRAIN_CONTOUR_CRS
    ),
    useNominatimFallback:
      String(
        process.env.USE_NOMINATIM_FALLBACK ??
          localConfig.USE_NOMINATIM_FALLBACK ??
          "true"
      ).toLowerCase() !== "false",
  };
}

function pruneRequestProgressStore() {
  const now = Date.now();

  for (const [token, entry] of requestProgressStore.entries()) {
    if (now - Number(entry?.updatedAt || 0) > REQUEST_PROGRESS_TTL_MS) {
      requestProgressStore.delete(token);
    }
  }
}

function readRequestProgressToken(request) {
  const headerValue = request?.headers?.["x-progress-token"];

  if (Array.isArray(headerValue)) {
    return String(headerValue[0] || "").trim();
  }

  return String(headerValue || "").trim();
}

function updateRequestProgress(token, nextState) {
  if (!token) {
    return null;
  }

  pruneRequestProgressStore();
  const now = Date.now();
  const existing = requestProgressStore.get(token) || {
    token,
    operation: "request",
    state: "active",
    percent: 0,
    message: "",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    error: "",
  };
  const merged = {
    ...existing,
    ...nextState,
    token,
    percent: Math.max(0, Math.min(100, Number(nextState?.percent ?? existing.percent) || 0)),
    message:
      nextState && Object.prototype.hasOwnProperty.call(nextState, "message")
        ? nextState.message ?? existing.message
        : existing.message,
    updatedAt: now,
  };

  requestProgressStore.set(token, merged);
  return merged;
}

function beginRequestProgress(token, operation, message) {
  if (!token) {
    return null;
  }

  const now = Date.now();
  pruneRequestProgressStore();
  const entry = {
    token,
    operation: String(operation || "request"),
    state: "active",
    percent: 0,
    message: String(message || "").trim(),
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    error: "",
  };

  requestProgressStore.set(token, entry);
  return entry;
}

function completeRequestProgress(token, message) {
  return updateRequestProgress(token, {
    state: "done",
    percent: 100,
    message: String(message || "완료되었습니다.").trim(),
    completedAt: Date.now(),
    error: "",
  });
}

function failRequestProgress(token, error) {
  const message = formatErrorForLog(error) || "요청 처리 중 오류가 발생했습니다.";
  return updateRequestProgress(token, {
    state: "error",
    message,
    completedAt: Date.now(),
    error: message,
  });
}

function createRangedProgressReporter(token, startPercent, endPercent) {
  if (!token) {
    return null;
  }

  const rangeStart = Number(startPercent) || 0;
  const rangeEnd = Number(endPercent) || 100;
  const span = rangeEnd - rangeStart;

  return (percent, message, extraState = {}) => {
    const normalizedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
    return updateRequestProgress(token, {
      ...extraState,
      percent: rangeStart + (span * normalizedPercent) / 100,
      message:
        typeof message === "string" && message.trim()
          ? message.trim()
          : undefined,
    });
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, payload, filename = null) {
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  };

  if (filename) {
    headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    headers["X-Export-Filename"] = filename;
  }

  response.writeHead(statusCode, headers);
  response.end(payload);
}

function sendBinary(
  response,
  statusCode,
  payload,
  contentType = "application/octet-stream",
  filename = null
) {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  };

  if (filename) {
    headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    headers["X-Export-Filename"] = filename;
  }

  response.writeHead(statusCode, headers);
  response.end(payload);
}

function sendHtml(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

async function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    request.on("data", (chunk) => {
      rawBody += chunk;
    });

    request.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

async function serveStatic(requestPath, response) {
  const resolvedPath =
    requestPath === "/"
      ? path.join(publicDir, "index.html")
      : path.join(publicDir, requestPath);
  const normalizedPath = path.normalize(resolvedPath);

  if (!normalizedPath.startsWith(publicDir)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(normalizedPath);
    const filePath = fileStat.isDirectory()
      ? path.join(normalizedPath, "index.html")
      : normalizedPath;
    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();

    response.writeHead(200, {
      "Content-Type":
        contentTypes[ext] || "application/octet-stream; charset=utf-8",
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

async function getRhino3dm() {
  if (!rhino3dmInstancePromise) {
    rhino3dmInstancePromise = import("rhino3dm").then(({ default: rhino3dm }) =>
      rhino3dm()
    );
  }

  return rhino3dmInstancePromise;
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10))
    );
}

function cleanHtmlText(value) {
  return stripHtml(decodeHtmlEntities(value));
}

function normalizeRegionName(value) {
  const replacements = [
    ["서울특별시", "서울"],
    ["부산광역시", "부산"],
    ["대구광역시", "대구"],
    ["인천광역시", "인천"],
    ["광주광역시", "광주"],
    ["대전광역시", "대전"],
    ["울산광역시", "울산"],
    ["세종특별자치시", "세종"],
    ["제주특별자치도", "제주"],
    ["강원특별자치도", "강원"],
    ["전북특별자치도", "전북"],
    ["경기도", "경기"],
    ["충청북도", "충북"],
    ["충청남도", "충남"],
    ["전라북도", "전북"],
    ["전라남도", "전남"],
    ["경상북도", "경북"],
    ["경상남도", "경남"],
  ];

  return replacements.reduce(
    (text, [source, target]) => text.replaceAll(source, target),
    String(value || "")
  );
}

function normalizeSystemAddress(value) {
  return normalizeRegionName(
    String(value || "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/대한민국/g, " ")
      .replace(/\b\d{5}\b/g, " ")
      .replace(/,/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function buildSystemAddress(location) {
  return normalizeSystemAddress(
    location?.roadAddress || location?.parcelAddress || location?.label || ""
  );
}

async function readEncodedResponseText(response, encoding) {
  const buffer = await response.arrayBuffer();
  return new TextDecoder(encoding).decode(buffer);
}

function metersToLatDegrees(meters) {
  return meters / METERS_PER_DEGREE_LAT;
}

function metersToLngDegrees(meters, lat) {
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return meters / (METERS_PER_DEGREE_LAT * cosLat);
}

function lngLatFromMeters(center, xMeters, yMeters) {
  return [
    center.lng + metersToLngDegrees(xMeters, center.lat),
    center.lat + metersToLatDegrees(yMeters),
  ];
}

function localMetersFromLngLat(point, center) {
  const x =
    (point[0] - center.lng) * METERS_PER_DEGREE_LAT * Math.cos((center.lat * Math.PI) / 180);
  const y = (point[1] - center.lat) * METERS_PER_DEGREE_LAT;
  return [x, y];
}

function closeRing(ring) {
  if (!ring.length) {
    return ring;
  }

  const first = ring[0];
  const last = ring[ring.length - 1];

  if (first[0] === last[0] && first[1] === last[1]) {
    return ring;
  }

  return [...ring, first];
}

function createCircleRing(center, radiusMeters, steps = 64) {
  const ring = [];

  for (let index = 0; index < steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    ring.push(
      lngLatFromMeters(
        center,
        Math.cos(angle) * radiusMeters,
        Math.sin(angle) * radiusMeters
      )
    );
  }

  return closeRing(ring);
}

function createRectangleRing(center, widthMeters, heightMeters) {
  const halfWidth = widthMeters / 2;
  const halfHeight = heightMeters / 2;

  return closeRing([
    lngLatFromMeters(center, -halfWidth, -halfHeight),
    lngLatFromMeters(center, halfWidth, -halfHeight),
    lngLatFromMeters(center, halfWidth, halfHeight),
    lngLatFromMeters(center, -halfWidth, halfHeight),
  ]);
}

function polygonFeature(ring, properties = {}) {
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: [closeRing(ring)],
    },
  };
}

function lineFeature(line, properties = {}) {
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "LineString",
      coordinates: line,
    },
  };
}

function featureCollection(features) {
  return {
    type: "FeatureCollection",
    features,
  };
}

function getOuterRing(feature) {
  if (!feature?.geometry) {
    return null;
  }

  if (feature.geometry.type === "Polygon") {
    return feature.geometry.coordinates?.[0] || null;
  }

  if (feature.geometry.type === "MultiPolygon") {
    return feature.geometry.coordinates?.[0]?.[0] || null;
  }

  return null;
}

function getOuterRings(feature) {
  if (!feature?.geometry) {
    return [];
  }

  if (feature.geometry.type === "Polygon") {
    return feature.geometry.coordinates?.[0]
      ? [feature.geometry.coordinates[0]]
      : [];
  }

  if (feature.geometry.type === "MultiPolygon") {
    return (feature.geometry.coordinates || [])
      .map((polygonCoordinates) => polygonCoordinates?.[0] || null)
      .filter(Boolean);
  }

  return [];
}

function pointInRing(point, ring) {
  let inside = false;

  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
    const xi = ring[current][0];
    const yi = ring[current][1];
    const xj = ring[previous][0];
    const yj = ring[previous][1];

    const intersect =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-9) + xi;

    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}

function openRing(ring) {
  if (!Array.isArray(ring) || !ring.length) {
    return [];
  }

  if (
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  ) {
    return ring.slice(0, -1);
  }

  return [...ring];
}

function signedAreaLocalRing(localRing) {
  if (!localRing?.length) {
    return 0;
  }

  let sum = 0;

  for (let index = 0; index < localRing.length; index += 1) {
    const current = localRing[index];
    const next = localRing[(index + 1) % localRing.length];
    sum += current.x * next.y - next.x * current.y;
  }

  return sum / 2;
}

function dedupeLocalRing(localRing) {
  const nextRing = [];

  for (const point of localRing) {
    const previous = nextRing[nextRing.length - 1];

    if (
      previous &&
      Math.abs(previous.x - point.x) < 1e-6 &&
      Math.abs(previous.y - point.y) < 1e-6
    ) {
      continue;
    }

    nextRing.push(point);
  }

  if (nextRing.length >= 2) {
    const first = nextRing[0];
    const last = nextRing[nextRing.length - 1];

    if (
      Math.abs(first.x - last.x) < 1e-6 &&
      Math.abs(first.y - last.y) < 1e-6
    ) {
      nextRing.pop();
    }
  }

  return nextRing;
}

function lineIntersectionLocal(segmentStart, segmentEnd, edgeStart, edgeEnd) {
  const x1 = segmentStart.x;
  const y1 = segmentStart.y;
  const x2 = segmentEnd.x;
  const y2 = segmentEnd.y;
  const x3 = edgeStart.x;
  const y3 = edgeStart.y;
  const x4 = edgeEnd.x;
  const y4 = edgeEnd.y;
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);

  if (Math.abs(denominator) < 1e-9) {
    return null;
  }

  const determinant1 = x1 * y2 - y1 * x2;
  const determinant2 = x3 * y4 - y3 * x4;

  return {
    x:
      (determinant1 * (x3 - x4) - (x1 - x2) * determinant2) / denominator,
    y:
      (determinant1 * (y3 - y4) - (y1 - y2) * determinant2) / denominator,
  };
}

function clipRingWithConvexRing(subjectRing, clipRing, center) {
  const subjectOpen = openRing(subjectRing);
  const clipOpen = openRing(clipRing);

  if (subjectOpen.length < 3 || clipOpen.length < 3) {
    return null;
  }

  const subjectLocal = subjectOpen.map((point) => {
    const [x, y] = localMetersFromLngLat(point, center);
    return { x, y };
  });
  let clipLocal = clipOpen.map((point) => {
    const [x, y] = localMetersFromLngLat(point, center);
    return { x, y };
  });

  if (signedAreaLocalRing(clipLocal) < 0) {
    clipLocal = [...clipLocal].reverse();
  }

  let output = dedupeLocalRing(subjectLocal);

  for (let index = 0; index < clipLocal.length; index += 1) {
    const edgeStart = clipLocal[index];
    const edgeEnd = clipLocal[(index + 1) % clipLocal.length];
    const input = output;
    output = [];

    if (!input.length) {
      break;
    }

    let segmentStart = input[input.length - 1];

    for (const segmentEnd of input) {
      const endCross =
        (edgeEnd.x - edgeStart.x) * (segmentEnd.y - edgeStart.y) -
        (edgeEnd.y - edgeStart.y) * (segmentEnd.x - edgeStart.x);
      const startCross =
        (edgeEnd.x - edgeStart.x) * (segmentStart.y - edgeStart.y) -
        (edgeEnd.y - edgeStart.y) * (segmentStart.x - edgeStart.x);
      const endInside = endCross >= -1e-7;
      const startInside = startCross >= -1e-7;

      if (endInside) {
        if (!startInside) {
          const intersection = lineIntersectionLocal(
            segmentStart,
            segmentEnd,
            edgeStart,
            edgeEnd
          );

          if (intersection) {
            output.push(intersection);
          }
        }

        output.push(segmentEnd);
      } else if (startInside) {
        const intersection = lineIntersectionLocal(
          segmentStart,
          segmentEnd,
          edgeStart,
          edgeEnd
        );

        if (intersection) {
          output.push(intersection);
        }
      }

      segmentStart = segmentEnd;
    }

    output = dedupeLocalRing(output);
  }

  if (output.length < 3) {
    return null;
  }

  return closeRing(
    output.map((point) => lngLatFromMeters(center, point.x, point.y))
  );
}

function clipFeatureToRing(feature, clipRing, center) {
  if (!feature?.geometry || !clipRing?.length) {
    return null;
  }

  const clippedRings = getOuterRings(feature)
    .map((ring) => clipRingWithConvexRing(ring, clipRing, center))
    .filter((ring) => polygonAreaSquareMeters(ring) > 1);

  if (!clippedRings.length) {
    return null;
  }

  if (clippedRings.length === 1) {
    return {
      ...feature,
      geometry: {
        type: "Polygon",
        coordinates: [clippedRings[0]],
      },
    };
  }

  return {
    ...feature,
    geometry: {
      type: "MultiPolygon",
      coordinates: clippedRings.map((ring) => [ring]),
    },
  };
}

function polygonBounds(ring) {
  return ring.reduce(
    (accumulator, point) => ({
      minLng: Math.min(accumulator.minLng, point[0]),
      minLat: Math.min(accumulator.minLat, point[1]),
      maxLng: Math.max(accumulator.maxLng, point[0]),
      maxLat: Math.max(accumulator.maxLat, point[1]),
    }),
    {
      minLng: Number.POSITIVE_INFINITY,
      minLat: Number.POSITIVE_INFINITY,
      maxLng: Number.NEGATIVE_INFINITY,
      maxLat: Number.NEGATIVE_INFINITY,
    }
  );
}

function polygonBoundsOverlap(leftBounds, rightBounds) {
  return !(
    leftBounds.maxLng < rightBounds.minLng ||
    leftBounds.minLng > rightBounds.maxLng ||
    leftBounds.maxLat < rightBounds.minLat ||
    leftBounds.minLat > rightBounds.maxLat
  );
}

function polygonBoundsContainBounds(outerBounds, innerBounds) {
  return (
    outerBounds.minLng <= innerBounds.minLng &&
    outerBounds.maxLng >= innerBounds.maxLng &&
    outerBounds.minLat <= innerBounds.minLat &&
    outerBounds.maxLat >= innerBounds.maxLat
  );
}

function polygonBoundsAreaScore(bounds) {
  return Math.max(0, bounds.maxLng - bounds.minLng) * Math.max(0, bounds.maxLat - bounds.minLat);
}

function selectPreferredContourCatalogEntries(entries, clipBounds) {
  const containingEntries = entries.filter(
    (entry) => entry.bounds && polygonBoundsContainBounds(entry.bounds, clipBounds)
  );

  if (!containingEntries.length) {
    return entries;
  }

  const smallestArea = Math.min(
    ...containingEntries.map((entry) => polygonBoundsAreaScore(entry.bounds))
  );

  return containingEntries.filter(
    (entry) => polygonBoundsAreaScore(entry.bounds) <= smallestArea * 1.1
  );
}

function polygonAreaSquareMeters(ring) {
  if (!ring || ring.length < 4) {
    return 0;
  }

  const origin = ring[0];
  let sum = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = localMetersFromLngLat(ring[index], {
      lng: origin[0],
      lat: origin[1],
    });
    const next = localMetersFromLngLat(ring[index + 1], {
      lng: origin[0],
      lat: origin[1],
    });
    sum += current[0] * next[1] - next[0] * current[1];
  }

  return Math.abs(sum) / 2;
}

function centroidOfRing(ring) {
  const area = polygonAreaSquareMeters(ring);

  if (!area) {
    return ring[0];
  }

  const origin = { lng: ring[0][0], lat: ring[0][1] };
  let sumX = 0;
  let sumY = 0;
  let factorSum = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = localMetersFromLngLat(ring[index], origin);
    const next = localMetersFromLngLat(ring[index + 1], origin);
    const factor = current[0] * next[1] - next[0] * current[1];
    sumX += (current[0] + next[0]) * factor;
    sumY += (current[1] + next[1]) * factor;
    factorSum += factor;
  }

  const centroidX = sumX / (3 * factorSum);
  const centroidY = sumY / (3 * factorSum);
  return lngLatFromMeters(origin, centroidX, centroidY);
}

function isPointInsideFeature(point, feature) {
  return getOuterRings(feature).some((ring) => pointInRing(point, ring));
}

function featureIntersectsRing(feature, clipRing) {
  if (!clipRing?.length) {
    return false;
  }

  const clipBounds = polygonBounds(clipRing);

  return getOuterRings(feature).some((ring) => {
    if (!ring?.length) {
      return false;
    }

    if (!polygonBoundsOverlap(polygonBounds(ring), clipBounds)) {
      return false;
    }

    const centroid = centroidOfRing(ring);

    if (centroid && pointInRing(centroid, clipRing)) {
      return true;
    }

    if (ring.some((point) => pointInRing(point, clipRing))) {
      return true;
    }

    if (clipRing.some((point) => pointInRing(point, ring))) {
      return true;
    }

    return false;
  });
}

function createMockParcelFeature(location) {
  const seed = Math.abs(
    Math.round((location.lat * 10_000 + location.lng * 10_000) % 1000)
  );
  const width = 28 + (seed % 7) * 4;
  const depth = 20 + (seed % 5) * 5;
  const chamfer = Math.min(width, depth) * 0.18;
  const rawLocalRing = [
    [-width / 2, -depth / 2],
    [width / 2 - chamfer, -depth / 2],
    [width / 2, -depth / 2 + chamfer],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ];
  const rotation = ((seed % 15) - 7) * (Math.PI / 180);

  const ring = rawLocalRing.map(([x, y]) => {
    const rotatedX = x * Math.cos(rotation) - y * Math.sin(rotation);
    const rotatedY = x * Math.sin(rotation) + y * Math.cos(rotation);
    return lngLatFromMeters(location, rotatedX, rotatedY);
  });

  return polygonFeature(ring, {
    provider: "mock",
    pnu: `MOCK-${seed}`,
    areaSqm: Math.round(width * depth - (chamfer * chamfer) / 2),
  });
}

function parseFeatureCollection(payload) {
  const status = payload?.response?.status || payload?.status;
  const message = payload?.response?.message || payload?.message;

  if (status && status !== "OK") {
    throw new Error(message || `Provider error: ${status}`);
  }

  const candidates = [
    payload,
    payload?.response?.result?.featureCollection,
    payload?.response?.result,
    payload?.result?.featureCollection,
    payload?.result,
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (candidate.type === "FeatureCollection" && Array.isArray(candidate.features)) {
      return candidate;
    }

    if (Array.isArray(candidate.features)) {
      return featureCollection(candidate.features);
    }
  }

  return featureCollection([]);
}

function normalizeCrsId(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized || "EPSG:4326";
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

function buildBoundsFromPoints(points) {
  if (!points?.length) {
    return null;
  }

  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) {
      continue;
    }

    const lng = Number(point[0]);
    const lat = Number(point[1]);

    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      continue;
    }

    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  }

  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) {
    return null;
  }

  return { minLng, minLat, maxLng, maxLat };
}

function buildBoundsFromLineStrings(lineStrings) {
  return buildBoundsFromPoints(lineStrings.flat());
}

function normalizeContourElevation(properties = {}) {
  const preferredKeys = new Set([
    "CONT",
    "ELEVATION",
    "ELEV",
    "ELEV_M",
    "ALTITUDE",
    "ALT",
    "ALTI",
    "HEIGHT",
    "HGT",
    "Z",
    "VALUE",
    "LEV",
    "LEVEL",
    "CNTR",
    "CONTOUR",
    "CTRLNHG",
  ]);

  for (const [rawKey, rawValue] of Object.entries(properties || {})) {
    const key = String(rawKey || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    const numericValue = Number(rawValue);

    if (preferredKeys.has(key) && Number.isFinite(numericValue)) {
      return Number(numericValue.toFixed(3));
    }
  }

  return null;
}

function createCoordinateTransformer(sourceCrs) {
  const normalizedSource = normalizeCrsId(sourceCrs);

  if (normalizedSource === "EPSG:4326") {
    return (point) => [Number(point[0]), Number(point[1])];
  }

  return (point) => proj4(normalizedSource, "EPSG:4326", point);
}

function normalizeLineStringCoordinates(lineString, transformPoint) {
  const normalized = [];

  for (const point of lineString || []) {
    if (!Array.isArray(point) || point.length < 2) {
      continue;
    }

    const transformedPoint = transformPoint
      ? transformPoint([Number(point[0]), Number(point[1])])
      : [Number(point[0]), Number(point[1])];
    const lng = Number(transformedPoint?.[0]);
    const lat = Number(transformedPoint?.[1]);

    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      continue;
    }

    const previous = normalized[normalized.length - 1];

    if (
      previous &&
      Math.abs(previous[0] - lng) < 1e-10 &&
      Math.abs(previous[1] - lat) < 1e-10
    ) {
      continue;
    }

    normalized.push([
      Number(lng.toFixed(9)),
      Number(lat.toFixed(9)),
    ]);
  }

  return normalized.length >= 2 ? normalized : null;
}

function buildContourFeatureRecord(geometry, properties = {}, transformPoint = null) {
  const lineStrings = getLineStringsFromGeometry(geometry)
    .map((lineString) => normalizeLineStringCoordinates(lineString, transformPoint))
    .filter(Boolean);

  if (!lineStrings.length) {
    return null;
  }

  const elevation = normalizeContourElevation(properties);
  const nextProperties = Number.isFinite(elevation)
    ? { ...properties, elevation }
    : { ...properties };

  return {
    type: "Feature",
    properties: nextProperties,
    geometry:
      lineStrings.length === 1
        ? { type: "LineString", coordinates: lineStrings[0] }
        : { type: "MultiLineString", coordinates: lineStrings },
    bounds: buildBoundsFromLineStrings(lineStrings),
  };
}

function pointsMatchOnBounds(a, b, tolerance = 1e-10) {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

function clipSegmentToBounds(start, end, bounds) {
  let t0 = 0;
  let t1 = 1;
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const tests = [
    [-deltaX, start[0] - bounds.minLng],
    [deltaX, bounds.maxLng - start[0]],
    [-deltaY, start[1] - bounds.minLat],
    [deltaY, bounds.maxLat - start[1]],
  ];

  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) {
        return null;
      }

      continue;
    }

    const ratio = q / p;

    if (p < 0) {
      if (ratio > t1) {
        return null;
      }

      t0 = Math.max(t0, ratio);
    } else {
      if (ratio < t0) {
        return null;
      }

      t1 = Math.min(t1, ratio);
    }
  }

  return [
    [
      Number((start[0] + deltaX * t0).toFixed(9)),
      Number((start[1] + deltaY * t0).toFixed(9)),
    ],
    [
      Number((start[0] + deltaX * t1).toFixed(9)),
      Number((start[1] + deltaY * t1).toFixed(9)),
    ],
  ];
}

function clipLineStringToBounds(lineString, bounds) {
  if (!lineString?.length || lineString.length < 2) {
    return [];
  }

  const parts = [];

  for (let index = 0; index < lineString.length - 1; index += 1) {
    const start = lineString[index];
    const end = lineString[index + 1];
    const clippedSegment = clipSegmentToBounds(start, end, bounds);

    if (!clippedSegment) {
      continue;
    }

    const [clippedStart, clippedEnd] = clippedSegment;
    const lastPart = parts[parts.length - 1];
    const lastPoint = lastPart?.[lastPart.length - 1];

    if (!lastPart || !lastPoint || !pointsMatchOnBounds(lastPoint, clippedStart)) {
      parts.push([clippedStart, clippedEnd]);
      continue;
    }

    if (!pointsMatchOnBounds(lastPoint, clippedEnd)) {
      lastPart.push(clippedEnd);
    }
  }

  return parts
    .map((part) => {
      const deduped = [];

      for (const point of part) {
        if (!deduped.length || !pointsMatchOnBounds(deduped[deduped.length - 1], point)) {
          deduped.push(point);
        }
      }

      return deduped;
    })
    .filter((part) => part.length >= 2);
}

function clipLineGeometryToBounds(geometry, bounds) {
  const lineStrings = getLineStringsFromGeometry(geometry);

  if (!lineStrings.length) {
    return null;
  }

  const clippedLineStrings = lineStrings.flatMap((lineString) =>
    clipLineStringToBounds(lineString, bounds)
  );

  if (!clippedLineStrings.length) {
    return null;
  }

  return clippedLineStrings.length === 1
    ? {
        type: "LineString",
        coordinates: clippedLineStrings[0],
      }
    : {
        type: "MultiLineString",
        coordinates: clippedLineStrings,
      };
}

async function loadGeoJsonTerrainContourDataset(filePath, sourceCrs) {
  const raw = await readFile(filePath, "utf8");
  const payload = JSON.parse(raw);
  const collection = parseFeatureCollection(payload);
  const transformPoint = createCoordinateTransformer(sourceCrs);
  const features = [];

  for (const feature of collection.features || []) {
    const record = buildContourFeatureRecord(
      feature?.geometry,
      feature?.properties || {},
      transformPoint
    );

    if (record?.bounds) {
      features.push(record);
    }
  }

  return {
    path: filePath,
    sourceCrs: normalizeCrsId(sourceCrs),
    sourceType: "geojson",
    provider: "official-contours",
    mode: "file",
    note: "Contour map comes from a local official source file.",
    features,
  };
}

function resolveSiblingFilePath(filePath, extension) {
  const parsedPath = path.parse(filePath);
  return path.join(parsedPath.dir, `${parsedPath.name}${extension}`);
}

async function loadShapefileTerrainContourDataset(filePath, sourceCrs) {
  const dbfPath = resolveSiblingFilePath(filePath, ".dbf");
  const transformPoint = createCoordinateTransformer(sourceCrs);
  const features = [];
  const source = await shapefile.open(filePath, dbfPath, {
    encoding: "utf-8",
  });

  while (true) {
    const result = await source.read();

    if (result.done) {
      break;
    }

    const record = buildContourFeatureRecord(
      result.value?.geometry,
      result.value?.properties || {},
      transformPoint
    );

    if (record?.bounds) {
      features.push(record);
    }
  }

  return {
    path: filePath,
    sourceCrs: normalizeCrsId(sourceCrs),
    sourceType: "shapefile",
    provider: "official-contours",
    mode: "file",
    note: "Contour map comes from a local official source file.",
    features,
  };
}

async function loadTerrainContourDatasetByPath(filePath, sourceCrs) {
  const metadata = await stat(filePath);
  const cacheKey = JSON.stringify({
    path: filePath,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
    crs: normalizeCrsId(sourceCrs),
  });
  const cachedDataset = terrainContourDatasetCache.get(cacheKey);

  if (cachedDataset) {
    return cachedDataset;
  }

  const extension = path.extname(filePath).toLowerCase();
  let dataset = null;

  if (extension === ".json" || extension === ".geojson") {
    dataset = await loadGeoJsonTerrainContourDataset(filePath, sourceCrs);
  } else if (extension === ".shp") {
    dataset = await loadShapefileTerrainContourDataset(filePath, sourceCrs);
  } else {
    throw new Error(
      `Unsupported contour source format: ${extension || "unknown"}`
    );
  }

  terrainContourDatasetCache.set(cacheKey, dataset);
  return dataset;
}

async function collectContourSourceFiles(rootPath) {
  const pendingPaths = [rootPath];
  const files = [];

  while (pendingPaths.length) {
    const currentPath = pendingPaths.pop();
    const entries = await readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const resolvedPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        pendingPaths.push(resolvedPath);
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (extension === ".shp" || extension === ".json" || extension === ".geojson") {
        files.push(resolvedPath);
      }
    }
  }

  return files.sort();
}

async function readShapefileHeaderBounds(filePath, sourceCrs) {
  const handle = await open(filePath, "r");

  try {
    const header = Buffer.alloc(100);
    await handle.read(header, 0, 100, 0);
    const minX = header.readDoubleLE(36);
    const minY = header.readDoubleLE(44);
    const maxX = header.readDoubleLE(52);
    const maxY = header.readDoubleLE(60);
    const transformPoint = createCoordinateTransformer(sourceCrs);
    const corners = [
      [minX, minY],
      [minX, maxY],
      [maxX, minY],
      [maxX, maxY],
    ].map((point) => transformPoint(point));

    return buildBoundsFromPoints(corners);
  } finally {
    await handle.close();
  }
}

async function buildTerrainContourCatalogEntry(filePath, sourceCrs) {
  const extension = path.extname(filePath).toLowerCase();
  const metadata = await stat(filePath);
  let bounds = null;

  if (extension === ".shp") {
    bounds = await readShapefileHeaderBounds(filePath, sourceCrs);
  } else {
    const dataset = await loadTerrainContourDatasetByPath(filePath, sourceCrs);
    bounds = buildBoundsFromPoints(
      dataset.features.flatMap((feature) =>
        getLineStringsFromGeometry(feature.geometry).flat()
      )
    );
  }

  return {
    path: filePath,
    extension,
    bounds,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
  };
}

async function buildTerrainContourCatalog(contourPath, sourceCrs) {
  const metadata = await stat(contourPath);
  const cacheKey = JSON.stringify({
    path: contourPath,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
    crs: normalizeCrsId(sourceCrs),
  });
  const cachedCatalog = terrainContourCatalogCache.get(cacheKey);

  if (cachedCatalog) {
    return cachedCatalog;
  }

  const sourceFiles = metadata.isDirectory()
    ? await collectContourSourceFiles(contourPath)
    : [contourPath];
  const entries = [];

  for (const filePath of sourceFiles) {
    const entry = await buildTerrainContourCatalogEntry(filePath, sourceCrs);

    if (entry.bounds) {
      entries.push(entry);
    }
  }

  const catalog = {
    rootPath: contourPath,
    sourceCrs: normalizeCrsId(sourceCrs),
    provider: "official-contours",
    mode: metadata.isDirectory() ? "directory" : "file",
    note: metadata.isDirectory()
      ? "Contour map comes from a local official source directory."
      : "Contour map comes from a local official source file.",
    entries,
  };

  terrainContourCatalogCache.clear();
  terrainContourCatalogCache.set(cacheKey, catalog);
  return catalog;
}

async function resolveOfficialContourCollection(clipFeature, config) {
  if (!config.terrainContourPath) {
    return null;
  }

  const clipRing = getOuterRing(clipFeature);

  if (!clipRing?.length) {
    return null;
  }

  const clipBounds = polygonBounds(clipRing);
  const catalog = await buildTerrainContourCatalog(
    config.terrainContourPath,
    config.terrainContourCrs
  );
  const overlappingEntries = catalog.entries.filter(
    (entry) => entry.bounds && polygonBoundsOverlap(entry.bounds, clipBounds)
  );
  const candidateEntries = selectPreferredContourCatalogEntries(
    overlappingEntries,
    clipBounds
  );
  const features = [];

  for (const entry of candidateEntries) {
    const dataset = await loadTerrainContourDatasetByPath(
      entry.path,
      catalog.sourceCrs
    );

    for (const record of dataset.features || []) {
      if (!record?.bounds || !polygonBoundsOverlap(record.bounds, clipBounds)) {
        continue;
      }

      const clippedGeometry = clipLineGeometryToBounds(record.geometry, clipBounds);

      if (!clippedGeometry) {
        continue;
      }

      features.push({
        type: "Feature",
        properties: { ...record.properties },
        geometry: clippedGeometry,
      });
    }
  }

  return {
    provider: catalog.provider,
    mode: catalog.mode,
    note: `${catalog.note} ${candidateEntries.length} source file(s) matched the current area.`,
    interval: estimateContourIntervalFromFeatures(features),
    collection: featureCollection(features),
  };
}

function pickPolygonFeature(features, location) {
  const point = [location.lng, location.lat];

  for (const feature of features) {
    const ring = getOuterRing(feature);

    if (ring && pointInRing(point, ring)) {
      return feature;
    }
  }

  return features.find((feature) => Boolean(getOuterRing(feature))) || null;
}

async function fetchVWorldFeatureCollection(
  dataLayer,
  geomFilter,
  buffer,
  config,
  size = 50,
  page = 1
) {
  const params = new URLSearchParams({
    key: config.vworldApiKey,
    service: "data",
    request: "GetFeature",
    version: "2.0",
    data: dataLayer,
    geomFilter,
    buffer: String(buffer),
    geometry: "true",
    size: String(size),
    page: String(page),
    format: "json",
    crs: "EPSG:4326",
  });

  if (config.vworldApiDomain) {
    params.set("domain", config.vworldApiDomain);
  }

  const response = await fetch(`https://api.vworld.kr/req/data?${params}`);

  if (!response.ok) {
    throw new Error(`VWorld data request failed with ${response.status}`);
  }

  const payload = await response.json();
  return parseFeatureCollection(payload);
}

async function fetchAllVWorldFeatureCollections(
  dataLayer,
  geomFilter,
  buffer,
  config,
  size = 250,
  maxPages = 6
) {
  const featureMap = new Map();

  for (let page = 1; page <= maxPages; page += 1) {
    const collection = await fetchVWorldFeatureCollection(
      dataLayer,
      geomFilter,
      buffer,
      config,
      size,
      page
    );
    const features = collection.features || [];

    for (const feature of features) {
      const key = String(
        feature?.id ||
          feature?.properties?.bd_mgt_sn ||
          feature?.properties?.pk ||
          JSON.stringify(feature?.geometry || {})
      );

      if (!featureMap.has(key)) {
        featureMap.set(key, feature);
      }
    }

    if (features.length < size) {
      break;
    }
  }

  return featureCollection([...featureMap.values()]);
}

function mapVWorldSearchItems(items, searchType) {
  return (items || [])
    .map((item, index) => ({
      id: item.id || `vworld-${index}`,
      label:
        stripHtml(item.title) ||
        item.address?.road ||
        item.address?.parcel ||
        "검색 결과",
      roadAddress: item.address?.road || "",
      parcelAddress: item.address?.parcel || "",
      lat: Number(item.point?.y || item.y),
      lng: Number(item.point?.x || item.x),
      provider: "vworld",
      searchType,
    }))
    .filter(
      (item) => Number.isFinite(item.lat) && Number.isFinite(item.lng) && item.label
    );
}

function dedupeSearchItems(items) {
  const seen = new Set();

  return items.filter((item) => {
    const key = [
      item.label,
      item.roadAddress,
      item.parcelAddress,
      item.lat.toFixed(6),
      item.lng.toFixed(6),
    ].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function normalizeAddressKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[()\-\.,]/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeDigits(value, length = 0) {
  const digits = String(value || "").replace(/\D+/g, "");
  return length ? digits.padStart(length, "0").slice(-length) : digits;
}

function buildPnuFromParts(admCd, mtYn, bun, ji) {
  const legalCodeDigits = normalizeDigits(admCd);
  const mainNumberDigits = normalizeDigits(bun);

  if (legalCodeDigits.length !== 10 || !mainNumberDigits.length) {
    return "";
  }

  const legalCode = legalCodeDigits;
  const pnuPlatGbCd = String(mtYn ?? "0").trim() === "1" ? "2" : "1";
  const mainNumber = mainNumberDigits.padStart(4, "0").slice(-4);
  const subNumber = normalizeDigits(ji, 4);

  return `${legalCode}${pnuPlatGbCd}${mainNumber}${subNumber}`;
}

function getVWorldResponseStatus(payload) {
  return String(payload?.response?.status || payload?.status || "").trim();
}

function getVWorldResponseErrorText(payload) {
  return (
    payload?.response?.error?.text ||
    payload?.response?.message ||
    payload?.message ||
    ""
  );
}

function buildJusoSearchItem(item, index) {
  const pnu = buildPnuFromParts(
    item.admCd,
    item.mtYn,
    item.lnbrMnnm,
    item.lnbrSlno
  );

  return {
    id: item.bdMgtSn || `juso-${index}`,
    label:
      item.roadAddrPart1 ||
      item.roadAddr ||
      item.jibunAddr ||
      item.bdNm ||
      "주소 검색 결과",
    roadAddress: item.roadAddr || item.roadAddrPart1 || "",
    parcelAddress: item.jibunAddr || "",
    provider: "juso",
    searchType: item.roadAddr ? "road" : "parcel",
    buildingName: item.bdNm || "",
    pnu,
    juso: {
      admCd: normalizeDigits(item.admCd, 10),
      rnMgtSn: item.rnMgtSn || "",
      bdMgtSn: item.bdMgtSn || "",
      roadAddrPart1: item.roadAddrPart1 || "",
      roadAddrPart2: item.roadAddrPart2 || "",
      jibunAddr: item.jibunAddr || "",
      roadAddr: item.roadAddr || "",
      zipNo: item.zipNo || "",
      mtYn: String(item.mtYn ?? "0"),
      lnbrMnnm: normalizeDigits(item.lnbrMnnm, 4),
      lnbrSlno: normalizeDigits(item.lnbrSlno, 4),
      buldMnnm: normalizeDigits(item.buldMnnm, 5),
      buldSlno: normalizeDigits(item.buldSlno, 5),
      siNm: item.siNm || "",
      sggNm: item.sggNm || "",
      emdNm: item.emdNm || "",
    },
  };
}

async function searchJuso(query, config) {
  const params = new URLSearchParams({
    confmKey: config.jusoConfirmKey,
    currentPage: "1",
    countPerPage: "10",
    keyword: query,
    resultType: "json",
    hstryYn: "Y",
    firstSort: "none",
    addInfoYn: "Y",
  });

  const response = await fetch(
    `https://business.juso.go.kr/addrlink/addrLinkApi.do?${params}`
  );

  if (!response.ok) {
    throw new Error(`Juso search failed with ${response.status}`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload?.results?.juso)
    ? payload.results.juso
    : payload?.results?.juso
      ? [payload.results.juso]
      : [];

  return items.map(buildJusoSearchItem);
}

function scoreAddressMatch(baseItem, jusoItem) {
  const baseRoad = normalizeAddressKey(baseItem.roadAddress);
  const baseParcel = normalizeAddressKey(baseItem.parcelAddress);
  const jusoRoad = normalizeAddressKey(jusoItem.roadAddress);
  const jusoParcel = normalizeAddressKey(jusoItem.parcelAddress);
  let score = 0;

  if (baseRoad && jusoRoad) {
    if (baseRoad === jusoRoad) {
      score += 100;
    } else if (baseRoad.startsWith(jusoRoad) || jusoRoad.startsWith(baseRoad)) {
      score += 70;
    }
  }

  if (baseParcel && jusoParcel) {
    if (baseParcel === jusoParcel) {
      score += 80;
    } else if (
      baseParcel.includes(jusoParcel) ||
      jusoParcel.includes(baseParcel)
    ) {
      score += 50;
    }
  }

  if (
    baseItem.buildingName &&
    jusoItem.buildingName &&
    normalizeAddressKey(baseItem.buildingName) ===
      normalizeAddressKey(jusoItem.buildingName)
  ) {
    score += 20;
  }

  return score;
}

function mergeVWorldAndJuso(vworldItems, jusoItems) {
  const matchedJusoIds = new Set();
  const merged = vworldItems.map((item) => {
    let bestMatch = null;
    let bestScore = 0;

    for (const candidate of jusoItems) {
      if (matchedJusoIds.has(candidate.id)) {
        continue;
      }

      const score = scoreAddressMatch(item, candidate);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    if (bestMatch && bestScore >= 70) {
      matchedJusoIds.add(bestMatch.id);
      return {
        ...item,
        provider: "vworld+juso",
        pnu: bestMatch.pnu || item.pnu || "",
        buildingName: bestMatch.buildingName || item.buildingName || "",
        juso: bestMatch.juso,
        roadAddress: bestMatch.roadAddress || item.roadAddress,
        parcelAddress: bestMatch.parcelAddress || item.parcelAddress,
      };
    }

    return item;
  });

  const remainingJuso = jusoItems.filter((item) => !matchedJusoIds.has(item.id));
  return { merged, remainingJuso };
}

async function geocodeJusoCandidate(item, config) {
  const query = item.roadAddress || item.parcelAddress || item.label;

  if (!query) {
    return null;
  }

  let result = null;

  if (config.vworldApiKey) {
    const roadResults = item.roadAddress
      ? await searchVWorldCategory(item.roadAddress, "road", config)
      : [];
    const parcelResults =
      roadResults.length === 0 && item.parcelAddress
        ? await searchVWorldCategory(item.parcelAddress, "parcel", config)
        : [];
    result = roadResults[0] || parcelResults[0] || null;
  }

  if (!result && config.useNominatimFallback) {
    const fallbackResults = await geocodeWithNominatim(query);
    result = fallbackResults[0] || null;
  }

  if (!result) {
    return null;
  }

  return {
    ...result,
    provider: config.vworldApiKey ? "juso+vworld" : "juso+nominatim",
    pnu: item.pnu || "",
    buildingName: item.buildingName || result.buildingName || "",
    juso: item.juso,
    roadAddress: item.roadAddress || result.roadAddress,
    parcelAddress: item.parcelAddress || result.parcelAddress,
    label: item.label || result.label,
  };
}

async function geocodeWithPreferredProviders(query, config) {
  let vworldItems = [];
  let jusoItems = [];

  if (config.vworldApiKey) {
    try {
      vworldItems = await geocodeWithVWorld(query, config);
    } catch (error) {
      if (!config.useNominatimFallback) {
        throw error;
      }
    }
  }

  if (config.jusoConfirmKey) {
    jusoItems = await searchJuso(query, config);
  }

  if (vworldItems.length && jusoItems.length) {
    const { merged, remainingJuso } = mergeVWorldAndJuso(vworldItems, jusoItems);
    const hydrated = [];

    for (const candidate of remainingJuso.slice(0, 4)) {
      const item = await geocodeJusoCandidate(candidate, config);

      if (item) {
        hydrated.push(item);
      }
    }

    return {
      provider: hydrated.length ? "vworld+juso" : "vworld",
      results: dedupeSearchItems([...merged, ...hydrated]),
    };
  }

  if (vworldItems.length) {
    return { provider: "vworld", results: dedupeSearchItems(vworldItems) };
  }

  if (jusoItems.length) {
    const hydrated = [];

    for (const candidate of jusoItems.slice(0, 5)) {
      const item = await geocodeJusoCandidate(candidate, config);

      if (item) {
        hydrated.push(item);
      }
    }

    return {
      provider: hydrated.length ? "juso+geocoded" : "juso",
      results: dedupeSearchItems(hydrated),
    };
  }

  if (config.useNominatimFallback) {
    return {
      provider: "nominatim",
      results: await geocodeWithNominatim(query),
    };
  }

  return {
    provider: "none",
    results: [],
  };
}

function extractPnuFromValue(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits.length === 19 ? digits : "";
}

function extractPnuFromProperties(properties) {
  if (!properties || typeof properties !== "object") {
    return "";
  }

  for (const key of ["pnu", "PNU", "Pnu"]) {
    const value = extractPnuFromValue(properties[key]);

    if (value) {
      return value;
    }
  }

  for (const value of Object.values(properties)) {
    const pnu = extractPnuFromValue(value);

    if (pnu) {
      return pnu;
    }
  }

  return "";
}

function normalizeParcelFeature(feature) {
  const properties = feature?.properties || {};

  return {
    ...feature,
    properties: {
      ...properties,
      pnu: extractPnuFromProperties(properties),
      addr: properties.addr || properties.ADDR || "",
      jibun: properties.jibun || properties.JIBUN || "",
    },
  };
}

function buildVWorldBuildingAddress(properties) {
  const parts = [
    properties.sido,
    properties.sigungu,
    properties.gu,
    properties.rd_nm,
    [properties.bld_s, properties.bld_e].filter(Boolean).join("-"),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return normalizeSystemAddress(parts.join(" "));
}

function estimateBuildingHeightMeters(properties) {
  const floors = Number(properties.gro_flo_co || 0);

  if (Number.isFinite(floors) && floors > 0) {
    return Number((floors * 3.4 + 1.2).toFixed(2));
  }

  return 9;
}

function normalizeBuildingFeature(feature, parcelFeature = null) {
  const properties = feature?.properties || {};
  const ring = getOuterRing(feature);
  const centroid = ring ? centroidOfRing(ring) : null;
  const parcelRing = parcelFeature ? getOuterRing(parcelFeature) : null;

  return {
    ...feature,
    properties: {
      ...properties,
      buildingId: String(
        properties.bd_mgt_sn || properties.pk || feature?.id || ""
      ).trim(),
      buildingName: String(
        properties.buld_nm || properties.buld_nm_dc || ""
      ).trim(),
      roadAddress: buildVWorldBuildingAddress(properties),
      aboveGroundFloors: Number(properties.gro_flo_co || 0),
      belowGroundFloors: Number(properties.und_flo_co || 0),
      heightMeters: estimateBuildingHeightMeters(properties),
      footprintAreaSqm: Number(
        (ring ? polygonAreaSquareMeters(ring) : 0).toFixed(2)
      ),
      centroidLng: centroid ? Number(centroid[0].toFixed(8)) : null,
      centroidLat: centroid ? Number(centroid[1].toFixed(8)) : null,
      isTarget:
        Boolean(parcelRing && featureIntersectsRing(feature, parcelRing)),
      sourceLayer: "lt_c_spbd",
    },
  };
}

function attachBuildingRegisterMetadata(
  buildingFeatures,
  buildingRegisterItems,
  parcelFeature
) {
  if (!buildingFeatures.length || !buildingRegisterItems.length || !parcelFeature) {
    return buildingFeatures;
  }

  const parcelRing = getOuterRing(parcelFeature);

  if (!parcelRing) {
    return buildingFeatures;
  }

  const nextFeatures = buildingFeatures.map((feature) => ({
    ...feature,
    properties: { ...(feature.properties || {}) },
  }));

  const targetFeatureIndexes = nextFeatures
    .map((feature, index) => {
      const centroid = [
        Number(feature.properties?.centroidLng),
        Number(feature.properties?.centroidLat),
      ];

      if (!Number.isFinite(centroid[0]) || !Number.isFinite(centroid[1])) {
        return null;
      }

      return pointInRing(centroid, parcelRing) ? index : null;
    })
    .filter((value) => value !== null);

  const sortedTargetIndexes = targetFeatureIndexes.sort((left, right) => {
    const leftArea = Number(nextFeatures[left].properties?.footprintAreaSqm || 0);
    const rightArea = Number(nextFeatures[right].properties?.footprintAreaSqm || 0);
    return rightArea - leftArea;
  });

  const sortedRegisterItems = [...buildingRegisterItems].sort(
    (left, right) => Number(right.totalAreaSqm || 0) - Number(left.totalAreaSqm || 0)
  );

  for (
    let index = 0;
    index < Math.min(sortedTargetIndexes.length, sortedRegisterItems.length);
    index += 1
  ) {
    const feature = nextFeatures[sortedTargetIndexes[index]];
    const registerItem = sortedRegisterItems[index];

    feature.properties = {
      ...feature.properties,
      buildingName:
        feature.properties.buildingName ||
        registerItem.buildingName ||
        registerItem.dongName ||
        "",
      roadAddress:
        registerItem.roadAddress || feature.properties.roadAddress || "",
      mainPurpose: registerItem.mainPurpose || "",
      registerBuildingId: registerItem.id || "",
      registerMatched: true,
      totalAreaSqm: Number(registerItem.totalAreaSqm || 0),
      heightMeters:
        Number(registerItem.heightMeters || 0) > 0
          ? Number(registerItem.heightMeters)
          : Number(feature.properties.heightMeters || 0),
      aboveGroundFloors:
        Number(registerItem.aboveGroundFloors || 0) > 0
          ? Number(registerItem.aboveGroundFloors)
          : Number(feature.properties.aboveGroundFloors || 0),
      belowGroundFloors:
        Number(registerItem.belowGroundFloors || 0) > 0
          ? Number(registerItem.belowGroundFloors)
          : Number(feature.properties.belowGroundFloors || 0),
    };
  }

  return nextFeatures;
}

function decomposePnu(pnu) {
  const normalized = extractPnuFromValue(pnu);

  if (normalized.length !== 19) {
    return null;
  }

  const pnuPlatGbCd = normalized.slice(10, 11);

  return {
    pnu: normalized,
    sigunguCd: normalized.slice(0, 5),
    bjdongCd: normalized.slice(5, 10),
    pnuPlatGbCd,
    platGbCd: pnuPlatGbCd === "2" ? "1" : "0",
    bun: normalized.slice(11, 15),
    ji: normalized.slice(15, 19),
  };
}

function resolveParcelReference(body) {
  const location = body.location || {};
  const siteContext = body.siteContext || {};
  const parcelBoundary = siteContext.parcelBoundary || {};
  const parcelProperties = parcelBoundary.properties || {};
  const locationJuso = location.juso || {};

  for (const candidate of [
    body.pnu,
    location.pnu,
    parcelProperties.pnu,
    parcelProperties.PNU,
  ]) {
    const parcelReference = decomposePnu(candidate);

    if (parcelReference) {
      return parcelReference;
    }
  }

  const builtPnu = buildPnuFromParts(
    locationJuso.admCd,
    locationJuso.mtYn,
    locationJuso.lnbrMnnm,
    locationJuso.lnbrSlno
  );

  return decomposePnu(builtPnu);
}

function normalizeOpenApiFieldValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "";
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim();
  return normalized;
}

function extractOpenApiSourceFields(record) {
  const sourceFields = {};

  for (const [key, value] of Object.entries(record || {})) {
    const normalized = normalizeOpenApiFieldValue(value);

    if (
      normalized === "" ||
      normalized === null ||
      normalized === undefined
    ) {
      continue;
    }

    sourceFields[key] = normalized;
  }

  return sourceFields;
}

function buildBuildingHubParams(parcelReference, config, numOfRows = 100) {
  return new URLSearchParams({
    serviceKey: config.buildingHubServiceKey,
    sigunguCd: parcelReference.sigunguCd,
    bjdongCd: parcelReference.bjdongCd,
    platGbCd: parcelReference.platGbCd,
    bun: parcelReference.bun,
    ji: parcelReference.ji,
    numOfRows: String(numOfRows),
    pageNo: "1",
    _type: "json",
  });
}

function normalizeOpenApiItems(payload) {
  const rawItems = payload?.response?.body?.items?.item;

  if (Array.isArray(rawItems)) {
    return rawItems;
  }

  return rawItems ? [rawItems] : [];
}

async function fetchBuildingRegisterSummary(parcelReference, config, numOfRows = 100) {
  const params = new URLSearchParams({
    serviceKey: config.buildingHubServiceKey,
    sigunguCd: parcelReference.sigunguCd,
    bjdongCd: parcelReference.bjdongCd,
    platGbCd: parcelReference.platGbCd,
    bun: parcelReference.bun,
    ji: parcelReference.ji,
    numOfRows: String(numOfRows),
    pageNo: "1",
    _type: "json",
  });

  const response = await fetch(
    `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?${params}`
  );

  if (!response.ok) {
    throw new Error(`Building HUB request failed with ${response.status}`);
  }

  const payload = await response.json();
  const resultCode = payload?.response?.header?.resultCode;

  if (resultCode && resultCode !== "00") {
    throw new Error(
      payload?.response?.header?.resultMsg || "건축물대장 조회에 실패했습니다."
    );
  }

  const items = normalizeOpenApiItems(payload);

  return items
    .map((item) => ({
      id: String(item.mgmBldrgstPk || item.rnum || ""),
      buildingName: String(item.bldNm || "").trim(),
      dongName: String(item.dongNm || "").trim(),
      roadAddress: String(item.newPlatPlc || "").trim(),
      parcelAddress: String(item.platPlc || "").trim(),
      mainPurpose: String(item.mainPurpsCdNm || "").trim(),
      etcPurpose: String(item.etcPurps || "").trim(),
      structureName: String(item.strctCdNm || "").trim(),
      roofName: String(item.roofCdNm || "").trim(),
      landAreaSqm: Number(item.platArea || 0),
      buildingAreaSqm: Number(item.archArea || 0),
      totalAreaSqm: Number(item.totArea || 0),
      coverageRatio: Number(item.bcRat || 0),
      floorAreaRatio: Number(item.vlRat || 0),
      heightMeters: Number(item.heit || 0),
      aboveGroundFloors: Number(item.grndFlrCnt || 0),
      belowGroundFloors: Number(item.ugrndFlrCnt || 0),
      approvalDate: String(item.useAprDay || "").trim(),
      registerKind: String(item.regstrKindCdNm || "").trim(),
      registerKindCode: String(item.regstrKindCd || "").trim(),
      mainAttachmentType: String(item.mainAtchGbCdNm || "").trim(),
      mainAttachmentTypeCode: String(item.mainAtchGbCd || "").trim(),
      parkingCount:
        Number(item.indrAutoUtcnt || 0) + Number(item.oudrAutoUtcnt || 0),
      sourceFields: extractOpenApiSourceFields(item),
    }))
    .sort((left, right) => right.totalAreaSqm - left.totalAreaSqm);
}

async function fetchBuildingFloorOutline(parcelReference, config, numOfRows = 1000) {
  const params = new URLSearchParams({
    serviceKey: config.buildingHubServiceKey,
    sigunguCd: parcelReference.sigunguCd,
    bjdongCd: parcelReference.bjdongCd,
    platGbCd: parcelReference.platGbCd,
    bun: parcelReference.bun,
    ji: parcelReference.ji,
    numOfRows: String(numOfRows),
    pageNo: "1",
    _type: "json",
  });

  const response = await fetch(
    `https://apis.data.go.kr/1613000/BldRgstHubService/getBrFlrOulnInfo?${params}`
  );

  if (!response.ok) {
    throw new Error(`Building HUB floor request failed with ${response.status}`);
  }

  const payload = await response.json();
  const resultCode = payload?.response?.header?.resultCode;

  if (resultCode && resultCode !== "00") {
    throw new Error(
      payload?.response?.header?.resultMsg || "건축물 층별현황 조회에 실패했습니다."
    );
  }

  const items = normalizeOpenApiItems(payload);

  return items
    .map((item) => ({
      dongName: String(item.dongNm || "").trim(),
      floorTypeCode: String(item.flrGbCd || "").trim(),
      floorTypeName: String(item.flrGbCdNm || "").trim(),
      floorNo: String(item.flrNo || "").trim(),
      floorName: String(item.flrNoNm || "").trim(),
      structureName: String(item.etcStrct || "").trim(),
      purpose: String(item.etcPurps || "").trim(),
      areaSquareMeters: Number(item.area || 0),
      sourceFields: extractOpenApiSourceFields(item),
    }))
    .sort((left, right) => {
      const leftType = Number(left.floorTypeCode || 0);
      const rightType = Number(right.floorTypeCode || 0);

      if (leftType !== rightType) {
        return leftType - rightType;
      }

      const leftFloor = Number(left.floorNo || 0);
      const rightFloor = Number(right.floorNo || 0);
      return leftFloor - rightFloor;
    });
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractScriptStringValue(html, variableName) {
  const match = html.match(
    new RegExp(`var\\s+${escapeRegExp(variableName)}\\s*=\\s*"([^"]*)"`, "i")
  );
  return match?.[1] || "";
}

function readResponseCharset(response, fallback = "utf-8") {
  const contentType = response.headers.get("content-type") || "";
  return contentType.match(/charset=([^;]+)/i)?.[1]?.trim() || fallback;
}

async function readResponseTextWithCharset(response, fallback = "utf-8") {
  return readEncodedResponseText(response, readResponseCharset(response, fallback));
}

function extractXmlText(xml, tagName) {
  const match = String(xml || "").match(
    new RegExp(`<${escapeRegExp(tagName)}[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i")
  );

  return cleanHtmlText(match?.[1] || "");
}

function parseXmlRecords(xml, recordTagName) {
  const records = [];
  const recordRegex = new RegExp(
    `<${escapeRegExp(recordTagName)}[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(recordTagName)}>`,
    "gi"
  );

  for (const match of String(xml || "").matchAll(recordRegex)) {
    const block = match[1];
    const record = {};
    const fieldRegex = /<([A-Za-z0-9_:-]+)[^>]*>([\s\S]*?)<\/\1>/g;

    for (const fieldMatch of block.matchAll(fieldRegex)) {
      const key = fieldMatch[1];

      if (key === recordTagName || key in record) {
        continue;
      }

      record[key] = cleanHtmlText(fieldMatch[2] || "");
    }

    records.push(record);
  }

  return records;
}

function formatCompactDate(value) {
  const digits = String(value || "").replace(/\D+/g, "");

  if (digits.length === 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }

  return cleanHtmlText(value) || "";
}

function parseEumDetailRuntimeConfig(html) {
  return {
    landMoveAttrKey: extractScriptStringValue(html, "landMoveAttrKey"),
    landCharacteristicsKey: extractScriptStringValue(html, "landCharacteristicsKey"),
    landMoveServiceUrl: extractScriptStringValue(html, "getLandMoveAttr"),
    landCharacteristicsServiceUrl: extractScriptStringValue(html, "getLandCharacteristics"),
    landPossessionServiceUrl: extractScriptStringValue(html, "getLadfrlService"),
  };
}

function buildEumConnectorUrl(serviceUrl, key, params = {}) {
  const segments = [`${serviceUrl}^key=${encodeURIComponent(String(key || ""))}`];

  for (const [paramKey, paramValue] of Object.entries(params)) {
    if (paramValue === null || paramValue === undefined || paramValue === "") {
      continue;
    }

    segments.push(
      `${paramKey}=${encodeURIComponent(String(paramValue))}`
    );
  }

  segments.push("domain=http://www.eum.go.kr");
  segments.push("format=xml");

  return `https://www.eum.go.kr/dataapis/UrlConnector.jsp?url=${segments.join("|")}`;
}

async function fetchEumConnectorXml(serviceUrl, key, params = {}) {
  if (!serviceUrl || !key) {
    return "";
  }

  const response = await fetch(buildEumConnectorUrl(serviceUrl, key, params));

  if (!response.ok) {
    throw new Error(`EUM detail request failed with ${response.status}`);
  }

  return readResponseTextWithCharset(response, "utf-8");
}

function pickLatestRecord(records, primaryKey, secondaryKey = "") {
  return [...records].sort((left, right) => {
    const leftPrimary = String(left?.[primaryKey] || "");
    const rightPrimary = String(right?.[primaryKey] || "");

    if (leftPrimary !== rightPrimary) {
      return rightPrimary.localeCompare(leftPrimary);
    }

    const leftSecondary = String(left?.[secondaryKey] || "");
    const rightSecondary = String(right?.[secondaryKey] || "");
    return rightSecondary.localeCompare(leftSecondary);
  })[0] || null;
}

async function fetchEumLandRelationDetails(parcelReference, html, config) {
  const runtimeConfig = parseEumDetailRuntimeConfig(html);
  const details = {
    landOwnership: null,
    landCharacteristics: null,
    landMovements: [],
    buildingInfo: {
      buildingCount: 0,
      buildings: [],
    },
    sourceStatus: {
      landOwnership: "unavailable",
      landCharacteristics: "unavailable",
      landMovements: "unavailable",
      buildingInfo: config.buildingHubServiceKey ? "pending" : "unavailable",
    },
  };

  const detailTasks = [
    (async () => {
      if (!runtimeConfig.landPossessionServiceUrl || !runtimeConfig.landMoveAttrKey) {
        return;
      }

      const xml = await fetchEumConnectorXml(
        runtimeConfig.landPossessionServiceUrl,
        runtimeConfig.landMoveAttrKey,
        {
          pnu: parcelReference.pnu,
        }
      );

      details.landOwnership = {
        possessionType: extractXmlText(xml, "posesnSeCodeNm") || "미확인",
        coOwnerCount: extractXmlText(xml, "cnrsPsnCo") || "미확인",
        scaleType: extractXmlText(xml, "ladFrtlScNm") || "미확인",
        baseDate: formatCompactDate(extractXmlText(xml, "lastUpdtDt")) || "미확인",
      };
      details.sourceStatus.landOwnership = "loaded";
    })().catch(() => {
      details.sourceStatus.landOwnership = "error";
    }),
    (async () => {
      if (
        !runtimeConfig.landCharacteristicsServiceUrl ||
        !runtimeConfig.landCharacteristicsKey
      ) {
        return;
      }

      const xml = await fetchEumConnectorXml(
        runtimeConfig.landCharacteristicsServiceUrl,
        runtimeConfig.landCharacteristicsKey,
        {
          pnu: parcelReference.pnu,
          numOfRows: 50,
        }
      );
      const records = parseXmlRecords(xml, "field");
      const latest = pickLatestRecord(records, "lastUpdtDt", "stdrYear");

      if (!latest) {
        details.sourceStatus.landCharacteristics = "empty";
        return;
      }

      details.landCharacteristics = {
        topographyHeight: latest.tpgrphHgCodeNm || "미확인",
        topographyShape: latest.tpgrphFrmCodeNm || "미확인",
        roadSide: latest.roadSideCodeNm || "미확인",
        baseDate: formatCompactDate(latest.lastUpdtDt) || "미확인",
      };
      details.sourceStatus.landCharacteristics = "loaded";
    })().catch(() => {
      details.sourceStatus.landCharacteristics = "error";
    }),
    (async () => {
      if (!runtimeConfig.landMoveServiceUrl || !runtimeConfig.landMoveAttrKey) {
        return;
      }

      const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      const xml = await fetchEumConnectorXml(
        runtimeConfig.landMoveServiceUrl,
        runtimeConfig.landMoveAttrKey,
        {
          pnu: parcelReference.pnu,
          startDt: "19000101",
          endDt: today,
          numOfRows: 30,
        }
      );
      const records = parseXmlRecords(xml, "field");

      details.landMovements = records
        .map((record) => ({
          landCategory: record.lndcgrCodeNm || "미확인",
          areaSquareMeters: Number(record.lndpclAr || 0),
          reason: record.ladMvmnPrvonshCodeNm || "미확인",
          movementDate: formatCompactDate(record.ladMvmnDe) || "미확인",
        }))
        .sort((left, right) => String(right.movementDate).localeCompare(String(left.movementDate)));

      details.sourceStatus.landMovements = details.landMovements.length ? "loaded" : "empty";
    })().catch(() => {
      details.sourceStatus.landMovements = "error";
    }),
  ];

  if (config.buildingHubServiceKey) {
    detailTasks.push(
      (async () => {
        const [buildings, floorOutline] = await Promise.all([
          fetchBuildingRegisterSummary(parcelReference, config, 100),
          fetchBuildingFloorOutline(parcelReference, config, 1000),
        ]);

        details.buildingInfo = {
          buildingCount: buildings.length,
          buildings: buildings.map((building) => {
            const normalizedDongName = String(building.dongName || "").trim();
            const floors = floorOutline.filter((floorItem) => {
              const floorDongName = String(floorItem.dongName || "").trim();

              if (normalizedDongName && floorDongName) {
                return normalizedDongName === floorDongName;
              }

              return !normalizedDongName || buildings.length === 1;
            });

            return {
              ...building,
              floorOutline: floors,
            };
          }),
        };
        details.sourceStatus.buildingInfo = buildings.length ? "loaded" : "empty";
      })().catch(() => {
        details.sourceStatus.buildingInfo = "error";
      })
    );
  }

  await Promise.all(detailTasks);
  return details;
}

function extractHtmlSection(html, elementId) {
  const match = html.match(
    new RegExp(`<td[^>]+id="${elementId}"[^>]*>([\\s\\S]*?)<\\/td>`, "i")
  );
  return match?.[1] || "";
}

function parseEumRegulationItems(sectionHtml, category) {
  const regex = /fn_lwLawDet\('([^']+)','([^']+)','([^']*)'\)/g;
  const items = [];

  for (const match of sectionHtml.matchAll(regex)) {
    const authCd = match[1];
    const ucode = match[2];
    const title = cleanHtmlText(match[3]).replace(/\([^)]*\)$/g, "").trim();

    if (!title) {
      continue;
    }

    const detailUrl =
      `/handoff/eum-law?ucode=${encodeURIComponent(ucode)}` +
      `&authCd=${encodeURIComponent(authCd)}` +
      `&uname=${encodeURIComponent(title)}`;

    items.push({
      category,
      authCd,
      ucode,
      title,
      detailUrl,
    });
  }

  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.category}|${item.authCd}|${item.ucode}|${item.title}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function parseAreaText(value) {
  const normalized = cleanHtmlText(value);
  const numeric = Number(
    normalized.replace(/[^0-9.]/g, "") || Number.NaN
  );

  return {
    text: normalized || "미확인",
    squareMeters: Number.isFinite(numeric) ? numeric : null,
  };
}

function parseEumLandInfoHtml(html, parcelReference, location) {
  const landCategory =
    cleanHtmlText(
      html.match(/id="present_class_val"[^>]*value="([^"]*)"/i)?.[1] || ""
    ) || "미확인";
  const area = parseAreaText(
    html.match(/id="present_area"[^>]*>([\s\S]*?)<\/td>/i)?.[1] || ""
  );
  const announcedPrice =
    cleanHtmlText(html.match(/id="jiga"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "") ||
    "미확인";
  const urbanPlanningItems = parseEumRegulationItems(
    extractHtmlSection(html, "present_mark1"),
    "국토계획법"
  );
  const otherLawItems = parseEumRegulationItems(
    extractHtmlSection(html, "present_mark2"),
    "다른 법령"
  );

  return {
    address: buildSystemAddress(location),
    parcelReference,
    summary: {
      landCategory,
      areaText: area.text,
      areaSquareMeters: area.squareMeters,
      announcedPrice,
      urbanPlanningCount: urbanPlanningItems.length,
      otherLawCount: otherLawItems.length,
    },
    regulations: {
      urbanPlanningItems,
      otherLawItems,
    },
    official: {
      detailFormAction: "https://www.eum.go.kr/web/ar/lu/luLandDet.jsp",
      detailFormFields: {
        selGbn: "umd",
        isNoScr: "script",
        s_type: "1",
        mode: "search",
        sggcd: parcelReference.sigunguCd,
        pnu: parcelReference.pnu,
        p_location: buildSystemAddress(location),
      },
      mapUrl:
        `https://www.eum.go.kr/web/ar/lu/luLandPop.jsp?pnu=${parcelReference.pnu}` +
        "&default_scale=1200&scale=1200",
      issueUrl:
        "https://www.gov.kr/mw/AA020InfoCappView.do?HighCtgCD=A09005&CappBizCD=15000000013&tp_seq=01",
    },
  };
}

async function fetchEumLandPage(parcelReference, location) {
  const formBody = new URLSearchParams({
    selGbn: "umd",
    isNoScr: "script",
    s_type: "1",
    mode: "search",
    sggcd: parcelReference.sigunguCd,
    pnu: parcelReference.pnu,
    p_location: buildSystemAddress(location),
  });
  const response = await fetch("https://www.eum.go.kr/web/ar/lu/luLandDet.jsp", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: formBody.toString(),
  });

  if (!response.ok) {
    throw new Error(`EUM request failed with ${response.status}`);
  }

  const html = await readEncodedResponseText(response, "euc-kr");
  return {
    html,
    landInfo: parseEumLandInfoHtml(html, parcelReference, location),
  };
}

async function fetchEumLandInfo(parcelReference, location) {
  const page = await fetchEumLandPage(parcelReference, location);
  return page.landInfo;
}

async function fetchEumLandInfoDetails(parcelReference, location, config) {
  const page = await fetchEumLandPage(parcelReference, location);
  const details = await fetchEumLandRelationDetails(
    parcelReference,
    page.html,
    config
  );

  return {
    ...page.landInfo,
    details,
  };
}

async function searchVWorldCategory(query, category, config) {
  const params = new URLSearchParams({
    key: config.vworldApiKey,
    service: "search",
    request: "search",
    version: "2.0",
    type: "address",
    category,
    crs: "EPSG:4326",
    size: "10",
    format: "json",
    query,
  });

  if (config.vworldApiDomain) {
    params.set("domain", config.vworldApiDomain);
  }

  const response = await fetch(`https://api.vworld.kr/req/search?${params}`);

  if (!response.ok) {
    throw new Error(`VWorld ${category} geocode failed with ${response.status}`);
  }

  const payload = await response.json();
  const status = getVWorldResponseStatus(payload);

  if (status && status !== "OK") {
    throw new Error(
      getVWorldResponseErrorText(payload) ||
        `VWorld ${category} geocode returned ${status}`
    );
  }

  return mapVWorldSearchItems(
    payload?.response?.result?.items,
    category === "road" ? "road" : "parcel"
  );
}

async function geocodeWithVWorld(query, config) {
  const [roadItems, parcelItems] = await Promise.all([
    searchVWorldCategory(query, "road", config),
    searchVWorldCategory(query, "parcel", config),
  ]);

  return dedupeSearchItems([...roadItems, ...parcelItems]);
}

async function geocodeWithNominatim(query) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "8",
    countrycodes: "kr",
  });

  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    {
      headers: {
        "User-Agent": "site-context-planner/0.1 (local development)",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Nominatim geocode failed with ${response.status}`);
  }

  const payload = await response.json();

  return payload.map((item, index) => ({
    id: item.place_id || `nominatim-${index}`,
    label: item.display_name,
    roadAddress: item.display_name,
    parcelAddress: "",
    lat: Number(item.lat),
    lng: Number(item.lon),
    provider: "nominatim",
    searchType: "mixed",
  }));
}

function parseParcelAddressReference(value) {
  const normalized = String(value || "").trim();
  const match = normalized.match(/(?:^|\s)(산)?\s*(\d+)(?:-(\d+))?\s*$/);

  if (!match) {
    return null;
  }

  return {
    mtYn: match[1] ? "1" : "0",
    bun: match[2],
    ji: match[3] || "",
  };
}

async function reverseWithVWorld(lat, lng, config) {
  const params = new URLSearchParams({
    key: config.vworldApiKey,
    service: "address",
    request: "getAddress",
    version: "2.0",
    point: `${lng},${lat}`,
    crs: "EPSG:4326",
    format: "json",
    type: "both",
    simple: "false",
  });

  if (config.vworldApiDomain) {
    params.set("domain", config.vworldApiDomain);
  }

  const response = await fetch(`https://api.vworld.kr/req/address?${params}`);

  if (!response.ok) {
    throw new Error(`VWorld reverse geocode failed with ${response.status}`);
  }

  const payload = await response.json();
  const status = getVWorldResponseStatus(payload);

  if (status && status !== "OK") {
    throw new Error(
      getVWorldResponseErrorText(payload) ||
        `VWorld reverse geocode returned ${status}`
    );
  }

  const results = Array.isArray(payload?.response?.result)
    ? payload.response.result
    : payload?.response?.result
      ? [payload.response.result]
      : [];

  const road = results.find(
    (item) => String(item.type || "").toLowerCase() === "road"
  );
  const parcel = results.find(
    (item) => String(item.type || "").toLowerCase() === "parcel"
  );
  const parcelReference = parseParcelAddressReference(parcel?.text);
  const admCd = normalizeDigits(parcel?.structure?.level4LC);
  const pnu = parcelReference
    ? buildPnuFromParts(
        admCd,
        parcelReference.mtYn,
        parcelReference.bun,
        parcelReference.ji
      )
    : "";

  return {
    id: `reverse-${lat}-${lng}`,
    label: road?.text || parcel?.text || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    roadAddress: road?.text || "",
    parcelAddress: parcel?.text || "",
    lat,
    lng,
    provider: "vworld",
    pnu,
    juso:
      pnu && admCd.length === 10
        ? {
            admCd,
            mtYn: parcelReference.mtYn,
            lnbrMnnm: normalizeDigits(parcelReference.bun, 4),
            lnbrSlno: normalizeDigits(parcelReference.ji, 4),
          }
        : null,
  };
}

async function reverseWithNominatim(lat, lng) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: "jsonv2",
  });

  const response = await fetch(
    `https://nominatim.openstreetmap.org/reverse?${params}`,
    {
      headers: {
        "User-Agent": "site-context-planner/0.1 (local development)",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Nominatim reverse geocode failed with ${response.status}`);
  }

  const payload = await response.json();

  return {
    id: `reverse-${lat}-${lng}`,
    label: payload.display_name || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    roadAddress: payload.display_name || "",
    parcelAddress: "",
    lat,
    lng,
    provider: "nominatim",
  };
}

function buildClipBoundary(location, options, parcelFeature) {
  const radius = Math.max(30, Number(options.radius) || 120);
  return polygonFeature(createRectangleRing(location, radius * 2, radius * 2), {
    shape: "rectangle",
  });
}

function createSyntheticContours(location, clipFeature, options) {
  const ring = getOuterRing(clipFeature);
  const center = { lat: location.lat, lng: location.lng };
  const localRing = ring.map((point) => localMetersFromLngLat(point, center));
  const xValues = localRing.map((point) => point[0]);
  const yValues = localRing.map((point) => point[1]);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const contourInterval = normalizeContourInterval(options.contourInterval);
  const radius = Math.max(30, Number(options.radius) || 120);
  const seed = Math.round(
    Math.abs(location.lat * 1000) + Math.abs(location.lng * 1000)
  );
  const bandCount = Math.max(7, Math.min(16, Math.round(radius / 18)));
  const verticalStep = (maxY - minY) / bandCount;
  const features = [];

  for (let bandIndex = 0; bandIndex <= bandCount; bandIndex += 1) {
    const baseY = minY + bandIndex * verticalStep;
    let currentSegment = [];

    for (let x = minX; x <= maxX; x += 7.5) {
      const wave =
        Math.sin((x + seed) / 33) * 5.5 +
        Math.cos((x - seed * 0.3) / 17) * 1.8;
      const y = baseY + wave;
      const lngLat = lngLatFromMeters(center, x, y);
      const inside = pointInRing(lngLat, ring);

      if (inside) {
        currentSegment.push(lngLat);
      } else if (currentSegment.length >= 2) {
        features.push(
          lineFeature(currentSegment, {
            provider: "synthetic",
            elevation: Number((bandIndex * contourInterval).toFixed(2)),
          })
        );
        currentSegment = [];
      } else {
        currentSegment = [];
      }
    }

    if (currentSegment.length >= 2) {
      features.push(
        lineFeature(currentSegment, {
          provider: "synthetic",
          elevation: Number((bandIndex * contourInterval).toFixed(2)),
        })
      );
    }
  }

  return featureCollection(features);
}

function quantizeTerrainHeight(siteContext, height) {
  if (!Number.isFinite(height)) {
    return height;
  }

  if (siteContext.options?.terrainMode !== "contour") {
    return height;
  }

  return quantizeAbsoluteElevation(
    height,
    siteContext.options?.contourInterval
  );
}

function buildSyntheticTerrainGrid(location, clipFeature, options) {
  const sampleGrid = buildTerrainSampleGrid(location, clipFeature, options);
  const seed = Math.round(
    Math.abs(location.lat * 1000) + Math.abs(location.lng * 1000)
  );
  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;

  const elevations = sampleGrid.cells.map((row) =>
    row.map((point) => {
      if (!point.inside) {
        return null;
      }

      const value = Number(
        syntheticHeightAtLocalPoint(point.x, point.y, seed).toFixed(2)
      );
      minElevation = Math.min(minElevation, value);
      maxElevation = Math.max(maxElevation, value);
      return value;
    })
  );

  return {
    step: sampleGrid.step,
    xValues: sampleGrid.xValues,
    yValues: sampleGrid.yValues,
    elevations,
    minElevation: Number.isFinite(minElevation) ? minElevation : null,
    maxElevation: Number.isFinite(maxElevation) ? maxElevation : null,
  };
}

async function fetchOpenMeteoElevationChunk(points) {
  const cacheKey = points
    .map((point) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`)
    .join("|");
  const cached = openMeteoElevationCache.get(cacheKey);

  if (cached && Date.now() - cached.cachedAt < OPEN_METEO_CACHE_TTL_MS) {
    return cached.values;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const params = new URLSearchParams({
        latitude: points.map((point) => point.lat.toFixed(6)).join(","),
        longitude: points.map((point) => point.lng.toFixed(6)).join(","),
      });
      const response = await fetch(`https://api.open-meteo.com/v1/elevation?${params}`, {
        headers: {
          "User-Agent": "site-context-planner/0.1",
        },
      });

      if (!response.ok) {
        throw new Error(`Open-Meteo elevation request failed with ${response.status}`);
      }

      const payload = await response.json();
      const values = Array.isArray(payload?.elevation)
        ? payload.elevation.map((value) => Number(value))
        : [];

      if (values.length !== points.length) {
        throw new Error("Open-Meteo elevation response did not match the request.");
      }

      openMeteoElevationCache.set(cacheKey, {
        cachedAt: Date.now(),
        values,
      });
      return values;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, attempt * 700);
      });
    }
  }

  if (points.length > 12) {
    const midpoint = Math.ceil(points.length / 2);
    const leftValues = await fetchOpenMeteoElevationChunk(points.slice(0, midpoint));
    const rightValues = await fetchOpenMeteoElevationChunk(points.slice(midpoint));
    const values = [...leftValues, ...rightValues];

    openMeteoElevationCache.set(cacheKey, {
      cachedAt: Date.now(),
      values,
    });
    return values;
  }

  throw lastError;
}

async function fetchOpenMeteoElevations(points) {
  const elevations = [];

  for (
    let index = 0;
    index < points.length;
    index += OPEN_METEO_MAX_POINTS_PER_REQUEST
  ) {
    const chunk = points.slice(index, index + OPEN_METEO_MAX_POINTS_PER_REQUEST);
    const values = await fetchOpenMeteoElevationChunk(chunk);
    elevations.push(...values);
  }

  return elevations;
}

async function fetchOpenTopoDataElevations(points) {
  const elevations = [];

  for (let index = 0; index < points.length; index += 80) {
    const chunk = points.slice(index, index + 80);
    const response = await fetch("https://api.opentopodata.org/v1/srtm90m", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "site-context-planner/0.1",
      },
      body: JSON.stringify({
        locations: chunk
          .map((point) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`)
          .join("|"),
        interpolation: "bilinear",
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenTopoData elevation request failed with ${response.status}`);
    }

    const payload = await response.json();

    if (payload?.status !== "OK") {
      throw new Error(payload?.error || "OpenTopoData elevation request failed.");
    }

    const results = Array.isArray(payload?.results) ? payload.results : [];

    if (results.length !== chunk.length) {
      throw new Error("OpenTopoData elevation response did not match the request.");
    }

    const values = results.map((item) => Number(item?.elevation));

    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error("OpenTopoData elevation response contained invalid values.");
    }

    elevations.push(...values);
  }

  return elevations;
}

function buildTerrainSampleGrid(location, clipFeature, options) {
  const clipRing = getOuterRing(clipFeature);
  const bounds = polygonBounds(clipRing);
  const minX = localMetersFromLngLat([bounds.minLng, location.lat], location)[0];
  const maxX = localMetersFromLngLat([bounds.maxLng, location.lat], location)[0];
  const minY = localMetersFromLngLat([location.lng, bounds.minLat], location)[1];
  const maxY = localMetersFromLngLat([location.lng, bounds.maxLat], location)[1];
  const widthMeters = maxX - minX;
  const heightMeters = maxY - minY;
  const step = resolveTerrainSampleStep(widthMeters, heightMeters, options);
  const xValues = [];
  const yValues = [];

  for (let x = minX; x <= maxX + 0.001; x += step) {
    xValues.push(Number(x.toFixed(3)));
  }

  if (xValues[xValues.length - 1] < maxX - 0.001) {
    xValues.push(Number(maxX.toFixed(3)));
  }

  for (let y = minY; y <= maxY + 0.001; y += step) {
    yValues.push(Number(y.toFixed(3)));
  }

  if (yValues[yValues.length - 1] < maxY - 0.001) {
    yValues.push(Number(maxY.toFixed(3)));
  }

  const points = [];
  const cells = [];

  for (const y of yValues) {
    const row = [];

    for (const x of xValues) {
      const lngLat = lngLatFromMeters(location, x, y);
      const inside = pointInRing(lngLat, clipRing);
      const point = { x, y, lng: lngLat[0], lat: lngLat[1], inside };

      if (inside) {
        point.elevationIndex = points.length;
        points.push(point);
      }

      row.push(point);
    }

    cells.push(row);
  }

  return {
    step,
    xValues,
    yValues,
    points,
    cells,
  };
}

function estimateContourIntervalFromFeatures(features = []) {
  const elevations = [...new Set(
    (features || [])
      .map((feature) => Number(feature?.properties?.elevation))
      .filter((value) => Number.isFinite(value))
      .map((value) => Number(value.toFixed(3)))
  )].sort((a, b) => a - b);
  let smallestPositiveDifference = Number.POSITIVE_INFINITY;

  for (let index = 1; index < elevations.length; index += 1) {
    const difference = Number((elevations[index] - elevations[index - 1]).toFixed(3));

    if (difference > 0.001) {
      smallestPositiveDifference = Math.min(smallestPositiveDifference, difference);
    }
  }

  return Number.isFinite(smallestPositiveDifference)
    ? normalizeContourInterval(smallestPositiveDifference)
    : null;
}

function distanceSquaredPointToBoundsLocal(xMeters, yMeters, bounds) {
  const dx =
    xMeters < bounds.minX
      ? bounds.minX - xMeters
      : xMeters > bounds.maxX
        ? xMeters - bounds.maxX
        : 0;
  const dy =
    yMeters < bounds.minY
      ? bounds.minY - yMeters
      : yMeters > bounds.maxY
        ? yMeters - bounds.maxY
        : 0;
  return dx * dx + dy * dy;
}

function distanceSquaredPointToSegmentLocal(xMeters, yMeters, startPoint, endPoint) {
  const dx = endPoint[0] - startPoint[0];
  const dy = endPoint[1] - startPoint[1];
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared <= 1e-9) {
    const px = xMeters - startPoint[0];
    const py = yMeters - startPoint[1];
    return px * px + py * py;
  }

  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((xMeters - startPoint[0]) * dx + (yMeters - startPoint[1]) * dy) /
        lengthSquared
    )
  );
  const projectedX = startPoint[0] + dx * ratio;
  const projectedY = startPoint[1] + dy * ratio;
  const deltaX = xMeters - projectedX;
  const deltaY = yMeters - projectedY;
  return deltaX * deltaX + deltaY * deltaY;
}

function buildContourPolylineRecords(contourCollection, location) {
  const records = [];

  for (const feature of contourCollection?.features || []) {
    const elevation = Number(feature?.properties?.elevation);

    if (!Number.isFinite(elevation)) {
      continue;
    }

    for (const lineString of getLineStringsFromGeometry(feature.geometry)) {
      const localPoints = lineString
        .map((point) => localMetersFromLngLat(point, location))
        .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

      if (localPoints.length < 2) {
        continue;
      }

      const segments = [];
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      for (let index = 0; index < localPoints.length - 1; index += 1) {
        const startPoint = localPoints[index];
        const endPoint = localPoints[index + 1];
        const segmentBounds = {
          minX: Math.min(startPoint[0], endPoint[0]),
          minY: Math.min(startPoint[1], endPoint[1]),
          maxX: Math.max(startPoint[0], endPoint[0]),
          maxY: Math.max(startPoint[1], endPoint[1]),
        };

        segments.push({
          startPoint,
          endPoint,
          bounds: segmentBounds,
        });
        minX = Math.min(minX, segmentBounds.minX);
        minY = Math.min(minY, segmentBounds.minY);
        maxX = Math.max(maxX, segmentBounds.maxX);
        maxY = Math.max(maxY, segmentBounds.maxY);
      }

      if (segments.length) {
        records.push({
          elevation,
          segments,
          bounds: {
            minX,
            minY,
            maxX,
            maxY,
          },
        });
      }
    }
  }

  return records;
}

function distanceSquaredPointToContourRecord(xMeters, yMeters, contourRecord) {
  let bestDistanceSquared = Number.POSITIVE_INFINITY;

  if (
    contourRecord?.bounds &&
    distanceSquaredPointToBoundsLocal(xMeters, yMeters, contourRecord.bounds) >
      bestDistanceSquared
  ) {
    return bestDistanceSquared;
  }

  for (const segment of contourRecord?.segments || []) {
    const boundsDistanceSquared = distanceSquaredPointToBoundsLocal(
      xMeters,
      yMeters,
      segment.bounds
    );

    if (boundsDistanceSquared >= bestDistanceSquared) {
      continue;
    }

    const segmentDistanceSquared = distanceSquaredPointToSegmentLocal(
      xMeters,
      yMeters,
      segment.startPoint,
      segment.endPoint
    );

    if (segmentDistanceSquared < bestDistanceSquared) {
      bestDistanceSquared = segmentDistanceSquared;

      if (bestDistanceSquared <= 1e-9) {
        break;
      }
    }
  }

  return bestDistanceSquared;
}

function resolveContourDrivenSampleStep(widthMeters, heightMeters, contourInterval) {
  const longestSide = Math.max(widthMeters, heightMeters, 1);
  const longestSideStep =
    longestSide <= 300
      ? 2
      : longestSide <= 600
        ? 2.5
        : longestSide <= 1000
          ? 3.5
          : longestSide <= 1600
            ? 5
            : 7;
  const intervalStep =
    contourInterval <= 1
      ? 1.5
      : contourInterval <= 2
        ? 2
        : contourInterval <= 5
          ? 2
          : contourInterval <= 10
            ? 3
            : 8;

  return Number(
    Math.max(1.5, Math.min(10, Math.max(longestSideStep, intervalStep))).toFixed(3)
  );
}

function buildTerrainSampleGridWithExplicitStep(location, clipFeature, step) {
  const clipRing = getOuterRing(clipFeature);
  const bounds = polygonBounds(clipRing);
  const minX = localMetersFromLngLat([bounds.minLng, location.lat], location)[0];
  const maxX = localMetersFromLngLat([bounds.maxLng, location.lat], location)[0];
  const minY = localMetersFromLngLat([location.lng, bounds.minLat], location)[1];
  const maxY = localMetersFromLngLat([location.lng, bounds.maxLat], location)[1];
  const xValues = [];
  const yValues = [];

  for (let x = minX; x <= maxX + 0.001; x += step) {
    xValues.push(Number(x.toFixed(3)));
  }

  if (xValues[xValues.length - 1] < maxX - 0.001) {
    xValues.push(Number(maxX.toFixed(3)));
  }

  for (let y = minY; y <= maxY + 0.001; y += step) {
    yValues.push(Number(y.toFixed(3)));
  }

  if (yValues[yValues.length - 1] < maxY - 0.001) {
    yValues.push(Number(maxY.toFixed(3)));
  }

  const points = [];
  const cells = [];

  for (const y of yValues) {
    const row = [];

    for (const x of xValues) {
      const lngLat = lngLatFromMeters(location, x, y);
      const inside = pointInRing(lngLat, clipRing);
      const point = { x, y, lng: lngLat[0], lat: lngLat[1], inside };

      if (inside) {
        points.push(point);
      }

      row.push(point);
    }

    cells.push(row);
  }

  return {
    step,
    xValues,
    yValues,
    points,
    cells,
  };
}

function estimateElevationFromContourRecords(
  xMeters,
  yMeters,
  contourRecords,
  contourInterval,
  sampleStep
) {
  const nearestRecords = contourRecords
    .map((record) => ({
      elevation: record.elevation,
      distanceSquared: distanceSquaredPointToContourRecord(xMeters, yMeters, record),
    }))
    .filter((item) => Number.isFinite(item.distanceSquared))
    .sort((left, right) => left.distanceSquared - right.distanceSquared)
    .slice(0, Math.min(6, contourRecords.length));

  if (!nearestRecords.length) {
    return null;
  }

  const snapThresholdSquared = Math.pow(Math.max(0.5, sampleStep * 0.35), 2);

  if (nearestRecords[0].distanceSquared <= snapThresholdSquared) {
    return Number(nearestRecords[0].elevation.toFixed(3));
  }

  let weightedElevationSum = 0;
  let totalWeight = 0;

  for (const record of nearestRecords) {
    const distance = Math.max(Math.sqrt(record.distanceSquared), 0.35);
    const weight = 1 / Math.pow(distance, 1.8);
    weightedElevationSum += record.elevation * weight;
    totalWeight += weight;
  }

  if (!totalWeight) {
    return null;
  }

  const estimatedElevation = weightedElevationSum / totalWeight;
  const roundedElevation = contourInterval > 0
    ? Number(estimatedElevation.toFixed(3))
    : Number(estimatedElevation.toFixed(3));

  return roundedElevation;
}

function buildTerrainGridFromContourCollection(
  location,
  clipFeature,
  contourCollection,
  contourInterval
) {
  const contourRecords = buildContourPolylineRecords(contourCollection, location);

  if (!contourRecords.length) {
    return null;
  }

  const clipRing = getOuterRing(clipFeature);
  const bounds = polygonBounds(clipRing);
  const minX = localMetersFromLngLat([bounds.minLng, location.lat], location)[0];
  const maxX = localMetersFromLngLat([bounds.maxLng, location.lat], location)[0];
  const minY = localMetersFromLngLat([location.lng, bounds.minLat], location)[1];
  const maxY = localMetersFromLngLat([location.lng, bounds.maxLat], location)[1];
  const step = resolveContourDrivenSampleStep(
    maxX - minX,
    maxY - minY,
    contourInterval
  );
  const sampleGrid = buildTerrainSampleGridWithExplicitStep(
    location,
    clipFeature,
    step
  );
  const elevations = [];
  const numericElevations = [];

  for (const row of sampleGrid.cells) {
    const elevationRow = [];

    for (const point of row) {
      if (!point.inside) {
        elevationRow.push(null);
        continue;
      }

      const elevation = estimateElevationFromContourRecords(
        point.x,
        point.y,
        contourRecords,
        contourInterval,
        step
      );

      if (Number.isFinite(elevation)) {
        elevationRow.push(elevation);
        numericElevations.push(elevation);
      } else {
        elevationRow.push(null);
      }
    }

    elevations.push(elevationRow);
  }

  if (!numericElevations.length) {
    return null;
  }

  const contourElevations = contourRecords
    .map((record) => record.elevation)
    .filter((value) => Number.isFinite(value));

  return {
    step,
    xValues: sampleGrid.xValues,
    yValues: sampleGrid.yValues,
    elevations,
    minElevation: Number(
      Math.min(...(contourElevations.length ? contourElevations : numericElevations)).toFixed(2)
    ),
    maxElevation: Number(
      Math.max(...(contourElevations.length ? contourElevations : numericElevations)).toFixed(2)
    ),
  };
}

async function resolveTerrainContext(location, clipFeature, options, config) {
  const requestedContourInterval = normalizeContourInterval(
    options.contourInterval
  );
  let contourSource = null;

  if (options.includeContours !== false) {
    try {
      contourSource = await resolveOfficialContourCollection(clipFeature, config);
    } catch (error) {
      contourSource = {
        provider: "official-contours",
        mode: "error",
        note:
          error instanceof Error
            ? `Official contour source could not be loaded. ${error.message}`
            : "Official contour source could not be loaded.",
        collection: null,
      };
    }
  }
  const sourceContourInterval = normalizeContourInterval(
    contourSource?.interval || requestedContourInterval
  );
  if (options.terrainMode === "flat") {
    return {
      provider: "flat",
      mode: "generated",
      note: "평탄화 지형으로 설정했습니다.",
      contourCollection:
        options.includeContours === false
          ? featureCollection([])
          : contourSource?.collection || featureCollection([]),
      contourSource,
      contourInterval: requestedContourInterval,
      sourceContourInterval,
      terrainGrid: null,
    };
  }

  const sampleFallbackGrid = buildSyntheticTerrainGrid(location, clipFeature, options);

  if (contourSource?.collection?.features?.length) {
    try {
      const contourTerrainGrid = buildTerrainGridFromContourCollection(
        location,
        clipFeature,
        contourSource.collection,
        sourceContourInterval
      );

      if (contourTerrainGrid?.elevations?.length) {
        return {
          provider: "official-contours",
          mode: "derived",
          note: "Terrain export is derived from the official contour source.",
          contourCollection:
            options.includeContours === false
              ? featureCollection([])
              : contourSource.collection,
          contourSource,
          contourInterval: requestedContourInterval,
          sourceContourInterval,
          terrainGrid: contourTerrainGrid,
        };
      }
    } catch (error) {
      contourSource = {
        ...contourSource,
        note:
          error instanceof Error
            ? `${contourSource.note} Terrain derivation fallback was used. ${error.message}`
            : `${contourSource.note} Terrain derivation fallback was used.`,
      };
    }
  }

  try {
    const sampleGrid = buildTerrainSampleGrid(location, clipFeature, options);
    let elevations;
    let provider = "open-meteo";
    let note = "실제 표고 샘플을 바탕으로 지형 메쉬를 생성했습니다.";

    try {
      elevations = await fetchOpenMeteoElevations(sampleGrid.points);
    } catch {
      elevations = await fetchOpenTopoDataElevations(sampleGrid.points);
      provider = "opentopodata";
      note = "실제 표고 샘플을 바탕으로 지형 메쉬를 생성했습니다. 보조 표고 소스를 사용했습니다.";
    }

    const rows = sampleGrid.cells.map((row) =>
      row.map((point) =>
        point.inside
          ? Number(elevations[point.elevationIndex].toFixed(2))
          : null
      )
    );
    const numericElevations = elevations.filter((value) => Number.isFinite(value));
    const terrainGrid = {
      step: sampleGrid.step,
      xValues: sampleGrid.xValues,
      yValues: sampleGrid.yValues,
      elevations: rows,
      minElevation: Number(Math.min(...numericElevations).toFixed(2)),
      maxElevation: Number(Math.max(...numericElevations).toFixed(2)),
    };

    return {
      provider,
      mode: "live",
      note,
      contourCollection:
        options.includeContours === false
          ? featureCollection([])
          : contourSource?.collection ||
            createContourLinesFromTerrainGrid(location, terrainGrid, options),
      contourSource,
      contourInterval: requestedContourInterval,
      sourceContourInterval,
      terrainGrid,
    };
  } catch (error) {
    const contourCollection =
      options.includeContours === false
        ? featureCollection([])
        : contourSource?.collection ||
          createContourLinesFromTerrainGrid(location, sampleFallbackGrid, options);

    return {
      provider: "synthetic",
      mode: "fallback",
      note:
        error instanceof Error
          ? `실지형 조회에 실패하여 임시 지형으로 대체했습니다: ${error.message}`
          : "실지형 조회에 실패하여 임시 지형으로 대체했습니다.",
      contourCollection,
      contourSource,
      contourInterval: requestedContourInterval,
      sourceContourInterval,
      terrainGrid: sampleFallbackGrid,
    };
  }
}

function pointsMatchInMeters(a, b, toleranceMeters = 0.05) {
  return (
    Math.abs(a[0] - b[0]) <= toleranceMeters &&
    Math.abs(a[1] - b[1]) <= toleranceMeters
  );
}

function mergeContourPolylinePoints(points, toleranceMeters) {
  const mergedPoints = [];

  for (const point of points) {
    if (
      !mergedPoints.length ||
      !pointsMatchInMeters(mergedPoints[mergedPoints.length - 1], point, toleranceMeters)
    ) {
      mergedPoints.push(point);
    }
  }

  return mergedPoints;
}

function averageLocalPoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function tryMergeContourPolyline(left, right, toleranceMeters) {
  const leftStart = left[0];
  const leftEnd = left[left.length - 1];
  const rightStart = right[0];
  const rightEnd = right[right.length - 1];

  if (pointsMatchInMeters(leftEnd, rightStart, toleranceMeters)) {
    return mergeContourPolylinePoints(
      [...left.slice(0, -1), averageLocalPoint(leftEnd, rightStart), ...right.slice(1)],
      toleranceMeters
    );
  }

  if (pointsMatchInMeters(leftEnd, rightEnd, toleranceMeters)) {
    return mergeContourPolylinePoints(
      [
        ...left.slice(0, -1),
        averageLocalPoint(leftEnd, rightEnd),
        ...[...right].reverse().slice(1),
      ],
      toleranceMeters
    );
  }

  if (pointsMatchInMeters(leftStart, rightStart, toleranceMeters)) {
    return mergeContourPolylinePoints(
      [
        ...[...left].reverse().slice(0, -1),
        averageLocalPoint(leftStart, rightStart),
        ...right.slice(1),
      ],
      toleranceMeters
    );
  }

  if (pointsMatchInMeters(leftStart, rightEnd, toleranceMeters)) {
    return mergeContourPolylinePoints(
      [...right.slice(0, -1), averageLocalPoint(leftStart, rightEnd), ...left.slice(1)],
      toleranceMeters
    );
  }

  return null;
}

function mergeContourPolylines(polylines, toleranceMeters) {
  const mergedPolylines = polylines
    .map((polyline) => mergeContourPolylinePoints(polyline, toleranceMeters))
    .filter((polyline) => polyline.length >= 2);
  let didMerge = true;

  while (didMerge) {
    didMerge = false;

    for (let leftIndex = 0; leftIndex < mergedPolylines.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < mergedPolylines.length;
        rightIndex += 1
      ) {
        const mergedLine = tryMergeContourPolyline(
          mergedPolylines[leftIndex],
          mergedPolylines[rightIndex],
          toleranceMeters
        );

        if (!mergedLine) {
          continue;
        }

        mergedPolylines[leftIndex] = mergedLine;
        mergedPolylines.splice(rightIndex, 1);
        didMerge = true;
        break;
      }

      if (didMerge) {
        break;
      }
    }
  }

  return mergedPolylines;
}

function buildMergedContourLineFeatures(
  location,
  rawSegments,
  mergeToleranceMeters = 1
) {
  const features = [];
  const segmentsByElevation = new Map();

  for (const segment of rawSegments || []) {
    const points = Array.isArray(segment?.points) ? segment.points : [];

    if (points.length !== 2 || !points[0] || !points[1]) {
      continue;
    }

    if (pointsMatchInMeters(points[0], points[1])) {
      continue;
    }

    const elevationKey = Number(segment.elevation || 0).toFixed(2);

    if (!segmentsByElevation.has(elevationKey)) {
      segmentsByElevation.set(elevationKey, []);
    }

    segmentsByElevation.get(elevationKey).push(segment);
  }

  for (const [elevationKey, segments] of segmentsByElevation.entries()) {
    const mergedPolylines = mergeContourPolylines(
      segments.map((segment) => segment.points.map((point) => [...point])),
      mergeToleranceMeters
    );

    for (const polyline of mergedPolylines) {
      if (polyline.length < 2) {
        continue;
      }

      features.push(
        lineFeature(
          polyline.map((point) => lngLatFromMeters(location, point[0], point[1])),
          {
            provider: segments[0]?.provider || "open-meteo",
            elevation: Number(elevationKey),
          }
        )
      );
    }
  }

  return features;
}

function createContourLinesFromTerrainGrid(location, terrainGrid, options) {
  if (!terrainGrid?.elevations?.length) {
    return featureCollection([]);
  }

  const interval = normalizeContourInterval(options.contourInterval);
  const startLevel =
    Math.floor(Number(terrainGrid.minElevation || 0) / interval) * interval;
  const endLevel =
    Math.ceil(Number(terrainGrid.maxElevation || 0) / interval) * interval;
  const rawSegments = [];

  const interpolate = (a, b, level) => {
    const difference = b.elevation - a.elevation;

    if (!difference) {
      return null;
    }

    const ratio = (level - a.elevation) / difference;

    if (ratio < 0 || ratio > 1) {
      return null;
    }

    return [a.x + (b.x - a.x) * ratio, a.y + (b.y - a.y) * ratio];
  };

  for (let level = startLevel; level <= endLevel + 0.001; level += interval) {
    for (let rowIndex = 0; rowIndex < terrainGrid.yValues.length - 1; rowIndex += 1) {
      for (
        let columnIndex = 0;
        columnIndex < terrainGrid.xValues.length - 1;
        columnIndex += 1
      ) {
        const topLeft = terrainGrid.elevations[rowIndex][columnIndex];
        const topRight = terrainGrid.elevations[rowIndex][columnIndex + 1];
        const bottomRight =
          terrainGrid.elevations[rowIndex + 1][columnIndex + 1];
        const bottomLeft = terrainGrid.elevations[rowIndex + 1][columnIndex];

        if (
          [topLeft, topRight, bottomRight, bottomLeft].some(
            (value) => !Number.isFinite(value)
          )
        ) {
          continue;
        }

        const corners = [
          {
            x: terrainGrid.xValues[columnIndex],
            y: terrainGrid.yValues[rowIndex],
            elevation: topLeft,
          },
          {
            x: terrainGrid.xValues[columnIndex + 1],
            y: terrainGrid.yValues[rowIndex],
            elevation: topRight,
          },
          {
            x: terrainGrid.xValues[columnIndex + 1],
            y: terrainGrid.yValues[rowIndex + 1],
            elevation: bottomRight,
          },
          {
            x: terrainGrid.xValues[columnIndex],
            y: terrainGrid.yValues[rowIndex + 1],
            elevation: bottomLeft,
          },
        ];

        const edges = [
          [corners[0], corners[1]],
          [corners[1], corners[2]],
          [corners[2], corners[3]],
          [corners[3], corners[0]],
        ];
        const intersections = [];

        for (const [startPoint, endPoint] of edges) {
          const minElevation = Math.min(startPoint.elevation, endPoint.elevation);
          const maxElevation = Math.max(startPoint.elevation, endPoint.elevation);

          if (level < minElevation || level > maxElevation) {
            continue;
          }

          const point = interpolate(startPoint, endPoint, level);

          if (point) {
            intersections.push(point);
          }
        }

        if (intersections.length === 2) {
          rawSegments.push({
            provider: "open-meteo",
            elevation: Number(level.toFixed(2)),
            points: [intersections[0], intersections[1]],
          });
        } else if (intersections.length === 4) {
          rawSegments.push({
            provider: "open-meteo",
            elevation: Number(level.toFixed(2)),
            points: [intersections[0], intersections[1]],
          });
          rawSegments.push({
            provider: "open-meteo",
            elevation: Number(level.toFixed(2)),
            points: [intersections[2], intersections[3]],
          });
        }
      }
    }
  }

  return featureCollection(
    rawSegments.map((segment) =>
      lineFeature(
        segment.points.map((point) => lngLatFromMeters(location, point[0], point[1])),
        {
          provider: segment.provider || "open-meteo",
          elevation: Number(segment.elevation || 0),
        }
      )
    )
  );
}

async function resolveParcelBoundary(location, config) {
  if (!config.vworldApiKey) {
    const mockParcel = normalizeParcelFeature(createMockParcelFeature(location));
    return {
      feature: mockParcel,
      provider: "mock",
      isFallback: true,
      note: "브이월드 키가 없어 모의 대지 경계를 사용했습니다.",
    };
  }

  try {
    const collection = await fetchVWorldFeatureCollection(
      "LP_PA_CBND_BUBUN",
      `POINT(${location.lng} ${location.lat})`,
      3,
      config
    );
    const parcelFeature = pickPolygonFeature(collection.features, location);

    if (parcelFeature) {
      const normalizedFeature = normalizeParcelFeature(parcelFeature);
      return {
        feature: normalizedFeature,
        provider: "vworld",
        isFallback: false,
        note: "브이월드에서 실제 대지 경계를 불러왔습니다.",
      };
    }
  } catch (error) {
    return {
      feature: normalizeParcelFeature(createMockParcelFeature(location)),
      provider: "mock",
      isFallback: true,
      note:
        error instanceof Error
          ? `대지 경계 조회에 실패했습니다: ${error.message}`
          : "대지 경계 조회에 실패했습니다.",
    };
  }

  return {
    feature: normalizeParcelFeature(createMockParcelFeature(location)),
    provider: "mock",
    isFallback: true,
    note: "실제 대지 경계가 없어 모의 대지 경계를 사용했습니다.",
  };
}

function estimateClipBufferMeters(location, clipFeature) {
  const clipRing = getOuterRing(clipFeature);

  if (!clipRing?.length) {
    return 160;
  }

  let maxDistance = 0;

  for (const point of clipRing) {
    const [xMeters, yMeters] = localMetersFromLngLat(point, location);
    maxDistance = Math.max(maxDistance, Math.hypot(xMeters, yMeters));
  }

  return Math.max(80, Math.ceil(maxDistance + 30));
}

function buildBuildingQueryPlan(location, clipFeature) {
  const clipRing = getOuterRing(clipFeature);
  const bounds = polygonBounds(clipRing);
  const minX = localMetersFromLngLat([bounds.minLng, location.lat], location)[0];
  const maxX = localMetersFromLngLat([bounds.maxLng, location.lat], location)[0];
  const minY = localMetersFromLngLat([location.lng, bounds.minLat], location)[1];
  const maxY = localMetersFromLngLat([location.lng, bounds.maxLat], location)[1];
  const width = maxX - minX;
  const height = maxY - minY;
  const longestSide = Math.max(width, height);

  if (longestSide <= 2400) {
    return [
      {
        lng: location.lng,
        lat: location.lat,
        buffer: Math.max(120, Math.ceil(longestSide / 2) + 80),
        maxPages: longestSide > 1400 ? 12 : 8,
      },
    ];
  }

  const tileStep = 2400;
  const buffer = 1750;
  const plans = [];

  for (let y = minY; y <= maxY + 0.001; y += tileStep) {
    for (let x = minX; x <= maxX + 0.001; x += tileStep) {
      const centerX = Math.min(x + tileStep / 2, maxX);
      const centerY = Math.min(y + tileStep / 2, maxY);
      const lngLat = lngLatFromMeters(location, centerX, centerY);

      plans.push({
        lng: lngLat[0],
        lat: lngLat[1],
        buffer,
        maxPages: 2,
      });
    }
  }

  plans.unshift({
    lng: location.lng,
    lat: location.lat,
    buffer: Math.min(2200, Math.ceil(longestSide / 2)),
    maxPages: 4,
  });

  return plans;
}

async function resolveBuildingContext(
  location,
  clipFeature,
  parcelFeature,
  config
) {
  if (!config.vworldApiKey) {
    return {
      collection: featureCollection([]),
      provider: "unavailable",
      isFallback: true,
      note: "VWorld key missing; building context unavailable.",
    };
  }

  try {
    const clipRing = getOuterRing(clipFeature);
    const queryPlan = buildBuildingQueryPlan(location, clipFeature);
    const featureMap = new Map();

    for (const query of queryPlan) {
      const collection = await fetchAllVWorldFeatureCollections(
        "lt_c_spbd",
        `POINT(${query.lng} ${query.lat})`,
        query.buffer,
        config,
        250,
        query.maxPages
      );

      for (const feature of collection.features) {
        const key = String(
          feature?.properties?.bd_mgt_sn ||
            feature?.properties?.pk ||
            feature?.id ||
            JSON.stringify(feature?.geometry || {})
        );

        if (!featureMap.has(key)) {
          featureMap.set(key, feature);
        }
      }
    }

    const filteredFeatures = [...featureMap.values()]
      .map((feature) => clipFeatureToRing(feature, clipRing, location))
      .filter(Boolean)
      .map((feature) => normalizeBuildingFeature(feature, parcelFeature))
      .filter((feature) => Number(feature.properties?.footprintAreaSqm || 0) > 2)
      .sort((left, right) => {
        const targetDelta =
          Number(right.properties?.isTarget || false) -
          Number(left.properties?.isTarget || false);

        if (targetDelta) {
          return targetDelta;
        }

        return (
          Number(right.properties?.footprintAreaSqm || 0) -
          Number(left.properties?.footprintAreaSqm || 0)
        );
      });

    const parcelReference = decomposePnu(parcelFeature?.properties?.pnu);
    let enrichedFeatures = filteredFeatures;
    let registerMatchedCount = 0;

    if (parcelReference && config.buildingHubServiceKey) {
      try {
        const registerItems = await fetchBuildingRegisterSummary(
          parcelReference,
          config
        );
        enrichedFeatures = attachBuildingRegisterMetadata(
          filteredFeatures,
          registerItems,
          parcelFeature
        );
        registerMatchedCount = enrichedFeatures.filter(
          (feature) => feature.properties?.registerMatched
        ).length;
      } catch {
        enrichedFeatures = filteredFeatures;
      }
    }

    return {
      collection: featureCollection(enrichedFeatures),
      provider: "vworld",
      isFallback: false,
      note:
        registerMatchedCount > 0
          ? `Loaded ${enrichedFeatures.length} building footprints and matched ${registerMatchedCount} building-register records.`
          : `Loaded ${enrichedFeatures.length} building footprints from VWorld.`,
    };
  } catch (error) {
    return {
      collection: featureCollection([]),
      provider: "unavailable",
      isFallback: true,
      note:
        error instanceof Error
          ? `Building context request failed: ${error.message}`
          : "Building context request failed.",
    };
  }
}

async function buildSiteContext(body, config, reportProgress = null) {
  const location = body.location || {};
  const options = body.options || {};
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  const progress =
    typeof reportProgress === "function" ? reportProgress : () => null;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("Invalid location payload");
  }

  const normalizedLocation = {
    ...location,
    lat,
    lng,
  };
  const cacheKey = buildSiteContextCacheKey(normalizedLocation, options);
  const cachedSiteContext = siteContextCache.get(cacheKey);

  if (
    cachedSiteContext &&
    Date.now() - cachedSiteContext.cachedAt < SITE_CONTEXT_CACHE_TTL_MS
  ) {
    progress(100, "저장된 대지 컨텍스트를 불러왔습니다.");
    return cachedSiteContext.value;
  }

  progress(10, "필지 경계를 불러오는 중입니다.");
  const parcelResult = await resolveParcelBoundary(normalizedLocation, config);
  progress(24, "대지 범위를 계산하는 중입니다.");
  const clipBoundary = buildClipBoundary(
    normalizedLocation,
    options,
    parcelResult.feature
  );
  progress(42, "지형 데이터를 준비하는 중입니다.");
  const terrainResult = await resolveTerrainContext(
    normalizedLocation,
    clipBoundary,
    options,
    config
  );
  const contourCollection =
    options.includeContours === false
      ? featureCollection([])
      : terrainResult.contourCollection;
  progress(
    58,
    options.includeBuildings === false
      ? "건물 컨텍스트를 생략하는 중입니다."
      : "건물 컨텍스트를 불러오는 중입니다."
  );
  const buildingResult =
    options.includeBuildings === false
      ? {
          collection: featureCollection([]),
          provider: "disabled",
          isFallback: false,
          note: "Building context disabled by option.",
        }
      : await resolveBuildingContext(
          normalizedLocation,
          clipBoundary,
          parcelResult.feature,
          config
        );
  progress(
    72,
    options.includeBuildings === false
      ? "건물 컨텍스트를 생략하고 있습니다."
      : "건물 컨텍스트를 정리하는 중입니다."
  );
  const parcelRing = getOuterRing(parcelResult.feature);
  const clipRing = getOuterRing(clipBoundary);
  const parcelArea = polygonAreaSquareMeters(parcelRing);
  const clipArea = polygonAreaSquareMeters(clipRing);
  const parcelCenter = centroidOfRing(parcelRing);
  const buildingCount = buildingResult.collection.features.length;
  const targetBuildingCount = buildingResult.collection.features.filter(
    (feature) => feature.properties?.isTarget
  ).length;

  const siteContext = {
    location: normalizedLocation,
    options: {
      shape: "rectangle",
      radius: Math.max(30, Number(options.radius) || 120),
      contourInterval: normalizeContourInterval(options.contourInterval),
      terrainMode: options.terrainMode || "contour",
      exportFormat: options.exportFormat || "obj",
      includeContours: options.includeContours !== false,
      includeBuildings: options.includeBuildings !== false,
      includeParcelBoundary: options.includeParcelBoundary !== false,
      includeRoads: options.includeRoads === true,
    },
    dataSources: {
      parcel: {
        provider: parcelResult.provider,
        mode: parcelResult.isFallback ? "fallback" : "live",
        note: parcelResult.note,
      },
      terrain: {
        provider: terrainResult.provider,
        mode: terrainResult.mode,
        note: terrainResult.note,
      },
      contours: terrainResult.contourSource
        ? {
            provider: terrainResult.contourSource.provider,
            mode: terrainResult.contourSource.mode,
            note: terrainResult.contourSource.note,
            interval: terrainResult.sourceContourInterval || null,
          }
        : null,
      buildings: {
        provider: buildingResult.provider,
        mode: buildingResult.isFallback ? "fallback" : "live",
        note: buildingResult.note,
      },
    },
    stats: {
      parcelAreaSqm: Number(parcelArea.toFixed(2)),
      clipAreaSqm: Number(clipArea.toFixed(2)),
      contourCount: contourCollection.features.length,
      contourInterval: normalizeContourInterval(options.contourInterval),
      minElevation: Number.isFinite(terrainResult.terrainGrid?.minElevation)
        ? terrainResult.terrainGrid.minElevation
        : null,
      maxElevation: Number.isFinite(terrainResult.terrainGrid?.maxElevation)
        ? terrainResult.terrainGrid.maxElevation
        : null,
      buildingCount,
      targetBuildingCount,
      parcelCenter,
    },
    parcelBoundary: parcelResult.feature,
    clipBoundary,
    contourLines: contourCollection,
    terrainGrid: terrainResult.terrainGrid,
    buildings: buildingResult.collection,
    roads: featureCollection([]),
  };

  siteContextCache.set(cacheKey, {
    cachedAt: Date.now(),
    value: siteContext,
  });

  progress(100, "대지 컨텍스트 준비가 완료되었습니다.");
  return siteContext;
}

function syntheticHeightAtLocalPoint(xMeters, yMeters, seed) {
  return (
    Math.sin((xMeters + seed) / 36) * 2.8 +
    Math.cos((yMeters - seed * 0.25) / 28) * 1.9 +
    Math.sin((xMeters + yMeters) / 54) * 0.8
  );
}

function siteHeightAtLocalPoint(siteContext, xMeters, yMeters, seed) {
  if (siteContext.options?.terrainMode === "flat") {
    return 0;
  }

  const terrainGrid = siteContext.terrainGrid;

  if (terrainGrid?.elevations?.length) {
    const xValues = terrainGrid.xValues || [];
    const yValues = terrainGrid.yValues || [];

    if (xValues.length >= 2 && yValues.length >= 2) {
      const xStep = terrainGrid.step || xValues[1] - xValues[0];
      const yStep = terrainGrid.step || yValues[1] - yValues[0];
      const gx = (xMeters - xValues[0]) / xStep;
      const gy = (yMeters - yValues[0]) / yStep;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const x1 = Math.min(xValues.length - 1, x0 + 1);
      const y1 = Math.min(yValues.length - 1, y0 + 1);

      if (x0 >= 0 && y0 >= 0 && x1 < xValues.length && y1 < yValues.length) {
        const q11 = terrainGrid.elevations[y0]?.[x0];
        const q21 = terrainGrid.elevations[y0]?.[x1];
        const q12 = terrainGrid.elevations[y1]?.[x0];
        const q22 = terrainGrid.elevations[y1]?.[x1];

        if ([q11, q21, q12, q22].every((value) => Number.isFinite(value))) {
          const tx = gx - x0;
          const ty = gy - y0;
          const top = q11 * (1 - tx) + q21 * tx;
          const bottom = q12 * (1 - tx) + q22 * tx;
          return quantizeTerrainHeight(
            siteContext,
            top * (1 - ty) + bottom * ty
          );
        }
      }
    }

    let closestElevation = null;
    let closestDistanceSquared = Number.POSITIVE_INFINITY;

    for (let rowIndex = 0; rowIndex < yValues.length; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < xValues.length; columnIndex += 1) {
        const value = terrainGrid.elevations[rowIndex]?.[columnIndex];

        if (!Number.isFinite(value)) {
          continue;
        }

        const dx = xMeters - xValues[columnIndex];
        const dy = yMeters - yValues[rowIndex];
        const distanceSquared = dx * dx + dy * dy;

        if (distanceSquared < closestDistanceSquared) {
          closestDistanceSquared = distanceSquared;
          closestElevation = value;
        }
      }
    }

    if (Number.isFinite(closestElevation)) {
      return quantizeTerrainHeight(siteContext, closestElevation);
    }
  }

  return quantizeTerrainHeight(
    siteContext,
    syntheticHeightAtLocalPoint(xMeters, yMeters, seed)
  );
}

function estimateBuildingBaseElevationFromSamples(
  siteContext,
  ring,
  center,
  seed
) {
  if (!ring.length || siteContext.options?.terrainMode !== "contour") {
    return null;
  }

  const elevations = [];

  for (let index = 0; index < ring.length; index += 1) {
    const point = ring[index];
    const nextPoint = ring[(index + 1) % ring.length];
    const samplePoints = [
      point,
      [
        point[0] + (nextPoint[0] - point[0]) * 0.5,
        point[1] + (nextPoint[1] - point[1]) * 0.5,
      ],
    ];

    for (const samplePoint of samplePoints) {
      const [xMeters, yMeters] = localMetersFromLngLat(samplePoint, center);
      const elevation = siteHeightAtLocalPoint(siteContext, xMeters, yMeters, seed);

      if (Number.isFinite(elevation)) {
        elevations.push(Number(elevation.toFixed(3)));
      }
    }
  }

  const centroid = centroidOfRing(ring);

  if (centroid) {
    const [xMeters, yMeters] = localMetersFromLngLat(centroid, center);
    const centroidElevation = siteHeightAtLocalPoint(
      siteContext,
      xMeters,
      yMeters,
      seed
    );

    if (Number.isFinite(centroidElevation)) {
      // Weight the interior of the footprint so single low edge samples
      // do not bury the whole building into the terrain.
      const normalizedCentroidElevation = Number(centroidElevation.toFixed(3));
      elevations.push(
        normalizedCentroidElevation,
        normalizedCentroidElevation,
        normalizedCentroidElevation
      );
    }
  }

  if (!elevations.length) {
    return null;
  }

  const countsByElevation = new Map();

  for (const elevation of elevations) {
    countsByElevation.set(elevation, (countsByElevation.get(elevation) || 0) + 1);
  }

  let dominantElevation = null;
  let dominantCount = -1;

  for (const [elevation, count] of countsByElevation.entries()) {
    if (
      count > dominantCount ||
      (count === dominantCount && elevation > dominantElevation)
    ) {
      dominantElevation = elevation;
      dominantCount = count;
    }
  }

  return Number.isFinite(dominantElevation)
    ? Number(dominantElevation.toFixed(3))
    : Number(Math.min(...elevations).toFixed(3));
}

function buildingBaseElevationForRing(siteContext, ring, center, seed) {
  if (!ring.length || siteContext.options?.terrainMode !== "contour") {
    return null;
  }

  const localRing = ring
    .map((point) => localMetersFromLngLat(point, center))
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  const footprintRing = buildPolygonClippingRing(
    orientLocalPolygonCounterClockwise(localRing)
  );

  if (footprintRing) {
    const footprintMultiPolygon = [[footprintRing]];
    const topSurfaceGroups = getCachedContourTopSurfaceGroups(siteContext);
    let dominantElevation = null;
    let dominantAreaSqm = 0;

    for (const surfaceGroup of topSurfaceGroups) {
      if (!surfaceGroup.multiPolygon?.length) {
        continue;
      }

      let overlapMultiPolygon = [];

      try {
        overlapMultiPolygon =
          polygonClipping.intersection(
            footprintMultiPolygon,
            surfaceGroup.multiPolygon
          ) || [];
      } catch (error) {
        console.warn(
          `[building-terrain] overlap intersection fallback elevation=${surfaceGroup.elevation} error=${formatErrorForLog(
            error
          )}`
        );
        continue;
      }

      const overlapAreaSqm = computeLocalMultiPolygonArea(overlapMultiPolygon);

      if (
        overlapAreaSqm > dominantAreaSqm + 0.001 ||
        (Math.abs(overlapAreaSqm - dominantAreaSqm) <= 0.001 &&
          surfaceGroup.elevation > dominantElevation)
      ) {
        dominantAreaSqm = overlapAreaSqm;
        dominantElevation = surfaceGroup.elevation;
      }
    }

    if (Number.isFinite(dominantElevation) && dominantAreaSqm > 0.001) {
      return Number(dominantElevation.toFixed(3));
    }
  }

  return estimateBuildingBaseElevationFromSamples(siteContext, ring, center, seed);
}

function sanitizeObjName(value, fallback) {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^\w\-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized || fallback;
}

function getOpenRing(ring) {
  if (!ring?.length) {
    return [];
  }

  const lastPoint = ring[ring.length - 1];
  const firstPoint = ring[0];

  if (lastPoint[0] === firstPoint[0] && lastPoint[1] === firstPoint[1]) {
    return ring.slice(0, -1);
  }

  return [...ring];
}

function appendObjVertex(lines, xMeters, yMeters, elevation) {
  // Match Rhino's "Rhino Z to OBJ Y" convention so importing with
  // "OBJ Y to Rhino Z" preserves a Z-up model in Rhino.
  lines.push(
    `v ${xMeters.toFixed(3)} ${elevation.toFixed(3)} ${(-yMeters).toFixed(3)}`
  );
}

function appendObjFace(lines, vertexIndices, reverse = false) {
  if (!Array.isArray(vertexIndices) || vertexIndices.length < 3) {
    return;
  }

  const faceIndices = reverse ? [...vertexIndices].reverse() : vertexIndices;
  lines.push(`f ${faceIndices.join(" ")}`);
}

function appendObjQuad(lines, a, b, c, d) {
  lines.push(`f ${a} ${b} ${c} ${d}`);
}

function getTerrainBaseElevation(siteContext, fallbackElevation = 0) {
  const reference = Number.isFinite(siteContext.stats?.minElevation)
    ? Number(siteContext.stats.minElevation)
    : fallbackElevation;

  if (!Number.isFinite(reference)) {
    return 0;
  }

  return Number((reference - 10).toFixed(3));
}

function resolveTerrainExportGridStep(
  siteContext,
  widthMeters,
  heightMeters,
  fallbackRadius = 120
) {
  const longestSide = Math.max(widthMeters, heightMeters, 1);
  const areaSquareMeters = Math.max(1, widthMeters * heightMeters);
  const radius = Math.max(30, Number(siteContext.options?.radius) || fallbackRadius);
  const terrainStep = Number(siteContext.terrainGrid?.step) || 0;
  const legacyStep = Math.max(4, Math.min(80, Math.round(radius / 35)));
  const pointBudget =
    longestSide >= 1600 ? 10_000 : longestSide >= 900 ? 8_100 : 6_400;
  const budgetLimitedStep = Math.sqrt(areaSquareMeters / pointBudget);

  if (siteContext.options?.terrainMode === "contour") {
    const preferredContourStep =
      terrainStep > 0 ? terrainStep / 2 : Math.max(4, legacyStep / 2);

    return Number(
      Math.max(4, Math.max(budgetLimitedStep, preferredContourStep)).toFixed(3)
    );
  }

  return Number(Math.max(legacyStep, budgetLimitedStep).toFixed(3));
}

function getTerraceCellElevation(siteContext, terrainGrid, rowIndex, columnIndex) {
  const values = [
    terrainGrid.elevations[rowIndex]?.[columnIndex],
    terrainGrid.elevations[rowIndex]?.[columnIndex + 1],
    terrainGrid.elevations[rowIndex + 1]?.[columnIndex + 1],
    terrainGrid.elevations[rowIndex + 1]?.[columnIndex],
  ].filter((value) => Number.isFinite(value));

  if (!values.length) {
    return null;
  }

  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return quantizeTerrainHeight(siteContext, average);
}

function dedupeLocalPolygonPoints(points, toleranceMeters = 0.001) {
  const deduped = [];

  for (const point of points || []) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    ) {
      continue;
    }

    if (
      !deduped.length ||
      !pointsMatchInMeters(deduped[deduped.length - 1], point, toleranceMeters)
    ) {
      deduped.push([point[0], point[1]]);
    }
  }

  if (
    deduped.length >= 2 &&
    pointsMatchInMeters(deduped[0], deduped[deduped.length - 1], toleranceMeters)
  ) {
    deduped.pop();
  }

  return deduped;
}

function interpolateTerrainPointAtLevel(startPoint, endPoint, level) {
  const elevationDifference = endPoint.elevation - startPoint.elevation;

  if (!elevationDifference) {
    return [startPoint.x, startPoint.y];
  }

  const ratio = (level - startPoint.elevation) / elevationDifference;

  return [
    startPoint.x + (endPoint.x - startPoint.x) * ratio,
    startPoint.y + (endPoint.y - startPoint.y) * ratio,
  ];
}

function clipTriangleAboveLevel(triangle, level) {
  const clipped = [];

  for (let index = 0; index < triangle.length; index += 1) {
    const current = triangle[index];
    const next = triangle[(index + 1) % triangle.length];
    const currentInside = current.elevation >= level;
    const nextInside = next.elevation >= level;

    if (currentInside && nextInside) {
      clipped.push([next.x, next.y]);
      continue;
    }

    if (currentInside && !nextInside) {
      clipped.push(interpolateTerrainPointAtLevel(current, next, level));
      continue;
    }

    if (!currentInside && nextInside) {
      clipped.push(interpolateTerrainPointAtLevel(current, next, level));
      clipped.push([next.x, next.y]);
    }
  }

  return dedupeLocalPolygonPoints(clipped);
}

function buildContourBandSlices(siteContext) {
  const terrainGrid = siteContext.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return [];
  }

  const interval = normalizeContourInterval(siteContext.options?.contourInterval);
  const startLevel =
    Math.floor(Number(terrainGrid.minElevation || 0) / interval) * interval;
  const maxElevation = Number(terrainGrid.maxElevation || 0);
  const slices = [];
  const xValues = terrainGrid.xValues || [];
  const yValues = terrainGrid.yValues || [];

  for (let level = startLevel; level < maxElevation - 0.001; level += interval) {
    const topElevation = Math.min(level + interval, maxElevation);

    if (topElevation <= level + 0.001) {
      continue;
    }

    for (let rowIndex = 0; rowIndex < yValues.length - 1; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < xValues.length - 1; columnIndex += 1) {
        const topLeft = terrainGrid.elevations[rowIndex]?.[columnIndex];
        const topRight = terrainGrid.elevations[rowIndex]?.[columnIndex + 1];
        const bottomRight =
          terrainGrid.elevations[rowIndex + 1]?.[columnIndex + 1];
        const bottomLeft = terrainGrid.elevations[rowIndex + 1]?.[columnIndex];

        if (
          [topLeft, topRight, bottomRight, bottomLeft].some(
            (value) => !Number.isFinite(value)
          )
        ) {
          continue;
        }

        const triangles = [
          [
            {
              x: xValues[columnIndex],
              y: yValues[rowIndex],
              elevation: topLeft,
            },
            {
              x: xValues[columnIndex + 1],
              y: yValues[rowIndex],
              elevation: topRight,
            },
            {
              x: xValues[columnIndex + 1],
              y: yValues[rowIndex + 1],
              elevation: bottomRight,
            },
          ],
          [
            {
              x: xValues[columnIndex],
              y: yValues[rowIndex],
              elevation: topLeft,
            },
            {
              x: xValues[columnIndex + 1],
              y: yValues[rowIndex + 1],
              elevation: bottomRight,
            },
            {
              x: xValues[columnIndex],
              y: yValues[rowIndex + 1],
              elevation: bottomLeft,
            },
          ],
        ];

        for (const triangle of triangles) {
          const polygonPoints = clipTriangleAboveLevel(triangle, level);

          if (polygonPoints.length >= 3) {
            slices.push({
              bottomElevation: Number(level.toFixed(3)),
              topElevation: Number(topElevation.toFixed(3)),
              points: polygonPoints,
            });
          }
        }
      }
    }
  }

  return slices;
}

function computeLocalPolygonSignedArea(points) {
  const polygon = dedupeLocalPolygonPoints(points);

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

function orientLocalPolygonCounterClockwise(points) {
  const polygon = dedupeLocalPolygonPoints(points);

  if (polygon.length < 3) {
    return polygon;
  }

  return computeLocalPolygonSignedArea(polygon) >= 0
    ? polygon
    : [...polygon].reverse();
}

function simplifyLocalPolygon(points, toleranceMeters = 0.001) {
  const polygon = dedupeLocalPolygonPoints(points, toleranceMeters);

  if (polygon.length < 3) {
    return polygon;
  }

  const simplified = [];

  for (let index = 0; index < polygon.length; index += 1) {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const vectorA = [current[0] - previous[0], current[1] - previous[1]];
    const vectorB = [next[0] - current[0], next[1] - current[1]];
    const cross = vectorA[0] * vectorB[1] - vectorA[1] * vectorB[0];
    const vectorALength = Math.hypot(vectorA[0], vectorA[1]);
    const vectorBLength = Math.hypot(vectorB[0], vectorB[1]);

    if (
      vectorALength <= toleranceMeters ||
      vectorBLength <= toleranceMeters ||
      Math.abs(cross) <= toleranceMeters * Math.max(vectorALength, vectorBLength)
    ) {
      continue;
    }

    simplified.push(current);
  }

  return simplified.length >= 3 ? simplified : polygon;
}

function buildLocalPointKey(point, decimals = 3) {
  return `${point[0].toFixed(decimals)},${point[1].toFixed(decimals)}`;
}

function buildPolygonClippingRing(points) {
  const polygon = dedupeLocalPolygonPoints(points, 0.001);

  if (polygon.length < 3) {
    return null;
  }

  return polygon.map(([xMeters, yMeters]) => [
    Number(xMeters.toFixed(6)),
    Number(yMeters.toFixed(6)),
  ]);
}

function buildContourBandUnionLoops(slices) {
  const multiPolygon = [];

  for (const slice of slices) {
    const ring = buildPolygonClippingRing(
      orientLocalPolygonCounterClockwise(slice.points)
    );

    if (!ring) {
      continue;
    }

    multiPolygon.push([ring]);
  }

  if (!multiPolygon.length) {
    return [];
  }

  try {
    const unionResult = polygonClipping.union(multiPolygon);

    return unionResult
      .flatMap((polygon) => polygon || [])
      .map((ring) => simplifyLocalPolygon(ring, 0.01))
      .filter((ring) => ring.length >= 3);
  } catch (error) {
    console.warn(
      `[terrain-union] polygon union fallback slices=${multiPolygon.length} error=${formatErrorForLog(
        error
      )}`
    );
    return [];
  }
}

function mergeBandSlicePolygons(polygons, precision = 3) {
  const edgeBuckets = new Map();

  for (const polygonPoints of polygons) {
    const polygon = orientLocalPolygonCounterClockwise(polygonPoints);

    if (polygon.length < 3) {
      continue;
    }

    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];

      if (pointsMatchInMeters(start, end)) {
        continue;
      }

      const startKey = buildLocalPointKey(start, precision);
      const endKey = buildLocalPointKey(end, precision);
      const normalizedKey =
        startKey <= endKey
          ? `${startKey}|${endKey}`
          : `${endKey}|${startKey}`;

      if (!edgeBuckets.has(normalizedKey)) {
        edgeBuckets.set(normalizedKey, []);
      }

      edgeBuckets.get(normalizedKey).push({ start, end, startKey, endKey });
    }
  }

  const boundaryEdges = [];
  const pointsByKey = new Map();

  for (const bucket of edgeBuckets.values()) {
    if (bucket.length % 2 === 0) {
      continue;
    }

    const edge = bucket[0];
    boundaryEdges.push(edge);
    pointsByKey.set(edge.startKey, edge.start);
    pointsByKey.set(edge.endKey, edge.end);
  }

  if (!boundaryEdges.length) {
    return [];
  }

  const connectedEdges = new Map();

  for (let edgeIndex = 0; edgeIndex < boundaryEdges.length; edgeIndex += 1) {
    const edge = boundaryEdges[edgeIndex];

    if (!connectedEdges.has(edge.startKey)) {
      connectedEdges.set(edge.startKey, []);
    }
    if (!connectedEdges.has(edge.endKey)) {
      connectedEdges.set(edge.endKey, []);
    }

    connectedEdges.get(edge.startKey).push(edgeIndex);
    connectedEdges.get(edge.endKey).push(edgeIndex);
  }

  const visitedEdges = new Set();
  const mergedPolygons = [];

  for (let edgeIndex = 0; edgeIndex < boundaryEdges.length; edgeIndex += 1) {
    if (visitedEdges.has(edgeIndex)) {
      continue;
    }

    const firstEdge = boundaryEdges[edgeIndex];
    const polygonPoints = [firstEdge.start, firstEdge.end];
    let previousKey = firstEdge.startKey;
    let currentKey = firstEdge.endKey;
    visitedEdges.add(edgeIndex);
    let isClosed = false;

    while (true) {
      if (currentKey === firstEdge.startKey) {
        isClosed = true;
        break;
      }

      const candidateIds = (connectedEdges.get(currentKey) || []).filter(
        (candidateId) => !visitedEdges.has(candidateId)
      );

      if (!candidateIds.length) {
        break;
      }

      const nextEdgeId =
        candidateIds.find((candidateId) => {
          const candidate = boundaryEdges[candidateId];
          const nextKey =
            candidate.startKey === currentKey
              ? candidate.endKey
              : candidate.startKey;
          return nextKey !== previousKey;
        }) ?? candidateIds[0];

      visitedEdges.add(nextEdgeId);
      const nextEdge = boundaryEdges[nextEdgeId];
      const nextKey =
        nextEdge.startKey === currentKey ? nextEdge.endKey : nextEdge.startKey;
      polygonPoints.push(pointsByKey.get(nextKey) || nextEdge.end);
      previousKey = currentKey;
      currentKey = nextKey;
    }

    if (!isClosed) {
      continue;
    }

    const simplifiedPolygon = simplifyLocalPolygon(
      polygonPoints,
      Math.max(0.001, Math.pow(10, -precision))
    );

    if (simplifiedPolygon.length >= 3) {
      mergedPolygons.push(simplifiedPolygon);
    }
  }

  return mergedPolygons;
}

function buildContourBandGroups(siteContext) {
  // Build cumulative terrain bands from clipped terrain-grid slices so
  // closed contours remain self-contained and only the true clip boundary
  // participates in the final solid.
  const rawSlices = buildContourBandSlices(siteContext);

  if (!rawSlices.length) {
    return [];
  }

  const groupedSlices = new Map();

  for (const slice of rawSlices) {
    const groupKey = `${slice.bottomElevation.toFixed(3)}|${slice.topElevation.toFixed(3)}`;

    if (!groupedSlices.has(groupKey)) {
      groupedSlices.set(groupKey, []);
    }

    groupedSlices.get(groupKey).push(slice);
  }

  const bandGroups = [];

  for (const [groupKey, slices] of groupedSlices.entries()) {
    const [bottomElevation, topElevation] = groupKey.split("|").map(Number);
    const unionLoops = buildContourBandUnionLoops(slices);
    const regions = buildContourBandRegions(unionLoops, slices);
    const boundaryLoops = regions.flatMap((region) => [
      region.outerPoints,
      ...(region.holePoints || []),
    ]);

    bandGroups.push({
      bottomElevation,
      topElevation,
      boundaryLoops,
      regions,
    });
  }

  return bandGroups;
}

function getCachedContourBandGroups(siteContext) {
  if (!siteContext || typeof siteContext !== "object") {
    return buildContourBandGroups(siteContext);
  }

  if (contourBandGroupCache.has(siteContext)) {
    return contourBandGroupCache.get(siteContext);
  }

  const bandGroups = buildContourBandGroups(siteContext).sort(
    (left, right) =>
      left.bottomElevation - right.bottomElevation ||
      left.topElevation - right.topElevation
  );
  contourBandGroupCache.set(siteContext, bandGroups);
  return bandGroups;
}

function buildPolygonClippingMultiPolygonFromRegions(regions) {
  const multiPolygon = [];

  for (const region of regions || []) {
    const outerRing = buildPolygonClippingRing(
      orientLocalPolygonCounterClockwise(region.outerPoints || [])
    );

    if (!outerRing) {
      continue;
    }

    const polygon = [outerRing];

    for (const holePoints of region.holePoints || []) {
      const holeRing = buildPolygonClippingRing(holePoints);

      if (holeRing) {
        polygon.push(holeRing);
      }
    }

    multiPolygon.push(polygon);
  }

  return multiPolygon;
}

function computeLocalMultiPolygonArea(multiPolygon) {
  let area = 0;

  for (const polygon of multiPolygon || []) {
    if (!Array.isArray(polygon) || !polygon.length) {
      continue;
    }

    area += Math.abs(computeLocalPolygonSignedArea(polygon[0]));

    for (let ringIndex = 1; ringIndex < polygon.length; ringIndex += 1) {
      area -= Math.abs(computeLocalPolygonSignedArea(polygon[ringIndex]));
    }
  }

  return Math.max(0, Number(area.toFixed(6)));
}

function buildContourTopSurfaceGroups(siteContext) {
  const bandGroups = getCachedContourBandGroups(siteContext);

  if (!bandGroups.length) {
    return [];
  }

  const cumulativeGroups = bandGroups
    .map((group) => ({
      ...group,
      multiPolygon: buildPolygonClippingMultiPolygonFromRegions(group.regions),
    }))
    .filter((group) => group.multiPolygon.length);
  const topSurfaceGroups = [];

  for (let index = 0; index < cumulativeGroups.length; index += 1) {
    const group = cumulativeGroups[index];
    const nextGroup = cumulativeGroups[index + 1];
    let topSurfaceMultiPolygon = group.multiPolygon;

    if (nextGroup?.multiPolygon?.length) {
      try {
        topSurfaceMultiPolygon =
          polygonClipping.difference(group.multiPolygon, nextGroup.multiPolygon) || [];
      } catch (error) {
        console.warn(
          `[building-terrain] top-surface difference fallback elevation=${group.topElevation} error=${formatErrorForLog(
            error
          )}`
        );
        topSurfaceMultiPolygon = group.multiPolygon;
      }
    }

    const areaSqm = computeLocalMultiPolygonArea(topSurfaceMultiPolygon);

    if (areaSqm <= 0.001) {
      continue;
    }

    topSurfaceGroups.push({
      elevation: Number(group.topElevation.toFixed(3)),
      areaSqm: Number(areaSqm.toFixed(3)),
      multiPolygon: topSurfaceMultiPolygon,
    });
  }

  return topSurfaceGroups;
}

function getCachedContourTopSurfaceGroups(siteContext) {
  if (!siteContext || typeof siteContext !== "object") {
    return buildContourTopSurfaceGroups(siteContext);
  }

  if (contourTopSurfaceCache.has(siteContext)) {
    return contourTopSurfaceCache.get(siteContext);
  }

  const topSurfaceGroups = buildContourTopSurfaceGroups(siteContext);
  contourTopSurfaceCache.set(siteContext, topSurfaceGroups);
  return topSurfaceGroups;
}

function estimateLocalPolygonInteriorPoint(polygon) {
  if (!polygon?.length) {
    return null;
  }

  const averagePoint = polygon.reduce(
    (sum, point) => {
      sum[0] += point[0];
      sum[1] += point[1];
      return sum;
    },
    [0, 0]
  );
  averagePoint[0] /= polygon.length;
  averagePoint[1] /= polygon.length;

  if (pointInRing(averagePoint, polygon)) {
    return averagePoint;
  }

  for (const point of polygon) {
    const candidate = [
      (point[0] + averagePoint[0]) / 2,
      (point[1] + averagePoint[1]) / 2,
    ];

    if (pointInRing(candidate, polygon)) {
      return candidate;
    }
  }

  return averagePoint;
}

function buildContourBandRegions(boundaryLoops, fallbackSlices = []) {
  const normalizedLoops = boundaryLoops
    .map((loop) => simplifyLocalPolygon(loop, 0.01))
    .filter((loop) => loop.length >= 3)
    .map((loop, index) => ({
      index,
      points: loop,
      area: Math.abs(computeLocalPolygonSignedArea(loop)),
      parentIndex: null,
      childIndexes: [],
      depth: 0,
      samplePoint: estimateLocalPolygonInteriorPoint(loop),
    }))
    .sort((left, right) => right.area - left.area);

  for (let loopIndex = 0; loopIndex < normalizedLoops.length; loopIndex += 1) {
    const loop = normalizedLoops[loopIndex];

    if (!loop.samplePoint) {
      continue;
    }

    for (let candidateIndex = loopIndex - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = normalizedLoops[candidateIndex];

      if (!pointInRing(loop.samplePoint, candidate.points)) {
        continue;
      }

      loop.parentIndex = candidate.index;
      candidate.childIndexes.push(loop.index);
      loop.depth = candidate.depth + 1;
      break;
    }
  }

  const loopsByIndex = new Map(
    normalizedLoops.map((loop) => [loop.index, loop])
  );
  const regions = [];

  for (const loop of normalizedLoops) {
    if (loop.depth % 2 !== 0) {
      continue;
    }

    const holePoints = loop.childIndexes
      .map((childIndex) => loopsByIndex.get(childIndex))
      .filter((childLoop) => childLoop && childLoop.depth === loop.depth + 1)
      .map((childLoop) => {
        const orientedHole = orientLocalPolygonCounterClockwise(childLoop.points);
        return [...orientedHole].reverse();
      });

    regions.push({
      outerPoints: orientLocalPolygonCounterClockwise(loop.points),
      holePoints,
    });
  }

  if (regions.length) {
    return regions;
  }

  return fallbackSlices
    .map((slice) => ({
      outerPoints: orientLocalPolygonCounterClockwise(slice.points),
      holePoints: [],
    }))
    .filter((region) => region.outerPoints.length >= 3);
}

function appendObjPrismFromPolygon(
  lines,
  polygonPoints,
  topElevation,
  baseElevation,
  vertexIndex
) {
  const openPolygon = dedupeLocalPolygonPoints(polygonPoints);

  if (openPolygon.length < 3 || topElevation <= baseElevation) {
    return vertexIndex;
  }

  const topIndices = [];
  const bottomIndices = [];

  for (const [xMeters, yMeters] of openPolygon) {
    appendObjVertex(lines, xMeters, yMeters, topElevation);
    topIndices.push(vertexIndex);
    vertexIndex += 1;
  }

  for (const [xMeters, yMeters] of openPolygon) {
    appendObjVertex(lines, xMeters, yMeters, baseElevation);
    bottomIndices.push(vertexIndex);
    vertexIndex += 1;
  }

  for (let index = 1; index < topIndices.length - 1; index += 1) {
    // no-op: caps are emitted below as polygon faces to keep OBJ lighter
  }

  appendObjFace(lines, topIndices);
  appendObjFace(lines, bottomIndices, true);

  for (let index = 0; index < openPolygon.length; index += 1) {
    const nextIndex = (index + 1) % openPolygon.length;
    appendObjQuad(
      lines,
      bottomIndices[index],
      bottomIndices[nextIndex],
      topIndices[nextIndex],
      topIndices[index]
    );
  }

  return vertexIndex;
}

function buildObjVertexCacheKey(xMeters, yMeters, elevation) {
  return `${xMeters.toFixed(3)}|${yMeters.toFixed(3)}|${elevation.toFixed(3)}`;
}

function ensureObjVertex(lines, vertexState, xMeters, yMeters, elevation) {
  const cacheKey = buildObjVertexCacheKey(xMeters, yMeters, elevation);

  if (vertexState.cache.has(cacheKey)) {
    return vertexState.cache.get(cacheKey);
  }

  appendObjVertex(lines, xMeters, yMeters, elevation);
  const vertexIndex = vertexState.nextIndex;
  vertexState.cache.set(cacheKey, vertexIndex);
  vertexState.nextIndex += 1;
  return vertexIndex;
}

function appendObjRegionCapFaces(lines, region, elevation, vertexState, reverse = false) {
  const rings = [region.outerPoints, ...(region.holePoints || [])]
    .map((ring) => dedupeLocalPolygonPoints(ring))
    .filter((ring) => ring.length >= 3);

  if (!rings.length) {
    return;
  }

  if (rings.length === 1) {
    const faceIndices = rings[0].map(([xMeters, yMeters]) =>
      ensureObjVertex(lines, vertexState, xMeters, yMeters, elevation)
    );
    appendObjFace(lines, faceIndices, reverse);
    return;
  }

  const flatCoordinates = [];
  const holeIndices = [];
  const vertexIndices = [];
  let pointOffset = 0;

  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const ring = rings[ringIndex];

    if (ringIndex > 0) {
      holeIndices.push(pointOffset);
    }

    for (const [xMeters, yMeters] of ring) {
      flatCoordinates.push(xMeters, yMeters);
      vertexIndices.push(
        ensureObjVertex(lines, vertexState, xMeters, yMeters, elevation)
      );
      pointOffset += 1;
    }
  }

  const triangles = earcut(flatCoordinates, holeIndices, 2);

  for (let index = 0; index < triangles.length; index += 3) {
    const a = vertexIndices[triangles[index]];
    const b = vertexIndices[triangles[index + 1]];
    const c = vertexIndices[triangles[index + 2]];

    if (reverse) {
      lines.push(`f ${a} ${c} ${b}`);
    } else {
      lines.push(`f ${a} ${b} ${c}`);
    }
  }
}

function appendObjVerticalLoopFaces(
  lines,
  loopPoints,
  topElevation,
  bottomElevation,
  vertexState
) {
  const polygon = dedupeLocalPolygonPoints(loopPoints);

  if (polygon.length < 2 || topElevation <= bottomElevation) {
    return;
  }

  const topIndices = polygon.map(([xMeters, yMeters]) =>
    ensureObjVertex(lines, vertexState, xMeters, yMeters, topElevation)
  );
  const bottomIndices = polygon.map(([xMeters, yMeters]) =>
    ensureObjVertex(lines, vertexState, xMeters, yMeters, bottomElevation)
  );
  const isCounterClockwise = computeLocalPolygonSignedArea(polygon) >= 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const nextIndex = (index + 1) % polygon.length;

    if (isCounterClockwise) {
      appendObjQuad(
        lines,
        bottomIndices[index],
        bottomIndices[nextIndex],
        topIndices[nextIndex],
        topIndices[index]
      );
    } else {
      appendObjQuad(
        lines,
        bottomIndices[nextIndex],
        bottomIndices[index],
        topIndices[index],
        topIndices[nextIndex]
      );
    }
  }
}

function appendObjContourBandRegionSolid(
  lines,
  region,
  topElevation,
  bottomElevation,
  vertexIndex,
  objectName
) {
  if (!region || topElevation <= bottomElevation) {
    return vertexIndex;
  }

  const rings = [region.outerPoints, ...(region.holePoints || [])]
    .map((ring) => dedupeLocalPolygonPoints(ring))
    .filter((ring) => ring.length >= 3);

  if (!rings.length) {
    return vertexIndex;
  }

  lines.push(`o ${objectName}`);

  const normalizedRegion = {
    outerPoints: rings[0],
    holePoints: rings.slice(1),
  };
  const vertexState = {
    cache: new Map(),
    nextIndex: vertexIndex,
  };

  appendObjRegionCapFaces(
    lines,
    normalizedRegion,
    topElevation,
    vertexState,
    false
  );
  appendObjRegionCapFaces(
    lines,
    normalizedRegion,
    bottomElevation,
    vertexState,
    true
  );

  for (const loop of rings) {
    appendObjVerticalLoopFaces(
      lines,
      loop,
      topElevation,
      bottomElevation,
      vertexState
    );
  }

  return vertexState.nextIndex;
}

function appendContourBandTerrainObjGeometry(lines, siteContext, vertexIndex) {
  const terrainGrid = siteContext.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return vertexIndex;
  }

  const interval = normalizeContourInterval(siteContext.options?.contourInterval);
  const baseElevation = getTerrainBaseElevation(
    siteContext,
    terrainGrid.minElevation
  );
  const clipPolygon = getOpenRing(getOuterRing(siteContext.clipBoundary)).map((point) =>
    localMetersFromLngLat(point, siteContext.location)
  );
  const minBandElevation =
    Math.floor(Number(terrainGrid.minElevation || 0) / interval) * interval;
  const bandGroups = getCachedContourBandGroups(siteContext);

  if (clipPolygon.length >= 3 && minBandElevation > baseElevation + 0.001) {
    lines.push("o TERRAIN_CONTOUR_BASE");
    vertexIndex = appendObjPrismFromPolygon(
      lines,
      clipPolygon,
      minBandElevation,
      baseElevation,
      vertexIndex
    );
  }

  for (let groupIndex = 0; groupIndex < bandGroups.length; groupIndex += 1) {
    const group = bandGroups[groupIndex];

    for (
      let regionIndex = 0;
      regionIndex < group.regions.length;
      regionIndex += 1
    ) {
      vertexIndex = appendObjContourBandRegionSolid(
        lines,
        group.regions[regionIndex],
        group.topElevation,
        group.bottomElevation,
        vertexIndex,
        `TERRAIN_CONTOUR_BAND_${groupIndex + 1}_${regionIndex + 1}`
      );
    }
  }

  return vertexIndex;
}

function buildMergedTerrainTerraceRects(siteContext) {
  const terrainGrid = siteContext.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return [];
  }

  const xValues = terrainGrid.xValues || [];
  const yValues = terrainGrid.yValues || [];
  const mergedRects = [];
  let activeRects = new Map();

  for (let rowIndex = 0; rowIndex < yValues.length - 1; rowIndex += 1) {
    const rowRects = [];
    let columnIndex = 0;

    while (columnIndex < xValues.length - 1) {
      const elevation = getTerraceCellElevation(
        siteContext,
        terrainGrid,
        rowIndex,
        columnIndex
      );

      if (!Number.isFinite(elevation)) {
        columnIndex += 1;
        continue;
      }

      let nextColumnIndex = columnIndex + 1;

      while (nextColumnIndex < xValues.length - 1) {
        const nextElevation = getTerraceCellElevation(
          siteContext,
          terrainGrid,
          rowIndex,
          nextColumnIndex
        );

        if (!Number.isFinite(nextElevation) || nextElevation !== elevation) {
          break;
        }

        nextColumnIndex += 1;
      }

      rowRects.push({
        elevation,
        xMin: xValues[columnIndex],
        xMax: xValues[nextColumnIndex],
        yMin: yValues[rowIndex],
        yMax: yValues[rowIndex + 1],
      });
      columnIndex = nextColumnIndex;
    }

    const nextActiveRects = new Map();

    for (const rect of rowRects) {
      const rectKey = [
        rect.elevation.toFixed(3),
        rect.xMin.toFixed(3),
        rect.xMax.toFixed(3),
      ].join("|");
      const continuedRect = activeRects.get(rectKey);

      if (continuedRect && Math.abs(continuedRect.yMax - rect.yMin) <= 0.001) {
        continuedRect.yMax = rect.yMax;
        nextActiveRects.set(rectKey, continuedRect);
        activeRects.delete(rectKey);
      } else {
        nextActiveRects.set(rectKey, { ...rect });
      }
    }

    for (const rect of activeRects.values()) {
      mergedRects.push(rect);
    }

    activeRects = nextActiveRects;
  }

  for (const rect of activeRects.values()) {
    mergedRects.push(rect);
  }

  return mergedRects;
}

function appendTerracedTerrainObjGeometry(lines, siteContext, vertexIndex) {
  const terrainGrid = siteContext.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return vertexIndex;
  }

  const baseElevation = getTerrainBaseElevation(
    siteContext,
    terrainGrid.minElevation
  );
  const terraceRects = buildMergedTerrainTerraceRects(siteContext);

  lines.push("o TERRAIN_TERRACES");

  for (const rect of terraceRects) {
    const corners = [
      [rect.xMin, rect.yMin],
      [rect.xMax, rect.yMin],
      [rect.xMax, rect.yMax],
      [rect.xMin, rect.yMax],
    ];
      const topIndices = [];
      const bottomIndices = [];

    for (const [xMeters, yMeters] of corners) {
      appendObjVertex(lines, xMeters, yMeters, rect.elevation);
      topIndices.push(vertexIndex);
      vertexIndex += 1;
    }

    for (const [xMeters, yMeters] of corners) {
      appendObjVertex(lines, xMeters, yMeters, baseElevation);
      bottomIndices.push(vertexIndex);
      vertexIndex += 1;
    }

    appendObjQuad(lines, ...topIndices);
    appendObjQuad(
      lines,
      bottomIndices[0],
      bottomIndices[3],
      bottomIndices[2],
      bottomIndices[1]
    );

    for (let index = 0; index < corners.length; index += 1) {
      const nextIndex = (index + 1) % corners.length;
      appendObjQuad(
        lines,
        bottomIndices[index],
        bottomIndices[nextIndex],
        topIndices[nextIndex],
        topIndices[index]
      );
    }
  }

  return vertexIndex;
}

function appendTerrainMeshObjGeometry(
  lines,
  siteContext,
  center,
  seed,
  vertexIndex
) {
  const clipRing = getOuterRing(siteContext.clipBoundary);
  const clipOpenRing = getOpenRing(clipRing);
  const bounds = polygonBounds(clipRing);
  const minX = localMetersFromLngLat([bounds.minLng, center.lat], center)[0];
  const maxX = localMetersFromLngLat([bounds.maxLng, center.lat], center)[0];
  const minY = localMetersFromLngLat([center.lng, bounds.minLat], center)[1];
  const maxY = localMetersFromLngLat([center.lng, bounds.maxLat], center)[1];
  const gridStep = resolveTerrainExportGridStep(
    siteContext,
    maxX - minX,
    maxY - minY,
    120
  );
  const vertexRows = [];
  let sampledMinTerrainElevation = Number.POSITIVE_INFINITY;

  lines.push("o TERRAIN_MESH");

  for (let y = minY; y <= maxY + 0.001; y += gridStep) {
    const row = [];

    for (let x = minX; x <= maxX + 0.001; x += gridStep) {
      const lngLat = lngLatFromMeters(center, x, y);

      if (!pointInRing(lngLat, clipRing)) {
        row.push(null);
        continue;
      }

      const elevation = siteHeightAtLocalPoint(siteContext, x, y, seed);
      sampledMinTerrainElevation = Math.min(sampledMinTerrainElevation, elevation);
      appendObjVertex(lines, x, y, elevation);
      row.push(vertexIndex);
      vertexIndex += 1;
    }

    vertexRows.push(row);
  }

  for (let rowIndex = 0; rowIndex < vertexRows.length - 1; rowIndex += 1) {
    const currentRow = vertexRows[rowIndex];
    const nextRow = vertexRows[rowIndex + 1];

    for (
      let columnIndex = 0;
      columnIndex < currentRow.length - 1;
      columnIndex += 1
    ) {
      const a = currentRow[columnIndex];
      const b = currentRow[columnIndex + 1];
      const c = nextRow[columnIndex + 1];
      const d = nextRow[columnIndex];

      if (a && b && c) {
        lines.push(`f ${a} ${b} ${c}`);
      }

      if (a && c && d) {
        lines.push(`f ${a} ${c} ${d}`);
      }
    }
  }

  const baseElevation = getTerrainBaseElevation(
    siteContext,
    sampledMinTerrainElevation
  );

  if (clipOpenRing.length >= 3 && Number.isFinite(baseElevation)) {
    const topBoundaryIndices = [];
    const bottomBoundaryIndices = [];

    lines.push("o TERRAIN_BLOCK");

    for (const point of clipOpenRing) {
      const [xMeters, yMeters] = localMetersFromLngLat(point, center);
      const topElevation = siteHeightAtLocalPoint(
        siteContext,
        xMeters,
        yMeters,
        seed
      );

      appendObjVertex(lines, xMeters, yMeters, topElevation);
      topBoundaryIndices.push(vertexIndex);
      vertexIndex += 1;

      appendObjVertex(lines, xMeters, yMeters, baseElevation);
      bottomBoundaryIndices.push(vertexIndex);
      vertexIndex += 1;
    }

    for (let index = 0; index < clipOpenRing.length; index += 1) {
      const nextIndex = (index + 1) % clipOpenRing.length;
      appendObjQuad(
        lines,
        bottomBoundaryIndices[index],
        bottomBoundaryIndices[nextIndex],
        topBoundaryIndices[nextIndex],
        topBoundaryIndices[index]
      );
    }

    for (let index = 1; index < bottomBoundaryIndices.length - 1; index += 1) {
      lines.push(
        `f ${bottomBoundaryIndices[0]} ${bottomBoundaryIndices[index + 1]} ${bottomBoundaryIndices[index]}`
      );
    }
  }

  return vertexIndex;
}

function appendBuildingObjGeometry(
  lines,
  feature,
  center,
  siteContext,
  seed,
  vertexIndex
) {
  const ring = getOpenRing(getOuterRing(feature));

  if (ring.length < 3) {
    return vertexIndex;
  }

  const heightMeters = Math.max(
    3,
    Number(feature.properties?.heightMeters || 0) || 10.2
  );
  const buildingBaseElevation = buildingBaseElevationForRing(
    siteContext,
    ring,
    center,
    seed
  );
  const objectName = sanitizeObjName(
    feature.properties?.buildingName ||
      feature.properties?.buildingId ||
      feature.properties?.roadAddress,
    `BUILDING_${vertexIndex}`
  );
  const suffix = feature.properties?.isTarget ? "TARGET" : "CONTEXT";

  lines.push(`o ${suffix}_${objectName}`);

  const bottomIndices = [];
  const topIndices = [];

  for (const point of ring) {
    const [xMeters, yMeters] = localMetersFromLngLat(point, center);
    const baseElevation = Number.isFinite(buildingBaseElevation)
      ? buildingBaseElevation
      : siteHeightAtLocalPoint(siteContext, xMeters, yMeters, seed);
    const roofElevation = baseElevation + heightMeters;

    appendObjVertex(lines, xMeters, yMeters, baseElevation);
    bottomIndices.push(vertexIndex);
    vertexIndex += 1;

    appendObjVertex(lines, xMeters, yMeters, roofElevation);
    topIndices.push(vertexIndex);
    vertexIndex += 1;
  }

  for (let index = 0; index < ring.length; index += 1) {
    const nextIndex = (index + 1) % ring.length;
    appendObjQuad(
      lines,
      bottomIndices[index],
      bottomIndices[nextIndex],
      topIndices[nextIndex],
      topIndices[index]
    );
  }

  appendObjFace(lines, topIndices);
  appendObjFace(lines, bottomIndices, true);

  return vertexIndex;
}

function buildObjFromSiteContext(siteContext, reportProgress = null) {
  const location = siteContext.location;
  const center = { lat: location.lat, lng: location.lng };
  const parcelRing = getOuterRing(siteContext.parcelBoundary);
  const seed = Math.round(Math.abs(center.lat * 1000) + Math.abs(center.lng * 1000));
  const progress =
    typeof reportProgress === "function" ? reportProgress : () => null;
  const lines = [
    "# Site Context Planner OBJ export",
    `# Generated at ${new Date().toISOString()}`,
  ];
  let vertexIndex = 1;

  progress(8, "OBJ 지형을 구성하는 중입니다.");

  if (siteContext.options?.terrainMode === "contour") {
    vertexIndex = appendContourBandTerrainObjGeometry(
      lines,
      siteContext,
      vertexIndex
    );
  } else {
    vertexIndex = appendTerrainMeshObjGeometry(
      lines,
      siteContext,
      center,
      seed,
      vertexIndex
    );
  }

  if (siteContext.options?.includeParcelBoundary !== false) {
    progress(48, "필지 경계선을 추가하는 중입니다.");
    lines.push("o PARCEL_BOUNDARY");
    const parcelVertexIndices = [];

    for (const point of parcelRing) {
      const [xMeters, yMeters] = localMetersFromLngLat(point, center);
      const elevation =
        siteHeightAtLocalPoint(siteContext, xMeters, yMeters, seed) + 0.15;
      appendObjVertex(lines, xMeters, yMeters, elevation);
      parcelVertexIndices.push(vertexIndex);
      vertexIndex += 1;
    }

    if (parcelVertexIndices.length >= 2) {
      lines.push(`l ${parcelVertexIndices.join(" ")}`);
    }
  }

  if (siteContext.options?.includeContours !== false) {
    progress(64, "등고선 레이어를 정리하는 중입니다.");
    let contourCounter = 1;

    for (const feature of siteContext.contourLines.features) {
      for (const lineString of getLineStringsFromGeometry(feature.geometry)) {
        lines.push(`o CONTOUR_${contourCounter}`);
        const contourIndices = [];

        for (const point of lineString) {
          const [xMeters, yMeters] = localMetersFromLngLat(point, center);
          const elevation = Number(feature.properties?.elevation || 0);
          appendObjVertex(lines, xMeters, yMeters, elevation);
          contourIndices.push(vertexIndex);
          vertexIndex += 1;
        }

        if (contourIndices.length >= 2) {
          lines.push(`l ${contourIndices.join(" ")}`);
        }

        contourCounter += 1;
      }
    }
  }

  if (siteContext.options?.includeBuildings !== false) {
    progress(82, "건물 매스를 배치하는 중입니다.");
    for (const feature of siteContext.buildings?.features || []) {
      vertexIndex = appendBuildingObjGeometry(
        lines,
        feature,
        center,
        siteContext,
        seed,
        vertexIndex
      );
    }
  }

  progress(96, "OBJ 파일을 마무리하는 중입니다.");
  return lines.join("\n");
}

function createRhinoObjectAttributes(rhino, layerIndex, name = "", color = null) {
  const attributes = new rhino.ObjectAttributes();
  attributes.layerIndex = layerIndex;
  attributes.name = String(name || "");

  if (color) {
    attributes.colorSource = rhino.ObjectColorSource.ColorFromObject;
    attributes.objectColor = color;
  }

  return attributes;
}

function ensureRhinoLayer(doc, layerIndexCache, name, color) {
  if (!layerIndexCache.has(name)) {
    layerIndexCache.set(name, doc.layers().addLayer(name, color));
  }

  return layerIndexCache.get(name);
}

function createRhinoPolylineCurve(rhino, points) {
  return new rhino.PolylineCurve(points);
}

function createRhinoLocalProfileCurve(rhino, polygonPoints) {
  const openPolygon = dedupeLocalPolygonPoints(polygonPoints);

  if (openPolygon.length < 3) {
    return null;
  }

  const profilePoints = openPolygon
    .map(([xMeters, yMeters]) => [xMeters, yMeters, 0])
    .concat([[openPolygon[0][0], openPolygon[0][1], 0]]);

  return createRhinoPolylineCurve(rhino, profilePoints);
}

function addRhinoTerrainTerraces(doc, rhino, layerIndex, siteContext) {
  const terrainGrid = siteContext.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return;
  }

  const baseElevation = getTerrainBaseElevation(
    siteContext,
    terrainGrid.minElevation
  );
  const terraceRects = buildMergedTerrainTerraceRects(siteContext);

  for (let rectIndex = 0; rectIndex < terraceRects.length; rectIndex += 1) {
    const rect = terraceRects[rectIndex];
    const profilePoints = [
      [rect.xMin, rect.yMin, baseElevation],
      [rect.xMax, rect.yMin, baseElevation],
      [rect.xMax, rect.yMax, baseElevation],
      [rect.xMin, rect.yMax, baseElevation],
      [rect.xMin, rect.yMin, baseElevation],
    ];
    const curve = createRhinoPolylineCurve(rhino, profilePoints);
    const extrusion = rhino.Extrusion.create(
      curve,
      rect.elevation - baseElevation,
      true
    );

    if (!extrusion) {
      continue;
    }

    const brep = extrusion.toBrep(true);

    if (!brep) {
      continue;
    }

    doc.objects().add(
      brep,
      createRhinoObjectAttributes(rhino, layerIndex, `TERRACE_${rectIndex + 1}`)
    );
  }
}

function addRhinoPrismFromPolygon(
  doc,
  rhino,
  layerIndex,
  polygonPoints,
  topElevation,
  baseElevation,
  objectName
) {
  const openPolygon = dedupeLocalPolygonPoints(polygonPoints);

  if (openPolygon.length < 3 || topElevation <= baseElevation) {
    return;
  }

  const profilePoints = openPolygon
    .map(([xMeters, yMeters]) => [xMeters, yMeters, baseElevation])
    .concat([[openPolygon[0][0], openPolygon[0][1], baseElevation]]);
  const curve = createRhinoPolylineCurve(rhino, profilePoints);
  const extrusion = rhino.Extrusion.create(curve, topElevation - baseElevation, true);

  if (!extrusion) {
    return;
  }

  doc.objects().add(
    extrusion,
    createRhinoObjectAttributes(rhino, layerIndex, objectName)
  );
}

function addRhinoContourBandRegionExtrusion(
  doc,
  rhino,
  layerIndex,
  region,
  topElevation,
  bottomElevation,
  objectName
) {
  if (topElevation <= bottomElevation) {
    return false;
  }

  const outerCurve = createRhinoLocalProfileCurve(rhino, region.outerPoints);

  if (!outerCurve) {
    return false;
  }

  const extrusion = new rhino.Extrusion();

  if (!extrusion.setOuterProfile(outerCurve, true)) {
    return false;
  }

  for (const holePoints of region.holePoints || []) {
    const holeCurve = createRhinoLocalProfileCurve(rhino, holePoints);

    if (!holeCurve) {
      continue;
    }

    extrusion.addInnerProfile(holeCurve);
  }

  if (
    !extrusion.setPathAndUp(
      [0, 0, bottomElevation],
      [0, 0, topElevation],
      [0, 1, 0]
    )
  ) {
    return false;
  }

  doc.objects().add(
    extrusion,
    createRhinoObjectAttributes(rhino, layerIndex, objectName)
  );
  return true;
}

function ensureRhinoMeshVertex(mesh, vertexCache, xMeters, yMeters, elevation) {
  const cacheKey = buildObjVertexCacheKey(xMeters, yMeters, elevation);

  if (vertexCache.has(cacheKey)) {
    return vertexCache.get(cacheKey);
  }

  const vertexIndex = mesh.vertices().add(xMeters, yMeters, elevation);
  vertexCache.set(cacheKey, vertexIndex);
  return vertexIndex;
}

function addRhinoMeshRegionCapFaces(mesh, vertexCache, region, elevation, reverse = false) {
  const rings = [region.outerPoints, ...(region.holePoints || [])]
    .map((ring) => dedupeLocalPolygonPoints(ring))
    .filter((ring) => ring.length >= 3);

  if (!rings.length) {
    return;
  }

  const flatCoordinates = [];
  const holeIndices = [];
  const vertexIndices = [];
  let pointOffset = 0;

  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const ring = rings[ringIndex];

    if (ringIndex > 0) {
      holeIndices.push(pointOffset);
    }

    for (const [xMeters, yMeters] of ring) {
      flatCoordinates.push(xMeters, yMeters);
      vertexIndices.push(
        ensureRhinoMeshVertex(mesh, vertexCache, xMeters, yMeters, elevation)
      );
      pointOffset += 1;
    }
  }

  const triangles = earcut(flatCoordinates, holeIndices, 2);

  for (let index = 0; index < triangles.length; index += 3) {
    const a = vertexIndices[triangles[index]];
    const b = vertexIndices[triangles[index + 1]];
    const c = vertexIndices[triangles[index + 2]];

    if (reverse) {
      mesh.faces().addTriFace(a, c, b);
    } else {
      mesh.faces().addTriFace(a, b, c);
    }
  }
}

function addRhinoMeshVerticalLoopFaces(
  mesh,
  vertexCache,
  loopPoints,
  topElevation,
  bottomElevation
) {
  const polygon = dedupeLocalPolygonPoints(loopPoints);

  if (polygon.length < 2 || topElevation <= bottomElevation) {
    return;
  }

  const topIndices = polygon.map(([xMeters, yMeters]) =>
    ensureRhinoMeshVertex(mesh, vertexCache, xMeters, yMeters, topElevation)
  );
  const bottomIndices = polygon.map(([xMeters, yMeters]) =>
    ensureRhinoMeshVertex(mesh, vertexCache, xMeters, yMeters, bottomElevation)
  );
  const isCounterClockwise = computeLocalPolygonSignedArea(polygon) >= 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const nextIndex = (index + 1) % polygon.length;

    if (isCounterClockwise) {
      mesh.faces().addQuadFace(
        bottomIndices[index],
        bottomIndices[nextIndex],
        topIndices[nextIndex],
        topIndices[index]
      );
    } else {
      mesh.faces().addQuadFace(
        bottomIndices[nextIndex],
        bottomIndices[index],
        topIndices[index],
        topIndices[nextIndex]
      );
    }
  }
}

function addRhinoContourBandTerrain(doc, rhino, layerIndex, siteContext) {
  const terrainGrid = siteContext.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return;
  }

  const interval = normalizeContourInterval(siteContext.options?.contourInterval);
  const baseElevation = getTerrainBaseElevation(
    siteContext,
    terrainGrid.minElevation
  );
  const clipPolygon = getOpenRing(getOuterRing(siteContext.clipBoundary)).map((point) =>
    localMetersFromLngLat(point, siteContext.location)
  );
  const minBandElevation =
    Math.floor(Number(terrainGrid.minElevation || 0) / interval) * interval;
  const bandGroups = getCachedContourBandGroups(siteContext);

  if (clipPolygon.length >= 3 && minBandElevation > baseElevation + 0.001) {
    addRhinoPrismFromPolygon(
      doc,
      rhino,
      layerIndex,
      clipPolygon,
      minBandElevation,
      baseElevation,
      "TERRAIN_BASE"
    );
  }

  const mesh = new rhino.Mesh();
  const vertexCache = new Map();

  for (let groupIndex = 0; groupIndex < bandGroups.length; groupIndex += 1) {
    const group = bandGroups[groupIndex];

    for (let regionIndex = 0; regionIndex < group.regions.length; regionIndex += 1) {
      const region = group.regions[regionIndex];

      if (
        addRhinoContourBandRegionExtrusion(
          doc,
          rhino,
          layerIndex,
          region,
          group.topElevation,
          group.bottomElevation,
          `TERRAIN_BAND_${groupIndex + 1}_${regionIndex + 1}`
        )
      ) {
        continue;
      }

      addRhinoMeshRegionCapFaces(
        mesh,
        vertexCache,
        region,
        group.topElevation,
        false
      );
      addRhinoMeshRegionCapFaces(
        mesh,
        vertexCache,
        region,
        group.bottomElevation,
        true
      );

      addRhinoMeshVerticalLoopFaces(
        mesh,
        vertexCache,
        region.outerPoints,
        group.topElevation,
        group.bottomElevation
      );

      for (const holePoints of region.holePoints || []) {
        addRhinoMeshVerticalLoopFaces(
          mesh,
          vertexCache,
          holePoints,
          group.topElevation,
          group.bottomElevation
        );
      }
    }
  }

  if (mesh.vertices().count && mesh.faces().count) {
    doc.objects().add(
      mesh,
      createRhinoObjectAttributes(rhino, layerIndex, "TERRAIN_BANDS")
    );
  }
}

function addRhinoTerrainMesh(doc, rhino, layerIndex, siteContext, center, seed) {
  const clipRing = getOuterRing(siteContext.clipBoundary);
  const bounds = polygonBounds(clipRing);
  const minX = localMetersFromLngLat([bounds.minLng, center.lat], center)[0];
  const maxX = localMetersFromLngLat([bounds.maxLng, center.lat], center)[0];
  const minY = localMetersFromLngLat([center.lng, bounds.minLat], center)[1];
  const maxY = localMetersFromLngLat([center.lng, bounds.maxLat], center)[1];
  const gridStep = resolveTerrainExportGridStep(
    siteContext,
    maxX - minX,
    maxY - minY,
    120
  );
  const mesh = new rhino.Mesh();
  const vertexRows = [];

  for (let y = minY; y <= maxY + 0.001; y += gridStep) {
    const row = [];

    for (let x = minX; x <= maxX + 0.001; x += gridStep) {
      const lngLat = lngLatFromMeters(center, x, y);

      if (!pointInRing(lngLat, clipRing)) {
        row.push(null);
        continue;
      }

      const elevation = siteHeightAtLocalPoint(siteContext, x, y, seed);
      row.push(mesh.vertices().add(x, y, elevation));
    }

    vertexRows.push(row);
  }

  for (let rowIndex = 0; rowIndex < vertexRows.length - 1; rowIndex += 1) {
    const currentRow = vertexRows[rowIndex];
    const nextRow = vertexRows[rowIndex + 1];

    for (
      let columnIndex = 0;
      columnIndex < currentRow.length - 1;
      columnIndex += 1
    ) {
      const a = currentRow[columnIndex];
      const b = currentRow[columnIndex + 1];
      const c = nextRow[columnIndex + 1];
      const d = nextRow[columnIndex];

      if ([a, b, c, d].every((value) => Number.isInteger(value))) {
        mesh.faces().addQuadFace(a, b, c, d);
      } else if ([a, b, c].every((value) => Number.isInteger(value))) {
        mesh.faces().addTriFace(a, b, c);
      } else if ([a, c, d].every((value) => Number.isInteger(value))) {
        mesh.faces().addTriFace(a, c, d);
      }
    }
  }

  if (mesh.vertices().count && mesh.faces().count) {
    doc.objects().add(
      mesh,
      createRhinoObjectAttributes(rhino, layerIndex, "TERRAIN_MESH")
    );
  }
}

function addRhinoFlatTerrain(doc, rhino, layerIndex, siteContext, center) {
  const clipRing = getOpenRing(getOuterRing(siteContext.clipBoundary));

  if (clipRing.length < 3) {
    return;
  }

  const baseElevation = getTerrainBaseElevation(siteContext, 0);
  const profilePoints = clipRing
    .map((point) => {
      const [xMeters, yMeters] = localMetersFromLngLat(point, center);
      return [xMeters, yMeters, baseElevation];
    })
    .concat([
      (() => {
        const [xMeters, yMeters] = localMetersFromLngLat(clipRing[0], center);
        return [xMeters, yMeters, baseElevation];
      })(),
    ]);
  const curve = createRhinoPolylineCurve(rhino, profilePoints);
  const extrusion = rhino.Extrusion.create(curve, 10, true);

  if (!extrusion) {
    return;
  }

  const brep = extrusion.toBrep(true);

  if (!brep) {
    return;
  }

  doc.objects().add(
    brep,
    createRhinoObjectAttributes(rhino, layerIndex, "TERRAIN_FLAT")
  );
}

function addRhinoBuildings(
  doc,
  rhino,
  layerIndex,
  targetLayerIndex,
  siteContext,
  center,
  seed
) {
  for (const feature of siteContext.buildings?.features || []) {
    const ring = getOpenRing(getOuterRing(feature));

    if (ring.length < 3) {
      continue;
    }

    const buildingBaseElevation = buildingBaseElevationForRing(
      siteContext,
      ring,
      center,
      seed
    );
    const footprintRing = ring.map((point) => {
      const [xMeters, yMeters] = localMetersFromLngLat(point, center);
      const elevation = Number.isFinite(buildingBaseElevation)
        ? buildingBaseElevation
        : siteHeightAtLocalPoint(siteContext, xMeters, yMeters, seed);
      return [xMeters, yMeters, elevation];
    });
    const averageElevation =
      footprintRing.reduce((sum, point) => sum + point[2], 0) / footprintRing.length;
    const profileCurve = createRhinoLocalProfileCurve(
      rhino,
      orientLocalPolygonCounterClockwise(
        footprintRing.map(([xMeters, yMeters]) => [xMeters, yMeters])
      )
    );
    const heightMeters = Math.max(
      3,
      Number(feature.properties?.heightMeters || 0) || 10.2
    );

    if (!profileCurve) {
      continue;
    }

    const extrusion = new rhino.Extrusion();

    if (!extrusion.setOuterProfile(profileCurve, true)) {
      continue;
    }

    if (
      !extrusion.setPathAndUp(
        [0, 0, averageElevation],
        [0, 0, averageElevation + heightMeters],
        [0, 1, 0]
      )
    ) {
      continue;
    }

    const brep = extrusion.toBrep(true);

    if (!brep) {
      continue;
    }

    doc.objects().add(
      brep,
      createRhinoObjectAttributes(
        rhino,
        feature.properties?.isTarget ? targetLayerIndex : layerIndex,
        feature.properties?.buildingName ||
          feature.properties?.buildingId ||
          "BUILDING",
        feature.properties?.isTarget
          ? { r: 180, g: 74, b: 58 }
          : { r: 88, g: 96, b: 107 }
      )
    );
  }
}

function addRhinoPolylineCollection(
  doc,
  rhino,
  layerIndex,
  features,
  center,
  elevationResolver
) {
  for (const feature of features) {
    const coordinateSets =
      feature?.geometry?.type === "LineString" ||
      feature?.geometry?.type === "MultiLineString"
        ? getLineStringsFromGeometry(feature.geometry)
        : [getOuterRing(feature)].filter(Boolean);

    for (const coordinates of coordinateSets) {
      if (!coordinates?.length) {
        continue;
      }

      const points = coordinates.map((point) => {
        const [xMeters, yMeters] = localMetersFromLngLat(point, center);
        return [xMeters, yMeters, elevationResolver(point, xMeters, yMeters)];
      });

      doc.objects().add(
        createRhinoPolylineCurve(rhino, points),
        createRhinoObjectAttributes(rhino, layerIndex)
      );
    }
  }
}

async function build3dmFromSiteContext(siteContext, reportProgress = null) {
  const progress =
    typeof reportProgress === "function" ? reportProgress : () => null;
  progress(6, "3DM 엔진을 준비하는 중입니다.");
  const rhino = await getRhino3dm();
  const doc = new rhino.File3dm();
  const center = {
    lat: Number(siteContext.location?.lat),
    lng: Number(siteContext.location?.lng),
  };
  const seed = Math.round(Math.abs(center.lat * 1000) + Math.abs(center.lng * 1000));
  const layerIndexCache = new Map();
  const terrainLayer = ensureRhinoLayer(doc, layerIndexCache, "terrain", {
    r: 181,
    g: 143,
    b: 92,
  });
  const buildingLayer = ensureRhinoLayer(doc, layerIndexCache, "buildings", {
    r: 88,
    g: 96,
    b: 107,
  });
  const targetBuildingLayer = ensureRhinoLayer(
    doc,
    layerIndexCache,
    "target-building",
    {
      r: 180,
      g: 74,
      b: 58,
    }
  );
  const parcelLayer = ensureRhinoLayer(doc, layerIndexCache, "parcel", {
    r: 191,
    g: 81,
    b: 42,
  });
  const contourLayer = ensureRhinoLayer(doc, layerIndexCache, "contours", {
    r: 88,
    g: 128,
    b: 168,
  });
  progress(18, "3DM 지형 레이어를 구성하는 중입니다.");

  if (siteContext.options?.terrainMode === "flat") {
    addRhinoFlatTerrain(doc, rhino, terrainLayer, siteContext, center);
  } else if (siteContext.options?.terrainMode === "contour") {
    addRhinoContourBandTerrain(doc, rhino, terrainLayer, siteContext);
  } else {
    addRhinoTerrainMesh(doc, rhino, terrainLayer, siteContext, center, seed);
  }

  if (siteContext.options?.includeBuildings !== false) {
    progress(56, "3DM 건물 레이어를 배치하는 중입니다.");
    addRhinoBuildings(
      doc,
      rhino,
      buildingLayer,
      targetBuildingLayer,
      siteContext,
      center,
      seed
    );
  }

  if (siteContext.options?.includeParcelBoundary !== false) {
    progress(74, "필지 경계선을 추가하는 중입니다.");
    addRhinoPolylineCollection(
      doc,
      rhino,
      parcelLayer,
      [siteContext.parcelBoundary],
      center,
      (_point, xMeters, yMeters) =>
        siteHeightAtLocalPoint(siteContext, xMeters, yMeters, seed) + 0.15
    );
  }

  if (siteContext.options?.includeContours !== false) {
    progress(86, "등고선 레이어를 추가하는 중입니다.");
    for (
      let index = 0;
      index < (siteContext.contourLines?.features || []).length;
      index += 1
    ) {
      const feature = siteContext.contourLines.features[index];
      const lineStrings = getLineStringsFromGeometry(feature.geometry);

      for (let lineIndex = 0; lineIndex < lineStrings.length; lineIndex += 1) {
        const points = lineStrings[lineIndex].map((point) => {
          const [xMeters, yMeters] = localMetersFromLngLat(point, center);
          return [xMeters, yMeters, Number(feature.properties?.elevation || 0)];
        });

        if (!points.length) {
          continue;
        }

        doc.objects().add(
          createRhinoPolylineCurve(rhino, points),
          createRhinoObjectAttributes(
            rhino,
            contourLayer,
            `CONTOUR_${index + 1}_${lineIndex + 1}`
          )
        );
      }
    }
  }

  progress(96, "3DM 파일을 직렬화하는 중입니다.");
  const writeOptions = new rhino.File3dmWriteOptions();
  writeOptions.version = RHINO6_FILE3DM_VERSION;
  writeOptions.saveUserData = true;
  return Buffer.from(doc.toByteArrayOptions(writeOptions));
}

function normalizeExportFormat(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "3dm" ? "3dm" : "obj";
}

function createModelSpec(body) {
  const siteContext = body.siteContext || null;
  const hasBuildings = (siteContext?.stats?.buildingCount || 0) > 0;

  return {
    jobId: `site-${Date.now()}`,
    status: "prototype",
    scope: hasBuildings ? "terrain+building" : "terrain-only",
    createdAt: new Date().toISOString(),
    message:
      hasBuildings
        ? "현재 내보내기는 프로토타입 단계이며, 대지 경계와 실표고 기반 지형, 주변 건물 mass가 함께 포함됩니다."
        : "현재 내보내기는 프로토타입 단계이며, 대지 경계와 실표고 기반 지형이 함께 포함됩니다.",
    location: body.location,
    options: body.options,
    exportTargets: ["3dm", "obj"],
    siteContextSummary: siteContext
      ? {
          parcelSource: siteContext.dataSources?.parcel?.provider || "unknown",
          terrainSource: siteContext.dataSources?.terrain?.provider || "unknown",
          buildingSource:
            siteContext.dataSources?.buildings?.provider || "unknown",
          parcelAreaSqm: siteContext.stats?.parcelAreaSqm || 0,
          contourCount: siteContext.stats?.contourCount || 0,
          minElevation: siteContext.stats?.minElevation ?? null,
          maxElevation: siteContext.stats?.maxElevation ?? null,
          buildingCount: siteContext.stats?.buildingCount || 0,
          targetBuildingCount: siteContext.stats?.targetBuildingCount || 0,
        }
      : null,
    siteContext,
    nextModules: ["dem-source"],
  };
}

function createEumHandoffHtml(requestUrl) {
  const pnu = extractPnuFromValue(requestUrl.searchParams.get("pnu"));
  const sggcd = normalizeDigits(requestUrl.searchParams.get("sggcd"), 5);
  const pLocation = normalizeSystemAddress(
    requestUrl.searchParams.get("p_location") || ""
  );

  if (!pnu || !sggcd) {
    return `
      <!doctype html>
      <html lang="ko">
        <head>
          <meta charset="utf-8" />
          <title>토지이음 연결 실패</title>
          <style>
            body { font-family: 'Segoe UI', sans-serif; padding: 32px; color: #2e241c; }
          </style>
        </head>
        <body>
          <h1>토지이음 연결에 필요한 필지 정보가 없습니다.</h1>
          <p>PNU 또는 시군구 코드가 비어 있습니다. 주소를 다시 선택한 뒤 시도해 주세요.</p>
        </body>
      </html>
    `;
  }

  const fields = {
    selGbn: "umd",
    isNoScr: "script",
    s_type: "1",
    mode: "search",
    sggcd,
    pnu,
    p_location: pLocation,
  };

  const inputs = Object.entries(fields)
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, "&quot;")}" />`
    )
    .join("");

  return `
    <!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>토지이음 연결 중</title>
        <style>
          body {
            font-family: 'Segoe UI', sans-serif;
            padding: 32px;
            color: #2e241c;
            background: #f8f4ec;
          }
          .card {
            max-width: 620px;
            margin: 0 auto;
            padding: 24px;
            border-radius: 20px;
            background: #fffaf2;
            border: 1px solid rgba(111, 86, 60, 0.18);
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>토지이음 결과 페이지로 이동 중입니다.</h1>
          <p>새 탭에서 자동 연결되지 않으면 아래 버튼을 눌러주세요.</p>
          <form id="handoffForm" method="post" action="https://www.eum.go.kr/web/ar/lu/luLandDet.jsp">
            ${inputs}
            <button type="submit">토지이음 열기</button>
          </form>
        </div>
        <script>
          window.addEventListener("load", function () {
            document.getElementById("handoffForm").submit();
          });
        </script>
      </body>
    </html>
  `;
}

function createEumLawHandoffHtml(requestUrl) {
  const authCd = String(requestUrl.searchParams.get("authCd") || "").trim();
  const ucode = String(requestUrl.searchParams.get("ucode") || "").trim();
  const uname = cleanHtmlText(requestUrl.searchParams.get("uname") || "").trim();

  if (!authCd || !ucode) {
    return `
      <!doctype html>
      <html lang="ko">
        <head>
          <meta charset="utf-8" />
          <title>법령 연결 실패</title>
          <style>
            body { font-family: 'Segoe UI', sans-serif; padding: 32px; color: #2e241c; }
          </style>
        </head>
        <body>
          <h1>법령 상세 연결에 필요한 정보가 없습니다.</h1>
          <p>법령 코드가 비어 있습니다. 주소를 다시 선택한 뒤 시도해 주세요.</p>
        </body>
      </html>
    `;
  }

  const fields = {
    authCd,
    ucode,
    uname,
  };

  const inputs = Object.entries(fields)
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, "&quot;")}" />`
    )
    .join("");

  return `
    <!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>법령 상세 연결 중</title>
        <style>
          body {
            font-family: 'Segoe UI', sans-serif;
            padding: 32px;
            color: #2e241c;
            background: #f8f4ec;
          }
          .card {
            max-width: 620px;
            margin: 0 auto;
            padding: 24px;
            border-radius: 20px;
            background: #fffaf2;
            border: 1px solid rgba(111, 86, 60, 0.18);
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>법령 상세 페이지로 이동 중입니다.</h1>
          <p>자동 연결되지 않으면 아래 버튼을 눌러주세요.</p>
          <form
            id="handoffForm"
            method="get"
            accept-charset="EUC-KR"
            action="https://www.eum.go.kr/web/ar/lw/lwLawDet.jsp"
          >
            ${inputs}
            <button type="submit">법령 상세 열기</button>
          </form>
        </div>
        <script>
          window.addEventListener("load", function () {
            document.getElementById("handoffForm").submit();
          });
        </script>
      </body>
    </html>
  `;
}

async function createApp() {
  const localConfig = await loadLocalConfig();
  const config = buildRuntimeConfig(localConfig);
  const requestHandler = async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    try {
      if (requestUrl.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (requestUrl.pathname === "/api/config" && request.method === "GET") {
        sendJson(response, 200, {
          map: {
            provider: "openstreetmap",
            initialCenter: { lat: 37.5665, lng: 126.978 },
            initialZoom: 16,
          },
          search: {
            hasVWorldKey: Boolean(config.vworldApiKey),
            hasJusoKey: Boolean(config.jusoConfirmKey),
            usesFallbackWithoutKey: config.useNominatimFallback,
          },
          data: {
            hasVWorldDataKey: Boolean(config.vworldApiKey),
            hasVWorldDomain: Boolean(config.vworldApiDomain),
          },
          futureSources: {
            hasJusoKey: Boolean(config.jusoConfirmKey),
            hasBuildingHubKey: Boolean(config.buildingHubServiceKey),
            hasLawOc: Boolean(config.lawApiOc),
            hasTerrainDemPath: Boolean(config.terrainDemPath),
            hasTerrainContourPath: Boolean(config.terrainContourPath),
            terrainContourCrs: normalizeCrsId(config.terrainContourCrs),
          },
        });
        return;
      }

      if (requestUrl.pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, {
          ok: true,
          uptimeSeconds: Number(process.uptime().toFixed(1)),
          timestamp: new Date().toISOString(),
          environment: {
            port: config.port,
            hasTerrainContourPath: Boolean(config.terrainContourPath),
            terrainContourCrs: normalizeCrsId(config.terrainContourCrs),
            hasBuildingHubKey: Boolean(config.buildingHubServiceKey),
            hasVWorldKey: Boolean(config.vworldApiKey),
            hasJusoKey: Boolean(config.jusoConfirmKey),
          },
        });
        return;
      }

      if (
        requestUrl.pathname === "/api/request-progress" &&
        request.method === "GET"
      ) {
        pruneRequestProgressStore();
        const token = String(requestUrl.searchParams.get("token") || "").trim();

        if (!token) {
          sendJson(response, 400, { error: "Missing progress token" });
          return;
        }

        const entry =
          requestProgressStore.get(token) || {
            token,
            operation: "request",
            state: "idle",
            percent: 0,
            message: "",
            startedAt: null,
            updatedAt: null,
            completedAt: null,
            error: "",
          };
        sendJson(response, 200, entry);
        return;
      }

      if (requestUrl.pathname === "/handoff/eum" && request.method === "GET") {
        sendHtml(response, 200, createEumHandoffHtml(requestUrl));
        return;
      }

      if (requestUrl.pathname === "/handoff/eum-law" && request.method === "GET") {
        sendHtml(response, 200, createEumLawHandoffHtml(requestUrl));
        return;
      }

      if (requestUrl.pathname === "/api/geocode" && request.method === "GET") {
        const query = requestUrl.searchParams.get("q")?.trim();

        if (!query) {
          sendJson(response, 400, { error: "Missing query" });
          return;
        }

        const { provider, results } = await geocodeWithPreferredProviders(
          query,
          config
        );

        sendJson(response, 200, { provider, results });
        return;
      }

      if (
        requestUrl.pathname === "/api/reverse-geocode" &&
        request.method === "GET"
      ) {
        const lat = Number(requestUrl.searchParams.get("lat"));
        const lng = Number(requestUrl.searchParams.get("lng"));

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          sendJson(response, 400, { error: "Invalid coordinates" });
          return;
        }

        let result = null;
        let provider = "none";

        if (config.vworldApiKey) {
          try {
            result = await reverseWithVWorld(lat, lng, config);
            provider = "vworld";
          } catch (error) {
            if (!config.useNominatimFallback) {
              throw error;
            }
          }
        }

        if (!result && config.useNominatimFallback) {
          result = await reverseWithNominatim(lat, lng);
          provider = "nominatim";
        }

        sendJson(response, 200, { provider, result });
        return;
      }

      if (
        requestUrl.pathname === "/api/site-context" &&
        request.method === "POST"
      ) {
        const progressToken = readRequestProgressToken(request);
        beginRequestProgress(
          progressToken,
          "site-context",
          "대지 컨텍스트 요청을 준비하는 중입니다."
        );

        try {
          const body = await readJsonBody(request);
          const payload = await buildSiteContext(
            body,
            config,
            createRangedProgressReporter(progressToken, 6, 96)
          );
          completeRequestProgress(
            progressToken,
            "대지 컨텍스트 준비가 완료되었습니다."
          );
          sendJson(response, 200, payload);
          return;
        } catch (error) {
          failRequestProgress(progressToken, error);
          throw error;
        }
      }

      if (
        requestUrl.pathname === "/api/model-spec" &&
        request.method === "POST"
      ) {
        const body = await readJsonBody(request);
        sendJson(response, 200, createModelSpec(body));
        return;
      }

      if (
        requestUrl.pathname === "/api/land-info" &&
        request.method === "POST"
      ) {
        const body = await readJsonBody(request);
        const parcelReference = resolveParcelReference(body);

        if (!parcelReference) {
          sendJson(response, 400, {
            error:
              "토지정보 조회용 필지 식별정보가 없습니다. 주소 검색 결과를 선택하거나 대지를 먼저 불러오세요.",
          });
          return;
        }

        const landInfo = await fetchEumLandInfo(parcelReference, body.location || {});
        sendJson(response, 200, landInfo);
        return;
      }

      if (
        requestUrl.pathname === "/api/land-info-details" &&
        request.method === "POST"
      ) {
        const body = await readJsonBody(request);
        const parcelReference = resolveParcelReference(body);

        if (!parcelReference) {
          sendJson(response, 400, {
            error:
              "토지 상세정보 조회용 필지 식별정보가 없습니다. 주소 검색 결과를 선택하거나 대지를 먼저 불러오세요.",
          });
          return;
        }

        const landInfo = await fetchEumLandInfoDetails(
          parcelReference,
          body.location || {},
          config
        );
        sendJson(response, 200, landInfo);
        return;
      }

      if (
        requestUrl.pathname === "/api/building-register" &&
        request.method === "POST"
      ) {
        if (!config.buildingHubServiceKey) {
          sendJson(response, 400, {
            error: "건축HUB 서비스키가 설정되지 않았습니다.",
          });
          return;
        }

        const body = await readJsonBody(request);
        const parcelReference = resolveParcelReference(body);

        if (!parcelReference) {
          sendJson(response, 400, {
            error:
              "건축물대장 조회용 필지 식별정보가 없습니다. 주소 검색 결과를 선택하거나 대지를 먼저 불러오세요.",
          });
          return;
        }

        const items = await fetchBuildingRegisterSummary(parcelReference, config);
        sendJson(response, 200, {
          parcelReference,
          buildingCount: items.length,
          primary: items[0] || null,
          items,
        });
        return;
      }

      if (
        (requestUrl.pathname === "/api/export-model" ||
          requestUrl.pathname === "/api/export-obj") &&
        request.method === "POST"
      ) {
        const progressToken = readRequestProgressToken(request);
        beginRequestProgress(
          progressToken,
          "export-model",
          "3D 파일 요청을 준비하는 중입니다."
        );

        try {
          const body = await readJsonBody(request);
          let siteContext = body.siteContext || null;
          const format =
            requestUrl.pathname === "/api/export-obj"
              ? "obj"
              : normalizeExportFormat(body.options?.exportFormat);

          if (!siteContext) {
            updateRequestProgress(progressToken, {
              percent: 8,
              message: "내보낼 대지 컨텍스트를 계산하는 중입니다.",
            });
            siteContext = await buildSiteContext(
              body,
              config,
              createRangedProgressReporter(progressToken, 8, 44)
            );
          } else {
            updateRequestProgress(progressToken, {
              percent: 16,
              message: "저장된 대지 컨텍스트를 확인하는 중입니다.",
            });
          }

          const exportStartedAt = Date.now();

          if (format === "3dm") {
            updateRequestProgress(progressToken, {
              percent: 48,
              message: "3DM 모델을 생성하는 중입니다.",
            });
            const exportBody = await build3dmFromSiteContext(
              siteContext,
              createRangedProgressReporter(progressToken, 48, 96)
            );
            console.log(
              `[export] done format=3dm bytes=${Number(
                exportBody?.byteLength || exportBody?.length || 0
              )} ms=${Date.now() - exportStartedAt}`
            );
            completeRequestProgress(
              progressToken,
              "3DM 파일 다운로드를 시작합니다."
            );
            sendBinary(
              response,
              200,
              exportBody,
              "application/octet-stream",
              `site-context-${Date.now()}.3dm`
            );
            return;
          }

          updateRequestProgress(progressToken, {
            percent: 48,
            message: "OBJ 모델을 생성하는 중입니다.",
          });
          const exportBody = buildObjFromSiteContext(
            siteContext,
            createRangedProgressReporter(progressToken, 48, 96)
          );
          console.log(
            `[export] done format=obj bytes=${Buffer.byteLength(
              exportBody,
              "utf8"
            )} ms=${Date.now() - exportStartedAt}`
          );
          completeRequestProgress(
            progressToken,
            "OBJ 파일 다운로드를 시작합니다."
          );
          sendText(response, 200, exportBody, `site-context-${Date.now()}.obj`);
        } catch (error) {
          failRequestProgress(progressToken, error);
          logServerError(
            `Export failed progressToken=${progressToken || "none"}`,
            error
          );
          throw error;
        }
        return;
      }

      await serveStatic(requestUrl.pathname, response);
    } catch (error) {
      logServerError(`${request.method} ${requestUrl.pathname}`, error);
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unexpected error",
      });
    }
  };

  async function listenOnConfiguredPort(port) {
    const server = createServer(requestHandler);

    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, resolve);
      });

      return { port, server };
    } catch (error) {
      server.close();

      if (error instanceof Error && error.code === "EADDRINUSE") {
        throw new Error(
          `Port ${port} is already in use. Stop the previous Site Context Planner server and try again.`
        );
      }

      throw error;
    }
  }

  const { port } = await listenOnConfiguredPort(config.port);
  console.log(`Site Context Planner running at http://localhost:${port}`);
}

export {
  addRhinoBuildings,
  addRhinoContourBandTerrain,
  addRhinoPolylineCollection,
  addRhinoPrismFromPolygon,
  addRhinoTerrainMesh,
  build3dmFromSiteContext,
  buildContourBandGroups,
  buildObjFromSiteContext,
  createRhinoObjectAttributes,
  ensureRhinoLayer,
  getRhino3dm,
};

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  createApp().catch((error) => {
    logServerError("Server startup failed", error);
    process.exitCode = 1;
  });
}
