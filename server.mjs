import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  open,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
const OPEN_METEO_CACHE_MAX_ENTRIES = 256;
const OPEN_METEO_MAX_POINTS_PER_REQUEST = 100;
const OPEN_METEO_MAX_CONCURRENT_REQUESTS = 3;
const OPEN_TOPO_DATA_MAX_POINTS_PER_REQUEST = 80;
const OPEN_TOPO_DATA_MAX_CONCURRENT_REQUESTS = 2;
const SITE_CONTEXT_CACHE_TTL_MS = 1000 * 60 * 10;
const SITE_CONTEXT_CACHE_MAX_ENTRIES = 12;
const GEOCODE_CACHE_TTL_MS = 1000 * 60 * 10;
const GEOCODE_CACHE_MAX_ENTRIES = 256;
const PROPERTY_DATA_CACHE_TTL_MS = 1000 * 60 * 10;
const PROPERTY_DATA_CACHE_MAX_ENTRIES = 64;
const EXPORT_ARTIFACT_CACHE_TTL_MS = 1000 * 60 * 5;
const EXPORT_ARTIFACT_CACHE_MAX_ENTRIES = 8;
const EXPORT_ARTIFACT_CACHE_MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const EXPORT_ARTIFACT_CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const TERRAIN_SOURCE_SPATIAL_RESOLUTION_METERS = 90;
const MIN_CONTOUR_INTERVAL_METERS = 0.1;
const TERRAIN_GRID_MIN_STEP_METERS = 10;
const DEFAULT_TERRAIN_CONTOUR_CRS = "EPSG:5179";
const DEFAULT_TERRAIN_CONTOUR_PATH = path.join(__dirname, "data", "contours");
const RHINO6_FILE3DM_VERSION = 6;
const REQUEST_PROGRESS_TTL_MS = 1000 * 60 * 20;
const TELEMETRY_MAX_ENTRIES = 24;
const SLOW_API_REQUEST_THRESHOLD_MS = 1500;
const SLOW_OUTBOUND_FETCH_THRESHOLD_MS = 4000;
const ROAD_SURFACE_OFFSET_METERS = 0.01;
const ROAD_SURFACE_THICKNESS_METERS = 0.01;
const FLAT_EXPORT_CURVE_ELEVATION = 0;
const TERRAIN_BAND_OVERLAP_METERS = 0.02;
const SKETCHUP_METERS_TO_INCHES = 39.37007874015748;
const SKETCHUP_EXPORT_TIMEOUT_MS = 1000 * 60 * 3;
const SKETCHUP_EXPORT_EXIT_GRACE_MS = 15_000;
const CHILD_PROCESS_FORCE_KILL_GRACE_MS = 5_000;
const DEFAULT_ROAD_WIDTH_METERS = 6;
const ROAD_SURFACE_MAX_SEGMENT_METERS = 3;
const ROAD_SURFACE_NEAR_MERGE_GAP_METERS = 1;
const ROAD_SURFACE_NEAR_MERGE_BRIDGE_WIDTH_METERS = 1.2;
const CONTOUR_BAND_UNION_MAX_SLICES = 12000;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_EXPORT_REQUEST_BODY_BYTES = 12 * 1024 * 1024;
const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_OUTBOUND_FETCH_TIMEOUT_MS = 15_000;
const LONG_OUTBOUND_FETCH_TIMEOUT_MS = 25_000;
const OVERPASS_FETCH_TIMEOUT_MS = 35_000;
const DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS = Object.freeze({
  vworld: 20_000,
  juso: 18_000,
  buildingHub: 20_000,
  eum: LONG_OUTBOUND_FETCH_TIMEOUT_MS,
  nominatim: 10_000,
  openMeteo: 12_000,
  openTopoData: 18_000,
  overpass: OVERPASS_FETCH_TIMEOUT_MS,
});
const DEFAULT_EXPORT_JOB_QUEUE_TIMEOUT_MS = 1000 * 60 * 8;
const DEFAULT_MAX_PENDING_EXPORT_JOBS_PER_CLIENT = 2;
const DEFAULT_EXPORT_JOB_DURATION_ESTIMATE_MS = 1000 * 45;
const EXPORT_JOB_DURATION_HISTORY_LIMIT = 8;
const DEFAULT_MAX_SITE_RADIUS_METERS = 1000;
const DEFAULT_MAX_MANUAL_RANGE_SIDE_METERS = DEFAULT_MAX_SITE_RADIUS_METERS * 2;
const DEFAULT_MAX_CONCURRENT_EXPORT_JOBS = 2;
const DEFAULT_CONTENT_SECURITY_POLICY_DIRECTIVES = Object.freeze([
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https://cloudflareinsights.com https://*.cloudflareinsights.com https://static.cloudflareinsights.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://www.eum.go.kr",
]);
const DEFAULT_FRAME_ANCESTORS = Object.freeze(["'none'"]);
const DEFAULT_AD_PREVIEW_ALLOWED_PATHS = Object.freeze([
  "/",
  "/contour3dmodel",
  "/heritage-risk",
  "/max-mass",
]);
const DEFAULT_INTERNAL_ONLY_STATIC_PATHS = Object.freeze([]);
const DEFAULT_PUBLIC_ENABLED_FEATURES = Object.freeze(["contour3dmodel"]);
const DEFAULT_AD_PREVIEW_FRAME_ANCESTORS = Object.freeze([
  "'self'",
  "https://ads.google.com",
  "https://google.com",
  "https://*.google.com",
  "https://*.google.co.kr",
  "https://*.googleadservices.com",
  "https://*.doubleclick.net",
  "https://*.googleusercontent.com",
]);
const DEFAULT_ADS_TXT_LINES = Object.freeze([]);
const FEATURE_PAGE_DEFINITIONS = Object.freeze([
  {
    id: "contour3dmodel",
    routePath: "/contour3dmodel",
    title: "3D 대지모형 스튜디오",
    summary:
      "주소 선택, 범위 지정, 다중 필지 선택, 대지/건물 컨텍스트 확인, 3D와 CAD export를 한 화면에서 이어가는 현재 메인 기능입니다.",
    enabledMeta: [
      { label: "진입 주소", value: "/contour3dmodel", code: true },
      { label: "현재 출력", value: "OBJ / DXF / SKP / 3DM" },
    ],
    disabledMeta: [
      { label: "상태", value: "공개 준비 중" },
      { label: "초점 방향", value: "대지 컨텍스트 + 3D/CAD 출력" },
    ],
  },
  {
    id: "heritage-risk",
    routePath: "/heritage-risk",
    title: "문화재 발굴 위험도 지도",
    summary:
      "후보지 주변의 문화재 조사 이력과 발굴 위험도를 지도 중심 흐름으로 검토하는 기능입니다. 메인 대지 검토와 이어지는 다음 단계로 준비 중입니다.",
    enabledMeta: [
      { label: "진입 주소", value: "/heritage-risk", code: true },
      { label: "핵심 방향", value: "지도 중심 위험도 검토" },
    ],
    disabledMeta: [
      { label: "상태", value: "공개 준비 중" },
      { label: "핵심 방향", value: "지도 중심 위험도 검토" },
    ],
  },
  {
    id: "max-mass",
    routePath: "/max-mass",
    title: "법규 기반 최대 매스 생성",
    summary:
      "대지와 법규 조건을 바탕으로 초기 최대 매스를 검토하는 기능입니다. 이후 안별 비교와 후속 설계 검토로 이어가기 좋은 흐름으로 준비 중입니다.",
    enabledMeta: [
      { label: "진입 주소", value: "/max-mass", code: true },
      { label: "핵심 방향", value: "법규 해석 + 초기 매스 검토" },
    ],
    disabledMeta: [
      { label: "상태", value: "공개 준비 중" },
      { label: "핵심 방향", value: "법규 해석 + 초기 매스 검토" },
    ],
  },
]);
const FEATURE_PAGE_DEFINITIONS_BY_ID = new Map(
  FEATURE_PAGE_DEFINITIONS.map((definition) => [definition.id, definition])
);
const ROAD_LAYER_CANDIDATES = [
  {
    layer: "lt_c_upisuq151",
    geometryType: "polygon",
    provider: "vworld-road-polygons",
  },
  {
    layer: "lt_l_moctlink",
    geometryType: "line",
    provider: "vworld-traffic-links",
  },
  {
    layer: "lt_l_sprd",
    geometryType: "line",
    provider: "vworld-road-lines",
  },
];
const openMeteoElevationCache = new Map();
const geocodeCache = new Map();
const geocodeInFlight = new Map();
const siteContextCache = new Map();
const eumLandPageCache = new Map();
const eumLandRelationDetailsCache = new Map();
const buildingRegisterSummaryCache = new Map();
const buildingFloorOutlineCache = new Map();
const exportArtifactCache = new Map();
const terrainContourCatalogCache = new Map();
const terrainContourDatasetCache = new Map();
const terrainContourRecordIndexCache = new Map();
const requestProgressStore = new Map();
const rateLimitStore = new Map();
const contourBandGroupCache = new WeakMap();
const contourCumulativeBandGroupCache = new WeakMap();
const contourRenderableBandGroupCache = new WeakMap();
const contourTopSurfaceCache = new WeakMap();
const sharedContourBandGroupCache = new Map();
const sharedContourCumulativeBandGroupCache = new Map();
const roadFootprintMultiPolygonCache = new WeakMap();
const roadContourSurfaceGroupCache = new WeakMap();
const siteContextGeometrySignatureCache = new WeakMap();
const recentSlowApiRequestEvents = [];
const recentUpstreamEvents = [];
const recentGeocodeEvents = [];
const eumLandPageInFlight = new Map();
const eumLandRelationDetailsInFlight = new Map();
const buildingRegisterSummaryInFlight = new Map();
const buildingFloorOutlineInFlight = new Map();
let rhino3dmInstancePromise = null;
let activeExportJobs = 0;
const exportJobWaitQueue = [];
const activeExportJobsByClient = new Map();
const recentExportDurationsMs = [];

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
  ".png": "image/png",
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

function truncateTelemetryText(value, maxLength = 220) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(1, maxLength - 1))}…`
    : normalized;
}

function pushTelemetryEvent(store, event, maxEntries = TELEMETRY_MAX_ENTRIES) {
  if (!Array.isArray(store) || !event || typeof event !== "object") {
    return;
  }

  store.push({
    ...event,
    occurredAt: event.occurredAt || new Date().toISOString(),
  });

  if (store.length > maxEntries) {
    store.splice(0, store.length - maxEntries);
  }
}

function recordSlowApiRequestTelemetry({ method, path, statusCode, durationMs }) {
  const normalizedPath = String(path || "").trim();

  if (
    !normalizedPath.startsWith("/api/") ||
    normalizedPath === "/api/request-progress" ||
    normalizedPath === "/api/health" ||
    normalizedPath === "/api/runtime-stats"
  ) {
    return;
  }

  const normalizedDurationMs = Math.max(0, Math.round(Number(durationMs) || 0));
  const normalizedStatusCode = Number(statusCode) || 0;

  if (
    normalizedStatusCode < 400 &&
    normalizedDurationMs < SLOW_API_REQUEST_THRESHOLD_MS
  ) {
    return;
  }

  pushTelemetryEvent(recentSlowApiRequestEvents, {
    method: String(method || "GET").toUpperCase(),
    path: normalizedPath,
    statusCode: normalizedStatusCode,
    durationMs: normalizedDurationMs,
  });
}

function recordUpstreamTelemetry(event = {}) {
  const normalizedDurationMs = Math.max(
    0,
    Math.round(Number(event?.durationMs) || 0)
  );
  const normalizedStatusCode = Number(event?.statusCode) || 0;
  const outcome = String(event?.outcome || "ok").trim() || "ok";

  if (outcome === "ok" && normalizedDurationMs < SLOW_OUTBOUND_FETCH_THRESHOLD_MS) {
    return;
  }

  pushTelemetryEvent(recentUpstreamEvents, {
    label: truncateTelemetryText(event?.label || "upstream"),
    host: truncateTelemetryText(event?.host || ""),
    outcome,
    statusCode: normalizedStatusCode || null,
    timeoutMs: Math.max(0, Math.round(Number(event?.timeoutMs) || 0)) || null,
    durationMs: normalizedDurationMs,
    error: truncateTelemetryText(event?.error || ""),
  });
}

function appendGeocodeTraceStage(trace, stage = {}) {
  if (!trace || !Array.isArray(trace.stages) || !stage) {
    return;
  }

  trace.stages.push({
    name: truncateTelemetryText(stage?.name || "geocode", 80),
    outcome: truncateTelemetryText(stage?.outcome || "ok", 40),
    durationMs: Math.max(0, Math.round(Number(stage?.durationMs) || 0)),
    count: Number.isFinite(stage?.count) ? Number(stage.count) : null,
    note: truncateTelemetryText(stage?.note || "", 120),
  });
}

function recordGeocodeTelemetry(event = {}) {
  pushTelemetryEvent(recentGeocodeEvents, {
    query: truncateTelemetryText(event?.query || "", 120),
    provider: truncateTelemetryText(event?.provider || "", 60),
    branch: truncateTelemetryText(event?.branch || "", 60),
    cacheStatus: truncateTelemetryText(event?.cacheStatus || "", 20),
    resultCount: Math.max(0, Math.round(Number(event?.resultCount) || 0)),
    totalMs: Math.max(0, Math.round(Number(event?.totalMs) || 0)),
    error: truncateTelemetryText(event?.error || "", 160),
    stages: Array.isArray(event?.stages)
      ? event.stages.slice(-12).map((stage) => ({
          name: truncateTelemetryText(stage?.name || "geocode", 80),
          outcome: truncateTelemetryText(stage?.outcome || "ok", 40),
          durationMs: Math.max(0, Math.round(Number(stage?.durationMs) || 0)),
          count: Number.isFinite(stage?.count) ? Number(stage.count) : null,
          note: truncateTelemetryText(stage?.note || "", 120),
        }))
      : [],
  });
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
    return JSON.parse(String(raw || "").replace(/^\uFEFF/u, ""));
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

function normalizeConfigList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeConfigString(entry))
      .filter(Boolean);
  }

  const normalized = normalizeConfigString(value);

  if (!normalized) {
    return [];
  }

  if (normalized.startsWith("[")) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => normalizeConfigString(entry))
          .filter(Boolean);
      }
    } catch {
      // Fall through to delimiter-based parsing.
    }
  }

  return normalized
    .split(/[\r\n,]+/u)
    .map((entry) => normalizeConfigString(entry))
    .filter(Boolean);
}

function normalizePathPrefix(value) {
  const normalized = normalizeConfigString(value);

  if (!normalized) {
    return "";
  }

  if (normalized === "/") {
    return "/";
  }

  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

function normalizePathPrefixList(value, fallback = DEFAULT_AD_PREVIEW_ALLOWED_PATHS) {
  const normalizedEntries = normalizeConfigList(value)
    .map((entry) => normalizePathPrefix(entry))
    .filter(Boolean);

  if (!normalizedEntries.length) {
    return [...fallback];
  }

  return [...new Set(normalizedEntries)];
}

function normalizeFeatureId(value) {
  const normalized = normalizeConfigString(value)
    .toLowerCase()
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");

  if (!normalized || !FEATURE_PAGE_DEFINITIONS_BY_ID.has(normalized)) {
    return "";
  }

  return normalized;
}

function normalizeFeatureIdList(
  value,
  fallback = DEFAULT_PUBLIC_ENABLED_FEATURES
) {
  const normalizedEntries = normalizeConfigList(value)
    .map((entry) => normalizeFeatureId(entry))
    .filter(Boolean);

  if (!normalizedEntries.length) {
    return [...fallback];
  }

  return [...new Set(normalizedEntries)];
}

function normalizeFrameAncestor(value) {
  const normalized = normalizeConfigString(value);

  if (!normalized) {
    return "";
  }

  if (normalized === "'self'" || normalized === "'none'") {
    return normalized;
  }

  return /^https?:\/\//iu.test(normalized) ? normalized : "";
}

function normalizeFrameAncestorList(
  value,
  fallback = DEFAULT_AD_PREVIEW_FRAME_ANCESTORS
) {
  const normalizedEntries = normalizeConfigList(value)
    .map((entry) => normalizeFrameAncestor(entry))
    .filter(Boolean);

  if (!normalizedEntries.length) {
    return [...fallback];
  }

  const uniqueEntries = [...new Set(normalizedEntries)];
  if (uniqueEntries.includes("'none'")) {
    return ["'none'"];
  }

  return uniqueEntries;
}

function matchesPathPrefix(requestPath, pathPrefix) {
  const normalizedRequestPath = normalizePathPrefix(requestPath || "/") || "/";
  const normalizedPathPrefix = normalizePathPrefix(pathPrefix);

  if (!normalizedPathPrefix) {
    return false;
  }

  if (normalizedPathPrefix === "/") {
    return normalizedRequestPath === "/";
  }

  return (
    normalizedRequestPath === normalizedPathPrefix ||
    normalizedRequestPath.startsWith(`${normalizedPathPrefix}/`)
  );
}

function isAdPreviewAllowedPath(requestPath, config) {
  return (config?.adPreviewAllowedPaths || []).some((pathPrefix) =>
    matchesPathPrefix(requestPath, pathPrefix)
  );
}

function findFeatureDefinitionByRequestPath(requestPath) {
  return FEATURE_PAGE_DEFINITIONS.find((definition) =>
    matchesPathPrefix(requestPath, definition.routePath)
  );
}

function buildPublicFeatureCatalog(config) {
  const enabledFeatureIds = new Set(config?.publicEnabledFeatures || []);

  return FEATURE_PAGE_DEFINITIONS.map((definition) => ({
    ...definition,
    publicEnabled: enabledFeatureIds.has(definition.id),
  }));
}

function isInternalOnlyStaticPath(requestPath, config) {
  const featureDefinition = findFeatureDefinitionByRequestPath(requestPath);

  if (featureDefinition) {
    return !(config?.publicEnabledFeatures || []).includes(featureDefinition.id);
  }

  return (config?.internalOnlyStaticPaths || []).some((pathPrefix) =>
    matchesPathPrefix(requestPath, pathPrefix)
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderFeatureMetaRow(meta) {
  const label = escapeHtml(meta?.label || "");
  const value = escapeHtml(meta?.value || "");
  const renderedValue = meta?.code ? `<code>${value}</code>` : value;

  return [
    "<div>",
    `  <dt>${label}</dt>`,
    `  <dd>${renderedValue}</dd>`,
    "</div>",
  ].join("");
}

function renderHubFeatureCard(feature) {
  const cardKicker = feature.publicEnabled ? "Live Now" : "Next Track";
  const badgeText = feature.publicEnabled ? "사용 가능" : "공개 준비 중";
  const badgeClass = feature.publicEnabled ? "feature-badge is-live" : "feature-badge";
  const cardClass = feature.publicEnabled ? "feature-card-live" : "feature-card-plan";
  const metaRows = (feature.publicEnabled ? feature.enabledMeta : feature.disabledMeta)
    .map((meta) => renderFeatureMetaRow(meta))
    .join("");
  const actionMarkup = feature.publicEnabled
    ? `<a class="feature-link" href="${escapeHtml(feature.routePath)}">기능 열기</a>`
    : '<span class="feature-link is-secondary is-disabled" aria-disabled="true">공개 준비 중</span>';

  return [
    `<article class="feature-card ${cardClass}">`,
    '  <div class="feature-head">',
    `    <p class="card-kicker">${cardKicker}</p>`,
    `    <span class="${badgeClass}">${badgeText}</span>`,
    "  </div>",
    `  <h2>${escapeHtml(feature.title)}</h2>`,
    `  <p class="card-copy">${escapeHtml(feature.summary)}</p>`,
    `  <dl class="feature-meta">${metaRows}</dl>`,
    `  <div class="feature-actions">${actionMarkup}</div>`,
    "</article>",
  ].join("\n");
}

function renderHubStatusChip(feature) {
  const label = feature.publicEnabled ? "운영 중" : "다음 단계";

  return [
    '<div class="status-chip">',
    `  <span>${label}</span>`,
    `  <strong>${escapeHtml(feature.title)}</strong>`,
    "</div>",
  ].join("\n");
}

function renderHubHtml(config) {
  const features = buildPublicFeatureCatalog(config);
  const featureCardsMarkup = features.map((feature) => renderHubFeatureCard(feature)).join("\n");
  const statusChipsMarkup = features.map((feature) => renderHubStatusChip(feature)).join("\n");

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Space Work Hub</title>
    <link rel="stylesheet" href="/hub.css?v=20260326-hub2" />
  </head>
  <body>
    <main class="hub-shell">
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">Space Work Hub</p>
          <h1>대지 분석 흐름을 한 허브에서 차례대로 이어갑니다</h1>
          <p class="hero-lead">
            메인 허브에서 현재 운영 중인 기능과 다음 단계 기능을 함께 살피고, 실제 작업은 각 단계의 화면에서 이어가도록 정리했습니다. 현재는 3D 대지모형이 운영 중이며, 다음 흐름으로 문화재 위험도 검토와 법규 기반 최대 매스 검토를 준비하고 있습니다.
          </p>
        </div>
        <div class="hero-status">
          ${statusChipsMarkup}
        </div>
      </section>

      <section class="hub-grid" aria-label="기능 목록">
        ${featureCardsMarkup}
      </section>

      <section class="roadmap-card" aria-label="확장 메모">
        <div>
          <p class="card-kicker">Structure Note</p>
          <h2>공개 전환은 설정 한 곳에서 관리합니다</h2>
        </div>
        <p class="card-copy">
          허브 노출, 버튼 상태, 실제 공개 접근은 같은 release flag를 기준으로 맞춰집니다. 준비가 끝난 기능만 공개로 전환하고, 나머지는 허브에서 다음 단계로만 소개하는 구조를 유지합니다.
        </p>
      </section>
    </main>
  </body>
</html>`;
}

function buildContentSecurityPolicy(frameAncestors = DEFAULT_FRAME_ANCESTORS) {
  const normalizedFrameAncestors = normalizeFrameAncestorList(
    frameAncestors,
    DEFAULT_FRAME_ANCESTORS
  );

  return [
    ...DEFAULT_CONTENT_SECURITY_POLICY_DIRECTIVES,
    `frame-ancestors ${normalizedFrameAncestors.join(" ")}`,
  ].join("; ");
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

function quantizeAbsoluteElevationUpward(height, interval) {
  if (!Number.isFinite(height)) {
    return height;
  }

  const normalizedInterval = normalizeContourInterval(interval);
  const bandIndex = Math.ceil(height / normalizedInterval - 1e-9);

  return Number((bandIndex * normalizedInterval).toFixed(3));
}

function nextContourIntervalStep(interval) {
  const normalized = normalizeContourInterval(interval);
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20];

  for (const step of steps) {
    if (step > normalized + 1e-9) {
      return step;
    }
  }

  return Number((normalized * 2).toFixed(3));
}

function estimateContourBandComplexity(siteContext, interval) {
  const terrainGrid = siteContext?.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return 0;
  }

  const cellCount = Math.max(
    1,
    (Math.max(0, (terrainGrid.xValues?.length || 0) - 1) *
      Math.max(0, (terrainGrid.yValues?.length || 0) - 1))
  );
  const bandCount = estimateContourBandCount(siteContext, interval);

  return cellCount * bandCount;
}

function estimateContourBandCount(siteContext, interval) {
  const terrainGrid = siteContext?.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return 0;
  }

  const heightSpan = Math.max(
    0,
    Number(terrainGrid.maxElevation || 0) - Number(terrainGrid.minElevation || 0)
  );
  return Math.max(
    1,
    Math.ceil(heightSpan / normalizeContourInterval(interval))
  );
}

function resolveContourBandCountBudget(exportFormat, radiusMeters) {
  let maxBandCount =
    exportFormat === "skp" || exportFormat === "skp-payload"
      ? 240
      : exportFormat === "3dm"
        ? 220
        : exportFormat === "obj"
          ? 180
          : 200;

  if (radiusMeters <= 90) {
    maxBandCount += 50;
  } else if (radiusMeters <= 140) {
    maxBandCount += 20;
  } else if (radiusMeters >= 260) {
    maxBandCount -= 40;
  }

  return Math.max(60, Math.round(maxBandCount));
}

function resolveMinimumRenderableContourBandInterval(sourceContourInterval) {
  if (!(sourceContourInterval > 0)) {
    return MIN_CONTOUR_INTERVAL_METERS;
  }

  // Allow finer interpolated terrace bands than the source contour interval.
  // Actual safety is enforced by the contour complexity budget, not by a hard
  // source/10 floor, otherwise a 5m source can never render at 0.1m.
  return MIN_CONTOUR_INTERVAL_METERS;
}

function inferSourceContourIntervalFromContourLines(contourCollection) {
  const elevations = [...new Set(
    (contourCollection?.features || [])
      .map((feature) => Number(feature?.properties?.elevation))
      .filter((value) => Number.isFinite(value))
      .map((value) => Number(value.toFixed(3)))
  )].sort((left, right) => left - right);

  if (elevations.length < 2) {
    return null;
  }

  let minPositiveDelta = Number.POSITIVE_INFINITY;

  for (let index = 1; index < elevations.length; index += 1) {
    const delta = Number((elevations[index] - elevations[index - 1]).toFixed(3));

    if (delta > 1e-6) {
      minPositiveDelta = Math.min(minPositiveDelta, delta);
    }
  }

  if (!Number.isFinite(minPositiveDelta)) {
    return null;
  }

  return normalizeContourInterval(minPositiveDelta);
}

function resolveSourceContourInterval(siteContext) {
  const configuredInterval = normalizeContourInterval(
    siteContext?.dataSources?.contours?.interval ||
      siteContext?.stats?.sourceContourInterval ||
      siteContext?.stats?.effectiveContourBandInterval ||
      siteContext?.options?.contourInterval
  );
  const inferredInterval = inferSourceContourIntervalFromContourLines(
    siteContext?.contourLines
  );

  if (Number.isFinite(inferredInterval) && inferredInterval > 0) {
    return Math.max(configuredInterval, inferredInterval);
  }

  return configuredInterval;
}

function resolveRequestedContourDisplayInterval(siteContext) {
  return normalizeContourInterval(
    siteContext?.stats?.requestedContourInterval ||
      siteContext?.options?.contourInterval
  );
}

function shouldPreserveNativeContourDisplayLines(format) {
  const normalizedFormat = String(format || "").trim().toLowerCase();
  return (
    normalizedFormat === "3dm" ||
    normalizedFormat === "dxf" ||
    normalizedFormat === "obj" ||
    normalizedFormat === "skp" ||
    normalizedFormat === "skp-payload"
  );
}

function isSketchUpExportFormat(formatOrSiteContext) {
  const normalizedFormat =
    typeof formatOrSiteContext === "string"
      ? String(formatOrSiteContext || "").trim().toLowerCase()
      : String(formatOrSiteContext?.options?.exportFormat || "")
          .trim()
          .toLowerCase();

  return normalizedFormat === "skp" || normalizedFormat === "skp-payload";
}

function hasOfficialContourDisplaySource(siteContext) {
  return (
    String(siteContext?.dataSources?.contours?.provider || "")
      .trim()
      .toLowerCase() === "official-contours" &&
    Number(siteContext?.contourLines?.features?.length || 0) > 0
  );
}

function shouldRefineSketchUpTerrainGrid(siteContext) {
  const radiusMeters = Math.max(30, Number(siteContext?.options?.radius) || 120);

  return Boolean(
    isSketchUpExportFormat(siteContext) &&
      siteContext?.options?.terrainMode === "contour" &&
      siteContext?.terrainGrid?.elevations?.length &&
      siteContext?.clipBoundary &&
      hasOfficialContourDisplaySource(siteContext) &&
      radiusMeters <= 220
  );
}

function resolveSketchUpTerrainRefineStep(siteContext) {
  const currentStep = Number(siteContext?.terrainGrid?.step || 0);
  const sourceContourInterval = resolveSourceContourInterval(siteContext);
  const radiusMeters = Math.max(30, Number(siteContext?.options?.radius) || 120);
  const maxPreferredStep =
    sourceContourInterval <= 1
      ? 0.5
      : sourceContourInterval <= 2
        ? 0.7
        : sourceContourInterval <= 5
          ? 0.95
          : sourceContourInterval <= 10
            ? 1.25
            : 1.6;
  const radiusScaledStep =
    radiusMeters <= 120
      ? currentStep * 0.6
      : radiusMeters <= 220
        ? currentStep * 0.72
        : currentStep * 0.82;
  const minimumStep =
    radiusMeters <= 120 ? 0.35 : radiusMeters <= 220 ? 0.45 : 0.6;
  const targetStep = Math.max(
    minimumStep,
    Math.min(
      Number.isFinite(radiusScaledStep) && radiusScaledStep > 0
        ? radiusScaledStep
        : maxPreferredStep,
      maxPreferredStep
    )
  );

  return Number(targetStep.toFixed(3));
}

function maybeRefineSketchUpTerrainGrid(siteContext) {
  if (!shouldRefineSketchUpTerrainGrid(siteContext)) {
    return siteContext;
  }

  const currentStep = Number(siteContext?.terrainGrid?.step || 0);
  const targetStep = resolveSketchUpTerrainRefineStep(siteContext);

  if (
    !Number.isFinite(targetStep) ||
    targetStep <= 0 ||
    (Number.isFinite(currentStep) && currentStep > 0 && targetStep >= currentStep - 1e-6)
  ) {
    return siteContext;
  }

  try {
    const refinedGrid = buildTerrainGridFromContourCollection(
      siteContext.location,
      siteContext.clipBoundary,
      siteContext.contourLines,
      resolveSourceContourInterval(siteContext),
      { sampleStep: targetStep }
    );

    if (refinedGrid?.elevations?.length) {
      siteContext.terrainGrid = refinedGrid;
      siteContext.stats = {
        ...(siteContext?.stats || {}),
        skpTerrainGridRefined: true,
        skpTerrainGridSourceStep: Number.isFinite(currentStep)
          ? Number(currentStep.toFixed(3))
          : null,
        skpTerrainGridStep: Number(
          Number(refinedGrid.step || targetStep).toFixed(3)
        ),
      };
    }
  } catch (error) {
    console.warn(
      `[skp-contours] terrain-grid refinement fallback error=${formatErrorForLog(error)}`
    );
  }

  return siteContext;
}

function resolveEffectiveContourBandInterval(siteContext) {
  const requestedInterval = normalizeContourInterval(
    siteContext?.options?.contourInterval
  );
  const cachedRequestedInterval = normalizeContourInterval(
    siteContext?.stats?.requestedContourInterval
  );
  const cachedEffectiveInterval = Number(
    siteContext?.stats?.effectiveContourBandInterval
  );
  const exportFormat = String(siteContext?.options?.exportFormat || "")
    .trim()
    .toLowerCase();
  const sourceContourInterval = resolveSourceContourInterval(siteContext);
  const radiusMeters = Math.max(30, Number(siteContext?.options?.radius) || 120);
  const maxBandCount = resolveContourBandCountBudget(
    exportFormat,
    radiusMeters
  );
  let effectiveInterval =
    Number.isFinite(cachedEffectiveInterval) &&
    Math.abs(cachedRequestedInterval - requestedInterval) <= 1e-9
      ? normalizeContourInterval(cachedEffectiveInterval)
      : requestedInterval;
  let maxComplexity =
    exportFormat === "skp" || exportFormat === "skp-payload"
      ? 12_000_000
      : exportFormat === "3dm"
        ? 10_000_000
      : exportFormat === "obj"
        ? 4_000_000
        : 6_000_000;
  const precisionBudgetBoost =
    requestedInterval <= 0.1
      ? radiusMeters <= 120
        ? 22
        : radiusMeters <= 180
          ? 12
          : radiusMeters <= 260
            ? 6
            : 1
      : requestedInterval <= 0.5
        ? radiusMeters <= 160
          ? 8
          : radiusMeters <= 240
            ? 4
            : 1
        : requestedInterval <= 1
          ? radiusMeters <= 220
            ? 3
            : 1
          : 1;
  maxComplexity = Math.round(maxComplexity * precisionBudgetBoost);
  effectiveInterval = Math.max(
    effectiveInterval,
    resolveMinimumRenderableContourBandInterval(sourceContourInterval)
  );

  while (
    (estimateContourBandComplexity(siteContext, effectiveInterval) >
      maxComplexity ||
      estimateContourBandCount(siteContext, effectiveInterval) > maxBandCount) &&
    effectiveInterval < 20
  ) {
    effectiveInterval = nextContourIntervalStep(effectiveInterval);
  }

  if (effectiveInterval > requestedInterval + 1e-9) {
    console.warn(
      `[terrain-band] interval relaxed requested=${requestedInterval} effective=${effectiveInterval} source=${sourceContourInterval} bandCount=${estimateContourBandCount(
        siteContext,
        effectiveInterval
      )}/${maxBandCount} complexity=${estimateContourBandComplexity(
        siteContext,
        requestedInterval
      )} format=${exportFormat || "default"}`
    );
  }

  return effectiveInterval;
}

function getContourBandCacheKey(siteContext) {
  return `${String(resolveEffectiveContourBandInterval(siteContext))}|${buildTerrainGridCacheSignature(
    siteContext?.terrainGrid
  )}`;
}

function buildTerrainGridCacheSignature(terrainGrid) {
  if (!terrainGrid?.elevations?.length) {
    return "no-grid";
  }

  const xValues = terrainGrid.xValues || [];
  const yValues = terrainGrid.yValues || [];
  const lastX = xValues.length ? xValues[xValues.length - 1] : 0;
  const lastY = yValues.length ? yValues[yValues.length - 1] : 0;

  return [
    Number(terrainGrid.minElevation || 0).toFixed(3),
    Number(terrainGrid.maxElevation || 0).toFixed(3),
    xValues.length,
    yValues.length,
    Number(xValues[0] || 0).toFixed(3),
    Number(yValues[0] || 0).toFixed(3),
    Number(lastX || 0).toFixed(3),
    Number(lastY || 0).toFixed(3),
  ].join("|");
}

function buildLocationCacheKey(location) {
  return `${Number(location?.lat || 0).toFixed(6)}|${Number(
    location?.lng || 0
  ).toFixed(6)}`;
}

function resolveContourCacheOwner(siteContext) {
  if (siteContext?.terrainGrid && typeof siteContext.terrainGrid === "object") {
    return siteContext.terrainGrid;
  }

  return siteContext && typeof siteContext === "object" ? siteContext : null;
}

function resolveRenderableContourCacheOwner(siteContext) {
  if (siteContext?.buildings && typeof siteContext.buildings === "object") {
    return siteContext.buildings;
  }

  return resolveContourCacheOwner(siteContext);
}

function resolveRoadGeometryCacheOwner(siteContext) {
  if (siteContext?.roads && typeof siteContext.roads === "object") {
    return siteContext.roads;
  }

  return resolveContourCacheOwner(siteContext);
}

function getOrCreateWeakMapEntry(cacheStore, owner) {
  if (!owner || typeof owner !== "object") {
    return null;
  }

  let entry = cacheStore.get(owner);

  if (!(entry instanceof Map)) {
    entry = new Map();
    cacheStore.set(owner, entry);
  }

  return entry;
}

function readSharedDerivedCache(cacheStore, cacheKey) {
  if (!(cacheStore instanceof Map) || !cacheKey) {
    return null;
  }

  const cachedEntry = cacheStore.get(cacheKey);

  if (!cachedEntry) {
    return null;
  }

  cachedEntry.lastAccessedAt = Date.now();
  return cachedEntry.value;
}

function writeSharedDerivedCache(cacheStore, cacheKey, value, maxEntries = 6) {
  if (!(cacheStore instanceof Map) || !cacheKey) {
    return;
  }

  cacheStore.set(cacheKey, {
    value,
    lastAccessedAt: Date.now(),
  });

  while (cacheStore.size > maxEntries) {
    const oldestEntry = [...cacheStore.entries()].sort(
      (left, right) =>
        Number(left?.[1]?.lastAccessedAt || 0) - Number(right?.[1]?.lastAccessedAt || 0)
    )[0];

    if (!oldestEntry) {
      break;
    }

    cacheStore.delete(oldestEntry[0]);
  }
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

function normalizeCustomBounds(bounds) {
  if (!bounds || typeof bounds !== "object") {
    return null;
  }

  const minLat = Number(bounds.minLat ?? bounds.south ?? bounds.swLat);
  const maxLat = Number(bounds.maxLat ?? bounds.north ?? bounds.neLat);
  const minLng = Number(bounds.minLng ?? bounds.west ?? bounds.swLng);
  const maxLng = Number(bounds.maxLng ?? bounds.east ?? bounds.neLng);

  if (
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLat) ||
    !Number.isFinite(minLng) ||
    !Number.isFinite(maxLng)
  ) {
    return null;
  }

  return {
    minLat: Math.min(minLat, maxLat),
    maxLat: Math.max(minLat, maxLat),
    minLng: Math.min(minLng, maxLng),
    maxLng: Math.max(minLng, maxLng),
  };
}

function measureCustomBoundsMeters(bounds) {
  const normalizedBounds = normalizeCustomBounds(bounds);

  if (!normalizedBounds) {
    return null;
  }

  const center = {
    lat: (normalizedBounds.minLat + normalizedBounds.maxLat) / 2,
    lng: (normalizedBounds.minLng + normalizedBounds.maxLng) / 2,
  };
  const southWest = localMetersFromLngLat(
    [normalizedBounds.minLng, normalizedBounds.minLat],
    center
  );
  const northEast = localMetersFromLngLat(
    [normalizedBounds.maxLng, normalizedBounds.maxLat],
    center
  );

  return {
    width: Math.abs(northEast[0] - southWest[0]),
    height: Math.abs(northEast[1] - southWest[1]),
  };
}

function assertSiteRequestWithinLimits(location, options, customBounds, config) {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    throw createHttpError(400, "위치 좌표가 올바르지 않습니다.");
  }

  const normalizedRadius = Math.max(30, Number(options?.radius) || 120);
  if (normalizedRadius > config.maxSiteRadiusMeters) {
    throw createHttpError(
      400,
      `반경은 서버 제한인 ${config.maxSiteRadiusMeters}m 이하로 요청해야 합니다.`
    );
  }

  const normalizedBounds = normalizeCustomBounds(customBounds);

  if (!normalizedBounds) {
    return;
  }

  const boundsSize = measureCustomBoundsMeters(normalizedBounds);

  if (
    boundsSize &&
    (boundsSize.width > config.maxManualRangeSideMeters ||
      boundsSize.height > config.maxManualRangeSideMeters)
  ) {
    throw createHttpError(
      400,
      `직접 지정 범위는 가로/세로 ${config.maxManualRangeSideMeters}m 이하로 요청해야 합니다.`
    );
  }
}

function assertSiteContextWithinLimits(siteContext, config) {
  if (!siteContext?.location || !siteContext?.options) {
    throw createHttpError(400, "모델 컨텍스트가 올바르지 않습니다.");
  }

  assertSiteRequestWithinLimits(
    siteContext.location,
    siteContext.options,
    siteContext.location?.customBounds,
    config
  );
}

function buildSiteContextCacheKey(location = {}, options = {}, customBounds = null) {
  const normalizedCustomBounds = normalizeCustomBounds(
    customBounds || location?.customBounds
  );
  const selectedParcels = normalizeSelectedParcelFeatures(location?.selectedParcels || []);

  return JSON.stringify({
    lat: Number(location.lat || 0).toFixed(6),
    lng: Number(location.lng || 0).toFixed(6),
    customBounds: normalizedCustomBounds,
    selectedParcels: selectedParcels.map((feature, index) => ({
      key: buildParcelSelectionKey(feature, index),
      groupName: resolveParcelGroupName(feature, index),
      groupLabel: buildParcelGroupLabel(feature, index),
    })),
    radius: Math.max(30, Number(options.radius) || 120),
    contourInterval: normalizeContourInterval(options.contourInterval),
    terrainMode: options.terrainMode === "flat" ? "flat" : "contour",
    buildingPlacement:
      options.buildingPlacement === "embed-lowest" ? "embed-lowest" : "dominant",
    exportFormat: normalizeExportFormat(options.exportFormat),
    includeContours: options.includeContours !== false,
    includeBuildings: options.includeBuildings !== false,
    includeParcelBoundary: options.includeParcelBoundary !== false,
    includeRoads: options.includeRoads === true,
    previewOnly: options.previewOnly === true,
  });
}

function extractExportRequestPayload(body) {
  const requestBody =
    body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const requestedLocation =
    requestBody.location &&
    typeof requestBody.location === "object" &&
    !Array.isArray(requestBody.location)
      ? requestBody.location
      : {};
  const requestedOptions =
    requestBody.options &&
    typeof requestBody.options === "object" &&
    !Array.isArray(requestBody.options)
      ? requestBody.options
      : {};
  const ignoredKeys = Object.keys(requestBody).filter(
    (key) => key !== "location" && key !== "options" && key !== "siteContext"
  );

  return {
    requestedLocation,
    requestedOptions,
    ignoredKeys,
    hasClientSuppliedSiteContext:
      requestBody.siteContext !== null && requestBody.siteContext !== undefined,
  };
}

function normalizeHashNumber(value, digits = 8) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Number(numericValue.toFixed(digits));
}

function normalizeHashValue(value, digits = 8) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeHashValue(entry, digits));
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        const normalizedValue = normalizeHashValue(value[key], digits);

        if (normalizedValue !== undefined) {
          result[key] = normalizedValue;
        }

        return result;
      }, {});
  }

  if (typeof value === "number") {
    return normalizeHashNumber(value, digits);
  }

  if (value === undefined) {
    return undefined;
  }

  return value;
}

function buildFeatureHashSnapshot(feature, propertyKeys = [], digits = 8) {
  if (!feature || typeof feature !== "object") {
    return null;
  }

  const pickedProperties =
    Array.isArray(propertyKeys) && propertyKeys.length > 0
      ? propertyKeys.reduce((result, key) => {
          result[key] = feature?.properties?.[key] ?? null;
          return result;
        }, {})
      : null;

  return normalizeHashValue(
    {
      id: feature.id ?? null,
      geometry: feature.geometry ?? null,
      properties: pickedProperties,
    },
    digits
  );
}

function buildFeatureCollectionHashSnapshot(collection, propertyKeys = [], digits = 8) {
  return {
    features: (collection?.features || []).map((feature) =>
      buildFeatureHashSnapshot(feature, propertyKeys, digits)
    ),
  };
}

function buildSiteContextGeometryHashInput(siteContext) {
  return {
    selectionMode: String(siteContext?.selectionMode || ""),
    location: normalizeHashValue(
      {
        customBounds: normalizeCustomBounds(siteContext?.location?.customBounds),
        selectedParcels: normalizeSelectedParcelFeatures(
          siteContext?.location?.selectedParcels || []
        ).map((feature, index) => ({
          key: buildParcelSelectionKey(feature, index),
          groupIndex: Number(feature?.properties?.groupIndex || index + 1),
          groupName: resolveParcelGroupName(feature, index),
          groupLabel: buildParcelGroupLabel(feature, index),
        })),
      },
      8
    ),
    clipBoundary: buildFeatureHashSnapshot(
      siteContext?.clipBoundary,
      ["sourceLayer"],
      8
    ),
    parcelBoundary: buildFeatureHashSnapshot(
      siteContext?.parcelBoundary,
      ["groupIndex", "groupName", "groupLabel", "isTarget", "sourceLayer"],
      8
    ),
    targetParcelGroups: buildFeatureCollectionHashSnapshot(
      siteContext?.targetParcelGroups,
      ["groupIndex", "groupName", "groupLabel", "isTarget", "sourceLayer"],
      8
    ),
    parcelContext: buildFeatureCollectionHashSnapshot(
      siteContext?.parcelContext,
      ["groupIndex", "groupName", "groupLabel", "isTarget", "sourceLayer"],
      8
    ),
    contourLines: buildFeatureCollectionHashSnapshot(
      siteContext?.contourLines,
      ["elevation", "provider", "sourceLayer"],
      8
    ),
    buildings: buildFeatureCollectionHashSnapshot(
      siteContext?.buildings,
      [
        "buildingId",
        "buildingName",
        "roadAddress",
        "heightMeters",
        "aboveGroundFloors",
        "belowGroundFloors",
        "isTarget",
        "sourceLayer",
      ],
      8
    ),
    roads: buildFeatureCollectionHashSnapshot(
      siteContext?.roads,
      ["roadId", "roadName", "widthMeters", "isTarget", "sourceLayer"],
      8
    ),
    terrainGrid: normalizeHashValue(
      siteContext?.terrainGrid
        ? {
            step: siteContext.terrainGrid.step,
            xValues: siteContext.terrainGrid.xValues,
            yValues: siteContext.terrainGrid.yValues,
            elevations: siteContext.terrainGrid.elevations,
            minElevation: siteContext.terrainGrid.minElevation,
            maxElevation: siteContext.terrainGrid.maxElevation,
          }
        : null,
      3
    ),
  };
}

function getSiteContextGeometrySignature(siteContext) {
  if (!siteContext || typeof siteContext !== "object") {
    return "none";
  }

  if (siteContextGeometrySignatureCache.has(siteContext)) {
    return siteContextGeometrySignatureCache.get(siteContext);
  }

  const signature = createHash("sha1")
    .update(JSON.stringify(buildSiteContextGeometryHashInput(siteContext)))
    .digest("hex");

  siteContextGeometrySignatureCache.set(siteContext, signature);
  return signature;
}

function normalizePathForComparison(filePath) {
  return String(filePath || "")
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function canUseWorkspaceTerrainContourFallback(requestedPath) {
  const normalizedPath = normalizePathForComparison(requestedPath);

  return (
    normalizedPath === "" ||
    normalizedPath.endsWith("/data/contours") ||
    normalizedPath.endsWith("/contours")
  );
}

function resolveTerrainContourPath(configuredPath = "") {
  const requestedPath = normalizeConfigString(configuredPath);

  if (requestedPath && existsSync(requestedPath)) {
    return {
      path: requestedPath,
      source: "configured",
      requestedPath,
    };
  }

  if (
    existsSync(DEFAULT_TERRAIN_CONTOUR_PATH) &&
    canUseWorkspaceTerrainContourFallback(requestedPath)
  ) {
    return {
      path: DEFAULT_TERRAIN_CONTOUR_PATH,
      source: requestedPath ? "workspace-fallback" : "workspace-default",
      requestedPath,
    };
  }

  return {
    path: requestedPath,
    source: requestedPath ? "configured-missing" : "missing",
    requestedPath,
  };
}

function buildProviderTimeoutConfig(localConfig = {}) {
  return {
    vworld: resolvePositiveInteger(
      process.env.VWORLD_FETCH_TIMEOUT_MS ||
        localConfig.VWORLD_FETCH_TIMEOUT_MS ||
        DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.vworld,
      DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.vworld
    ),
    juso: resolvePositiveInteger(
      process.env.JUSO_FETCH_TIMEOUT_MS ||
        localConfig.JUSO_FETCH_TIMEOUT_MS ||
        DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.juso,
      DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.juso
    ),
    buildingHub: resolvePositiveInteger(
      process.env.BUILDING_HUB_FETCH_TIMEOUT_MS ||
        localConfig.BUILDING_HUB_FETCH_TIMEOUT_MS ||
        DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.buildingHub,
      DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.buildingHub
    ),
    eum: resolvePositiveInteger(
      process.env.EUM_FETCH_TIMEOUT_MS ||
        localConfig.EUM_FETCH_TIMEOUT_MS ||
        DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.eum,
      DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.eum
    ),
    nominatim: resolvePositiveInteger(
      process.env.NOMINATIM_FETCH_TIMEOUT_MS ||
        localConfig.NOMINATIM_FETCH_TIMEOUT_MS ||
        DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.nominatim,
      DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.nominatim
    ),
    openMeteo: resolvePositiveInteger(
      process.env.OPEN_METEO_FETCH_TIMEOUT_MS ||
        localConfig.OPEN_METEO_FETCH_TIMEOUT_MS ||
        DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.openMeteo,
      DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.openMeteo
    ),
    openTopoData: resolvePositiveInteger(
      process.env.OPEN_TOPO_DATA_FETCH_TIMEOUT_MS ||
        localConfig.OPEN_TOPO_DATA_FETCH_TIMEOUT_MS ||
        DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.openTopoData,
      DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.openTopoData
    ),
    overpass: resolvePositiveInteger(
      process.env.OVERPASS_FETCH_TIMEOUT_MS ||
        localConfig.OVERPASS_FETCH_TIMEOUT_MS ||
        DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.overpass,
      DEFAULT_PROVIDER_FETCH_TIMEOUTS_MS.overpass
    ),
  };
}

function buildRuntimeConfig(localConfig) {
  const maxSiteRadiusMeters = resolvePositiveInteger(
    process.env.MAX_SITE_RADIUS_METERS ||
      localConfig.MAX_SITE_RADIUS_METERS ||
      DEFAULT_MAX_SITE_RADIUS_METERS,
    DEFAULT_MAX_SITE_RADIUS_METERS
  );
  const terrainContourPathResolution = resolveTerrainContourPath(
    process.env.TERRAIN_CONTOUR_PATH || localConfig.TERRAIN_CONTOUR_PATH || ""
  );
  const maxManualRangeSideFallback = Math.max(
    DEFAULT_MAX_MANUAL_RANGE_SIDE_METERS,
    maxSiteRadiusMeters * 2
  );

  return {
    port: Number(process.env.PORT || localConfig.PORT || 3000),
    bindHost:
      normalizeConfigString(
        process.env.BIND_HOST || localConfig.BIND_HOST || DEFAULT_BIND_HOST
      ) || DEFAULT_BIND_HOST,
    vworldApiKey: normalizeConfigString(
      process.env.VWORLD_API_KEY || localConfig.VWORLD_API_KEY || ""
    ),
    vworldApiDomain: normalizeConfigString(
      process.env.VWORLD_API_DOMAIN || localConfig.VWORLD_API_DOMAIN || ""
    ),
    jusoConfirmKey: normalizeConfigString(
      process.env.JUSO_CONFIRM_KEY || localConfig.JUSO_CONFIRM_KEY || ""
    ),
    jusoCoordinateConfirmKey: normalizeConfigString(
      process.env.JUSO_COORD_CONFIRM_KEY ||
        localConfig.JUSO_COORD_CONFIRM_KEY ||
        process.env.JUSO_CONFIRM_KEY ||
        localConfig.JUSO_CONFIRM_KEY ||
        ""
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
    terrainContourPath: terrainContourPathResolution.path,
    terrainContourPathSource: terrainContourPathResolution.source,
    terrainContourPathRequested: terrainContourPathResolution.requestedPath,
    terrainContourCrs: normalizeConfigString(
      process.env.TERRAIN_CONTOUR_CRS ||
        localConfig.TERRAIN_CONTOUR_CRS ||
        DEFAULT_TERRAIN_CONTOUR_CRS
    ),
    skpExportEngine: normalizeConfigString(
      process.env.SKP_EXPORT_ENGINE ||
        localConfig.SKP_EXPORT_ENGINE ||
        "auto"
    ),
    skpExporterCli: normalizeConfigString(
      process.env.SKP_EXPORTER_CLI || localConfig.SKP_EXPORTER_CLI || ""
    ),
    sketchUpExe: normalizeConfigString(
      process.env.SKETCHUP_EXE || localConfig.SKETCHUP_EXE || ""
    ),
    useNominatimFallback:
      String(
        process.env.USE_NOMINATIM_FALLBACK ??
          localConfig.USE_NOMINATIM_FALLBACK ??
          "true"
      ).toLowerCase() !== "false",
    maxRequestBodyBytes: resolvePositiveInteger(
      process.env.MAX_REQUEST_BODY_BYTES ||
        localConfig.MAX_REQUEST_BODY_BYTES ||
        DEFAULT_MAX_REQUEST_BODY_BYTES,
      DEFAULT_MAX_REQUEST_BODY_BYTES
    ),
    maxExportRequestBodyBytes: resolvePositiveInteger(
      process.env.MAX_EXPORT_REQUEST_BODY_BYTES ||
        localConfig.MAX_EXPORT_REQUEST_BODY_BYTES ||
        DEFAULT_MAX_EXPORT_REQUEST_BODY_BYTES,
      DEFAULT_MAX_EXPORT_REQUEST_BODY_BYTES
    ),
    maxSiteRadiusMeters,
    maxManualRangeSideMeters: resolvePositiveInteger(
      process.env.MAX_MANUAL_RANGE_SIDE_METERS ||
        localConfig.MAX_MANUAL_RANGE_SIDE_METERS ||
        maxManualRangeSideFallback,
      maxManualRangeSideFallback
    ),
    maxConcurrentExportJobs: resolvePositiveInteger(
      process.env.MAX_CONCURRENT_EXPORT_JOBS ||
        localConfig.MAX_CONCURRENT_EXPORT_JOBS ||
        DEFAULT_MAX_CONCURRENT_EXPORT_JOBS,
      DEFAULT_MAX_CONCURRENT_EXPORT_JOBS
    ),
    exportJobQueueTimeoutMs: resolvePositiveInteger(
      process.env.EXPORT_JOB_QUEUE_TIMEOUT_MS ||
        localConfig.EXPORT_JOB_QUEUE_TIMEOUT_MS ||
        DEFAULT_EXPORT_JOB_QUEUE_TIMEOUT_MS,
      DEFAULT_EXPORT_JOB_QUEUE_TIMEOUT_MS
    ),
    maxPendingExportJobsPerClient: resolvePositiveInteger(
      process.env.MAX_PENDING_EXPORT_JOBS_PER_CLIENT ||
        localConfig.MAX_PENDING_EXPORT_JOBS_PER_CLIENT ||
        DEFAULT_MAX_PENDING_EXPORT_JOBS_PER_CLIENT,
      DEFAULT_MAX_PENDING_EXPORT_JOBS_PER_CLIENT
    ),
    adPreviewAllowedPaths: normalizePathPrefixList(
      process.env.AD_PREVIEW_ALLOWED_PATHS ||
        localConfig.AD_PREVIEW_ALLOWED_PATHS ||
        DEFAULT_AD_PREVIEW_ALLOWED_PATHS
    ),
    publicEnabledFeatures: normalizeFeatureIdList(
      process.env.PUBLIC_ENABLED_FEATURES ||
        localConfig.PUBLIC_ENABLED_FEATURES ||
        DEFAULT_PUBLIC_ENABLED_FEATURES
    ),
    internalOnlyStaticPaths: normalizePathPrefixList(
      process.env.INTERNAL_ONLY_STATIC_PATHS ||
        localConfig.INTERNAL_ONLY_STATIC_PATHS ||
        DEFAULT_INTERNAL_ONLY_STATIC_PATHS
    ),
    adPreviewFrameAncestors: normalizeFrameAncestorList(
      process.env.AD_PREVIEW_FRAME_ANCESTORS ||
        localConfig.AD_PREVIEW_FRAME_ANCESTORS ||
        DEFAULT_AD_PREVIEW_FRAME_ANCESTORS
    ),
    adsTxtLines: normalizeConfigList(
      process.env.ADS_TXT_LINES ||
        localConfig.ADS_TXT_LINES ||
        DEFAULT_ADS_TXT_LINES
    ),
    providerTimeouts: buildProviderTimeoutConfig(localConfig),
    rateLimits: {
      api: {
        maxRequests: 120,
        windowMs: 1000 * 60,
        message: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
      },
      search: {
        maxRequests: 60,
        windowMs: 1000 * 60,
        message: "검색 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
      },
      heavy: {
        maxRequests: 24,
        windowMs: 1000 * 60,
        message: "무거운 데이터 요청이 잠시 몰리고 있습니다. 조금 후 다시 시도해주세요.",
      },
      export: {
        maxRequests: 8,
        windowMs: 1000 * 60 * 10,
        message: "모델 내보내기 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
      },
      progress: {
        maxRequests: 240,
        windowMs: 1000 * 60,
        message: "진행률 조회 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
      },
    },
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
  return normalizeProgressToken(
    readSingleHeaderValue(request?.headers?.["x-progress-token"])
  );
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
    clientIp: "",
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
  const normalizedToken = normalizeProgressToken(token);

  if (!normalizedToken) {
    return null;
  }

  const now = Date.now();
  pruneRequestProgressStore();
  const entry = {
    token: normalizedToken,
    operation: String(operation || "request"),
    state: "active",
    percent: 0,
    message: String(message || "").trim(),
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    error: "",
    clientIp: "",
  };

  requestProgressStore.set(normalizedToken, entry);
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

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(
    statusCode,
    buildResponseHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    })
  );
  response.end(JSON.stringify(payload, null, 2));
}

function encodeHttpHeaderFilename(filename) {
  return encodeURIComponent(String(filename || "download"))
    .replace(/['()]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    )
    .replace(/\*/g, "%2A");
}

function buildAsciiHeaderFilename(filename) {
  const ascii = String(filename || "download")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/[;\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return ascii || "download";
}

function buildContentDispositionHeader(filename) {
  const asciiFilename = buildAsciiHeaderFilename(filename);
  const encodedFilename = encodeHttpHeaderFilename(filename);
  return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

function sendText(
  response,
  statusCode,
  payload,
  filename = null,
  extraHeaders = {}
) {
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  };

  if (filename) {
    headers["Content-Disposition"] = buildContentDispositionHeader(filename);
  }

  response.writeHead(
    statusCode,
    buildResponseHeaders({
      ...headers,
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    })
  );
  response.end(payload);
}

function sendBinary(
  response,
  statusCode,
  payload,
  contentType = "application/octet-stream",
  filename = null,
  extraHeaders = {}
) {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  };

  if (filename) {
    headers["Content-Disposition"] = buildContentDispositionHeader(filename);
  }

  response.writeHead(
    statusCode,
    buildResponseHeaders({
      ...headers,
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    })
  );
  response.end(payload);
}

function sendHtml(
  response,
  statusCode,
  payload,
  extraHeaders = {},
  securityOptions = {}
) {
  response.writeHead(
    statusCode,
    buildResponseHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    }, securityOptions)
  );
  response.end(payload);
}

async function readJsonBody(request, options = {}) {
  return new Promise((resolve, reject) => {
    const maxBytes = Math.max(
      1,
      Number(options?.maxBytes) || DEFAULT_MAX_REQUEST_BODY_BYTES
    );
    const declaredContentLength = parseRequestContentLength(request);

    if (
      Number.isFinite(declaredContentLength) &&
      declaredContentLength > maxBytes
    ) {
      reject(
        createHttpError(
          413,
          `요청 본문은 ${formatByteLimit(maxBytes)} 이하만 허용됩니다.`
        )
      );
      return;
    }

    let rawBody = "";
    let totalBytes = 0;
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) {
        return;
      }

      totalBytes += Buffer.byteLength(chunk);

      if (totalBytes > maxBytes) {
        settled = true;
        request.resume();
        reject(
          createHttpError(
            413,
            `요청 본문은 ${formatByteLimit(maxBytes)} 이하만 허용됩니다.`
          )
        );
        return;
      }

      rawBody += chunk;
    });

    request.on("end", () => {
      if (settled) {
        return;
      }

      settled = true;

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

    request.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    });
  });
}

async function serveStatic(request, requestPath, response, config) {
  if (requestPath === "/" || requestPath === "/hub.html") {
    sendHtml(
      response,
      200,
      renderHubHtml(config),
      {},
      {
        frameAncestors: isAdPreviewAllowedPath(requestPath, config)
          ? config.adPreviewFrameAncestors
          : DEFAULT_FRAME_ANCESTORS,
      }
    );
    return;
  }

  const clientIp = getClientIp(request);
  const staticPageAliases = new Map([
    ["/contour3dmodel", "index.html"],
    ["/contour3dmodel/", "index.html"],
    ["/heritage-risk", "heritage-risk/index.html"],
    ["/heritage-risk/", "heritage-risk/index.html"],
    ["/max-mass", "max-mass/index.html"],
    ["/max-mass/", "max-mass/index.html"],
  ]);
  const resolvedPath = staticPageAliases.has(requestPath)
    ? path.resolve(publicDir, staticPageAliases.get(requestPath))
    : path.resolve(publicDir, `.${requestPath}`);

  if (isInternalOnlyStaticPath(requestPath, config)) {

    if (!isLoopbackIp(clientIp)) {
      console.warn(
        `[static] blocked path=${requestPath} host=${String(
          request.headers.host || ""
        )} client=${String(clientIp || "unknown")} publicEnabled=${(
          config?.publicEnabledFeatures || []
        ).join(",") || "none"}`
      );
      sendJson(response, 404, { error: "Not found" });
      return;
    }
  }

  if (requestPath === "/ads.txt" && Array.isArray(config?.adsTxtLines) && config.adsTxtLines.length) {
    sendText(
      response,
      200,
      `${config.adsTxtLines.join("\n")}\n`
    );
    return;
  }

  if (!isPathInsideDirectory(publicDir, resolvedPath)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(resolvedPath);
    const filePath = fileStat.isDirectory()
      ? path.join(resolvedPath, "index.html")
      : resolvedPath;
    const [resolvedPublicDir, resolvedFilePath] = await Promise.all([
      realpath(publicDir),
      realpath(filePath),
    ]);

    if (!isPathInsideDirectory(resolvedPublicDir, resolvedFilePath)) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }

    const body = await readFile(resolvedFilePath);
    const ext = path.extname(resolvedFilePath).toLowerCase();

    response.writeHead(
      200,
      buildResponseHeaders({
        "Content-Type":
          contentTypes[ext] || "application/octet-stream; charset=utf-8",
        ...(ext === ".html" ? { "Cache-Control": "no-store" } : {}),
      }, {
        frameAncestors:
          ext === ".html" && isAdPreviewAllowedPath(requestPath, config)
            ? config.adPreviewFrameAncestors
            : DEFAULT_FRAME_ANCESTORS,
      })
    );
    response.end(body);
  } catch (error) {
    console.warn(
      `[static] miss path=${requestPath} host=${String(
        request.headers.host || ""
      )} client=${String(clientIp || "unknown")} resolved=${resolvedPath} alias=${staticPageAliases.get(
        requestPath
      ) || ""} error=${formatErrorForLog(error)}`
    );
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

function readCacheEntryTouchTimestamp(entry) {
  return Number(entry?.lastAccessedAt || entry?.cachedAt || entry?.expiresAt || 0);
}

function pruneCacheEntries(
  cacheStore,
  { now = Date.now(), maxEntries = 0, isExpired = null } = {}
) {
  if (!(cacheStore instanceof Map)) {
    return;
  }

  const survivors = [];

  for (const [cacheKey, entry] of cacheStore.entries()) {
    if (!entry || typeof entry !== "object") {
      cacheStore.delete(cacheKey);
      continue;
    }

    if (typeof isExpired === "function" && isExpired(entry, now)) {
      cacheStore.delete(cacheKey);
      continue;
    }

    survivors.push([cacheKey, entry]);
  }

  if (maxEntries > 0 && survivors.length > maxEntries) {
    survivors.sort(
      (left, right) =>
        readCacheEntryTouchTimestamp(left[1]) - readCacheEntryTouchTimestamp(right[1])
    );

    while (survivors.length > maxEntries) {
      const [cacheKey] = survivors.shift() || [];

      if (!cacheKey) {
        break;
      }

      cacheStore.delete(cacheKey);
    }
  }
}

function touchCacheEntry(entry, now = Date.now()) {
  if (!entry || typeof entry !== "object") {
    return entry;
  }

  entry.lastAccessedAt = now;
  return entry;
}

function buildParcelDataCacheKey(parcelReference, scope = "") {
  const normalizedParcelReference = decomposePnu(parcelReference?.pnu) || parcelReference;
  const pnu = String(normalizedParcelReference?.pnu || "").trim();
  const normalizedScope = String(scope || "").trim();

  if (!pnu) {
    return normalizedScope;
  }

  return normalizedScope ? `${normalizedScope}:${pnu}` : pnu;
}

function readTimedCachePayload(
  cacheStore,
  cacheKey,
  { now = Date.now(), ttlMs = PROPERTY_DATA_CACHE_TTL_MS, maxEntries = PROPERTY_DATA_CACHE_MAX_ENTRIES } = {}
) {
  pruneCacheEntries(cacheStore, {
    now,
    maxEntries,
    isExpired: (entry, timestamp) => Number(entry?.expiresAt || 0) <= timestamp,
  });
  const cachedEntry = cacheStore.get(cacheKey);

  if (!cachedEntry) {
    return { hit: false, payload: null };
  }

  if (Number(cachedEntry.expiresAt || 0) <= now) {
    cacheStore.delete(cacheKey);
    return { hit: false, payload: null };
  }

  touchCacheEntry(cachedEntry, now);
  return {
    hit: true,
    payload: cachedEntry.payload,
  };
}

function writeTimedCachePayload(
  cacheStore,
  cacheKey,
  payload,
  { now = Date.now(), ttlMs = PROPERTY_DATA_CACHE_TTL_MS, maxEntries = PROPERTY_DATA_CACHE_MAX_ENTRIES } = {}
) {
  cacheStore.set(cacheKey, {
    cachedAt: now,
    lastAccessedAt: now,
    expiresAt: now + ttlMs,
    payload,
  });
  pruneCacheEntries(cacheStore, {
    now,
    maxEntries,
    isExpired: (entry, timestamp) => Number(entry?.expiresAt || 0) <= timestamp,
  });
}

async function readOrLoadResponseCache(
  cacheStore,
  inFlightStore,
  cacheKey,
  loadPayload,
  options = {}
) {
  const now = Date.now();
  const cached = readTimedCachePayload(cacheStore, cacheKey, {
    now,
    ttlMs: options?.ttlMs,
    maxEntries: options?.maxEntries,
  });

  if (cached.hit) {
    return cached.payload;
  }

  const existingPromise = inFlightStore.get(cacheKey);

  if (existingPromise) {
    return existingPromise;
  }

  const pendingPromise = (async () => {
    const payload = await loadPayload();
    writeTimedCachePayload(cacheStore, cacheKey, payload, {
      ttlMs: options?.ttlMs,
      maxEntries: options?.maxEntries,
    });
    return payload;
  })();

  inFlightStore.set(cacheKey, pendingPromise);

  try {
    return await pendingPromise;
  } finally {
    if (inFlightStore.get(cacheKey) === pendingPromise) {
      inFlightStore.delete(cacheKey);
    }
  }
}

function buildGeocodeCacheKey(query) {
  return String(query || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function readGeocodeCache(query) {
  const cacheKey = buildGeocodeCacheKey(query);
  const now = Date.now();
  pruneCacheEntries(geocodeCache, {
    now,
    maxEntries: GEOCODE_CACHE_MAX_ENTRIES,
    isExpired: (entry, timestamp) => Number(entry?.expiresAt || 0) <= timestamp,
  });
  const cachedEntry = geocodeCache.get(cacheKey);

  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.expiresAt <= now) {
    geocodeCache.delete(cacheKey);
    return null;
  }

  touchCacheEntry(cachedEntry, now);
  return cachedEntry.payload;
}

function writeGeocodeCache(query, payload) {
  const cacheKey = buildGeocodeCacheKey(query);
  const now = Date.now();
  geocodeCache.set(cacheKey, {
    cachedAt: now,
    lastAccessedAt: now,
    payload,
    expiresAt: now + GEOCODE_CACHE_TTL_MS,
  });
  pruneCacheEntries(geocodeCache, {
    now,
    maxEntries: GEOCODE_CACHE_MAX_ENTRIES,
    isExpired: (entry, timestamp) => Number(entry?.expiresAt || 0) <= timestamp,
  });
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

function featureIntersectsFeature(feature, targetFeature) {
  return getOuterRings(targetFeature).some((ring) =>
    featureIntersectsRing(feature, ring)
  );
}

function getFeatureAreaSquareMeters(feature) {
  return Number(
    getOuterRings(feature)
      .reduce((sum, ring) => sum + polygonAreaSquareMeters(ring), 0)
      .toFixed(3)
  );
}

function centroidOfFeature(feature) {
  const outerRings = getOuterRings(feature);

  if (!outerRings.length) {
    return null;
  }

  let weightedLng = 0;
  let weightedLat = 0;
  let totalWeight = 0;

  for (const ring of outerRings) {
    const area = polygonAreaSquareMeters(ring);
    const centroid = centroidOfRing(ring);

    if (!centroid) {
      continue;
    }

    const weight = area > 0.001 ? area : 1;
    weightedLng += centroid[0] * weight;
    weightedLat += centroid[1] * weight;
    totalWeight += weight;
  }

  if (totalWeight > 0.001) {
    return [
      Number((weightedLng / totalWeight).toFixed(8)),
      Number((weightedLat / totalWeight).toFixed(8)),
    ];
  }

  return outerRings[0]?.[0] || null;
}

function buildCombinedPolygonFeature(features, properties = {}) {
  const polygons = (features || []).flatMap((feature) =>
    getGeometryPolygonCoordinateSets(feature?.geometry)
  );

  if (!polygons.length) {
    return null;
  }

  if (polygons.length === 1) {
    return {
      type: "Feature",
      properties,
      geometry: {
        type: "Polygon",
        coordinates: polygons[0].map((ring) => closeRing(ring)),
      },
    };
  }

  return {
    type: "Feature",
    properties,
    geometry: {
      type: "MultiPolygon",
      coordinates: polygons.map((polygon) =>
        polygon.map((ring) => closeRing(ring))
      ),
    },
  };
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

function createCoordinateTransformerToSource(sourceCrs) {
  const normalizedSource = normalizeCrsId(sourceCrs);

  if (normalizedSource === "EPSG:4326") {
    return (point) => [Number(point[0]), Number(point[1])];
  }

  return (point) => proj4("EPSG:4326", normalizedSource, point);
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

function createDataViewFromBuffer(buffer) {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function parsePolylineGeometryFromShapefileRecord(buffer) {
  const view = createDataViewFromBuffer(buffer);
  const type = view.getInt32(0, true);

  if (![3, 13, 23].includes(type)) {
    return null;
  }

  const partCount = view.getInt32(36, true);
  const pointCount = view.getInt32(40, true);

  if (partCount <= 0 || pointCount <= 1) {
    return null;
  }

  let offset = 44;
  const parts = new Array(partCount);
  const points = new Array(pointCount);

  for (let index = 0; index < partCount; index += 1, offset += 4) {
    parts[index] = view.getInt32(offset, true);
  }

  for (let index = 0; index < pointCount; index += 1, offset += 16) {
    points[index] = [view.getFloat64(offset, true), view.getFloat64(offset + 8, true)];
  }

  return partCount === 1
    ? { type: "LineString", coordinates: points }
    : {
        type: "MultiLineString",
        coordinates: parts.map((partOffset, index) => points.slice(partOffset, parts[index + 1])),
      };
}

function buildBoundsFromSourceBounds(sourceBounds, transformPoint) {
  if (!sourceBounds || typeof transformPoint !== "function") {
    return null;
  }

  const corners = [
    [sourceBounds.minX, sourceBounds.minY],
    [sourceBounds.minX, sourceBounds.maxY],
    [sourceBounds.maxX, sourceBounds.minY],
    [sourceBounds.maxX, sourceBounds.maxY],
  ].map((point) => transformPoint(point));

  return buildBoundsFromPoints(corners);
}

function buildSourceBoundsFromClipBounds(clipBounds, sourceCrs) {
  if (!clipBounds) {
    return null;
  }

  const transformPoint = createCoordinateTransformerToSource(sourceCrs);
  const corners = [
    [clipBounds.minLng, clipBounds.minLat],
    [clipBounds.minLng, clipBounds.maxLat],
    [clipBounds.maxLng, clipBounds.minLat],
    [clipBounds.maxLng, clipBounds.maxLat],
  ].map((point) => transformPoint(point));

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of corners) {
    const x = Number(point?.[0]);
    const y = Number(point?.[1]);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

function sourceBoundsOverlap(leftBounds, rightBounds) {
  if (!leftBounds || !rightBounds) {
    return false;
  }

  return !(
    leftBounds.maxX < rightBounds.minX ||
    leftBounds.minX > rightBounds.maxX ||
    leftBounds.maxY < rightBounds.minY ||
    leftBounds.minY > rightBounds.maxY
  );
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

async function buildShapefileTerrainContourRecordIndex(filePath, sourceCrs) {
  const metadata = await stat(filePath);
  const cacheKey = JSON.stringify({
    path: filePath,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
    crs: normalizeCrsId(sourceCrs),
    kind: "record-index",
  });
  const cachedIndex = terrainContourRecordIndexCache.get(cacheKey);

  if (cachedIndex) {
    return cachedIndex;
  }

  const dbfPath = resolveSiblingFilePath(filePath, ".dbf");
  const shpHandle = await open(filePath, "r");
  let dbfSource = null;

  try {
    console.log(`[contours] indexing ${path.basename(filePath)}`);
    dbfSource = await shapefile.openDbf(dbfPath, { encoding: "utf-8" });
    const entries = [];
    let offsetBytes = 100;
    let recordIndex = 0;

    while (offsetBytes + 8 <= metadata.size) {
      const header = Buffer.alloc(8);
      const headerResult = await shpHandle.read(header, 0, 8, offsetBytes);

      if (headerResult.bytesRead < 8) {
        break;
      }

      const contentLengthBytes = header.readInt32BE(4) * 2;

      if (contentLengthBytes <= 0) {
        break;
      }

      const previewLength = Math.min(contentLengthBytes, 44);
      const preview = Buffer.alloc(previewLength);
      const previewResult = await shpHandle.read(preview, 0, previewLength, offsetBytes + 8);

      if (previewResult.bytesRead < 4) {
        break;
      }

      const dbfRecord = await dbfSource.read();
      const shapeType = preview.readInt32LE(0);

      if ([3, 13, 23].includes(shapeType) && previewResult.bytesRead >= 36) {
        const sourceBounds = {
          minX: preview.readDoubleLE(4),
          minY: preview.readDoubleLE(12),
          maxX: preview.readDoubleLE(20),
          maxY: preview.readDoubleLE(28),
        };
        const elevation = normalizeContourElevation(dbfRecord?.value || {});

        entries.push({
          recordIndex,
          offsetBytes,
          contentLengthBytes,
          sourceBounds,
          properties: Number.isFinite(elevation) ? { elevation } : {},
        });
      }

      offsetBytes += 8 + contentLengthBytes;
      recordIndex += 1;
    }

    const index = {
      path: filePath,
      sourceCrs: normalizeCrsId(sourceCrs),
      entries,
    };

    console.log(
      `[contours] indexed ${path.basename(filePath)} records=${entries.length}`
    );
    terrainContourRecordIndexCache.set(cacheKey, index);
    return index;
  } finally {
    if (dbfSource?.cancel) {
      await dbfSource.cancel().catch(() => null);
    }

    await shpHandle.close();
  }
}

async function loadIndexedShapefileTerrainContourDataset(filePath, sourceCrs, clipBounds) {
  const contourIndex = await buildShapefileTerrainContourRecordIndex(filePath, sourceCrs);
  const clipSourceBounds = buildSourceBoundsFromClipBounds(clipBounds, sourceCrs);
  const transformPoint = createCoordinateTransformer(sourceCrs);
  const candidateEntries = clipSourceBounds
    ? contourIndex.entries.filter((entry) =>
        sourceBoundsOverlap(entry.sourceBounds, clipSourceBounds)
      )
    : contourIndex.entries;
  const shpHandle = await open(filePath, "r");

  try {
    const features = [];

    for (const entry of candidateEntries) {
      const body = Buffer.alloc(entry.contentLengthBytes);
      const result = await shpHandle.read(
        body,
        0,
        entry.contentLengthBytes,
        entry.offsetBytes + 8
      );

      if (result.bytesRead < entry.contentLengthBytes) {
        continue;
      }

      const geometry = parsePolylineGeometryFromShapefileRecord(body);

      if (!geometry) {
        continue;
      }

      const record = buildContourFeatureRecord(
        geometry,
        entry.properties,
        transformPoint
      );

      if (!record?.bounds || !polygonBoundsOverlap(record.bounds, clipBounds)) {
        continue;
      }

      features.push(record);
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
  } finally {
    await shpHandle.close();
  }
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

function buildTerrainRegionHints(location = {}) {
  const admCdSource =
    normalizeDigits(location.juso?.admCd) ||
    normalizeDigits(String(location.pnu || "").slice(0, 10));
  const provinceCode = admCdSource.slice(0, 2);
  const provinceCodeHints = {
    "11": ["서울"],
    "26": ["부산"],
    "27": ["대구"],
    "28": ["인천"],
    "29": ["광주"],
    "30": ["대전"],
    "31": ["울산"],
    "36": ["세종"],
    "41": ["경기"],
    "42": ["강원", "강원특별자치도"],
    "43": ["충북"],
    "44": ["충남"],
    "45": ["전북", "전북특별자치도"],
    "46": ["전남"],
    "47": ["경북"],
    "48": ["경남"],
    "50": ["제주"],
  };

  if (provinceCodeHints[provinceCode]?.length) {
    return provinceCodeHints[provinceCode];
  }

  const raw = [
    location.label,
    location.parcelAddress,
    location.roadAddress,
    location.juso?.siNm,
    location.juso?.sggNm,
    location.juso?.emdNm,
  ]
    .filter(Boolean)
    .join(" ");

  const aliases = [
    ["서울", ["서울"]],
    ["서울특별시", ["서울"]],
    ["부산", ["부산"]],
    ["부산광역시", ["부산"]],
    ["대구", ["대구"]],
    ["대구광역시", ["대구"]],
    ["인천", ["인천"]],
    ["인천광역시", ["인천"]],
    ["광주", ["광주"]],
    ["광주광역시", ["광주"]],
    ["대전", ["대전"]],
    ["대전광역시", ["대전"]],
    ["울산", ["울산"]],
    ["울산광역시", ["울산"]],
    ["세종", ["세종"]],
    ["세종특별자치시", ["세종"]],
    ["경기", ["경기"]],
    ["경기도", ["경기"]],
    ["강원", ["강원", "강원특별자치도"]],
    ["강원도", ["강원", "강원특별자치도"]],
    ["강원특별자치도", ["강원", "강원특별자치도"]],
    ["충북", ["충북"]],
    ["충청북도", ["충북"]],
    ["충남", ["충남"]],
    ["충청남도", ["충남"]],
    ["전북", ["전북", "전북특별자치도"]],
    ["전라북도", ["전북", "전북특별자치도"]],
    ["전북특별자치도", ["전북", "전북특별자치도"]],
    ["전남", ["전남"]],
    ["전라남도", ["전남"]],
    ["경북", ["경북"]],
    ["경상북도", ["경북"]],
    ["경남", ["경남"]],
    ["경상남도", ["경남"]],
    ["제주", ["제주"]],
    ["제주특별자치도", ["제주"]],
  ];

  for (const [needle, hints] of aliases) {
    if (raw.includes(needle)) {
      return hints;
    }
  }

  return [];
}

async function pickPreferredContourRoots(rootPath, location = {}) {
  const hints = buildTerrainRegionHints(location);

  if (!hints.length) {
    return [rootPath];
  }

  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    const matchedRoots = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => hints.some((hint) => entry.name.includes(hint)))
      .map((entry) => path.join(rootPath, entry.name));

    return matchedRoots.length ? matchedRoots : [rootPath];
  } catch {
    return [rootPath];
  }
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

async function buildTerrainContourCatalog(contourPath, sourceCrs, location = {}) {
  const metadata = await stat(contourPath);
  const cacheKey = JSON.stringify({
    path: contourPath,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
    crs: normalizeCrsId(sourceCrs),
    regionHints: buildTerrainRegionHints(location),
  });
  const cachedCatalog = terrainContourCatalogCache.get(cacheKey);

  if (cachedCatalog) {
    return cachedCatalog;
  }

  let sourceFiles = [];

  if (metadata.isDirectory()) {
    const preferredRoots = await pickPreferredContourRoots(contourPath, location);

    for (const preferredRoot of preferredRoots) {
      const files = await collectContourSourceFiles(preferredRoot);
      sourceFiles.push(...files);
    }
  } else {
    sourceFiles = [contourPath];
  }

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

async function resolveOfficialContourCollection(location, clipFeature, config) {
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
    config.terrainContourCrs,
    location
  );
  const overlappingEntries = catalog.entries.filter(
    (entry) => entry.bounds && polygonBoundsOverlap(entry.bounds, clipBounds)
  );
  const candidateEntries = selectPreferredContourCatalogEntries(
    overlappingEntries,
    clipBounds
  );
  console.log(
    `[contours] area-matched files=${candidateEntries.length}/${catalog.entries.length}`
  );
  const features = [];

  for (const entry of candidateEntries) {
    const dataset =
      entry.extension === ".shp"
        ? await loadIndexedShapefileTerrainContourDataset(
            entry.path,
            catalog.sourceCrs,
            clipBounds
          )
        : await loadTerrainContourDatasetByPath(entry.path, catalog.sourceCrs);

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

function buildLocationParcelLookup(location = {}) {
  const directPnu = extractPnuFromValue(location?.pnu);
  const jusoPnu = buildPnuFromParts(
    location?.juso?.admCd,
    location?.juso?.mtYn,
    location?.juso?.lnbrMnnm,
    location?.juso?.lnbrSlno
  );
  const pnu = directPnu || jusoPnu || "";
  const parcelReference = decomposePnu(pnu);
  const parcelAddressKey = normalizeAddressKey(location?.parcelAddress);
  const jibunKeys = new Set();

  if (parcelReference) {
    const mainNumber = String(Number(parcelReference.bun || 0));
    const subNumber = String(Number(parcelReference.ji || 0));
    const plainJibun = subNumber === "0" ? mainNumber : `${mainNumber}-${subNumber}`;
    jibunKeys.add(normalizeAddressKey(plainJibun));

    if (parcelReference.platGbCd === "1") {
      jibunKeys.add(normalizeAddressKey(`산 ${plainJibun}`));
    }
  }

  return {
    pnu,
    parcelAddressKey,
    jibunKeys,
  };
}

function scoreParcelFeatureCandidate(feature, lookup, point, index) {
  const ring = getOuterRing(feature);

  if (!ring) {
    return null;
  }

  const properties = feature?.properties || {};
  const featurePnu = extractPnuFromProperties(properties);
  const addressKey = normalizeAddressKey(properties.addr || properties.ADDR || "");
  const jibunKey = normalizeAddressKey(properties.jibun || properties.JIBUN || "");
  const pointInside = Number.isFinite(point?.[0]) && Number.isFinite(point?.[1])
    ? isPointInsideFeature(point, feature)
    : false;
  const areaSquareMeters = Math.max(
    0,
    polygonAreaSquareMeters(ring) || Number.POSITIVE_INFINITY
  );
  const centroid = centroidOfRing(ring);
  let centroidDistanceSquared = Number.POSITIVE_INFINITY;

  if (centroid && Number.isFinite(point?.[0]) && Number.isFinite(point?.[1])) {
    const [dx, dy] = localMetersFromLngLat(centroid, {
      lng: point[0],
      lat: point[1],
    });
    centroidDistanceSquared = dx * dx + dy * dy;
  }

  return {
    feature,
    index,
    pnuMatch: Boolean(lookup.pnu && featurePnu === lookup.pnu),
    addressExactMatch: Boolean(
      lookup.parcelAddressKey &&
        addressKey &&
        addressKey === lookup.parcelAddressKey
    ),
    addressPartialMatch: Boolean(
      lookup.parcelAddressKey &&
        addressKey &&
        (addressKey.includes(lookup.parcelAddressKey) ||
          lookup.parcelAddressKey.includes(addressKey))
    ),
    jibunMatch: Boolean(
      lookup.jibunKeys.size &&
        ((jibunKey && lookup.jibunKeys.has(jibunKey)) ||
          [...lookup.jibunKeys].some(
            (candidate) => candidate && addressKey && addressKey.includes(candidate)
          ))
    ),
    pointInside,
    areaSquareMeters,
    centroidDistanceSquared,
  };
}

function pickPolygonFeature(features, location) {
  const lookup = buildLocationParcelLookup(location);
  const point = [Number(location?.lng), Number(location?.lat)];
  const scoredFeatures = (features || [])
    .map((feature, index) =>
      scoreParcelFeatureCandidate(normalizeParcelFeature(feature), lookup, point, index)
    )
    .filter(Boolean);

  if (!scoredFeatures.length) {
    return features.find((feature) => Boolean(getOuterRing(feature))) || null;
  }

  scoredFeatures.sort((left, right) =>
    Number(right.pnuMatch) - Number(left.pnuMatch) ||
    Number(right.addressExactMatch) - Number(left.addressExactMatch) ||
    Number(right.jibunMatch) - Number(left.jibunMatch) ||
    Number(right.pointInside) - Number(left.pointInside) ||
    Number(right.addressPartialMatch) - Number(left.addressPartialMatch) ||
    left.areaSquareMeters - right.areaSquareMeters ||
    left.centroidDistanceSquared - right.centroidDistanceSquared ||
    left.index - right.index
  );

  return scoredFeatures[0]?.feature || null;
}

function isRetriableUpstreamError(error) {
  const message = String(error?.message || error || "");
  return /Provider error: ERROR|429|504|ECONNRESET|fetch failed|socket hang up|ETIMEDOUT|timed out|terminated/i.test(
    message
  );
}

function waitForRetryDelay(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function resolveUpstreamRetryDelayMs(error, attempt, label = "upstream") {
  const message = String(error?.message || error || "");
  const normalizedLabel = String(label || "").trim().toLowerCase();

  if (/429/i.test(message)) {
    const isOverpass = normalizedLabel.includes("overpass");
    const baseDelayMs = isOverpass ? 3000 : 1000;
    const maxDelayMs = isOverpass ? 12000 : 5000;
    return Math.min(maxDelayMs, baseDelayMs * Math.max(1, attempt));
  }

  return Math.min(1800, 300 * Math.max(1, attempt));
}

async function retryUpstreamOperation(operation, options = {}) {
  const attempts = Math.max(1, Number(options?.attempts) || 1);
  const label = String(options?.label || "upstream").trim();
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= attempts || !isRetriableUpstreamError(error)) {
        throw error;
      }

      const delayMs = resolveUpstreamRetryDelayMs(error, attempt, label);
      console.warn(
        `[upstream-retry] label=${label} attempt=${attempt}/${attempts} delayMs=${delayMs} reason=${
          error instanceof Error ? error.message : error
        }`
      );
      await waitForRetryDelay(delayMs);
    }
  }

  throw lastError || new Error(`${label} request failed.`);
}

function buildVWorldDomainCandidates(config) {
  const configuredDomain = String(config?.vworldApiDomain || "").trim();
  const localhostDomain = `http://localhost:${Math.max(
    1,
    Number(config?.port) || 3000
  )}`;
  const candidates = [];

  for (const candidate of [configuredDomain, localhostDomain]) {
    const normalized = String(candidate || "").trim();

    if (!normalized || candidates.includes(normalized)) {
      continue;
    }

    candidates.push(normalized);
  }

  return candidates;
}

async function fetchVWorldFeatureCollection(
  dataLayer,
  geomFilter,
  buffer,
  config,
  size = 50,
  page = 1
) {
  const domainCandidates = buildVWorldDomainCandidates(config);
  let lastError = null;

  for (const domainCandidate of domainCandidates) {
    try {
      return await retryUpstreamOperation(
        async () => {
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
            domain: domainCandidate,
          });

          const response = await fetchWithTimeout(
            `https://api.vworld.kr/req/data?${params}`,
            {},
            {
              requestLabel: "VWorld data request",
              timeoutMs: config?.providerTimeouts?.vworld,
            }
          );

          if (!response.ok) {
            throw new Error(`VWorld data request failed with ${response.status}`);
          }

          const payload = await response.json();
          return parseFeatureCollection(payload);
        },
        {
          attempts: 2,
          label: `vworld:${dataLayer}:page${page}:${domainCandidate}`,
        }
      );
    } catch (error) {
      lastError = error;

      if (domainCandidate !== domainCandidates[domainCandidates.length - 1]) {
        console.warn(
          `[vworld-domain-fallback] layer=${dataLayer} page=${page} domain=${domainCandidate} reason=${
            error instanceof Error ? error.message : error
          }`
        );
      }
    }
  }

  throw lastError || new Error(`VWorld data request failed for ${dataLayer}.`);
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

function tokenizeSearchQuery(value) {
  return [...new Set(
    String(value || "")
      .replace(/[()\-\.,]/g, " ")
      .split(/\s+/)
      .map((token) => normalizeAddressKey(token))
      .filter(Boolean)
  )];
}

function collectSearchTextTokens(value) {
  return tokenizeSearchQuery(value).filter((token) => !/^\d+$/.test(token));
}

function collectSearchItemAddressKeys(item) {
  return [
    normalizeAddressKey(item?.parcelAddress),
    normalizeAddressKey(item?.roadAddress),
    normalizeAddressKey(item?.label),
  ].filter(Boolean);
}

function countSearchItemTokenMatches(item, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return 0;
  }

  const keys = collectSearchItemAddressKeys(item);

  if (!keys.length) {
    return 0;
  }

  let count = 0;

  for (const token of tokens) {
    if (keys.some((key) => key.includes(token))) {
      count += 1;
    }
  }

  return count;
}

function filterSearchItemsByBestTokenCoverage(items, tokens, minimumMatches = 1) {
  if (!Array.isArray(items) || items.length === 0 || !Array.isArray(tokens) || tokens.length === 0) {
    return items;
  }

  const ranked = items.map((item) => ({
    item,
    matchedTokens: countSearchItemTokenMatches(item, tokens),
  }));
  const bestMatchCount = Math.max(
    0,
    ...ranked.map((entry) => entry.matchedTokens)
  );

  if (bestMatchCount < Math.max(1, Number(minimumMatches) || 1)) {
    return items;
  }

  return ranked
    .filter((entry) => entry.matchedTokens === bestMatchCount)
    .map((entry) => entry.item);
}

function buildSearchQueryHints(query) {
  const normalizedQuery = normalizeAddressKey(query);
  const parcelReference = parseParcelAddressReference(query);
  const roadAddressQuery = /(?:로|길|대로)\d/u.test(String(query || "").replace(/\s+/g, ""));
  const normalizedRoadAddressQuery = /(?:\uB300\uB85C|\uB85C|\uAE38)\d/u.test(
    String(query || "").replace(/\s+/g, "")
  );
  const areaQuery = parcelReference
    ? String(query || "")
        .replace(/(?:^|\s)(\uC0B0)?\s*\d+(?:-\d+)?\s*$/u, "")
        .trim()
    : "";

  return {
    normalizedQuery,
    parcelReference,
    mainNumber: normalizeDigits(parcelReference?.bun),
    subNumber: normalizeDigits(parcelReference?.ji),
    mtYn: parcelReference?.mtYn || "0",
    roadAddressQuery: normalizedRoadAddressQuery,
    areaQuery,
    normalizedAreaQuery: normalizeAddressKey(areaQuery),
    textTokens: collectSearchTextTokens(query),
    areaTokens: collectSearchTextTokens(areaQuery),
  };
}

function hasSpecificSearchNumberSignal(hints) {
  return Boolean(
    hints?.mainNumber || normalizeDigits(hints?.normalizedQuery || "").length
  );
}

function buildSearchResponseProfile(hints) {
  const hasNumericSignal = hasSpecificSearchNumberSignal(hints);
  const highSpecificity = Boolean(
    hints?.parcelReference ||
      (hints?.roadAddressQuery && hasNumericSignal) ||
      ((hints?.textTokens?.length || 0) >= 3 && hasNumericSignal)
  );
  const addressLikeQuery = Boolean(
    highSpecificity || hints?.roadAddressQuery || hasNumericSignal
  );

  return {
    providerResultLimit: highSpecificity ? 6 : addressLikeQuery ? 8 : 10,
    jusoHydrationLimit: highSpecificity ? 2 : hints?.roadAddressQuery ? 3 : 5,
    reverseHydrationLimit: highSpecificity ? 2 : hints?.roadAddressQuery ? 3 : 5,
    skipRemainingJusoHydrationThreshold: highSpecificity
      ? 4200
      : Number.POSITIVE_INFINITY,
  };
}

function extractSearchItemParcelReference(item) {
  const pnuReference = decomposePnu(item?.pnu);

  if (pnuReference) {
    return {
      mtYn: pnuReference.platGbCd === "1" ? "1" : "0",
      bun: normalizeDigits(pnuReference.bun),
      ji: normalizeDigits(pnuReference.ji),
    };
  }

  if (normalizeDigits(item?.juso?.admCd, 10).length === 10) {
    return {
      mtYn: String(item?.juso?.mtYn ?? "0"),
      bun: normalizeDigits(item?.juso?.lnbrMnnm),
      ji: normalizeDigits(item?.juso?.lnbrSlno),
    };
  }

  return parseParcelAddressReference(item?.parcelAddress || "");
}

function hasExactParcelAddressMatch(item, hints) {
  if (!hints?.parcelReference || !hints?.mainNumber) {
    return false;
  }

  const text = String(item?.parcelAddress || item?.label || "").trim();
  const match = text.match(/(?:^|\s)(\uC0B0)?\s*(\d+)(?:-(\d+))?\s*$/u);

  if (!match) {
    return false;
  }

  const itemMtYn = match[1] ? "1" : "0";
  const itemMainNumber = normalizeDigits(match[2]);
  const itemSubNumber = normalizeDigits(match[3]);
  const querySubNumber = normalizeDigits(hints.subNumber);

  if (
    itemMtYn !== hints.mtYn ||
    itemMainNumber !== hints.mainNumber ||
    itemSubNumber !== querySubNumber
  ) {
    return false;
  }

  return (
    !hints.areaTokens.length ||
    countSearchItemTokenMatches(item, hints.areaTokens) === hints.areaTokens.length
  );
}

function scoreSearchItemQueryMatch(item, query) {
  const hints =
    query && typeof query === "object" ? query : buildSearchQueryHints(query || "");

  if (!hints.normalizedQuery && !hints.parcelReference) {
    return 0;
  }

  const parcelAddressKey = normalizeAddressKey(item?.parcelAddress);
  const roadAddressKey = normalizeAddressKey(item?.roadAddress);
  const labelKey = normalizeAddressKey(item?.label);
  let score = 0;
  const areaTokenCount = countSearchItemTokenMatches(item, hints.areaTokens);
  const textTokenCount = countSearchItemTokenMatches(
    item,
    hints.areaTokens.length ? hints.areaTokens : hints.textTokens
  );

  if (hints.normalizedQuery) {
    if (parcelAddressKey && parcelAddressKey === hints.normalizedQuery) {
      score += 5000;
    } else if (roadAddressKey && roadAddressKey === hints.normalizedQuery) {
      score += 4200;
    } else if (
      parcelAddressKey &&
      (parcelAddressKey.includes(hints.normalizedQuery) ||
        hints.normalizedQuery.includes(parcelAddressKey))
    ) {
      score += 400;
    } else if (
      roadAddressKey &&
      (roadAddressKey.includes(hints.normalizedQuery) ||
        hints.normalizedQuery.includes(roadAddressKey))
    ) {
      score += 220;
    } else if (labelKey && labelKey.includes(hints.normalizedQuery)) {
      score += 80;
    }
  }

  if (hints.areaTokens.length) {
    if (areaTokenCount === hints.areaTokens.length) {
      score += 1800;
    } else if (areaTokenCount > 0) {
      score += areaTokenCount * 260;
    } else {
      score -= 2600;
    }
  } else if (hints.textTokens.length >= 2) {
    if (textTokenCount === hints.textTokens.length) {
      score += 1100;
    } else if (textTokenCount > 0) {
      score += textTokenCount * 220;
    } else {
      score -= 900;
    }
  }

  if (hints.parcelReference) {
    const itemReference = extractSearchItemParcelReference(item);
    const mainMatch =
      normalizeDigits(itemReference?.bun) === hints.mainNumber && hints.mainNumber;
    const subMatch =
      normalizeDigits(itemReference?.ji) === hints.subNumber &&
      normalizeDigits(hints.subNumber) === normalizeDigits(itemReference?.ji);
    const mtMatch = String(itemReference?.mtYn ?? "0") === hints.mtYn;

    if (mainMatch && subMatch && mtMatch) {
      score += 3000;
    } else if (mainMatch && subMatch) {
      score += 1800;
    } else if (mainMatch) {
      score += 650;
    }

    if (item?.searchType === "parcel") {
      score += 150;
    }

    if (item?.parcelAddress) {
      score += 120;
    } else if (item?.roadAddress) {
      score -= 80;
    }
  }

  return score;
}

function scoreSearchItemParcelConfidence(item, query = "") {
  return (
    (extractPnuFromValue(item?.pnu) ? 1000 : 0) +
    (normalizeDigits(item?.juso?.admCd, 10).length === 10 ? 250 : 0) +
    (item?.parcelAddress ? 40 : 0) +
    (item?.searchType === "parcel" ? 20 : 0) +
    (String(item?.provider || "").includes("juso") ? 10 : 0) +
    scoreSearchItemQueryMatch(item, query)
  );
}

function dedupeSearchItems(items, query = "") {
  const bestByKey = new Map();

  for (const item of items || []) {
    const key = [
      item.label,
      item.roadAddress,
      item.parcelAddress,
      item.lat.toFixed(6),
      item.lng.toFixed(6),
    ].join("|");
    const existing = bestByKey.get(key);

    if (
      !existing ||
      scoreSearchItemParcelConfidence(item, query) >
        scoreSearchItemParcelConfidence(existing, query)
    ) {
      bestByKey.set(key, item);
    }
  }

  return [...bestByKey.values()];
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

function normalizeJusoUdrtYn(value, roadAddress = "") {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (["1", "y", "yes", "true"].includes(normalized)) {
    return "1";
  }

  if (["0", "n", "no", "false"].includes(normalized)) {
    return "0";
  }

  return String(roadAddress || "").includes("지하") ? "1" : "0";
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

function isVWorldNoResultStatus(status, errorText = "") {
  const normalizedStatus = String(status || "").trim().toUpperCase();
  const normalizedErrorText = normalizeAddressKey(errorText);

  if (!normalizedStatus) {
    return false;
  }

  return (
    normalizedStatus === "NOT_FOUND" ||
    normalizedStatus === "NO_DATA" ||
    normalizedStatus === "NO_RESULT" ||
    normalizedStatus === "EMPTY" ||
    normalizedErrorText.includes("검색결과가없습니다") ||
    normalizedErrorText.includes("조회결과가없습니다") ||
    normalizedErrorText.includes("결과가없습니다")
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
      udrtYn: normalizeJusoUdrtYn(item.udrtYn, item.roadAddr || item.roadAddrPart1 || ""),
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

function resolveVWorldSearchCategories(queryHints = {}) {
  if (queryHints?.parcelReference) {
    return ["parcel"];
  }

  if (queryHints?.roadAddressQuery) {
    return ["road"];
  }

  return ["road", "parcel"];
}

async function searchJuso(query, config, options = {}) {
  const resultLimit = Math.max(
    1,
    Math.min(10, Number(options?.resultLimit || 10))
  );
  const params = new URLSearchParams({
    confmKey: config.jusoConfirmKey,
    currentPage: "1",
    countPerPage: String(resultLimit),
    keyword: query,
    resultType: "json",
    hstryYn: "Y",
    firstSort: "none",
    addInfoYn: "Y",
  });

  const payload = await retryUpstreamOperation(
    async () => {
      const response = await fetchWithTimeout(
        `https://business.juso.go.kr/addrlink/addrLinkApi.do?${params}`,
        {},
        {
          requestLabel: "Juso search request",
          timeoutMs: config?.providerTimeouts?.juso,
        }
      );

      if (!response.ok) {
        throw new Error(`Juso search failed with ${response.status}`);
      }

      return response.json();
    },
    {
      attempts: 2,
      label: "juso-search",
    }
  );
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

async function geocodeJusoCandidateWithCoordinateApi(item, config) {
  const confirmKey = String(
    config?.jusoCoordinateConfirmKey || config?.jusoConfirmKey || ""
  ).trim();
  const admCd = normalizeDigits(item?.juso?.admCd, 10);
  const rnMgtSn = normalizeDigits(item?.juso?.rnMgtSn, 12);
  const buldMnnm = normalizeDigits(item?.juso?.buldMnnm, 5);
  const buldSlno = normalizeDigits(item?.juso?.buldSlno, 5);

  if (!confirmKey || admCd.length !== 10 || rnMgtSn.length !== 12 || !buldMnnm) {
    return null;
  }

  const params = new URLSearchParams({
    confmKey: confirmKey,
    admCd,
    rnMgtSn,
    udrtYn: normalizeJusoUdrtYn(item?.juso?.udrtYn, item?.roadAddress),
    buldMnnm,
    buldSlno: buldSlno || "00000",
    resultType: "json",
  });

  const payload = await retryUpstreamOperation(
    async () => {
      const response = await fetchWithTimeout(
        `https://business.juso.go.kr/addrlink/addrCoordApi.do?${params}`,
        {},
        {
          requestLabel: "Juso coordinate request",
          timeoutMs: config?.providerTimeouts?.juso,
        }
      );

      if (!response.ok) {
        throw new Error(`Juso coordinate request failed with ${response.status}`);
      }

      return response.json();
    },
    {
      attempts: 2,
      label: "juso-coordinate",
    }
  );
  const errorCode = String(payload?.results?.common?.errorCode || "").trim();
  const totalCount = Number(payload?.results?.common?.totalCount || 0);

  if ((errorCode && errorCode !== "0") || totalCount <= 0) {
    return null;
  }

  const coordItem = Array.isArray(payload?.results?.juso)
    ? payload.results.juso[0]
    : payload?.results?.juso;
  const x = Number(coordItem?.entX ?? coordItem?.x);
  const y = Number(coordItem?.entY ?? coordItem?.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const [lng, lat] = proj4("EPSG:5179", "EPSG:4326", [x, y]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return {
    id: item.id,
    label: item.label,
    roadAddress: item.roadAddress || coordItem?.roadAddr || item?.juso?.roadAddr || "",
    parcelAddress:
      item.parcelAddress || coordItem?.jibunAddr || item?.juso?.jibunAddr || "",
    lat: Number(lat),
    lng: Number(lng),
    provider: "juso+coord",
    searchType: item.searchType || "road",
    pnu: item.pnu || "",
    buildingName: item.buildingName || "",
    juso: item.juso,
  };
}

function mergeGeocodedSearchResultWithJusoCandidate(result, item, provider = "") {
  if (!result) {
    return null;
  }

  return {
    ...result,
    id: result.id || item.id,
    label: item.label || result.label,
    roadAddress: item.roadAddress || result.roadAddress || "",
    parcelAddress: item.parcelAddress || result.parcelAddress || "",
    provider: provider || result.provider || "juso",
    searchType: item.searchType || result.searchType || "road",
    pnu: item.pnu || result.pnu || "",
    buildingName: item.buildingName || result.buildingName || "",
    juso: item.juso || result.juso || null,
  };
}

function selectGeocodedVWorldResultForJusoCandidate(
  vworldItems,
  candidate,
  queryHints = null
) {
  if (!Array.isArray(vworldItems) || !vworldItems.length || !candidate) {
    return null;
  }

  const hints =
    queryHints && typeof queryHints === "object"
      ? queryHints
      : buildSearchQueryHints(
          candidate.roadAddress || candidate.parcelAddress || candidate.label || ""
        );
  const rankedItems = vworldItems
    .map((item, index) => ({
      item,
      index,
      addressScore: scoreAddressMatch(item, candidate),
      queryScore: scoreSearchItemQueryMatch(item, hints),
      parcelConfidence: scoreSearchItemParcelConfidence(item, hints),
    }))
    .sort(
      (left, right) =>
        right.addressScore - left.addressScore ||
        right.queryScore - left.queryScore ||
        right.parcelConfidence - left.parcelConfidence ||
        left.index - right.index
    );
  const bestMatch = rankedItems[0];

  if (!bestMatch) {
    return null;
  }

  const exactAddressMatch = bestMatch.addressScore >= 100;
  const strongRoadMatch =
    hints?.roadAddressQuery &&
    bestMatch.addressScore >= 70 &&
    bestMatch.queryScore >= 4000;
  const strongParcelMatch =
    !hints?.roadAddressQuery && bestMatch.queryScore >= 4500;

  return exactAddressMatch || strongRoadMatch || strongParcelMatch
    ? bestMatch.item
    : null;
}

async function geocodeJusoCandidate(item, config, options = {}) {
  const query = item.roadAddress || item.parcelAddress || item.label;
  const candidateNote = item.roadAddress || item.parcelAddress || item.label || "";

  if (!query) {
    return null;
  }

  let result = null;

  if (config.jusoCoordinateConfirmKey || config.jusoConfirmKey) {
    const coordinateStartedAt = Date.now();
    try {
      result = await geocodeJusoCandidateWithCoordinateApi(item, config);
      appendGeocodeTraceStage(options.trace, {
        name: "juso-coordinate",
        outcome: result ? "ok" : "empty",
        durationMs: Date.now() - coordinateStartedAt,
        count: result ? 1 : 0,
        note: candidateNote,
      });
    } catch {
      appendGeocodeTraceStage(options.trace, {
        name: "juso-coordinate",
        outcome: "error",
        durationMs: Date.now() - coordinateStartedAt,
        count: 0,
        note: candidateNote,
      });
      result = null;
    }
  }

  if (!result && Array.isArray(options.sharedVWorldResults)) {
    const sharedMatch = selectGeocodedVWorldResultForJusoCandidate(
      options.sharedVWorldResults,
      item,
      options.queryHints
    );

    if (sharedMatch) {
      appendGeocodeTraceStage(options.trace, {
        name: "juso-shared-vworld-match",
        outcome: "ok",
        durationMs: 0,
        count: 1,
        note: candidateNote,
      });
      result = mergeGeocodedSearchResultWithJusoCandidate(
        sharedMatch,
        item,
        "juso+vworld-fast"
      );
    }
  }

  if (!result && options.allowVWorldFallback !== false && config.vworldApiKey) {
    const vworldFallbackStartedAt = Date.now();
    const sharedCategories = new Set(
      Array.isArray(options.sharedVWorldCategories)
        ? options.sharedVWorldCategories.map((category) =>
            String(category || "").trim().toLowerCase()
          )
        : []
    );
    const [roadResults, parcelResults] = await Promise.all([
      item.roadAddress && !sharedCategories.has("road")
        ? searchVWorldCategory(item.roadAddress, "road", config).catch(() => [])
        : Promise.resolve([]),
      item.parcelAddress && !sharedCategories.has("parcel")
        ? searchVWorldCategory(item.parcelAddress, "parcel", config).catch(
            () => []
          )
        : Promise.resolve([]),
    ]);

    appendGeocodeTraceStage(options.trace, {
      name: "juso-vworld-fallback",
      outcome: roadResults[0] || parcelResults[0] ? "ok" : "empty",
      durationMs: Date.now() - vworldFallbackStartedAt,
      count: (roadResults?.length || 0) + (parcelResults?.length || 0),
      note: candidateNote,
    });

    result = roadResults[0] || parcelResults[0] || null;
  }

  if (!result && options.allowParcelFallback !== false && item.parcelAddress) {
    const parcelFallbackStartedAt = Date.now();
    try {
      const parcelFallbackResults = await geocodeParcelQueryWithDataFallback(
        item.parcelAddress,
        [],
        config
      );
      appendGeocodeTraceStage(options.trace, {
        name: "juso-parcel-fallback",
        outcome: parcelFallbackResults[0] ? "ok" : "empty",
        durationMs: Date.now() - parcelFallbackStartedAt,
        count: parcelFallbackResults.length,
        note: candidateNote,
      });
      result = parcelFallbackResults[0] || null;
    } catch {
      appendGeocodeTraceStage(options.trace, {
        name: "juso-parcel-fallback",
        outcome: "error",
        durationMs: Date.now() - parcelFallbackStartedAt,
        count: 0,
        note: candidateNote,
      });
      result = null;
    }
  }

  if (!result && options.allowNominatimFallback !== false && config.useNominatimFallback) {
    const nominatimFallbackStartedAt = Date.now();
    const fallbackResults = await geocodeWithNominatim(query, config);
    appendGeocodeTraceStage(options.trace, {
      name: "juso-nominatim-fallback",
      outcome: fallbackResults[0] ? "ok" : "empty",
      durationMs: Date.now() - nominatimFallbackStartedAt,
      count: fallbackResults.length,
      note: candidateNote,
    });
    result = fallbackResults[0] || null;
  }

  if (!result) {
    return null;
  }

  return mergeGeocodedSearchResultWithJusoCandidate(
    result,
    item,
    result.provider || (config.vworldApiKey ? "juso+vworld" : "juso+nominatim")
  );
}

function selectShortCircuitJusoCandidate(query, queryHints, jusoItems) {
  if (!Array.isArray(jusoItems) || !jusoItems.length) {
    return null;
  }

  const sortedItems = sortSearchItemsByParcelConfidence(jusoItems, query);
  const textTokens = queryHints?.areaTokens?.length
    ? queryHints.areaTokens
    : queryHints?.textTokens || [];
  const tokenFiltered = filterSearchItemsByBestTokenCoverage(
    sortedItems,
    textTokens,
    queryHints?.areaTokens?.length ? 1 : Math.min(2, textTokens.length || 0)
  );
  const rankedItems = queryHints?.roadAddressQuery
    ? tokenFiltered.filter((item) => item?.searchType === "road").length
      ? tokenFiltered.filter((item) => item?.searchType === "road")
      : tokenFiltered
    : tokenFiltered;
  const candidate = rankedItems[0];

  if (!candidate) {
    return null;
  }

  const matchScore = scoreSearchItemQueryMatch(candidate, queryHints);

  if (hasExactParcelAddressMatch(candidate, queryHints)) {
    return candidate;
  }

  if (queryHints?.roadAddressQuery) {
    const exactRoadAddressMatch =
      normalizeAddressKey(candidate?.roadAddress) === queryHints.normalizedQuery;

    if (exactRoadAddressMatch) {
      return candidate;
    }

    return rankedItems.length === 1 && matchScore >= 4200 ? candidate : null;
  }

  return rankedItems.length === 1 && matchScore >= 5000 ? candidate : null;
}

function selectStrongJusoFastPathCandidates(query, queryHints, jusoItems) {
  if (!Array.isArray(jusoItems) || !jusoItems.length || queryHints?.parcelReference) {
    return [];
  }

  const rankedItems = normalizeSearchResultsForQuery(jusoItems, query);

  if (!rankedItems.length) {
    return [];
  }

  const strongThreshold = queryHints?.roadAddressQuery ? 4300 : 5000;
  const topScore = scoreSearchItemQueryMatch(rankedItems[0], queryHints);

  if (topScore < strongThreshold) {
    return [];
  }

  const candidates = [rankedItems[0]];

  if (rankedItems.length > 1) {
    const secondScore = scoreSearchItemQueryMatch(rankedItems[1], queryHints);

    if (secondScore >= strongThreshold && topScore - secondScore <= 700) {
      candidates.push(rankedItems[1]);
    }
  }

  return candidates;
}

function hasSearchParcelReference(item) {
  const pnu = extractPnuFromValue(item?.pnu);
  const admCd = normalizeDigits(item?.juso?.admCd, 10);
  return Boolean(pnu || admCd.length === 10);
}

function mergeSearchReference(baseItem, enrichedItem) {
  if (!enrichedItem) {
    return baseItem;
  }

  return {
    ...baseItem,
    provider: enrichedItem.provider || baseItem.provider,
    roadAddress: enrichedItem.roadAddress || baseItem.roadAddress || "",
    parcelAddress: enrichedItem.parcelAddress || baseItem.parcelAddress || "",
    pnu: enrichedItem.pnu || baseItem.pnu || "",
    juso: enrichedItem.juso || baseItem.juso || null,
    buildingName: enrichedItem.buildingName || baseItem.buildingName || "",
  };
}

async function hydrateSearchItemsWithReverse(items, config, limit = 5) {
  if (!config.vworldApiKey || !Array.isArray(items) || !items.length) {
    return items;
  }

  return Promise.all(
    items.map(async (item, index) => {
      if (
        index >= limit ||
        hasSearchParcelReference(item) ||
        !Number.isFinite(item?.lat) ||
        !Number.isFinite(item?.lng)
      ) {
        return item;
      }

      try {
        const reverseResult = await reverseWithVWorld(item.lat, item.lng, config);
        return mergeSearchReference(item, reverseResult);
      } catch {
        return item;
      }
    })
  );
}

function sortSearchItemsByParcelConfidence(items, query = "") {
  return [...items]
    .map((item, index) => ({
      item,
      index,
      score: scoreSearchItemParcelConfidence(item, query),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

function buildSearchItemParcelKey(item) {
  const pnu = extractPnuFromValue(item?.pnu);

  if (pnu) {
    return `pnu:${pnu}`;
  }

  const reference = extractSearchItemParcelReference(item);
  const admCd = normalizeDigits(item?.juso?.admCd, 10);

  if (reference?.bun) {
    return `ref:${admCd}:${reference.mtYn || "0"}:${reference.bun}:${reference.ji || "0"}`;
  }

  const parcelAddressKey = normalizeAddressKey(item?.parcelAddress);

  if (parcelAddressKey) {
    return `addr:${parcelAddressKey}`;
  }

  return `coord:${Number(item?.lat || 0).toFixed(6)}:${Number(item?.lng || 0).toFixed(6)}`;
}

function collapseSearchItemsByParcel(items, query = "") {
  const bestByKey = new Map();

  for (const item of items || []) {
    const key = buildSearchItemParcelKey(item);
    const existing = bestByKey.get(key);

    if (
      !existing ||
      scoreSearchItemParcelConfidence(item, query) >
        scoreSearchItemParcelConfidence(existing, query)
    ) {
      bestByKey.set(key, item);
    }
  }

  return [...bestByKey.values()];
}

function normalizeSearchResultsForQuery(items, query = "") {
  const sorted = sortSearchItemsByParcelConfidence(
    dedupeSearchItems(items, query),
    query
  );
  const hints = buildSearchQueryHints(query);
  const textTokens = hints.areaTokens.length ? hints.areaTokens : hints.textTokens;
  const tokenFiltered = filterSearchItemsByBestTokenCoverage(
    sorted,
    textTokens,
    hints.areaTokens.length ? 1 : Math.min(2, textTokens.length || 0)
  );

  if (hints.roadAddressQuery) {
    const roadOnly = tokenFiltered.filter((item) => item?.searchType === "road");
    return roadOnly.length ? roadOnly : tokenFiltered;
  }

  if (!hints.parcelReference) {
    return tokenFiltered;
  }

  const explicitParcelCandidates = tokenFiltered.filter(
    (item) => item?.searchType === "parcel"
  );
  const parcelCandidates = explicitParcelCandidates.length
    ? explicitParcelCandidates
    : tokenFiltered.filter(
        (item) =>
          Boolean(extractSearchItemParcelReference(item)) ||
          Boolean(extractPnuFromValue(item?.pnu))
      );
  const scopedCandidates = parcelCandidates.length ? parcelCandidates : tokenFiltered;

  let filtered = scopedCandidates;
  const exactParcelMatches = filtered.filter((item) =>
    hasExactParcelAddressMatch(item, hints)
  );

  if (exactParcelMatches.length) {
    filtered = exactParcelMatches;
  }

  const mainMatches = filtered.filter(
    (item) =>
      normalizeDigits(extractSearchItemParcelReference(item)?.bun) ===
      hints.mainNumber
  );

  if (mainMatches.length) {
    filtered = mainMatches;
  }

  if (hints.subNumber) {
    const subMatches = filtered.filter(
      (item) =>
        normalizeDigits(extractSearchItemParcelReference(item)?.ji) ===
        normalizeDigits(hints.subNumber)
    );

    if (subMatches.length) {
      filtered = subMatches;
    }
  }

  const mtMatches = filtered.filter(
    (item) =>
      String(extractSearchItemParcelReference(item)?.mtYn || "0") === hints.mtYn
  );

  if (mtMatches.length) {
    filtered = mtMatches;
  } else if (hints.mtYn === "1") {
    const textualMtMatches = filtered.filter((item) =>
      normalizeAddressKey(item?.parcelAddress || item?.label || "").includes(
        "산"
      )
    );

    if (textualMtMatches.length) {
      filtered = textualMtMatches;
    } else {
      const normalizedTextualMtMatches = filtered.filter((item) =>
        normalizeAddressKey(item?.parcelAddress || item?.label || "").includes(
          "\uC0B0"
        )
      );

      if (normalizedTextualMtMatches.length) {
        filtered = normalizedTextualMtMatches;
      }
    }
  }

  return sortSearchItemsByParcelConfidence(
    collapseSearchItemsByParcel(filtered, query),
    query
  );
}

async function finalizeSearchResults(primaryResults, query, config) {
  const baseResults = normalizeSearchResultsForQuery(primaryResults, query);
  const hints = buildSearchQueryHints(query);

  if (!hints.parcelReference || !config.vworldApiKey || !baseResults.length) {
    return baseResults;
  }

  try {
    const parcelFallbackResults = await geocodeParcelQueryWithDataFallback(
      query,
      baseResults,
      config
    );

    if (!parcelFallbackResults.length) {
      return baseResults;
    }

    return normalizeSearchResultsForQuery(
      [...parcelFallbackResults, ...baseResults],
      query
    );
  } catch (error) {
    console.warn(
      `[search] parcel merge fallback failed query="${query}" error="${error?.message || error}"`
    );
    return baseResults;
  }
}

async function geocodeWithPreferredProviders(query, config, trace = null) {
  const hints = buildSearchQueryHints(query);
  const searchProfile = buildSearchResponseProfile(hints);
  const vworldCategories = resolveVWorldSearchCategories(hints);
  const sharedVworldBudgetMs = hints.roadAddressQuery ? 700 : 500;
  const providerErrors = [];
  const vworldSearchStartedAt = Date.now();
  const vworldPromise = config.vworldApiKey
    ? geocodeWithVWorld(query, config, {
        resultLimit: searchProfile.providerResultLimit,
      })
        .then((items) => {
          appendGeocodeTraceStage(trace, {
            name: "vworld-search",
            outcome: "ok",
            durationMs: Date.now() - vworldSearchStartedAt,
            count: items.length,
            note: vworldCategories.join("+"),
          });
          return { ok: true, items };
        })
        .catch((error) => {
          appendGeocodeTraceStage(trace, {
            name: "vworld-search",
            outcome: "error",
            durationMs: Date.now() - vworldSearchStartedAt,
            count: 0,
            note: error?.message || error,
          });
          return { ok: false, error, items: [] };
        })
    : (() => {
        appendGeocodeTraceStage(trace, {
          name: "vworld-search",
          outcome: "skipped",
          durationMs: 0,
          count: 0,
          note: "no-key",
        });
        return Promise.resolve({ ok: true, items: [] });
      })();
  const jusoSearchStartedAt = Date.now();
  const jusoPromise = config.jusoConfirmKey
    ? searchJuso(query, config, {
        resultLimit: searchProfile.providerResultLimit,
      })
        .then((items) => {
          appendGeocodeTraceStage(trace, {
            name: "juso-search",
            outcome: "ok",
            durationMs: Date.now() - jusoSearchStartedAt,
            count: items.length,
          });
          return { ok: true, items };
        })
        .catch((error) => {
          appendGeocodeTraceStage(trace, {
            name: "juso-search",
            outcome: "error",
            durationMs: Date.now() - jusoSearchStartedAt,
            count: 0,
            note: error?.message || error,
          });
          return { ok: false, error, items: [] };
        })
    : (() => {
        appendGeocodeTraceStage(trace, {
          name: "juso-search",
          outcome: "skipped",
          durationMs: 0,
          count: 0,
          note: "no-key",
        });
        return Promise.resolve({ ok: true, items: [] });
      })();
  const jusoResult = await jusoPromise;
  const jusoItems = jusoResult.items || [];
  let resolvedVworldResult = null;

  async function readVWorldResult() {
    if (!resolvedVworldResult) {
      resolvedVworldResult = await vworldPromise;
    }

    return resolvedVworldResult;
  }

  async function readVWorldResultWithinBudget(timeoutMs = sharedVworldBudgetMs) {
    if (!config.vworldApiKey) {
      return { ok: true, items: [], timedOut: false };
    }

    if (resolvedVworldResult) {
      return { ...resolvedVworldResult, timedOut: false };
    }

    const waitStartedAt = Date.now();
    const outcome = await Promise.race([
      readVWorldResult().then((result) => ({ timedOut: false, result })),
      waitForRetryDelay(timeoutMs).then(() => ({
        timedOut: true,
        result: { ok: true, items: [] },
      })),
    ]);

    const result = {
      ...outcome.result,
      timedOut: outcome.timedOut,
    };

    appendGeocodeTraceStage(trace, {
      name: "vworld-shared-wait",
      outcome: outcome.timedOut ? "timeout" : "ok",
      durationMs: Date.now() - waitStartedAt,
      count: Array.isArray(result?.items) ? result.items.length : 0,
      note: outcome.timedOut ? `budget=${timeoutMs}` : "",
    });

    return result;
  }

  function buildGeocodeOutcome(provider, results, branch = provider) {
    if (trace && typeof trace === "object") {
      trace.provider = provider;
      trace.branch = branch;
    }

    return { provider, results };
  }

  const jusoFastPathCandidates =
    jusoResult.ok &&
    (config.jusoCoordinateConfirmKey || config.vworldApiKey)
      ? selectStrongJusoFastPathCandidates(query, hints, jusoItems)
      : [];

  if (jusoFastPathCandidates.length) {
    const fastVworldResult = config.vworldApiKey
      ? await readVWorldResultWithinBudget()
      : { ok: true, items: [], timedOut: false };
    const fastPathStartedAt = Date.now();
    const fastJusoResults = (
      await Promise.all(
        jusoFastPathCandidates.map((candidate) =>
          geocodeJusoCandidate(candidate, config, {
            trace,
            queryHints: hints,
            sharedVWorldResults: fastVworldResult.items || [],
            sharedVWorldCategories: fastVworldResult.timedOut
              ? []
              : vworldCategories,
            allowVWorldFallback: false,
            allowParcelFallback: false,
            allowNominatimFallback: false,
          }).catch(() => null)
        )
      )
    ).filter(Boolean);
    appendGeocodeTraceStage(trace, {
      name: "juso-fast-path",
      outcome: fastJusoResults.length ? "ok" : "empty",
      durationMs: Date.now() - fastPathStartedAt,
      count: fastJusoResults.length,
      note: `candidates=${jusoFastPathCandidates.length}`,
    });

    if (fastJusoResults.length) {
      const fastProvider =
        fastJusoResults.length > 1
          ? fastJusoResults.every((item) => item?.provider === "juso+vworld-fast")
            ? "juso+vworld-fast-batch"
            : fastJusoResults.every((item) => item?.provider === "juso+coord")
              ? "juso+coord-fast-batch"
              : "juso-fast-batch"
          : fastJusoResults[0]?.provider === "juso+coord"
            ? "juso+coord-fast"
            : fastJusoResults[0]?.provider || "juso-fast";
      return buildGeocodeOutcome(
        fastProvider,
        normalizeSearchResultsForQuery(fastJusoResults, query),
        "juso-fast-path"
      );
    }
  }

  const shortCircuitJusoCandidate = jusoResult.ok
    ? selectShortCircuitJusoCandidate(query, hints, jusoItems)
    : null;

  if (shortCircuitJusoCandidate) {
    const sharedVworldResult = config.vworldApiKey
      ? await readVWorldResultWithinBudget()
      : { ok: true, items: [], timedOut: false };
    const shortCircuitStartedAt = Date.now();
    const directJusoResults = (
      await Promise.all(
        [shortCircuitJusoCandidate].map((candidate) =>
          geocodeJusoCandidate(candidate, config, {
            trace,
            queryHints: hints,
            sharedVWorldResults: sharedVworldResult.items || [],
            sharedVWorldCategories: sharedVworldResult.timedOut
              ? []
              : vworldCategories,
          }).catch(() => null)
        )
      )
    ).filter(Boolean);
    appendGeocodeTraceStage(trace, {
      name: "juso-short-circuit",
      outcome: directJusoResults.length ? "ok" : "empty",
      durationMs: Date.now() - shortCircuitStartedAt,
      count: directJusoResults.length,
    });

    if (directJusoResults.length) {
      return buildGeocodeOutcome(
        directJusoResults[0]?.provider || "juso+geocoded",
        await finalizeSearchResults(
          await hydrateSearchItemsWithReverse(directJusoResults, config, 1),
          query,
          config
        ),
        "juso-short-circuit"
      );
    }
  }

  const vworldResult = await readVWorldResult();
  const vworldItems = vworldResult.items || [];

  if (!vworldResult.ok && vworldResult.error) {
    providerErrors.push(vworldResult.error);
  }

  if (!jusoResult.ok && jusoResult.error) {
    providerErrors.push(jusoResult.error);
  }

  if (
    providerErrors.length &&
    !config.useNominatimFallback &&
    !vworldItems.length &&
    !jusoItems.length
  ) {
    throw providerErrors[0];
  }

  if (hints.parcelReference && !vworldItems.length && !jusoItems.length) {
    try {
      const parcelFallbackResults = await geocodeParcelQueryWithDataFallback(
        query,
        [],
        config
      );

      if (parcelFallbackResults.length) {
        return buildGeocodeOutcome(
          "vworld-data",
          normalizeSearchResultsForQuery(parcelFallbackResults, query),
          "parcel-data-fallback"
        );
      }
    } catch (error) {
      console.warn(
        `[search] direct parcel fallback failed query="${query}" error="${error?.message || error}"`
      );
    }
  }

  if (vworldItems.length && jusoItems.length) {
    const { merged, remainingJuso } = mergeVWorldAndJuso(vworldItems, jusoItems);
    const normalizedMerged = normalizeSearchResultsForQuery(merged, query);
    const skipRemainingJusoHydration =
      normalizedMerged.length &&
      scoreSearchItemQueryMatch(normalizedMerged[0], hints) >=
        searchProfile.skipRemainingJusoHydrationThreshold;
    const hydrated = (
      await Promise.all(
        (
          skipRemainingJusoHydration
            ? []
            : remainingJuso.slice(0, searchProfile.jusoHydrationLimit)
        ).map((candidate) =>
          geocodeJusoCandidate(candidate, config, {
            trace,
            queryHints: hints,
            sharedVWorldResults: vworldItems,
            sharedVWorldCategories: vworldCategories,
          }).catch(() => null)
        )
      )
    ).filter(Boolean);

    const combined = await hydrateSearchItemsWithReverse(
      [...merged, ...hydrated],
      config,
      searchProfile.reverseHydrationLimit
    );

    return buildGeocodeOutcome(
      hydrated.length ? "vworld+juso" : "vworld",
      await finalizeSearchResults(combined, query, config),
      "vworld-juso-merge"
    );
  }

  if (vworldItems.length) {
    const hydrated = await hydrateSearchItemsWithReverse(
      vworldItems,
      config,
      searchProfile.reverseHydrationLimit
    );
    return buildGeocodeOutcome(
      "vworld",
      await finalizeSearchResults(hydrated, query, config),
      "vworld-only"
    );
  }

  if (jusoItems.length) {
    const jusoHydrationStartedAt = Date.now();
    const hydrated = (
      await Promise.all(
        jusoItems.slice(0, searchProfile.jusoHydrationLimit).map((candidate) =>
          geocodeJusoCandidate(candidate, config, {
            trace,
            queryHints: hints,
            sharedVWorldResults: vworldItems,
            sharedVWorldCategories: vworldCategories,
          }).catch(() => null)
        )
      )
    ).filter(Boolean);
    appendGeocodeTraceStage(trace, {
      name: "juso-hydration",
      outcome: hydrated.length ? "ok" : "empty",
      durationMs: Date.now() - jusoHydrationStartedAt,
      count: hydrated.length,
      note: `limit=${searchProfile.jusoHydrationLimit}`,
    });

    return buildGeocodeOutcome(
      hydrated.length ? "juso+geocoded" : "juso",
      await finalizeSearchResults(hydrated, query, config),
      "juso-only"
    );
  }

  if (config.useNominatimFallback) {
    let fallbackResults = [];

    try {
      fallbackResults = await geocodeWithNominatim(query, config);
    } catch (error) {
      providerErrors.push(error);
    }

    let parcelFallbackResults = [];

    try {
      parcelFallbackResults = await geocodeParcelQueryWithDataFallback(
        query,
        fallbackResults,
        config
      );
    } catch (error) {
      console.warn(
        `[search] parcel fallback bypassed query="${query}" error="${error?.message || error}"`
      );
    }

    return buildGeocodeOutcome(
      parcelFallbackResults.length ? "nominatim+vworld-data" : "nominatim",
      normalizeSearchResultsForQuery(
        parcelFallbackResults.length ? parcelFallbackResults : fallbackResults,
        query
      ),
      "nominatim-fallback"
    );
  }

  if (providerErrors.length) {
    console.warn(
      `[search] no provider returned results query="${query}" lastError="${providerErrors.at(-1)?.message || providerErrors.at(-1)}"`
    );
  }

  return buildGeocodeOutcome("none", [], "none");
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

function buildParcelSelectionKey(feature, fallbackIndex = 0) {
  const normalizedFeature = normalizeParcelFeature(feature);
  const pnu = extractPnuFromProperties(normalizedFeature?.properties || {});

  if (pnu) {
    return pnu;
  }

  return buildFeatureMapKey(normalizedFeature, ["pk", "PK", "id", "ID"]) ||
    `parcel-group-${fallbackIndex + 1}`;
}

function buildParcelGroupName(index = 0) {
  return `PARCEL_GROUP_${index + 1}`;
}

function isGeneratedParcelGroupName(value = "") {
  return /^PARCEL_GROUP_\d+$/i.test(String(value || "").trim());
}

function resolveExplicitParcelGroupText(properties = {}) {
  const preferredText = String(
    properties.groupLabel || properties.groupName || ""
  ).trim();

  if (!preferredText) {
    return "";
  }

  const hasCustomSource =
    String(properties.groupNameSource || "").trim().toLowerCase() === "custom";
  const fallbackText = String(
    properties.addr || properties.jibun || extractPnuFromProperties(properties) || ""
  ).trim();

  if (
    hasCustomSource ||
    !fallbackText ||
    !isGeneratedParcelGroupName(preferredText)
  ) {
    return preferredText;
  }

  return "";
}

function resolveParcelGroupName(feature, index = 0) {
  const properties = feature?.properties || {};
  return resolveExplicitParcelGroupText(properties) || buildParcelGroupLabel(feature, index);
}

function buildParcelGroupLabel(feature, index = 0) {
  const properties = feature?.properties || {};
  return String(
    resolveExplicitParcelGroupText(properties) ||
      properties.addr ||
      properties.jibun ||
      extractPnuFromProperties(properties) ||
      buildParcelGroupName(index)
  ).trim();
}

function buildParcelGroupExportName(feature, index = 0) {
  return (
    String(resolveParcelGroupName(feature, index)).trim() || buildParcelGroupName(index)
  );
}

function normalizeSelectedParcelFeature(feature) {
  const polygons = getGeometryPolygonCoordinateSets(feature?.geometry).map((polygon) =>
    polygon.map((ring) =>
      closeRing(
        (ring || [])
          .map((point) =>
            Array.isArray(point) && point.length >= 2
              ? [Number(point[0]), Number(point[1])]
              : null
          )
          .filter(
            (point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1])
          )
      )
    )
  );
  const filteredPolygons = polygons.filter((polygon) =>
    polygon.some((ring) => ring.length >= 4)
  );

  if (!filteredPolygons.length) {
    return null;
  }

  const normalizedFeature =
    filteredPolygons.length === 1
      ? {
          type: "Feature",
          properties: { ...(feature?.properties || {}) },
          geometry: {
            type: "Polygon",
            coordinates: filteredPolygons[0],
          },
        }
      : {
          type: "Feature",
          properties: { ...(feature?.properties || {}) },
          geometry: {
            type: "MultiPolygon",
            coordinates: filteredPolygons,
          },
        };

  return normalizeParcelFeature(normalizedFeature);
}

function normalizeSelectedParcelFeatures(features) {
  const featureMap = new Map();

  for (const [index, candidate] of (Array.isArray(features) ? features : []).entries()) {
    const normalizedFeature = normalizeSelectedParcelFeature(candidate);

    if (!normalizedFeature) {
      continue;
    }

    const key = buildParcelSelectionKey(normalizedFeature, index);

    if (!featureMap.has(key)) {
      featureMap.set(key, normalizedFeature);
    }
  }

  return [...featureMap.values()];
}

function buildTargetParcelGroupFeatures(features) {
  return normalizeSelectedParcelFeatures(features).map((feature, index) => ({
    ...feature,
    properties: {
      ...(feature.properties || {}),
      isTarget: true,
      groupIndex: index + 1,
      groupId: buildParcelSelectionKey(feature, index),
      groupName: resolveParcelGroupName(feature, index),
      groupLabel: buildParcelGroupLabel(feature, index),
      sourceLayer: "LP_PA_CBND_BUBUN",
    },
  }));
}

function getTargetParcelGroupFeatures(siteContext) {
  const targetParcelGroups = siteContext?.targetParcelGroups?.features || [];

  if (targetParcelGroups.length) {
    return targetParcelGroups;
  }

  if (siteContext?.selectionMode === "range" || !siteContext?.parcelBoundary) {
    return [];
  }

  return buildTargetParcelGroupFeatures([siteContext.parcelBoundary]);
}

function resolveTargetParcelGroupForFeature(feature, targetParcelFeatures = []) {
  const normalizedTargets = Array.isArray(targetParcelFeatures)
    ? targetParcelFeatures.filter(Boolean)
    : targetParcelFeatures
      ? [targetParcelFeatures]
      : [];

  if (!normalizedTargets.length) {
    return null;
  }

  const featureCentroid = centroidOfFeature(feature);

  if (featureCentroid) {
    const directMatch = normalizedTargets.find((targetFeature) =>
      isPointInsideFeature(featureCentroid, targetFeature)
    );

    if (directMatch) {
      return directMatch;
    }
  }

  return normalizedTargets.find((targetFeature) =>
    featureIntersectsFeature(feature, targetFeature)
  ) || null;
}

function resolveTargetParcelGroupForLineString(lineString, targetParcelFeatures = []) {
  if (!Array.isArray(lineString) || lineString.length < 2) {
    return null;
  }

  const normalizedTargets = Array.isArray(targetParcelFeatures)
    ? targetParcelFeatures.filter(Boolean)
    : targetParcelFeatures
      ? [targetParcelFeatures]
      : [];
  let bestMatch = null;
  let bestScore = 0;

  for (const targetFeature of normalizedTargets) {
    const score = lineString.reduce(
      (sum, point) => sum + (isPointInsideFeature(point, targetFeature) ? 1 : 0),
      0
    );

    if (score > bestScore) {
      bestScore = score;
      bestMatch = targetFeature;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

function buildFeatureMapKey(feature, preferredPropertyKeys = []) {
  const properties = feature?.properties || {};

  for (const key of preferredPropertyKeys) {
    const value = String(properties?.[key] || "").trim();

    if (value) {
      return value;
    }
  }

  return String(
    feature?.id || properties?.pk || properties?.fid || JSON.stringify(feature?.geometry || {})
  );
}

function inferRoadWidthMeters(properties = {}) {
  const directWidthCandidates = [
    properties.width,
    properties.road_width,
    properties.roadWidth,
    properties.width_m,
    properties.r_wd,
    properties.rd_wd,
    properties.ln_wd,
    properties.lane_wd,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 1 && value <= 80);

  if (directWidthCandidates.length) {
    return directWidthCandidates[0];
  }

  const laneCountCandidates = [
    properties.lane_cnt,
    properties.laneCount,
    properties.lanes,
    properties.lane_co,
    properties.car_lane,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 20);

  if (laneCountCandidates.length) {
    return Math.max(4, laneCountCandidates[0] * 3.25);
  }

  return DEFAULT_ROAD_WIDTH_METERS;
}

function inferOsmRoadWidthMeters(highway = "") {
  const normalized = String(highway || "").trim().toLowerCase();

  switch (normalized) {
    case "motorway":
    case "motorway_link":
      return 12;
    case "trunk":
    case "trunk_link":
      return 10;
    case "primary":
    case "primary_link":
      return 8.5;
    case "secondary":
    case "secondary_link":
      return 7.5;
    case "tertiary":
    case "tertiary_link":
      return 6.5;
    case "residential":
    case "living_street":
    case "service":
    case "unclassified":
      return 5.5;
    case "track":
      return 4.5;
    case "cycleway":
    case "footway":
    case "path":
    case "pedestrian":
      return 3;
    default:
      return DEFAULT_ROAD_WIDTH_METERS;
  }
}

function parseLooseNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Number.NaN;
  }

  const normalized = String(value || "")
    .trim()
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/)?.[0];
  const numeric = Number(normalized || Number.NaN);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function pickFirstFiniteNumber(values = []) {
  for (const value of values) {
    const numeric = parseLooseNumber(value);

    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return Number.NaN;
}

function normalizeRoadFeature(feature, sourceLayer = "") {
  const properties = feature?.properties || {};

  return {
    ...feature,
    properties: {
      ...properties,
      roadId: buildFeatureMapKey(feature, [
        "link_id",
        "LINK_ID",
        "id",
        "ID",
        "uid",
        "UID",
      ]),
      roadName: String(
        properties.road_nm ||
          properties.ROAD_NM ||
          properties.name ||
          properties.NAME ||
          properties.rd_nm ||
          properties.RD_NM ||
          ""
      ).trim(),
      widthMeters: Number(inferRoadWidthMeters(properties).toFixed(2)),
      sourceLayer,
    },
  };
}

function mapOverpassRoadCollection(payload) {
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];

  return featureCollection(
    elements
      .filter(
        (element) =>
          element?.type === "way" &&
          Array.isArray(element?.geometry) &&
          element.geometry.length >= 2
      )
      .map((element) =>
        lineFeature(
          element.geometry.map((point) => [Number(point.lon), Number(point.lat)]),
          {
            roadId: String(element.id || ""),
            roadName: String(element?.tags?.name || "").trim(),
            highway: String(element?.tags?.highway || "").trim(),
            widthMeters: inferOsmRoadWidthMeters(element?.tags?.highway),
            sourceLayer: "overpass-highway",
          }
        )
      )
  );
}

async function fetchOverpassRoadCollection(clipFeature, config = null) {
  const clipRing = getOuterRing(clipFeature);

  if (!clipRing?.length) {
    return featureCollection([]);
  }

  const bounds = polygonBounds(clipRing);
  const body = `[out:json][timeout:25];
(
  way["highway"]["area"!~"yes"](${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng});
);
out geom;`;
  return retryUpstreamOperation(
    async () => {
      const response = await fetchWithTimeout(
        "https://overpass-api.de/api/interpreter",
        {
          method: "POST",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "User-Agent": "space-work/0.1 (local development)",
          },
          body,
        },
        {
          requestLabel: "Overpass road request",
          timeoutMs: config?.providerTimeouts?.overpass,
        }
      );

      if (!response.ok) {
        throw new Error(`Overpass road request failed with ${response.status}`);
      }

      const payload = await response.json();
      return mapOverpassRoadCollection(payload);
    },
    {
      attempts: 4,
      label: "overpass-roads",
    }
  );
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

function buildOsmBuildingAddress(properties = {}) {
  const fullAddress = normalizeSystemAddress(properties["addr:full"] || "");

  if (fullAddress) {
    return fullAddress;
  }

  const parts = [
    properties["addr:province"],
    properties["addr:city"],
    properties["addr:district"],
    properties["addr:subdistrict"],
    properties["addr:street"],
    properties["addr:housenumber"],
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return normalizeSystemAddress(parts.join(" "));
}

function estimateBuildingHeightMeters(properties) {
  const explicitHeight = pickFirstFiniteNumber([
    properties.height,
    properties.building_height,
    properties["building:height"],
  ]);

  if (Number.isFinite(explicitHeight) && explicitHeight > 1 && explicitHeight <= 500) {
    return Number(explicitHeight.toFixed(2));
  }

  const floors = pickFirstFiniteNumber([
    properties.gro_flo_co,
    properties["building:levels"],
    properties.levels,
  ]);

  if (Number.isFinite(floors) && floors > 0) {
    return Number((floors * 3.4 + 1.2).toFixed(2));
  }

  return 9;
}

function normalizeBuildingFeature(feature, parcelFeature = null) {
  const properties = feature?.properties || {};
  const ring = getOuterRing(feature);
  const centroid = ring ? centroidOfRing(ring) : null;
  const targetParcelFeature = resolveTargetParcelGroupForFeature(feature, parcelFeature);
  const targetParcelProperties = targetParcelFeature?.properties || {};

  return {
    ...feature,
    properties: {
      ...properties,
      buildingId: String(
        properties.bd_mgt_sn ||
          properties.pk ||
          properties.osmId ||
          feature?.id ||
          ""
      ).trim(),
      buildingName: String(
        properties.buld_nm ||
          properties.buld_nm_dc ||
          properties.name ||
          properties.NAME ||
          ""
      ).trim(),
      roadAddress:
        buildVWorldBuildingAddress(properties) || buildOsmBuildingAddress(properties),
      aboveGroundFloors: Number(
        pickFirstFiniteNumber([
          properties.gro_flo_co,
          properties["building:levels"],
          properties.levels,
        ]) || 0
      ),
      belowGroundFloors: Number(
        pickFirstFiniteNumber([
          properties.und_flo_co,
          properties["building:levels:underground"],
          properties.underground_levels,
        ]) || 0
      ),
      heightMeters: estimateBuildingHeightMeters(properties),
      footprintAreaSqm: Number(
        (ring ? polygonAreaSquareMeters(ring) : 0).toFixed(2)
      ),
      centroidLng: centroid ? Number(centroid[0].toFixed(8)) : null,
      centroidLat: centroid ? Number(centroid[1].toFixed(8)) : null,
      isTarget: Boolean(targetParcelFeature),
      targetParcelGroupIndex: Number(
        targetParcelProperties.groupIndex || Number.NaN
      ) || null,
      targetParcelGroupId: String(targetParcelProperties.groupId || "").trim(),
      targetParcelGroupName: String(targetParcelProperties.groupName || "").trim(),
      sourceLayer: String(properties.sourceLayer || "lt_c_spbd").trim() || "lt_c_spbd",
    },
  };
}

function mapOverpassBuildingCollection(payload) {
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];

  return featureCollection(
    elements
      .filter(
        (element) =>
          element?.type === "way" &&
          Array.isArray(element?.geometry) &&
          element.geometry.length >= 3
      )
      .map((element) => {
        const ring = element.geometry.map((point) => [
          Number(point?.lon),
          Number(point?.lat),
        ]);

        if (
          ring.some(
            (point) => !Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])
          )
        ) {
          return null;
        }

        return polygonFeature(ring, {
          ...(element?.tags || {}),
          osmId: String(element.id || ""),
          sourceLayer: "overpass-building",
        });
      })
      .filter(Boolean)
  );
}

async function fetchOverpassBuildingCollection(clipFeature, config = null) {
  const clipRing = getOuterRing(clipFeature);

  if (!clipRing?.length) {
    return featureCollection([]);
  }

  const bounds = polygonBounds(clipRing);
  const body = `[out:json][timeout:25];
(
  way["building"]["area"!~"yes"](${bounds.minLat},${bounds.minLng},${bounds.maxLat},${bounds.maxLng});
);
out geom;`;
  return retryUpstreamOperation(
    async () => {
      const response = await fetchWithTimeout(
        "https://overpass-api.de/api/interpreter",
        {
          method: "POST",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "User-Agent": "space-work/0.1 (local development)",
          },
          body,
        },
        {
          requestLabel: "Overpass building request",
          timeoutMs: config?.providerTimeouts?.overpass,
        }
      );

      if (!response.ok) {
        throw new Error(`Overpass building request failed with ${response.status}`);
      }

      const payload = await response.json();
      return mapOverpassBuildingCollection(payload);
    },
    {
      attempts: 4,
      label: "overpass-buildings",
    }
  );
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
  const cacheKey = `${buildParcelDataCacheKey(
    parcelReference,
    "building-register-summary"
  )}:rows=${Number(numOfRows) || 100}`;

  return readOrLoadResponseCache(
    buildingRegisterSummaryCache,
    buildingRegisterSummaryInFlight,
    cacheKey,
    async () => {
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

      const payload = await retryUpstreamOperation(
        async () => {
          const response = await fetchWithTimeout(
            `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?${params}`,
            {},
            {
              requestLabel: "Building HUB request",
              timeoutMs: config?.providerTimeouts?.buildingHub,
            }
          );

          if (!response.ok) {
            throw new Error(`Building HUB request failed with ${response.status}`);
          }

          return response.json();
        },
        {
          attempts: 2,
          label: "building-hub-summary",
        }
      );
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
    },
    {
      ttlMs: PROPERTY_DATA_CACHE_TTL_MS,
      maxEntries: PROPERTY_DATA_CACHE_MAX_ENTRIES,
    }
  );
}

async function fetchBuildingFloorOutline(parcelReference, config, numOfRows = 1000) {
  const cacheKey = `${buildParcelDataCacheKey(
    parcelReference,
    "building-floor-outline"
  )}:rows=${Number(numOfRows) || 1000}`;

  return readOrLoadResponseCache(
    buildingFloorOutlineCache,
    buildingFloorOutlineInFlight,
    cacheKey,
    async () => {
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

      const payload = await retryUpstreamOperation(
        async () => {
          const response = await fetchWithTimeout(
            `https://apis.data.go.kr/1613000/BldRgstHubService/getBrFlrOulnInfo?${params}`,
            {},
            {
              requestLabel: "Building HUB floor request",
              timeoutMs: config?.providerTimeouts?.buildingHub,
            }
          );

          if (!response.ok) {
            throw new Error(`Building HUB floor request failed with ${response.status}`);
          }

          return response.json();
        },
        {
          attempts: 2,
          label: "building-hub-floor",
        }
      );
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
    },
    {
      ttlMs: PROPERTY_DATA_CACHE_TTL_MS,
      maxEntries: PROPERTY_DATA_CACHE_MAX_ENTRIES,
    }
  );
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

async function fetchEumConnectorXml(serviceUrl, key, params = {}, config = null) {
  if (!serviceUrl || !key) {
    return "";
  }

  return retryUpstreamOperation(
    async () => {
      const response = await fetchWithTimeout(
        buildEumConnectorUrl(serviceUrl, key, params),
        {},
        {
          requestLabel: "EUM detail request",
          timeoutMs: config?.providerTimeouts?.eum,
        }
      );

      if (!response.ok) {
        throw new Error(`EUM detail request failed with ${response.status}`);
      }

      return readResponseTextWithCharset(response, "utf-8");
    },
    {
      attempts: 2,
      label: "eum-detail",
    }
  );
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
        },
        config
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
        },
        config
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
        },
        config
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

async function fetchEumLandPage(parcelReference, location, config = null) {
  const cacheKey = buildParcelDataCacheKey(parcelReference, "eum-land-page");
  const cachedPage = await readOrLoadResponseCache(
    eumLandPageCache,
    eumLandPageInFlight,
    cacheKey,
    async () => {
      const formBody = new URLSearchParams({
        selGbn: "umd",
        isNoScr: "script",
        s_type: "1",
        mode: "search",
        sggcd: parcelReference.sigunguCd,
        pnu: parcelReference.pnu,
        p_location: buildSystemAddress(location),
      });
      const html = await retryUpstreamOperation(
        async () => {
          const response = await fetchWithTimeout(
            "https://www.eum.go.kr/web/ar/lu/luLandDet.jsp",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
              },
              body: formBody.toString(),
            },
            {
              requestLabel: "EUM request",
              timeoutMs: config?.providerTimeouts?.eum,
            }
          );

          if (!response.ok) {
            throw new Error(`EUM request failed with ${response.status}`);
          }

          return readEncodedResponseText(response, "euc-kr");
        },
        {
          attempts: 2,
          label: "eum-page",
        }
      );

      return { html };
    },
    {
      ttlMs: PROPERTY_DATA_CACHE_TTL_MS,
      maxEntries: PROPERTY_DATA_CACHE_MAX_ENTRIES,
    }
  );

  return {
    html: cachedPage.html,
    landInfo: parseEumLandInfoHtml(cachedPage.html, parcelReference, location),
  };
}

async function fetchEumLandInfo(parcelReference, location, config = null) {
  const page = await fetchEumLandPage(parcelReference, location, config);
  return page.landInfo;
}

async function fetchEumLandInfoDetails(parcelReference, location, config) {
  const page = await fetchEumLandPage(parcelReference, location, config);
  const detailsCacheKey = `${buildParcelDataCacheKey(
    parcelReference,
    "eum-land-details"
  )}:buildingHub=${config?.buildingHubServiceKey ? "on" : "off"}`;
  const details = await readOrLoadResponseCache(
    eumLandRelationDetailsCache,
    eumLandRelationDetailsInFlight,
    detailsCacheKey,
    () =>
      fetchEumLandRelationDetails(
        parcelReference,
        page.html,
        config
      ),
    {
      ttlMs: PROPERTY_DATA_CACHE_TTL_MS,
      maxEntries: PROPERTY_DATA_CACHE_MAX_ENTRIES,
    }
  );

  return {
    ...page.landInfo,
    details,
  };
}

async function searchVWorldCategory(query, category, config, options = {}) {
  const domainCandidates = buildVWorldDomainCandidates(config);
  const resultLimit = Math.max(
    1,
    Math.min(10, Number(options?.resultLimit || 10))
  );
  let lastError = null;

  for (const domainCandidate of domainCandidates) {
    try {
      return await retryUpstreamOperation(
        async () => {
          const params = new URLSearchParams({
            key: config.vworldApiKey,
            service: "search",
            request: "search",
            version: "2.0",
            type: "address",
            category,
            crs: "EPSG:4326",
            size: String(resultLimit),
            format: "json",
            query,
            domain: domainCandidate,
          });
          const response = await fetchWithTimeout(
            `https://api.vworld.kr/req/search?${params}`,
            {},
            {
              requestLabel: `VWorld ${category} geocode request`,
              timeoutMs: config?.providerTimeouts?.vworld,
            }
          );

          if (!response.ok) {
            throw new Error(`VWorld ${category} geocode failed with ${response.status}`);
          }

          const payload = await response.json();
          const status = getVWorldResponseStatus(payload);
          const errorText = getVWorldResponseErrorText(payload);

          if (status && status !== "OK") {
            if (isVWorldNoResultStatus(status, errorText)) {
              return [];
            }

            throw new Error(
              errorText ||
                `VWorld ${category} geocode returned ${status}`
            );
          }

          return mapVWorldSearchItems(
            payload?.response?.result?.items,
            category === "road" ? "road" : "parcel"
          );
        },
        {
          attempts: 2,
          label: `vworld-search:${category}:${domainCandidate}`,
        }
      );
    } catch (error) {
      lastError = error;
      console.warn(
        `[vworld-domain-fallback] search=${category} domain=${domainCandidate} reason=${
          error instanceof Error ? error.message : error
        }`
      );
    }
  }

  throw lastError || new Error(`VWorld ${category} geocode request failed.`);
}

async function geocodeWithVWorld(query, config, options = {}) {
  const hints = buildSearchQueryHints(query);
  const categories = resolveVWorldSearchCategories(hints);
  const settledResults = await Promise.allSettled(
    categories.map((category) =>
      searchVWorldCategory(query, category, config, options)
    )
  );
  const recoveredItems = [];
  const errors = [];

  for (const result of settledResults) {
    if (result.status === "fulfilled") {
      recoveredItems.push(...(result.value || []));
    } else {
      errors.push(result.reason);
    }
  }

  if (recoveredItems.length) {
    return dedupeSearchItems(recoveredItems, query);
  }

  if (errors.length) {
    throw errors[0];
  }

  return [];
}

async function geocodeWithNominatim(query, config = null) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "8",
    countrycodes: "kr",
  });

  const response = await fetchWithTimeout(
    `https://nominatim.openstreetmap.org/search?${params}`,
    {
      headers: {
        "User-Agent": "space-work/0.1 (local development)",
      },
    },
    {
      requestLabel: "Nominatim geocode request",
      timeoutMs: config?.providerTimeouts?.nominatim,
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
    boundingbox: Array.isArray(item.boundingbox)
      ? item.boundingbox.map((value) => Number(value))
      : [],
    osmType: item.osm_type || "",
    placeType: item.type || item.addresstype || "",
    className: item.class || "",
  }));
}

function estimateSearchAnchorBufferMeters(anchor) {
  const lat = Number(anchor?.lat);
  const lng = Number(anchor?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return 800;
  }

  const boundingbox = Array.isArray(anchor?.boundingbox)
    ? anchor.boundingbox.map((value) => Number(value))
    : [];

  if (boundingbox.length !== 4 || boundingbox.some((value) => !Number.isFinite(value))) {
    return 1200;
  }

  const [south, north, west, east] = boundingbox;
  const center = { lat, lng };
  const corners = [
    [west, south],
    [west, north],
    [east, south],
    [east, north],
  ];
  let maxDistance = 0;

  for (const corner of corners) {
    const [dx, dy] = localMetersFromLngLat(corner, center);
    maxDistance = Math.max(maxDistance, Math.sqrt(dx * dx + dy * dy));
  }

  return Math.max(300, Math.min(6000, Math.ceil(maxDistance + 200)));
}

function buildSearchItemFromParcelFeature(feature, areaAnchor) {
  const normalizedFeature = normalizeParcelFeature(feature);
  const ring = getOuterRing(normalizedFeature);
  const centroid = ring ? centroidOfRing(ring) : null;
  const properties = normalizedFeature?.properties || {};

  return {
    id: properties.pnu || `parcel-data-${Math.random().toString(36).slice(2, 10)}`,
    label: properties.addr || properties.jibun || areaAnchor?.label || "Parcel search result",
    roadAddress: "",
    parcelAddress: properties.addr || properties.jibun || "",
    lat: Number(centroid?.[1] ?? areaAnchor?.lat ?? 0),
    lng: Number(centroid?.[0] ?? areaAnchor?.lng ?? 0),
    provider: "vworld-data",
    searchType: "parcel",
    pnu: properties.pnu || "",
  };
}

async function geocodeParcelQueryWithDataFallback(query, fallbackResults, config) {
  if (!config.vworldApiKey) {
    return [];
  }

  const hints = buildSearchQueryHints(query);
  const anchorMap = new Map();

  if (!hints.parcelReference || !hints.mainNumber) {
    return [];
  }

  for (const anchor of fallbackResults || []) {
    if (!Number.isFinite(anchor?.lat) || !Number.isFinite(anchor?.lng)) {
      continue;
    }

    const key = `${Number(anchor.lat).toFixed(6)}:${Number(anchor.lng).toFixed(6)}`;

    if (!anchorMap.has(key)) {
      anchorMap.set(key, anchor);
    }
  }

  if (hints.areaQuery) {
    for (const category of ["parcel", "road"]) {
      try {
        const areaAnchors = await searchVWorldCategory(
          hints.areaQuery,
          category,
          config
        );

        for (const anchor of areaAnchors.slice(0, 4)) {
          if (!Number.isFinite(anchor?.lat) || !Number.isFinite(anchor?.lng)) {
            continue;
          }

          const key = `${Number(anchor.lat).toFixed(6)}:${Number(anchor.lng).toFixed(6)}`;

          if (!anchorMap.has(key)) {
            anchorMap.set(key, anchor);
          }
        }
      } catch {
        // Ignore area-anchor lookup failures and keep the current fallback anchors.
      }
    }
  }

  const anchors = [...anchorMap.values()];

  if (!anchors.length) {
    return [];
  }

  const rankedCandidates = [];

  for (const anchor of anchors.slice(0, 6)) {
    if (!Number.isFinite(anchor?.lat) || !Number.isFinite(anchor?.lng)) {
      continue;
    }

    const bufferMeters = Math.max(1200, estimateSearchAnchorBufferMeters(anchor));
    let collection = null;

    try {
      collection = await fetchAllVWorldFeatureCollections(
        "LP_PA_CBND_BUBUN",
        `POINT(${anchor.lng} ${anchor.lat})`,
        bufferMeters,
        config,
        250,
        10
      );
    } catch (error) {
      console.warn(
        `[search] parcel data fallback failed query="${query}" anchor="${anchor?.label || ""}" error="${error?.message || error}"`
      );
      continue;
    }

    const areaAnchorKey = normalizeAddressKey(
      anchor?.parcelAddress || anchor?.roadAddress || anchor?.label || ""
    );

    for (const feature of collection.features || []) {
      const searchItem = buildSearchItemFromParcelFeature(feature, anchor);
      const matchScore = scoreSearchItemQueryMatch(searchItem, hints);

      if (matchScore < 650) {
        continue;
      }

      const parcelAddressKey = normalizeAddressKey(searchItem.parcelAddress);
      let score = scoreSearchItemParcelConfidence(searchItem, hints);

      if (
        hints.normalizedAreaQuery &&
        parcelAddressKey &&
        parcelAddressKey.includes(hints.normalizedAreaQuery)
      ) {
        score += 1200;
      } else if (
        hints.normalizedAreaQuery &&
        areaAnchorKey &&
        areaAnchorKey.includes(hints.normalizedAreaQuery)
      ) {
        score += 300;
      }

      rankedCandidates.push({
        item: searchItem,
        score,
        areaSquareMeters: Math.max(
          0,
          polygonAreaSquareMeters(getOuterRing(normalizeParcelFeature(feature))) ||
            Number.POSITIVE_INFINITY
        ),
      });
    }
  }

  return rankedCandidates
    .sort(
      (left, right) =>
        right.score - left.score || left.areaSquareMeters - right.areaSquareMeters
    )
    .map((entry) => entry.item)
    .filter((item, index, array) =>
      array.findIndex((candidate) => candidate.pnu === item.pnu) === index
    )
    .slice(0, 8);
}

function parseParcelAddressReference(value) {
  const normalized = String(value || "").trim();
  const normalizedMatch = normalized.match(
    /(?:^|\s)(\uC0B0)?\s*(\d+)(?:-(\d+))?\s*$/u
  );

  if (normalizedMatch) {
    return {
      mtYn: normalizedMatch[1] ? "1" : "0",
      bun: normalizedMatch[2],
      ji: normalizedMatch[3] || "",
    };
  }
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
  const domainCandidates = buildVWorldDomainCandidates(config);
  let payload = null;
  let lastError = null;

  for (const domainCandidate of domainCandidates) {
    try {
      payload = await retryUpstreamOperation(
        async () => {
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
            domain: domainCandidate,
          });
          const response = await fetchWithTimeout(
            `https://api.vworld.kr/req/address?${params}`,
            {},
            {
              requestLabel: "VWorld reverse geocode request",
              timeoutMs: config?.providerTimeouts?.vworld,
            }
          );

          if (!response.ok) {
            throw new Error(`VWorld reverse geocode failed with ${response.status}`);
          }

          const nextPayload = await response.json();
          const status = getVWorldResponseStatus(nextPayload);

          if (status && status !== "OK") {
            throw new Error(
              getVWorldResponseErrorText(nextPayload) ||
                `VWorld reverse geocode returned ${status}`
            );
          }

          return nextPayload;
        },
        {
          attempts: 2,
          label: `vworld-reverse:${domainCandidate}`,
        }
      );
      break;
    } catch (error) {
      lastError = error;

      if (domainCandidate !== domainCandidates[domainCandidates.length - 1]) {
        console.warn(
          `[vworld-domain-fallback] reverse domain=${domainCandidate} reason=${
            error instanceof Error ? error.message : error
          }`
        );
      }
    }
  }

  if (!payload) {
    throw lastError || new Error("VWorld reverse geocode request failed.");
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

async function reverseWithNominatim(lat, lng, config = null) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: "jsonv2",
  });

  const response = await fetchWithTimeout(
    `https://nominatim.openstreetmap.org/reverse?${params}`,
    {
      headers: {
        "User-Agent": "space-work/0.1 (local development)",
      },
    },
    {
      requestLabel: "Nominatim reverse geocode request",
      timeoutMs: config?.providerTimeouts?.nominatim,
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

function buildClipBoundary(location, options, parcelFeature, customBounds = null) {
  const normalizedBounds = normalizeCustomBounds(customBounds);

  if (normalizedBounds) {
    return polygonFeature(
      [
        [normalizedBounds.minLng, normalizedBounds.minLat],
        [normalizedBounds.maxLng, normalizedBounds.minLat],
        [normalizedBounds.maxLng, normalizedBounds.maxLat],
        [normalizedBounds.minLng, normalizedBounds.maxLat],
        [normalizedBounds.minLng, normalizedBounds.minLat],
      ],
      {
        shape: "rectangle",
        selectionMode: "range",
      }
    );
  }

  const radius = Math.max(30, Number(options.radius) || 120);
  return polygonFeature(createRectangleRing(location, radius * 2, radius * 2), {
    shape: "rectangle",
  });
}

function buildClipBoundaryForTargetParcels(location, options, parcelFeatures) {
  const targetParcelFeatures = buildTargetParcelGroupFeatures(parcelFeatures);

  if (!targetParcelFeatures.length) {
    return buildClipBoundary(location, options, null);
  }

  const radius = Math.max(30, Number(options.radius) || 120);
  const localPoints = targetParcelFeatures.flatMap((feature) =>
    getOuterRings(feature).flatMap((ring) =>
      ring.map((point) => localMetersFromLngLat(point, location))
    )
  );

  if (!localPoints.length) {
    return buildClipBoundary(location, options, null);
  }

  const minX = Math.min(...localPoints.map((point) => point[0])) - radius;
  const maxX = Math.max(...localPoints.map((point) => point[0])) + radius;
  const minY = Math.min(...localPoints.map((point) => point[1])) - radius;
  const maxY = Math.max(...localPoints.map((point) => point[1])) + radius;

  return polygonFeature(
    [
      lngLatFromMeters(location, minX, minY),
      lngLatFromMeters(location, maxX, minY),
      lngLatFromMeters(location, maxX, maxY),
      lngLatFromMeters(location, minX, maxY),
    ],
    {
      shape: "rectangle",
      selectionMode: "multi-parcel",
    }
  );
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

  const interval = resolveEffectiveContourBandInterval(siteContext);

  return quantizeAbsoluteElevationUpward(height, interval);
}

function resolveBuildingPlacementContourInterval(siteContext) {
  return normalizeContourInterval(
    siteContext?.stats?.effectiveContourBandInterval ??
      siteContext?.stats?.requestedContourInterval ??
      siteContext?.options?.contourInterval
  );
}

function quantizeBuildingPlacementHeight(siteContext, height) {
  if (!Number.isFinite(height)) {
    return height;
  }

  if (siteContext?.options?.terrainMode !== "contour") {
    return height;
  }

  return quantizeAbsoluteElevationUpward(
    height,
    resolveBuildingPlacementContourInterval(siteContext)
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

async function mapItemsWithConcurrency(items, concurrency, mapper) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const results = new Array(normalizedItems.length);
  const workerCount = Math.max(
    1,
    Math.min(normalizedItems.length || 1, Number(concurrency) || 1)
  );
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < normalizedItems.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(normalizedItems[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function fetchOpenMeteoElevationChunk(points, timeoutMs = undefined) {
  const cacheKey = points
    .map((point) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`)
    .join("|");
  const now = Date.now();
  pruneCacheEntries(openMeteoElevationCache, {
    now,
    maxEntries: OPEN_METEO_CACHE_MAX_ENTRIES,
    isExpired: (entry, timestamp) =>
      timestamp - Number(entry?.cachedAt || 0) >= OPEN_METEO_CACHE_TTL_MS,
  });
  const cached = openMeteoElevationCache.get(cacheKey);

  if (cached && now - cached.cachedAt < OPEN_METEO_CACHE_TTL_MS) {
    touchCacheEntry(cached, now);
    return cached.values;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const params = new URLSearchParams({
        latitude: points.map((point) => point.lat.toFixed(6)).join(","),
        longitude: points.map((point) => point.lng.toFixed(6)).join(","),
      });
      const response = await fetchWithTimeout(
        `https://api.open-meteo.com/v1/elevation?${params}`,
        {
          headers: {
            "User-Agent": "space-work/0.1",
          },
        },
        {
          requestLabel: "Open-Meteo elevation request",
          timeoutMs,
        }
      );

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

      const cachedAt = Date.now();
      openMeteoElevationCache.set(cacheKey, {
        cachedAt,
        lastAccessedAt: cachedAt,
        values,
      });
      pruneCacheEntries(openMeteoElevationCache, {
        now: cachedAt,
        maxEntries: OPEN_METEO_CACHE_MAX_ENTRIES,
        isExpired: (entry, timestamp) =>
          timestamp - Number(entry?.cachedAt || 0) >= OPEN_METEO_CACHE_TTL_MS,
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
    const leftValues = await fetchOpenMeteoElevationChunk(
      points.slice(0, midpoint),
      timeoutMs
    );
    const rightValues = await fetchOpenMeteoElevationChunk(
      points.slice(midpoint),
      timeoutMs
    );
    const values = [...leftValues, ...rightValues];

    const cachedAt = Date.now();
    openMeteoElevationCache.set(cacheKey, {
      cachedAt,
      lastAccessedAt: cachedAt,
      values,
    });
    pruneCacheEntries(openMeteoElevationCache, {
      now: cachedAt,
      maxEntries: OPEN_METEO_CACHE_MAX_ENTRIES,
      isExpired: (entry, timestamp) =>
        timestamp - Number(entry?.cachedAt || 0) >= OPEN_METEO_CACHE_TTL_MS,
    });
    return values;
  }

  throw lastError;
}

async function fetchOpenMeteoElevations(points, timeoutMs = undefined) {
  const chunks = [];

  for (
    let index = 0;
    index < points.length;
    index += OPEN_METEO_MAX_POINTS_PER_REQUEST
  ) {
    chunks.push(points.slice(index, index + OPEN_METEO_MAX_POINTS_PER_REQUEST));
  }

  const elevationChunks = await mapItemsWithConcurrency(
    chunks,
    OPEN_METEO_MAX_CONCURRENT_REQUESTS,
    (chunk) => fetchOpenMeteoElevationChunk(chunk, timeoutMs)
  );

  return elevationChunks.flat();
}

async function fetchOpenTopoDataElevationChunk(points, timeoutMs = undefined) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        "https://api.opentopodata.org/v1/srtm90m",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "space-work/0.1",
          },
          body: JSON.stringify({
            locations: points
              .map((point) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`)
              .join("|"),
            interpolation: "bilinear",
          }),
        },
        {
          requestLabel: "OpenTopoData elevation request",
          timeoutMs,
        }
      );

      if (!response.ok) {
        throw new Error(`OpenTopoData elevation request failed with ${response.status}`);
      }

      const payload = await response.json();

      if (payload?.status !== "OK") {
        throw new Error(payload?.error || "OpenTopoData elevation request failed.");
      }

      const results = Array.isArray(payload?.results) ? payload.results : [];

      if (results.length !== points.length) {
        throw new Error("OpenTopoData elevation response did not match the request.");
      }

      const values = results.map((item) => Number(item?.elevation));

      if (values.some((value) => !Number.isFinite(value))) {
        throw new Error("OpenTopoData elevation response contained invalid values.");
      }

      return values;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, attempt * 700);
      });
    }
  }

  if (points.length > 20) {
    const midpoint = Math.ceil(points.length / 2);
    const leftValues = await fetchOpenTopoDataElevationChunk(
      points.slice(0, midpoint),
      timeoutMs
    );
    const rightValues = await fetchOpenTopoDataElevationChunk(
      points.slice(midpoint),
      timeoutMs
    );
    return [...leftValues, ...rightValues];
  }

  throw lastError;
}

async function fetchOpenTopoDataElevations(points, timeoutMs = undefined) {
  const chunks = [];

  for (let index = 0; index < points.length; index += OPEN_TOPO_DATA_MAX_POINTS_PER_REQUEST) {
    chunks.push(points.slice(index, index + OPEN_TOPO_DATA_MAX_POINTS_PER_REQUEST));
  }

  const elevationChunks = await mapItemsWithConcurrency(
    chunks,
    OPEN_TOPO_DATA_MAX_CONCURRENT_REQUESTS,
    (chunk) => fetchOpenTopoDataElevationChunk(chunk, timeoutMs)
  );

  return elevationChunks.flat();
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
    longestSide <= 120
      ? 0.75
      : longestSide <= 300
        ? 1
        : longestSide <= 600
          ? 1.5
        : longestSide <= 1000
          ? 2.5
          : longestSide <= 1600
            ? 4
            : 6;
  const intervalStep =
    contourInterval <= 1
      ? 0.75
      : contourInterval <= 2
        ? 1
        : contourInterval <= 5
          ? 1.5
          : contourInterval <= 10
            ? 2.5
            : 6;

  return Number(
    Math.max(0.75, Math.min(8, Math.max(longestSideStep, intervalStep))).toFixed(3)
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
  contourInterval,
  options = {}
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
  const configuredStep = Number(options?.sampleStep);
  const step =
    Number.isFinite(configuredStep) && configuredStep > 0
      ? Number(Math.max(0.35, Math.min(8, configuredStep)).toFixed(3))
      : resolveContourDrivenSampleStep(
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
  const terrainDebugPrefix = `[terrain] lat=${Number(location?.lat || 0).toFixed(6)} lng=${Number(location?.lng || 0).toFixed(6)} radius=${Math.max(30, Number(options?.radius) || 120)}`;

  console.log(`${terrainDebugPrefix} start includeContours=${options.includeContours !== false}`);

  if (options.includeContours !== false) {
    try {
      console.log(`${terrainDebugPrefix} official-contours loading`);
      contourSource = await resolveOfficialContourCollection(
        location,
        clipFeature,
        config
      );
      console.log(
        `${terrainDebugPrefix} official-contours loaded features=${Number(
          contourSource?.collection?.features?.length || 0
        )} interval=${Number(contourSource?.interval || 0)}`
      );
    } catch (error) {
      console.log(
        `${terrainDebugPrefix} official-contours error=${
          error instanceof Error ? error.message : "unknown"
        }`
      );
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
    console.log(`${terrainDebugPrefix} flat-mode return`);
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

  console.log(`${terrainDebugPrefix} synthetic-fallback-grid building`);
  const sampleFallbackGrid = buildSyntheticTerrainGrid(location, clipFeature, options);
  console.log(
    `${terrainDebugPrefix} synthetic-fallback-grid ready step=${Number(
      sampleFallbackGrid?.step || 0
    )} rows=${Number(sampleFallbackGrid?.elevations?.length || 0)}`
  );
  const shouldSuppressSyntheticContourFallback = Boolean(
    options.includeContours !== false &&
      config?.terrainContourPath &&
      !contourSource?.collection?.features?.length
  );
  const buildContourCollectionForTerrainGrid = (terrainGrid) => {
    if (options.includeContours === false) {
      return featureCollection([]);
    }

    if (contourSource?.collection?.features?.length) {
      return contourSource.collection;
    }

    if (shouldSuppressSyntheticContourFallback) {
      return featureCollection([]);
    }

    return createContourLinesFromTerrainGrid(location, terrainGrid, options);
  };

  if (shouldSuppressSyntheticContourFallback && contourSource) {
    contourSource = {
      ...contourSource,
      note: `${contourSource.note} Synthetic contour fallback was suppressed to avoid showing grid-derived contours in preview/export.`,
    };
  }

  if (contourSource?.collection?.features?.length) {
    try {
      console.log(
        `${terrainDebugPrefix} contour-derivation building features=${Number(
          contourSource.collection.features.length || 0
        )}`
      );
      const contourTerrainGrid = buildTerrainGridFromContourCollection(
        location,
        clipFeature,
        contourSource.collection,
        sourceContourInterval
      );

      if (contourTerrainGrid?.elevations?.length) {
        console.log(
          `${terrainDebugPrefix} contour-derivation ready step=${Number(
            contourTerrainGrid?.step || 0
          )} rows=${Number(contourTerrainGrid?.elevations?.length || 0)}`
        );
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
      console.log(
        `${terrainDebugPrefix} contour-derivation error=${
          error instanceof Error ? error.message : "unknown"
        }`
      );
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
    console.log(`${terrainDebugPrefix} sampled-grid building`);
    const sampleGrid = buildTerrainSampleGrid(location, clipFeature, options);
    console.log(
      `${terrainDebugPrefix} sampled-grid ready step=${Number(
        sampleGrid?.step || 0
      )} points=${Number(sampleGrid?.points?.length || 0)}`
    );
    let elevations;
    let provider = "open-meteo";
    let note = "실제 표고 샘플을 바탕으로 지형 메쉬를 생성했습니다.";

    try {
      console.log(`${terrainDebugPrefix} open-meteo request`);
      elevations = await fetchOpenMeteoElevations(
        sampleGrid.points,
        config?.providerTimeouts?.openMeteo
      );
    } catch {
      console.log(`${terrainDebugPrefix} open-meteo failed -> opentopodata`);
      elevations = await fetchOpenTopoDataElevations(
        sampleGrid.points,
        config?.providerTimeouts?.openTopoData
      );
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
      contourCollection: buildContourCollectionForTerrainGrid(terrainGrid),
      contourSource,
      contourInterval: requestedContourInterval,
      sourceContourInterval,
      terrainGrid,
    };
  } catch (error) {
    console.log(
      `${terrainDebugPrefix} sampled-grid error=${
        error instanceof Error ? error.message : "unknown"
      }`
    );
    const contourCollection = buildContourCollectionForTerrainGrid(
      sampleFallbackGrid
    );

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
    buildMergedContourLineFeatures(
      location,
      rawSegments,
      Math.max(0.5, Math.min(2, Number(interval || 1)))
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
    const lookup = buildLocationParcelLookup(location);
    const searchBuffers = lookup.pnu ? [3, 12, 30] : [3];
    let bestFeature = null;

    for (const buffer of searchBuffers) {
      const collection = await fetchAllVWorldFeatureCollections(
        "LP_PA_CBND_BUBUN",
        `POINT(${location.lng} ${location.lat})`,
        buffer,
        config,
        150,
        lookup.pnu ? 4 : 2
      );
      const parcelFeature = pickPolygonFeature(collection.features, location);
      const selectedPnu = extractPnuFromProperties(parcelFeature?.properties || {});

      console.log(
        `[parcel] lat=${Number(location.lat || 0).toFixed(6)} lng=${Number(
          location.lng || 0
        ).toFixed(6)} buffer=${buffer} features=${Number(
          collection.features?.length || 0
        )} expectedPnu=${lookup.pnu || "none"} selectedPnu=${selectedPnu || "none"}`
      );

      if (!parcelFeature) {
        continue;
      }

      if (!bestFeature) {
        bestFeature = parcelFeature;
      }

      if (!lookup.pnu || selectedPnu === lookup.pnu) {
        return {
          feature: normalizeParcelFeature(parcelFeature),
          provider: "vworld",
          isFallback: false,
          note: "브이월드에서 실제 대지 경계를 불러왔습니다.",
        };
      }
    }

    if (bestFeature) {
      return {
        feature: normalizeParcelFeature(bestFeature),
        provider: "vworld",
        isFallback: false,
        note: "브이월드에서 대지 경계 후보 중 가장 일치도가 높은 필지를 선택했습니다.",
      };
    }

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

async function resolveParcelContext(
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
      note: "VWorld key missing; parcel context unavailable.",
    };
  }

  try {
    const clipRing = getOuterRing(clipFeature);
    const queryPlan = buildBuildingQueryPlan(location, clipFeature);
    const featureMap = new Map();
    const targetParcelFeatures = buildTargetParcelGroupFeatures(
      Array.isArray(parcelFeature) ? parcelFeature : parcelFeature ? [parcelFeature] : []
    );
    const targetParcelKeys = new Set(
      targetParcelFeatures.map((feature, index) =>
        buildParcelSelectionKey(feature, index)
      )
    );

    for (const query of queryPlan) {
      const collection = await fetchAllVWorldFeatureCollections(
        "LP_PA_CBND_BUBUN",
        `POINT(${query.lng} ${query.lat})`,
        Math.max(80, query.buffer),
        config,
        250,
        Math.max(4, query.maxPages)
      );

      for (const feature of collection.features || []) {
        const normalizedFeature = normalizeParcelFeature(feature);
        const pnu = extractPnuFromProperties(normalizedFeature.properties);
        const key = pnu || buildFeatureMapKey(normalizedFeature, ["pk", "PK"]);

        if (!featureMap.has(key)) {
          featureMap.set(key, normalizedFeature);
        }
      }
    }

    const filteredFeatures = [...featureMap.values()]
      .map((feature) => clipFeatureToRing(feature, clipRing, location))
      .filter(Boolean)
      .map((feature) => normalizeParcelFeature(feature))
      .filter((feature) => {
        const featureKey = buildParcelSelectionKey(feature);
        return !targetParcelKeys.has(featureKey);
      })
      .map((feature) => ({
        ...feature,
        properties: {
          ...(feature.properties || {}),
          isTarget: false,
          sourceLayer: "LP_PA_CBND_BUBUN",
        },
      }))
      .sort((left, right) => {
        const leftArea = polygonAreaSquareMeters(getOuterRing(left));
        const rightArea = polygonAreaSquareMeters(getOuterRing(right));
        return leftArea - rightArea;
      });

    return {
      collection: featureCollection(filteredFeatures),
      provider: "vworld",
      isFallback: false,
      note: `Loaded ${filteredFeatures.length} surrounding parcel boundaries from VWorld.`,
    };
  } catch (error) {
    return {
      collection: featureCollection([]),
      provider: "unavailable",
      isFallback: true,
      note:
        error instanceof Error
          ? `Parcel context request failed: ${error.message}`
          : "Parcel context request failed.",
    };
  }
}

function clipRoadFeatureToClipBoundary(feature, clipFeature, location, geometryType) {
  const normalizedFeature = normalizeRoadFeature(
    feature,
    feature?.properties?.sourceLayer || ""
  );

  if (geometryType === "polygon") {
    return clipFeatureToRing(normalizedFeature, getOuterRing(clipFeature), location);
  }

  const clipRing = getOuterRing(clipFeature);
  const clipBounds = polygonBounds(clipRing);
  const clippedGeometry = clipLineGeometryToBounds(
    normalizedFeature.geometry,
    clipBounds
  );

  if (!clippedGeometry) {
    return null;
  }

  return {
    ...normalizedFeature,
    geometry: clippedGeometry,
  };
}

function buildRoadContextResult(
  features,
  provider,
  geometryType,
  location,
  note,
  isFallback = false
) {
  const surfaceCollection = buildRoadSurfaceFeatureCollection(features, location);

  if (surfaceCollection.features.length) {
    const rawFeatureLabel = geometryType === "polygon" ? "polygon" : "line";
    const rawFeatureCount = Array.isArray(features) ? features.length : 0;
    return {
      collection: surfaceCollection,
      provider,
      isFallback,
      note:
        rawFeatureCount > 0
          ? `Loaded ${rawFeatureCount} road ${rawFeatureLabel} feature(s) from ${provider}; merged them into ${surfaceCollection.features.length} road surface polygon(s).`
          : note,
    };
  }

  return {
    collection: featureCollection(features),
    provider,
    isFallback,
    note,
  };
}

async function finalizeBuildingContextCollection(
  features,
  provider,
  isFallback,
  note,
  targetParcelFeatures,
  config
) {
  const filteredFeatures = [...features].sort((left, right) => {
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
  const registerParcelFeature =
    targetParcelFeatures.length === 1 ? targetParcelFeatures[0] : null;
  const parcelReference = decomposePnu(registerParcelFeature?.properties?.pnu);
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
        registerParcelFeature
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
    provider,
    isFallback,
    note:
      registerMatchedCount > 0
        ? `${note} Matched ${registerMatchedCount} building-register record(s).`
        : note,
  };
}

async function resolveRoadContext(location, clipFeature, options, config) {
  if (options.includeRoads !== true) {
    return {
      collection: featureCollection([]),
      provider: "disabled",
      isFallback: false,
      note: "Road context disabled by option.",
    };
  }

  const queryPlan = buildBuildingQueryPlan(location, clipFeature);
  const fallbackBoundaryCandidate = ROAD_LAYER_CANDIDATES.find(
    (candidate) => candidate.layer === "lt_l_sprd"
  );
  const hasVWorldKey = Boolean(config.vworldApiKey);

  if (hasVWorldKey) {
    for (const candidate of ROAD_LAYER_CANDIDATES) {
      if (candidate.layer === "lt_l_sprd") {
        continue;
      }

      try {
        const featureMap = new Map();

        for (const query of queryPlan) {
          const collection = await fetchAllVWorldFeatureCollections(
            candidate.layer,
            `POINT(${query.lng} ${query.lat})`,
            Math.max(120, query.buffer),
            config,
            250,
            Math.max(3, query.maxPages)
          );

          for (const feature of collection.features || []) {
            const normalizedFeature = normalizeRoadFeature(feature, candidate.layer);
            const key = buildFeatureMapKey(normalizedFeature, [
              "roadId",
              "ROAD_ID",
              "link_id",
              "LINK_ID",
            ]);

            if (!featureMap.has(key)) {
              featureMap.set(key, normalizedFeature);
            }
          }
        }

        const filteredFeatures = [...featureMap.values()]
          .map((feature) =>
            clipRoadFeatureToClipBoundary(
              {
                ...feature,
                properties: {
                  ...(feature.properties || {}),
                  sourceLayer: candidate.layer,
                },
              },
              clipFeature,
              location,
              candidate.geometryType
            )
          )
          .filter(Boolean)
          .filter((feature) =>
            candidate.geometryType === "polygon"
              ? polygonAreaSquareMeters(getOuterRing(feature)) > 4
              : getLineStringsFromGeometry(feature.geometry).some(
                  (lineString) => lineString.length >= 2
                )
          );

        console.log(
          `[roads] layer=${candidate.layer} features=${filteredFeatures.length} geometry=${candidate.geometryType}`
        );

        if (filteredFeatures.length) {
          return buildRoadContextResult(
            filteredFeatures,
            candidate.provider,
            candidate.geometryType,
            location,
            `Loaded ${filteredFeatures.length} road feature(s) from ${candidate.layer}.`,
            false
          );
        }
      } catch (error) {
        console.warn(
          `[roads] layer=${candidate.layer} failed: ${error instanceof Error ? error.message : error}`
        );
      }
    }
  }

  try {
    const collection = await fetchOverpassRoadCollection(clipFeature, config);
    const filteredFeatures = (collection.features || [])
      .map((feature) =>
        clipRoadFeatureToClipBoundary(
          feature,
          clipFeature,
          location,
          "line"
        )
      )
      .filter(Boolean)
      .filter((feature) =>
        getLineStringsFromGeometry(feature.geometry).some(
          (lineString) => lineString.length >= 2
        )
      )
      .map((feature) => normalizeRoadFeature(feature, "overpass-highway"));

    console.log(`[roads] layer=overpass-highway features=${filteredFeatures.length} geometry=line`);

    if (filteredFeatures.length) {
      return buildRoadContextResult(
        filteredFeatures,
        "openstreetmap-overpass",
        "line",
        location,
        `Loaded ${filteredFeatures.length} road feature(s) from Overpass.`,
        true
      );
    }
  } catch (error) {
    console.warn(
      `[roads] layer=overpass-highway failed: ${error instanceof Error ? error.message : error}`
    );
  }

  if (hasVWorldKey && fallbackBoundaryCandidate) {
    try {
      const featureMap = new Map();

      for (const query of queryPlan) {
        const collection = await fetchAllVWorldFeatureCollections(
          fallbackBoundaryCandidate.layer,
          `POINT(${query.lng} ${query.lat})`,
          Math.max(120, query.buffer),
          config,
          250,
          Math.max(3, query.maxPages)
        );

        for (const feature of collection.features || []) {
          const normalizedFeature = normalizeRoadFeature(
            feature,
            fallbackBoundaryCandidate.layer
          );
          const key = buildFeatureMapKey(normalizedFeature, [
            "roadId",
            "ROAD_ID",
            "link_id",
            "LINK_ID",
          ]);

          if (!featureMap.has(key)) {
            featureMap.set(key, normalizedFeature);
          }
        }
      }

      const filteredFeatures = [...featureMap.values()]
        .map((feature) =>
          clipRoadFeatureToClipBoundary(
            {
              ...feature,
              properties: {
                ...(feature.properties || {}),
                sourceLayer: fallbackBoundaryCandidate.layer,
              },
            },
            clipFeature,
            location,
            fallbackBoundaryCandidate.geometryType
          )
        )
        .filter(Boolean)
        .filter((feature) =>
          getLineStringsFromGeometry(feature.geometry).some(
            (lineString) => lineString.length >= 2
          )
        );

      console.log(
        `[roads] layer=${fallbackBoundaryCandidate.layer} features=${filteredFeatures.length} geometry=${fallbackBoundaryCandidate.geometryType}`
      );

      if (filteredFeatures.length) {
        return buildRoadContextResult(
          filteredFeatures,
          fallbackBoundaryCandidate.provider,
          fallbackBoundaryCandidate.geometryType,
          location,
          `Loaded ${filteredFeatures.length} road feature(s) from ${fallbackBoundaryCandidate.layer}.`,
          true
        );
      }
    } catch (error) {
      console.warn(
        `[roads] layer=${fallbackBoundaryCandidate.layer} failed: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  return {
    collection: featureCollection([]),
    provider: "unavailable",
    isFallback: true,
    note: hasVWorldKey
      ? "No road-context layer returned usable features for the current area."
      : "Road context unavailable from Overpass and no VWorld key was configured.",
  };
}

async function resolveOverpassBuildingContext(
  location,
  clipFeature,
  targetParcelFeatures,
  config,
  fallbackReason = ""
) {
  try {
    const clipRing = getOuterRing(clipFeature);
    const collection = await fetchOverpassBuildingCollection(clipFeature, config);
    const filteredFeatures = (collection.features || [])
      .map((feature) => clipFeatureToRing(feature, clipRing, location))
      .filter(Boolean)
      .map((feature) => normalizeBuildingFeature(feature, targetParcelFeatures))
      .filter((feature) => Number(feature.properties?.footprintAreaSqm || 0) > 2);

    console.log(
      `[buildings] layer=overpass-building features=${filteredFeatures.length} geometry=polygon`
    );

    if (!filteredFeatures.length) {
      return null;
    }

    const notePrefix = fallbackReason ? `${fallbackReason} ` : "";
    return finalizeBuildingContextCollection(
      filteredFeatures,
      "openstreetmap-overpass",
      true,
      `${notePrefix}Loaded ${filteredFeatures.length} building footprint(s) from Overpass.`,
      targetParcelFeatures,
      config
    );
  } catch (error) {
    console.warn(
      `[buildings] layer=overpass-building failed: ${
        error instanceof Error ? error.message : error
      }`
    );
    return null;
  }
}

async function resolveBuildingContext(
  location,
  clipFeature,
  parcelFeature,
  config
) {
  const clipRing = getOuterRing(clipFeature);
  const targetParcelFeatures = buildTargetParcelGroupFeatures(
    Array.isArray(parcelFeature) ? parcelFeature : parcelFeature ? [parcelFeature] : []
  );
  const queryPlan = buildBuildingQueryPlan(location, clipFeature);
  let vworldError = null;

  if (config.vworldApiKey) {
    try {
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

        for (const feature of collection.features || []) {
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
        .map((feature) => normalizeBuildingFeature(feature, targetParcelFeatures))
        .filter((feature) => Number(feature.properties?.footprintAreaSqm || 0) > 2);

      console.log(
        `[buildings] layer=lt_c_spbd features=${filteredFeatures.length} geometry=polygon`
      );

      if (filteredFeatures.length) {
        return finalizeBuildingContextCollection(
          filteredFeatures,
          "vworld",
          false,
          `Loaded ${filteredFeatures.length} building footprint(s) from VWorld.`,
          targetParcelFeatures,
          config
        );
      }

      vworldError = new Error("VWorld returned no usable building footprints.");
    } catch (error) {
      vworldError =
        error instanceof Error ? error : new Error("Building context request failed.");
    }
  } else {
    vworldError = new Error("VWorld key missing.");
  }

  const fallbackReason = vworldError
    ? `VWorld building context failed: ${vworldError.message}.`
    : "";
  const overpassResult = await resolveOverpassBuildingContext(
    location,
    clipFeature,
    targetParcelFeatures,
    config,
    fallbackReason
  );

  if (overpassResult) {
    return overpassResult;
  }

  return {
    collection: featureCollection([]),
    provider: "unavailable",
    isFallback: true,
    note: fallbackReason || "Building context request failed.",
  };
}

async function buildSiteContext(body, config, reportProgress = null) {
  const location = body.location || {};
  const options = {
    ...(body.options || {}),
    previewOnly: body.previewOnly === true || body.options?.previewOnly === true,
    radius: Math.max(30, Number(body.options?.radius) || 120),
  };
  const customBounds = normalizeCustomBounds(body.customBounds || location.customBounds);
  const isManualRange = Boolean(customBounds);
  const isSelectionPreview = options.previewOnly === true && !isManualRange;
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  const progress =
    typeof reportProgress === "function" ? reportProgress : () => null;

  const normalizedLocation = {
    ...location,
    lat,
    lng,
    selectedParcels: normalizeSelectedParcelFeatures(
      body.selectedParcels || location.selectedParcels || []
    ),
  };
  const targetParcelGroupFeatures = isManualRange
    ? []
    : buildTargetParcelGroupFeatures(normalizedLocation.selectedParcels);
  const isMultiParcelSelection =
    !isManualRange && targetParcelGroupFeatures.length > 1;
  assertSiteRequestWithinLimits(normalizedLocation, options, customBounds, config);
  const cacheKey = buildSiteContextCacheKey(normalizedLocation, options, customBounds);
  const now = Date.now();
  pruneCacheEntries(siteContextCache, {
    now,
    maxEntries: SITE_CONTEXT_CACHE_MAX_ENTRIES,
    isExpired: (entry, timestamp) =>
      timestamp - Number(entry?.cachedAt || 0) >= SITE_CONTEXT_CACHE_TTL_MS,
  });
  const cachedSiteContext = siteContextCache.get(cacheKey);

  if (
    cachedSiteContext &&
    now - cachedSiteContext.cachedAt < SITE_CONTEXT_CACHE_TTL_MS
  ) {
    progress(100, "저장된 대지 컨텍스트를 불러왔습니다.");
    return cachedSiteContext.value;
  }

  progress(10, "필지 경계를 불러오는 중입니다.");
  const parcelResult = isManualRange
    ? {
        feature: buildClipBoundary(normalizedLocation, options, null, customBounds),
        provider: "manual-range",
        isFallback: false,
        note: "User-defined rectangle range was applied.",
      }
    : targetParcelGroupFeatures.length
      ? {
          feature: buildCombinedPolygonFeature(targetParcelGroupFeatures, {
            isTarget: true,
            sourceLayer: "LP_PA_CBND_BUBUN",
          }),
          provider: "selection-cache",
          isFallback: false,
          note:
            targetParcelGroupFeatures.length > 1
              ? `Using ${targetParcelGroupFeatures.length} selected parcel boundaries.`
              : "Using the selected parcel boundary.",
        }
      : await resolveParcelBoundary(normalizedLocation, config);
  progress(24, "대지 범위를 계산하는 중입니다.");
  const clipBoundary = isManualRange
    ? parcelResult.feature
    : isSelectionPreview
      ? targetParcelGroupFeatures.length > 1
        ? buildClipBoundaryForTargetParcels(
            normalizedLocation,
            { ...options, radius: 30 },
            targetParcelGroupFeatures
          )
        : parcelResult.feature
      : targetParcelGroupFeatures.length
        ? buildClipBoundaryForTargetParcels(
            normalizedLocation,
            options,
            targetParcelGroupFeatures
          )
        : buildClipBoundary(
            normalizedLocation,
            options,
            parcelResult.feature
          );
  progress(42, "지형 데이터를 준비하는 중입니다.");
  const terrainResult = isSelectionPreview
    ? {
        provider: "preview",
        mode: "skipped",
        note: "Terrain loading skipped for address selection preview.",
        contourCollection: featureCollection([]),
        terrainGrid: null,
        contourSource: null,
        sourceContourInterval: null,
      }
    : await resolveTerrainContext(
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
    56,
    isSelectionPreview ? "Skipping surrounding parcels for preview." : "Loading surrounding parcels."
  );
  const parcelContextResult = isSelectionPreview
    ? {
        collection: featureCollection([]),
        provider: "preview",
        isFallback: false,
        note: "Surrounding parcel context skipped for address selection preview.",
      }
    : await resolveParcelContext(
        normalizedLocation,
        clipBoundary,
        isManualRange ? null : targetParcelGroupFeatures.length ? targetParcelGroupFeatures : parcelResult.feature,
        config
      );
  progress(
    68,
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
          isManualRange ? null : targetParcelGroupFeatures.length ? targetParcelGroupFeatures : parcelResult.feature,
          config
        );
  progress(
    80,
    options.includeRoads === true
      ? "Loading road context."
      : "Skipping road context."
  );
  const roadResult = isSelectionPreview
    ? {
        collection: featureCollection([]),
        provider: "preview",
        isFallback: false,
        note: "Road context skipped for address selection preview.",
      }
    : await resolveRoadContext(
        normalizedLocation,
        clipBoundary,
        options,
        config
      );
  progress(
    88,
    options.includeBuildings === false
      ? "건물 컨텍스트를 생략하고 있습니다."
      : "건물 컨텍스트를 정리하는 중입니다."
  );
  const selectedTargetParcelFeatures = isManualRange
    ? []
    : targetParcelGroupFeatures.length
      ? targetParcelGroupFeatures
      : buildTargetParcelGroupFeatures([parcelResult.feature]);
  const clipRing = getOuterRing(clipBoundary);
  const parcelArea = isManualRange
    ? polygonAreaSquareMeters(clipRing)
    : selectedTargetParcelFeatures.reduce(
        (sum, feature) => sum + getFeatureAreaSquareMeters(feature),
        0
      );
  const clipArea = polygonAreaSquareMeters(clipRing);
  const parcelCenter = isManualRange
    ? centroidOfRing(clipRing)
    : centroidOfFeature(
        buildCombinedPolygonFeature(selectedTargetParcelFeatures) || parcelResult.feature
      );
  const buildingCount = buildingResult.collection.features.length;
  const targetBuildingCount = isManualRange
    ? 0
    : buildingResult.collection.features.filter((feature) => feature.properties?.isTarget)
        .length;
  const parcelContextCount = parcelContextResult.collection.features.length;
  const roadCount = roadResult.collection.features.length;
  const normalizedTargetParcelFeature = isManualRange
    ? {
        ...clipBoundary,
        properties: {
          ...(clipBoundary.properties || {}),
          isTarget: false,
          sourceLayer: "MANUAL_RANGE",
        },
      }
    : selectedTargetParcelFeatures.length === 1
      ? normalizeParcelFeature(selectedTargetParcelFeatures[0])
      : buildCombinedPolygonFeature(selectedTargetParcelFeatures, {
          isTarget: true,
          sourceLayer: "LP_PA_CBND_BUBUN",
          selectedParcelCount: selectedTargetParcelFeatures.length,
        });
  const targetParcelFeature = normalizedTargetParcelFeature
    ? {
        ...normalizedTargetParcelFeature,
        properties: {
          ...(normalizedTargetParcelFeature.properties || {}),
          isTarget: isManualRange ? false : true,
          sourceLayer: isManualRange ? "MANUAL_RANGE" : "LP_PA_CBND_BUBUN",
        },
      }
    : null;

  const siteContext = {
    selectionMode: isManualRange
      ? "range"
      : isMultiParcelSelection
        ? "multi-parcel"
        : "address",
    location: normalizedLocation,
    options: {
      shape: "rectangle",
      radius: Math.max(30, Number(options.radius) || 120),
      contourInterval: normalizeContourInterval(options.contourInterval),
      terrainMode: options.terrainMode === "flat" ? "flat" : "contour",
      previewOnly: isSelectionPreview,
      buildingPlacement:
        options.buildingPlacement === "embed-lowest" ? "embed-lowest" : "dominant",
      exportFormat: options.exportFormat || "obj",
      includeContours: options.includeContours !== false,
      includeBuildings: options.includeBuildings !== false,
      includeParcelBoundary: options.includeParcelBoundary !== false,
      splitParcelBoundary: options.splitParcelBoundary === true,
      includeRoads: options.includeRoads === true,
    },
    dataSources: {
      parcel: {
        provider: parcelResult.provider,
        mode: parcelResult.isFallback ? "fallback" : "live",
        note: parcelResult.note,
      },
      parcelContext: {
        provider: parcelContextResult.provider,
        mode: parcelContextResult.isFallback ? "fallback" : "live",
        note: parcelContextResult.note,
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
      roads: {
        provider: roadResult.provider,
        mode: roadResult.isFallback ? "fallback" : "live",
        note: roadResult.note,
      },
    },
    stats: {
      parcelAreaSqm: Number((isManualRange ? clipArea : parcelArea).toFixed(2)),
      clipAreaSqm: Number(clipArea.toFixed(2)),
      targetParcelCount: selectedTargetParcelFeatures.length || (isManualRange ? 0 : 1),
      contextParcelCount: parcelContextCount,
      contourCount: contourCollection.features.length,
      contourInterval: normalizeContourInterval(options.contourInterval),
      sourceContourInterval: terrainResult.sourceContourInterval || null,
      minElevation: Number.isFinite(terrainResult.terrainGrid?.minElevation)
        ? terrainResult.terrainGrid.minElevation
        : null,
      maxElevation: Number.isFinite(terrainResult.terrainGrid?.maxElevation)
        ? terrainResult.terrainGrid.maxElevation
        : null,
      buildingCount,
      targetBuildingCount,
      roadCount,
      parcelCenter,
    },
    parcelBoundary: targetParcelFeature,
    targetParcelGroups: featureCollection(selectedTargetParcelFeatures),
    parcelContext: parcelContextResult.collection,
    clipBoundary,
    contourLines: contourCollection,
    terrainGrid: terrainResult.terrainGrid,
    buildings: buildingResult.collection,
    roads: roadResult.collection,
  };

  const effectiveContourBandInterval = resolveEffectiveContourBandInterval(
    siteContext
  );

  siteContext.stats.effectiveContourBandInterval = effectiveContourBandInterval;

  if (
    effectiveContourBandInterval >
    Number(siteContext.options?.contourInterval || effectiveContourBandInterval) +
      1e-9
  ) {
    const relaxationNote = `Dense contour export was relaxed from ${siteContext.options.contourInterval}m to ${effectiveContourBandInterval}m for stability.`;
    siteContext.dataSources.terrain.note = siteContext.dataSources.terrain.note
      ? `${siteContext.dataSources.terrain.note} ${relaxationNote}`
      : relaxationNote;
  }

  const cachedAt = Date.now();
  siteContextCache.set(cacheKey, {
    cachedAt,
    lastAccessedAt: cachedAt,
    value: siteContext,
  });
  pruneCacheEntries(siteContextCache, {
    now: cachedAt,
    maxEntries: SITE_CONTEXT_CACHE_MAX_ENTRIES,
    isExpired: (entry, timestamp) =>
      timestamp - Number(entry?.cachedAt || 0) >= SITE_CONTEXT_CACHE_TTL_MS,
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

function resolveRawTerrainHeightAtLocalPoint(siteContext, xMeters, yMeters, seed) {
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
          return top * (1 - ty) + bottom * ty;
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
      return closestElevation;
    }
  }

  return syntheticHeightAtLocalPoint(xMeters, yMeters, seed);
}

function siteHeightAtLocalPoint(siteContext, xMeters, yMeters, seed) {
  return quantizeTerrainHeight(
    siteContext,
    resolveRawTerrainHeightAtLocalPoint(siteContext, xMeters, yMeters, seed)
  );
}

function collectBuildingFootprintElevationSamples(
  siteContext,
  ring,
  center,
  seed,
  {
    quantized = true,
    includeBoundary = true,
    includeCentroid = true,
    centroidWeight = 2,
    interiorWeight = 1,
    maxInteriorSamples = 196,
  } = {}
) {
  if (!ring.length) {
    return [];
  }

  const localRing = ring
    .map((point) => localMetersFromLngLat(point, center))
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

  if (localRing.length < 3) {
    return [];
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [xMeters, yMeters] of localRing) {
    minX = Math.min(minX, xMeters);
    minY = Math.min(minY, yMeters);
    maxX = Math.max(maxX, xMeters);
    maxY = Math.max(maxY, yMeters);
  }

  const widthMeters = Math.max(0.1, maxX - minX);
  const heightMeters = Math.max(0.1, maxY - minY);
  const terrainStep = Math.max(0.5, Number(siteContext.terrainGrid?.step) || 0.5);
  const budgetStep = Math.sqrt(
    Math.max(0.25, (widthMeters * heightMeters) / Math.max(16, maxInteriorSamples))
  );
  const sampleStep = Math.max(
    0.5,
    Math.min(2, terrainStep, Number(budgetStep.toFixed(3)))
  );
  const samples = [];
  const pushElevation = (xMeters, yMeters, weight = 1) => {
    const rawHeight = resolveRawTerrainHeightAtLocalPoint(
      siteContext,
      xMeters,
      yMeters,
      seed
    );
    const height = quantized
      ? quantizeBuildingPlacementHeight(siteContext, rawHeight)
      : rawHeight;

    if (!Number.isFinite(height)) {
      return;
    }

    for (let index = 0; index < weight; index += 1) {
      samples.push(Number(height.toFixed(3)));
    }
  };

  if (includeBoundary) {
    for (let index = 0; index < localRing.length; index += 1) {
      const point = localRing[index];
      const nextPoint = localRing[(index + 1) % localRing.length];
      pushElevation(point[0], point[1]);
      pushElevation(
        point[0] + (nextPoint[0] - point[0]) * 0.5,
        point[1] + (nextPoint[1] - point[1]) * 0.5
      );
    }
  }

  const centroid = centroidOfRing(ring);

  if (centroid && includeCentroid) {
    const [centroidX, centroidY] = localMetersFromLngLat(centroid, center);
    pushElevation(centroidX, centroidY, centroidWeight);
  }

  let interiorSamples = 0;

  for (
    let yMeters = minY + sampleStep * 0.5;
    yMeters < maxY && interiorSamples < 96;
    yMeters += sampleStep
  ) {
    for (
      let xMeters = minX + sampleStep * 0.5;
      xMeters < maxX && interiorSamples < 96;
      xMeters += sampleStep
    ) {
      if (!pointInRing([xMeters, yMeters], localRing)) {
        continue;
      }

      pushElevation(xMeters, yMeters, interiorWeight);
      interiorSamples += 1;
    }
  }

  return samples;
}

function resolveDominantElevationFromValues(elevations) {
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
    : null;
}

function estimateBuildingDominantTerraceElevationFromSamples(
  siteContext,
  ring,
  center,
  seed
) {
  if (!ring.length || siteContext.options?.terrainMode !== "contour") {
    return null;
  }

  const terrainGrid = siteContext.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return null;
  }

  const localRing = ring
    .map((point) => localMetersFromLngLat(point, center))
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

  if (localRing.length < 3) {
    return null;
  }

  const elevations = [];
  const xValues = terrainGrid.xValues || [];
  const yValues = terrainGrid.yValues || [];

  for (let rowIndex = 0; rowIndex < yValues.length - 1; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < xValues.length - 1; columnIndex += 1) {
      const centerPoint = [
        (xValues[columnIndex] + xValues[columnIndex + 1]) / 2,
        (yValues[rowIndex] + yValues[rowIndex + 1]) / 2,
      ];

      if (!pointInRing(centerPoint, localRing)) {
        continue;
      }

      const cellValues = [
        terrainGrid.elevations[rowIndex]?.[columnIndex],
        terrainGrid.elevations[rowIndex]?.[columnIndex + 1],
        terrainGrid.elevations[rowIndex + 1]?.[columnIndex + 1],
        terrainGrid.elevations[rowIndex + 1]?.[columnIndex],
      ].filter((value) => Number.isFinite(value));

      if (!cellValues.length) {
        continue;
      }

      const averagedCellHeight =
        cellValues.reduce((sum, value) => sum + value, 0) / cellValues.length;
      const elevation = quantizeBuildingPlacementHeight(
        siteContext,
        averagedCellHeight
      );

      if (Number.isFinite(elevation)) {
        elevations.push(Number(elevation.toFixed(3)));
      }
    }
  }

  if (elevations.length) {
    return resolveDominantElevationFromValues(elevations);
  }

  const sampledElevations = collectBuildingFootprintElevationSamples(
    siteContext,
    ring,
    center,
    seed,
    {
      quantized: true,
      includeBoundary: false,
      includeCentroid: true,
      centroidWeight: 2,
      interiorWeight: 1,
      maxInteriorSamples: 256,
    }
  );

  if (sampledElevations.length) {
    return resolveDominantElevationFromValues(sampledElevations);
  }

  const fallbackElevations = collectBuildingFootprintElevationSamples(
    siteContext,
    ring,
    center,
    seed,
    {
      quantized: true,
      includeBoundary: true,
      includeCentroid: true,
      centroidWeight: 3,
      interiorWeight: 1,
      maxInteriorSamples: 64,
    }
  );

  return resolveDominantElevationFromValues(fallbackElevations);
}

function estimateBuildingDominantTerraceElevationFromCellOverlap(
  siteContext,
  ring,
  center
) {
  if (!ring.length || siteContext.options?.terrainMode !== "contour") {
    return null;
  }

  const terrainGrid = siteContext.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return null;
  }

  const localRing = orientLocalPolygonCounterClockwise(
    ring
      .map((point) => localMetersFromLngLat(point, center))
      .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
  );

  if (localRing.length < 3) {
    return null;
  }

  const bounds = computeLocalBoundsFromPoints(localRing);
  const xValues = terrainGrid.xValues || [];
  const yValues = terrainGrid.yValues || [];
  const areaByElevation = new Map();

  if (!bounds || xValues.length < 2 || yValues.length < 2) {
    return null;
  }

  for (let rowIndex = 0; rowIndex < yValues.length - 1; rowIndex += 1) {
    const cellMinY = yValues[rowIndex];
    const cellMaxY = yValues[rowIndex + 1];

    if (cellMaxY <= bounds.minY || cellMinY >= bounds.maxY) {
      continue;
    }

    for (let columnIndex = 0; columnIndex < xValues.length - 1; columnIndex += 1) {
      const cellMinX = xValues[columnIndex];
      const cellMaxX = xValues[columnIndex + 1];

      if (cellMaxX <= bounds.minX || cellMinX >= bounds.maxX) {
        continue;
      }

      const clippedPolygon = clipLocalPolygonToRect(
        localRing,
        cellMinX,
        cellMinY,
        cellMaxX,
        cellMaxY
      );
      const overlapArea = Math.abs(computeLocalPolygonSignedArea(clippedPolygon));

      if (overlapArea <= 1e-4) {
        continue;
      }

      const cellValues = [
        terrainGrid.elevations[rowIndex]?.[columnIndex],
        terrainGrid.elevations[rowIndex]?.[columnIndex + 1],
        terrainGrid.elevations[rowIndex + 1]?.[columnIndex + 1],
        terrainGrid.elevations[rowIndex + 1]?.[columnIndex],
      ].filter((value) => Number.isFinite(value));

      if (!cellValues.length) {
        continue;
      }

      const averagedCellHeight =
        cellValues.reduce((sum, value) => sum + value, 0) / cellValues.length;
      const elevation = quantizeBuildingPlacementHeight(
        siteContext,
        averagedCellHeight
      );

      if (!Number.isFinite(elevation)) {
        continue;
      }

      areaByElevation.set(
        elevation,
        Number(((areaByElevation.get(elevation) || 0) + overlapArea).toFixed(6))
      );
    }
  }

  let dominantElevation = null;
  let dominantArea = 0;

  for (const [elevation, overlapArea] of areaByElevation.entries()) {
    if (
      overlapArea > dominantArea + 1e-6 ||
      (Math.abs(overlapArea - dominantArea) <= 1e-6 &&
        Number.isFinite(dominantElevation) &&
        elevation > dominantElevation)
    ) {
      dominantArea = overlapArea;
      dominantElevation = elevation;
    } else if (!Number.isFinite(dominantElevation)) {
      dominantArea = overlapArea;
      dominantElevation = elevation;
    }
  }

  return Number.isFinite(dominantElevation)
    ? Number(dominantElevation.toFixed(3))
    : null;
}

function estimateBuildingDominantTerraceElevationFromBandOverlap(
  siteContext,
  ring,
  center
) {
  if (!ring.length || siteContext.options?.terrainMode !== "contour") {
    return null;
  }

  const localRing = ring
    .map((point) => localMetersFromLngLat(point, center))
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

  if (localRing.length < 3) {
    return null;
  }

  const buildingRing = buildPolygonClippingRing(
    orientLocalPolygonCounterClockwise(localRing)
  );

  if (!buildingRing) {
    return null;
  }

  const buildingBounds = computeLocalBoundsFromPoints(localRing);
  const buildingMultiPolygon = [[buildingRing]];
  let dominantElevation = null;
  let dominantArea = 0;

  for (const group of getCachedContourBandGroups(siteContext)) {
    if (!group?.multiPolygon?.length || !boundsOverlap(buildingBounds, group.bounds, 0.05)) {
      continue;
    }

    try {
      const overlapMultiPolygon =
        polygonClipping.intersection(group.multiPolygon, buildingMultiPolygon) || [];
      const overlapArea = computeLocalMultiPolygonArea(overlapMultiPolygon);

      if (
        overlapArea > dominantArea + 1e-6 ||
        (Math.abs(overlapArea - dominantArea) <= 1e-6 &&
          Number.isFinite(group.topElevation) &&
          group.topElevation > dominantElevation)
      ) {
        dominantArea = overlapArea;
        dominantElevation = group.topElevation;
      }
    } catch (error) {
      console.warn(
        `[building-terrain] dominant-overlap fallback elevation=${Number(
          group.topElevation || 0
        )} error=${formatErrorForLog(error)}`
      );
      return null;
    }
  }

  return dominantArea > 0 && Number.isFinite(dominantElevation)
    ? Number(dominantElevation.toFixed(3))
    : null;
}

function estimateBuildingDominantTerraceElevation(
  siteContext,
  ring,
  center,
  seed
) {
  return (
    estimateBuildingDominantTerraceElevationFromCellOverlap(
      siteContext,
      ring,
      center
    ) ||
    estimateBuildingDominantTerraceElevationFromSamples(
      siteContext,
      ring,
      center,
      seed
    )
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

  const elevations = collectBuildingFootprintElevationSamples(
    siteContext,
    ring,
    center,
    seed,
    { quantized: true }
  );

  if (!elevations.length) {
    return null;
  }

  return (
    resolveDominantElevationFromValues(elevations) ||
    Number(Math.min(...elevations).toFixed(3))
  );
}

function estimateBuildingLowestElevationFromSamples(
  siteContext,
  ring,
  center,
  seed
) {
  if (!ring.length || siteContext.options?.terrainMode !== "contour") {
    return null;
  }
  const elevations = collectBuildingFootprintElevationSamples(
    siteContext,
    ring,
    center,
    seed,
    { quantized: false }
  );

  if (!elevations.length) {
    return null;
  }

  return Number(Math.min(...elevations).toFixed(3));
}

function getBuildingPlacementCache(siteContext) {
  if (!siteContext) {
    return new Map();
  }

  if (!siteContext.__buildingPlacementCache) {
    Object.defineProperty(siteContext, "__buildingPlacementCache", {
      value: new Map(),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  return siteContext.__buildingPlacementCache;
}

function buildBuildingPlacementCacheKey(siteContext, ring) {
  const placementMode =
    siteContext?.options?.buildingPlacement === "embed-lowest"
      ? "embed-lowest"
      : "dominant";
  const interval = resolveEffectiveContourBandInterval(siteContext);
  const ringKey = (ring || [])
    .map((point) =>
      Array.isArray(point) && point.length >= 2
        ? `${Number(point[0]).toFixed(8)},${Number(point[1]).toFixed(8)}`
        : "invalid"
    )
    .join(";");

  return `${placementMode}|${interval}|${ringKey}`;
}

function resolveBuildingPlacementForRing(siteContext, ring, center, seed) {
  if (!ring.length || siteContext.options?.terrainMode !== "contour") {
    return null;
  }

  const cache = getBuildingPlacementCache(siteContext);
  const cacheKey = buildBuildingPlacementCacheKey(siteContext, ring);

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const placementMode =
    siteContext.options?.buildingPlacement === "embed-lowest"
      ? "embed-lowest"
      : "dominant";
  const overlapDominantElevation = estimateBuildingDominantTerraceElevationFromCellOverlap(
    siteContext,
    ring,
    center
  );
  const sampledDominantElevation = estimateBuildingDominantTerraceElevationFromSamples(
    siteContext,
    ring,
    center,
    seed
  );
  const fallbackDominantElevation = estimateBuildingBaseElevationFromSamples(
    siteContext,
    ring,
    center,
    seed
  );
  const lowestElevation = estimateBuildingLowestElevationFromSamples(
    siteContext,
    ring,
    center,
    seed
  );

  let finalBaseElevation = null;
  let source = "unresolved";

  if (placementMode === "embed-lowest") {
    if (Number.isFinite(lowestElevation)) {
      finalBaseElevation = lowestElevation;
      source = "lowest-sample";
    }
  } else if (Number.isFinite(overlapDominantElevation)) {
    finalBaseElevation = overlapDominantElevation;
    source = "dominant-cell-overlap";
  } else if (Number.isFinite(sampledDominantElevation)) {
    finalBaseElevation = sampledDominantElevation;
    source = "dominant-sample-grid";
  } else if (Number.isFinite(fallbackDominantElevation)) {
    finalBaseElevation = fallbackDominantElevation;
    source = "dominant-sample";
  } else if (Number.isFinite(lowestElevation)) {
    finalBaseElevation = lowestElevation;
    source = "lowest-sample-fallback";
  }

  const placementInfo = {
    placementMode,
    source,
    dominantElevation: Number.isFinite(overlapDominantElevation)
      ? Number(overlapDominantElevation.toFixed(3))
      : null,
    sampledDominantElevation: Number.isFinite(sampledDominantElevation)
      ? Number(sampledDominantElevation.toFixed(3))
      : null,
    fallbackDominantElevation: Number.isFinite(fallbackDominantElevation)
      ? Number(fallbackDominantElevation.toFixed(3))
      : null,
    lowestElevation: Number.isFinite(lowestElevation)
      ? Number(lowestElevation.toFixed(3))
      : null,
    finalBaseElevation: Number.isFinite(finalBaseElevation)
      ? Number(finalBaseElevation.toFixed(3))
      : null,
    effectiveContourInterval: resolveEffectiveContourBandInterval(siteContext),
  };

  cache.set(cacheKey, placementInfo);
  return placementInfo;
}

function applyBuildingPlacementDebug(feature, placementInfo) {
  if (!feature?.properties || !placementInfo) {
    return;
  }

  feature.properties.buildingPlacementDebug = {
    placementMode: placementInfo.placementMode,
    source: placementInfo.source,
    dominantElevation: placementInfo.dominantElevation,
    sampledDominantElevation: placementInfo.sampledDominantElevation,
    fallbackDominantElevation: placementInfo.fallbackDominantElevation,
    lowestElevation: placementInfo.lowestElevation,
    finalBaseElevation: placementInfo.finalBaseElevation,
    effectiveContourInterval: placementInfo.effectiveContourInterval,
  };
}

function buildingBaseElevationForRing(siteContext, ring, center, seed) {
  const placementInfo = resolveBuildingPlacementForRing(
    siteContext,
    ring,
    center,
    seed
  );
  return placementInfo?.finalBaseElevation ?? null;
}

function buildBuildingPlacementDiagnostics(siteContext) {
  if (
    siteContext?.options?.terrainMode !== "contour" ||
    siteContext?.options?.includeBuildings === false
  ) {
    return [];
  }

  const center = siteContext.location;
  const seed = Math.round(
    Math.abs(Number(center?.lat) * 1000) + Math.abs(Number(center?.lng) * 1000)
  );
  const targetFeatures = (siteContext.buildings?.features || []).filter(
    (feature) => feature?.properties?.isTarget
  );
  const sampleFeatures =
    targetFeatures.length > 0
      ? targetFeatures
      : (siteContext.buildings?.features || []).slice(0, 5);

  return sampleFeatures
    .map((feature, index) => {
      const ring = getOpenRing(getOuterRing(feature));
      const placementInfo = resolveBuildingPlacementForRing(
        siteContext,
        ring,
        center,
        seed
      );

      applyBuildingPlacementDebug(feature, placementInfo);

      if (!placementInfo) {
        return null;
      }

      return {
        index,
        isTarget: Boolean(feature?.properties?.isTarget),
        name:
          feature?.properties?.buildingName ||
          feature?.properties?.buildingId ||
          feature?.properties?.roadAddress ||
          "BUILDING",
        placementMode: placementInfo.placementMode,
        source: placementInfo.source,
        dominantElevation: placementInfo.dominantElevation,
        sampledDominantElevation: placementInfo.sampledDominantElevation,
        fallbackDominantElevation: placementInfo.fallbackDominantElevation,
        lowestElevation: placementInfo.lowestElevation,
        finalBaseElevation: placementInfo.finalBaseElevation,
        effectiveContourInterval: placementInfo.effectiveContourInterval,
      };
    })
    .filter(Boolean);
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
    return {
      x: startPoint.x,
      y: startPoint.y,
      elevation: level,
    };
  }

  const ratio = (level - startPoint.elevation) / elevationDifference;

  return {
    x: startPoint.x + (endPoint.x - startPoint.x) * ratio,
    y: startPoint.y + (endPoint.y - startPoint.y) * ratio,
    elevation: level,
  };
}

function clipPolygonByElevation(points, level, keepAbove = true) {
  const clipped = [];

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const currentInside = keepAbove
      ? current.elevation >= level
      : current.elevation <= level;
    const nextInside = keepAbove
      ? next.elevation >= level
      : next.elevation <= level;

    if (currentInside && nextInside) {
      clipped.push(next);
      continue;
    }

    if (currentInside && !nextInside) {
      clipped.push(interpolateTerrainPointAtLevel(current, next, level));
      continue;
    }

    if (!currentInside && nextInside) {
      clipped.push(interpolateTerrainPointAtLevel(current, next, level));
      clipped.push(next);
    }
  }

  return clipped;
}

function clipTriangleToBand(triangle, bottomLevel, topLevel) {
  const aboveBottom = clipPolygonByElevation(triangle, bottomLevel, true);

  if (aboveBottom.length < 3) {
    return [];
  }

  const withinTop = clipPolygonByElevation(aboveBottom, topLevel, false);

  if (withinTop.length < 3) {
    return [];
  }

  return dedupeLocalPolygonPoints(
    withinTop.map((point) => [point.x, point.y])
  );
}

function buildContourBandSlices(siteContext) {
  const terrainGrid = siteContext.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return [];
  }

  const interval = resolveEffectiveContourBandInterval(siteContext);
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
          const polygonPoints = clipTriangleToBand(triangle, level, topElevation);

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

function orientLocalPolygonClockwise(points) {
  const polygon = dedupeLocalPolygonPoints(points);

  if (polygon.length < 3) {
    return polygon;
  }

  return computeLocalPolygonSignedArea(polygon) <= 0
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

function distancePointToLocalSegment(point, segmentStart, segmentEnd) {
  const [px, py] = point || [];
  const [x1, y1] = segmentStart || [];
  const [x2, y2] = segmentEnd || [];

  if (
    !Number.isFinite(px) ||
    !Number.isFinite(py) ||
    !Number.isFinite(x1) ||
    !Number.isFinite(y1) ||
    !Number.isFinite(x2) ||
    !Number.isFinite(y2)
  ) {
    return 0;
  }

  const dx = x2 - x1;
  const dy = y2 - y1;
  const squaredLength = dx * dx + dy * dy;

  if (squaredLength <= 1e-12) {
    return Math.hypot(px - x1, py - y1);
  }

  const ratio = Math.max(
    0,
    Math.min(1, ((px - x1) * dx + (py - y1) * dy) / squaredLength)
  );
  const projectedX = x1 + dx * ratio;
  const projectedY = y1 + dy * ratio;

  return Math.hypot(px - projectedX, py - projectedY);
}

function simplifyLocalPolylineDouglasPeucker(points, toleranceMeters = 0.001) {
  const tolerance = Math.max(0.001, Number(toleranceMeters) || 0);
  const normalized = [];

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
      !normalized.length ||
      !pointsMatchInMeters(
        normalized[normalized.length - 1],
        point,
        Math.max(0.001, tolerance * 0.25)
      )
    ) {
      normalized.push([Number(point[0]), Number(point[1])]);
    }
  }

  if (normalized.length <= 2) {
    return normalized;
  }

  const keep = new Array(normalized.length).fill(false);
  keep[0] = true;
  keep[normalized.length - 1] = true;
  const ranges = [[0, normalized.length - 1]];

  while (ranges.length) {
    const [startIndex, endIndex] = ranges.pop();
    let farthestIndex = -1;
    let farthestDistance = -1;

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = distancePointToLocalSegment(
        normalized[index],
        normalized[startIndex],
        normalized[endIndex]
      );

      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }

    if (farthestIndex !== -1 && farthestDistance > tolerance) {
      keep[farthestIndex] = true;
      ranges.push([startIndex, farthestIndex], [farthestIndex, endIndex]);
    }
  }

  const simplified = normalized.filter((_, index) => keep[index]);
  return simplified.length >= 2 ? simplified : normalized;
}

function simplifyLocalPolygonDouglasPeucker(points, toleranceMeters = 0.001) {
  const polygon = dedupeLocalPolygonPoints(
    points,
    Math.max(0.001, (Number(toleranceMeters) || 0) * 0.2)
  );

  if (polygon.length < 3) {
    return polygon;
  }

  const tolerance = Math.max(0.001, Number(toleranceMeters) || 0);
  let anchorIndex = 0;
  let farthestDistance = -1;
  const centroid = polygon.reduce(
    (accumulator, [xMeters, yMeters]) => {
      accumulator.x += xMeters;
      accumulator.y += yMeters;
      return accumulator;
    },
    { x: 0, y: 0 }
  );
  centroid.x /= polygon.length;
  centroid.y /= polygon.length;

  for (let index = 0; index < polygon.length; index += 1) {
    const point = polygon[index];
    const distance = Math.hypot(point[0] - centroid.x, point[1] - centroid.y);

    if (distance > farthestDistance) {
      farthestDistance = distance;
      anchorIndex = index;
    }
  }

  const rotated = polygon
    .slice(anchorIndex)
    .concat(polygon.slice(0, anchorIndex));
  const simplifiedOpen = simplifyLocalPolylineDouglasPeucker(
    [...rotated, rotated[0]],
    tolerance
  );

  if (
    simplifiedOpen.length >= 2 &&
    pointsMatchInMeters(
      simplifiedOpen[0],
      simplifiedOpen[simplifiedOpen.length - 1],
      Math.max(0.001, tolerance * 0.25)
    )
  ) {
    simplifiedOpen.pop();
  }

  return simplifiedOpen.length >= 3 ? simplifiedOpen : polygon;
}

function smoothLocalPolygonChaikin(
  points,
  {
    iterations = 1,
    ratio = 0.2,
    maxPointCount = 192,
    minSegmentLength = 0.05,
  } = {}
) {
  let polygon = dedupeLocalPolygonPoints(points, 0.001);

  if (polygon.length < 4) {
    return polygon;
  }

  const iterationCount = Math.max(0, Math.min(2, Number(iterations) || 0));
  const cornerRatio = Math.max(0.12, Math.min(0.32, Number(ratio) || 0.2));
  const limit = Math.max(32, Number(maxPointCount) || 192);
  const segmentFloor = Math.max(0.01, Number(minSegmentLength) || 0.05);
  const targetAreaSign = Math.sign(computeLocalPolygonSignedArea(polygon)) || -1;

  for (let iterationIndex = 0; iterationIndex < iterationCount; iterationIndex += 1) {
    if (polygon.length < 4 || polygon.length >= limit) {
      break;
    }

    const smoothed = [];

    for (let index = 0; index < polygon.length; index += 1) {
      const current = polygon[index];
      const next = polygon[(index + 1) % polygon.length];
      const dx = next[0] - current[0];
      const dy = next[1] - current[1];
      const segmentLength = Math.hypot(dx, dy);

      if (segmentLength <= segmentFloor) {
        smoothed.push(current);
        continue;
      }

      smoothed.push([
        Number((current[0] + dx * cornerRatio).toFixed(6)),
        Number((current[1] + dy * cornerRatio).toFixed(6)),
      ]);
      smoothed.push([
        Number((current[0] + dx * (1 - cornerRatio)).toFixed(6)),
        Number((current[1] + dy * (1 - cornerRatio)).toFixed(6)),
      ]);
    }

    polygon = dedupeLocalPolygonPoints(smoothed, 0.001);

    if (polygon.length < 3) {
      return dedupeLocalPolygonPoints(points, 0.001);
    }

    const nextAreaSign = Math.sign(computeLocalPolygonSignedArea(polygon)) || targetAreaSign;

    if (nextAreaSign !== targetAreaSign) {
      polygon = [...polygon].reverse();
    }
  }

  return polygon.length >= 3 ? polygon : dedupeLocalPolygonPoints(points, 0.001);
}

function smoothSketchUpSolidLoop(points, toleranceMeters = 0) {
  const tolerance = Math.max(0, Number(toleranceMeters) || 0);
  const polygon = dedupeLocalPolygonPoints(points, Math.max(0.001, tolerance * 0.12));

  if (polygon.length < 4 || tolerance < 0.28) {
    return polygon;
  }

  const areaBefore = Math.abs(computeLocalPolygonSignedArea(polygon));

  if (!(areaBefore > 0.01)) {
    return polygon;
  }

  const smoothed = smoothLocalPolygonChaikin(polygon, {
    iterations: tolerance >= 0.95 ? 2 : 1,
    ratio: tolerance >= 0.95 ? 0.2 : 0.18,
    maxPointCount: polygon.length >= 80 ? 256 : 192,
    minSegmentLength: Math.max(0.04, tolerance * 0.12),
  });
  const normalized = simplifyLocalPolygon(
    smoothed,
    Math.max(0.01, tolerance * 0.08)
  );
  const areaAfter = Math.abs(computeLocalPolygonSignedArea(normalized));

  if (
    normalized.length < 3 ||
    areaAfter <= areaBefore * 0.7 ||
    areaAfter >= areaBefore * 1.05
  ) {
    return polygon;
  }

  return normalized;
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

function computeLocalPolygonBounds(points) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points || []) {
    const xMeters = Number(point?.[0]);
    const yMeters = Number(point?.[1]);

    if (!Number.isFinite(xMeters) || !Number.isFinite(yMeters)) {
      continue;
    }

    minX = Math.min(minX, xMeters);
    minY = Math.min(minY, yMeters);
    maxX = Math.max(maxX, xMeters);
    maxY = Math.max(maxY, yMeters);
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
  };
}

function getContourBandSliceBounds(slice) {
  if (slice?.bounds) {
    return slice.bounds;
  }

  const bounds = computeLocalPolygonBounds(slice?.points || []);

  if (slice && bounds) {
    slice.bounds = bounds;
  }

  return bounds;
}

function partitionContourBandSlices(
  slices,
  interval = 1,
  maxBucketSize = CONTOUR_BAND_UNION_MAX_SLICES
) {
  const validSlices = (slices || []).filter((slice) => slice?.points?.length >= 3);

  if (validSlices.length <= maxBucketSize) {
    return [validSlices];
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const slice of validSlices) {
    const bounds = getContourBandSliceBounds(slice);

    if (!bounds) {
      continue;
    }

    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return [validSlices];
  }

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const targetBucketCount = Math.max(
    2,
    Math.ceil(validSlices.length / Math.max(1, maxBucketSize))
  );
  const gridDimension = Math.max(2, Math.ceil(Math.sqrt(targetBucketCount)));
  const tileWidth = Math.max(interval * 12, spanX / gridDimension);
  const tileHeight = Math.max(interval * 12, spanY / gridDimension);
  const buckets = new Map();

  for (const slice of validSlices) {
    const bounds = getContourBandSliceBounds(slice);

    if (!bounds) {
      continue;
    }

    const centerX = (bounds.minX + bounds.maxX) * 0.5;
    const centerY = (bounds.minY + bounds.maxY) * 0.5;
    const tileX = Math.max(
      0,
      Math.min(gridDimension - 1, Math.floor((centerX - minX) / tileWidth))
    );
    const tileY = Math.max(
      0,
      Math.min(gridDimension - 1, Math.floor((centerY - minY) / tileHeight))
    );
    const bucketKey = `${tileX}|${tileY}`;

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, []);
    }

    buckets.get(bucketKey).push(slice);
  }

  const partitioned = [...buckets.values()].filter((bucket) => bucket.length);

  return partitioned.length ? partitioned : [validSlices];
}

function buildContourBandBoundaryLoopsFromSlices(slices, interval = 1) {
  const precision =
    interval <= 0.1 ? 2 : interval <= 0.5 ? 2 : interval <= 1 ? 3 : 3;
  return mergeBandSlicePolygons(
    slices.map((slice) => slice.points).filter((points) => points?.length >= 3),
    precision
  )
    .map((ring) => simplifyLocalPolygon(ring, Math.max(0.01, interval * 0.05)))
    .filter((ring) => ring.length >= 3);
}

function buildContourBandRegionsFromMultiPolygon(multiPolygon) {
  const regions = [];

  for (const polygon of multiPolygon || []) {
    if (!Array.isArray(polygon) || !polygon.length) {
      continue;
    }

    const outerPoints = simplifyLocalPolygon(
      orientLocalPolygonCounterClockwise(polygon[0] || []),
      0.01
    );

    if (outerPoints.length < 3) {
      continue;
    }

    const holePoints = (polygon.slice(1) || [])
      .map((ring) =>
        simplifyLocalPolygon(
          [...orientLocalPolygonCounterClockwise(ring || [])].reverse(),
          0.01
        )
      )
      .filter((ring) => ring.length >= 3);

    regions.push({
      outerPoints,
      holePoints,
    });
  }

  return regions;
}

function buildContourBandRegionsForSlicesInternal(slices, interval = 1, depth = 0) {
  const multiPolygon = [];

  for (const slice of slices || []) {
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

  if (multiPolygon.length > CONTOUR_BAND_UNION_MAX_SLICES) {
    const partitionedBuckets =
      depth < 3 ? partitionContourBandSlices(slices, interval) : [];

    if (
      partitionedBuckets.length > 1 &&
      partitionedBuckets.length < multiPolygon.length
    ) {
      console.warn(
        `[terrain-union] partitioned dense slices=${multiPolygon.length} buckets=${partitionedBuckets.length} interval=${Number(
          interval || 0
        )} depth=${depth + 1}`
      );
      const partitionedRegions = partitionedBuckets.flatMap((bucket) =>
        buildContourBandRegionsForSlicesInternal(bucket, interval, depth + 1)
      );

      if (partitionedRegions.length) {
        return partitionedRegions;
      }
    }

    console.warn(
      `[terrain-union] dense-slice boundary merge slices=${multiPolygon.length} interval=${Number(
        interval || 0
      )}`
    );
    const fallbackLoops = buildContourBandBoundaryLoopsFromSlices(
      slices,
      interval
    );
    return buildContourBandRegions(fallbackLoops, slices);
  }

  try {
    const unionResult = polygonClipping.union(multiPolygon) || [];
    const regions = buildContourBandRegionsFromMultiPolygon(unionResult);

    if (regions.length) {
      return regions;
    }
  } catch (error) {
    console.warn(
      `[terrain-union] polygon union fallback slices=${multiPolygon.length} error=${formatErrorForLog(
        error
      )}`
    );
  }

  const fallbackLoops = buildContourBandBoundaryLoopsFromSlices(slices, interval);
  return buildContourBandRegions(fallbackLoops, slices);
}

function buildContourBandRegionsForSlices(slices, interval = 1) {
  return buildContourBandRegionsForSlicesInternal(slices, interval, 0);
}

function buildContourBandUnionLoopsInternal(slices, interval = 1, depth = 0) {
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

  if (multiPolygon.length > CONTOUR_BAND_UNION_MAX_SLICES) {
    const partitionedBuckets =
      depth < 3 ? partitionContourBandSlices(slices, interval) : [];

    if (
      partitionedBuckets.length > 1 &&
      partitionedBuckets.length < multiPolygon.length
    ) {
      console.warn(
        `[terrain-union] partitioned loop slices=${multiPolygon.length} buckets=${partitionedBuckets.length} interval=${Number(
          interval || 0
        )} depth=${depth + 1}`
      );
      const partitionedLoops = partitionedBuckets.flatMap((bucket) =>
        buildContourBandUnionLoopsInternal(bucket, interval, depth + 1)
      );

      if (partitionedLoops.length) {
        return partitionedLoops;
      }
    }

    console.warn(
      `[terrain-union] dense-slice boundary merge slices=${multiPolygon.length} interval=${Number(
        interval || 0
      )}`
    );
    return buildContourBandBoundaryLoopsFromSlices(slices, interval);
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
    return buildContourBandBoundaryLoopsFromSlices(slices, interval);
  }
}

function buildContourBandUnionLoops(slices, interval = 1) {
  return buildContourBandUnionLoopsInternal(slices, interval, 0);
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
    const interval = Math.max(
      MIN_CONTOUR_INTERVAL_METERS,
      Number((topElevation - bottomElevation).toFixed(3))
    );
    const regions = buildContourBandRegionsForSlices(slices, interval);
    const multiPolygon = buildPolygonClippingMultiPolygonFromRegions(regions);
    const bounds = computeRegionBounds(regions);
    const boundaryLoops = regions.flatMap((region) => [
      region.outerPoints,
      ...(region.holePoints || []),
    ]);

    if (!regions.length) {
      console.warn(
        `[terrain-band] skipped empty band bottom=${bottomElevation} top=${topElevation} slices=${slices.length}`
      );
      continue;
    }

    bandGroups.push({
      bottomElevation,
      topElevation,
      boundaryLoops,
      regions,
      multiPolygon,
      bounds,
    });
  }

  return bandGroups;
}

function getCachedContourBandGroups(siteContext) {
  if (!siteContext || typeof siteContext !== "object") {
    return buildContourBandGroups(siteContext);
  }

  const cacheKey = getContourBandCacheKey(siteContext);
  const sharedCachedBandGroups = readSharedDerivedCache(
    sharedContourBandGroupCache,
    cacheKey
  );

  if (sharedCachedBandGroups) {
    return sharedCachedBandGroups;
  }

  const owner = resolveContourCacheOwner(siteContext);
  const entry = getOrCreateWeakMapEntry(contourBandGroupCache, owner);

  if (entry instanceof Map && entry.has(cacheKey)) {
    return entry.get(cacheKey);
  }

  const bandGroups = buildContourBandGroups(siteContext).sort(
    (left, right) =>
      left.bottomElevation - right.bottomElevation ||
      left.topElevation - right.topElevation
  );

  if (entry instanceof Map) {
    entry.set(cacheKey, bandGroups);
  }
  writeSharedDerivedCache(sharedContourBandGroupCache, cacheKey, bandGroups);

  return bandGroups;
}

function buildCumulativeContourBandGroups(siteContext) {
  const bandGroups = getCachedContourBandGroups(siteContext);

  if (!bandGroups.length) {
    return [];
  }

  const cumulativeDescending = [];
  let cumulativeMultiPolygon = [];

  for (let index = bandGroups.length - 1; index >= 0; index -= 1) {
    const group = bandGroups[index];
    const groupMultiPolygon = buildPolygonClippingMultiPolygonFromRegions(
      group.regions
    );

    if (!groupMultiPolygon.length) {
      continue;
    }

    let nextMultiPolygon = groupMultiPolygon;

    if (cumulativeMultiPolygon.length) {
      try {
        nextMultiPolygon =
          polygonClipping.union(groupMultiPolygon, cumulativeMultiPolygon) || [];
      } catch (error) {
        console.warn(
          `[terrain-band] cumulative union fallback elevation=${group.topElevation} error=${formatErrorForLog(
            error
          )}`
        );
        nextMultiPolygon = [...groupMultiPolygon, ...cumulativeMultiPolygon];
      }
    }

    const regions = stripRegionHoles(
      buildContourBandRegionsFromMultiPolygon(nextMultiPolygon)
    );

    if (!regions.length) {
      cumulativeMultiPolygon = nextMultiPolygon;
      continue;
    }

    cumulativeDescending.push({
      ...group,
      boundaryLoops: regions.flatMap((region) => [
        region.outerPoints,
        ...(region.holePoints || []),
      ]),
      regions,
      multiPolygon: nextMultiPolygon,
    });
    cumulativeMultiPolygon = nextMultiPolygon;
  }

  return cumulativeDescending.reverse();
}

function getCachedCumulativeContourBandGroups(siteContext) {
  if (!siteContext || typeof siteContext !== "object") {
    return buildCumulativeContourBandGroups(siteContext);
  }

  const cacheKey = getContourBandCacheKey(siteContext);
  const sharedCachedBandGroups = readSharedDerivedCache(
    sharedContourCumulativeBandGroupCache,
    cacheKey
  );

  if (sharedCachedBandGroups) {
    return sharedCachedBandGroups;
  }

  const owner = resolveContourCacheOwner(siteContext);
  const entry = getOrCreateWeakMapEntry(contourCumulativeBandGroupCache, owner);

  if (entry instanceof Map && entry.has(cacheKey)) {
    return entry.get(cacheKey);
  }

  const bandGroups = buildCumulativeContourBandGroups(siteContext).sort(
    (left, right) =>
      left.bottomElevation - right.bottomElevation ||
      left.topElevation - right.topElevation
  );

  if (entry instanceof Map) {
    entry.set(cacheKey, bandGroups);
  }
  writeSharedDerivedCache(
    sharedContourCumulativeBandGroupCache,
    cacheKey,
    bandGroups
  );

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

function stripRegionHoles(regions) {
  return (regions || [])
    .map((region) => ({
      outerPoints: orientLocalPolygonCounterClockwise(region?.outerPoints || []),
      holePoints: [],
    }))
    .filter((region) => region.outerPoints.length >= 3);
}

function buildBuildingFootprintMultiPolygon(siteContext) {
  if (siteContext.options?.includeBuildings === false) {
    return [];
  }

  const center = siteContext.location;
  const multiPolygon = [];

  for (const feature of siteContext.buildings?.features || []) {
    const ring = getOpenRing(getOuterRing(feature));

    if (ring.length < 3) {
      continue;
    }

    const localRing = ring
      .map((point) => localMetersFromLngLat(point, center))
      .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    const polygonRing = buildPolygonClippingRing(
      orientLocalPolygonCounterClockwise(localRing)
    );

    if (polygonRing) {
      multiPolygon.push([polygonRing]);
    }
  }

  if (!multiPolygon.length) {
    return [];
  }

  try {
    return polygonClipping.union(multiPolygon) || [];
  } catch (error) {
    console.warn(
      `[building-terrain] footprint union fallback error=${formatErrorForLog(
        error
      )}`
    );
    return multiPolygon;
  }
}

function buildBuildingFootprintCarveProfiles(siteContext) {
  if (siteContext.options?.includeBuildings === false) {
    return [];
  }

  const center = siteContext.location;
  const seed = Math.round(
    Math.abs(Number(center?.lat) * 1000) + Math.abs(Number(center?.lng) * 1000)
  );
  const profiles = [];

  for (const feature of siteContext.buildings?.features || []) {
    const ring = getOpenRing(getOuterRing(feature));

    if (ring.length < 3) {
      continue;
    }

    const localRing = ring
      .map((point) => localMetersFromLngLat(point, center))
      .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    const polygonRing = buildPolygonClippingRing(
      orientLocalPolygonCounterClockwise(localRing)
    );

    if (!polygonRing) {
      continue;
    }

    const placementInfo = resolveBuildingPlacementForRing(
      siteContext,
      ring,
      center,
      seed
    );
    const baseElevation = placementInfo?.finalBaseElevation ?? null;

    profiles.push({
      baseElevation: Number.isFinite(baseElevation) ? Number(baseElevation) : null,
      polygon: [polygonRing],
    });
  }

  return profiles;
}

function buildRenderableContourBandGroups(siteContext) {
  const cumulativeGroups = getCachedCumulativeContourBandGroups(siteContext);

  if (
    siteContext.options?.buildingPlacement !== "embed-lowest" ||
    !cumulativeGroups.length
  ) {
    return cumulativeGroups;
  }

  const buildingCarveProfiles = buildBuildingFootprintCarveProfiles(siteContext);

  if (!buildingCarveProfiles.length) {
    return cumulativeGroups;
  }

  const renderableGroups = [];

  for (const group of cumulativeGroups) {
    const groupMultiPolygon =
      group.multiPolygon || buildPolygonClippingMultiPolygonFromRegions(group.regions);
    let carvedMultiPolygon = groupMultiPolygon;
    const activeBuildingFootprints = buildingCarveProfiles
      .filter(
        (profile) =>
          !Number.isFinite(profile.baseElevation) ||
          group.topElevation > profile.baseElevation + 1e-9
      )
      .map((profile) => profile.polygon);

    if (groupMultiPolygon.length && activeBuildingFootprints.length) {
      try {
        carvedMultiPolygon =
          polygonClipping.difference(groupMultiPolygon, activeBuildingFootprints) || [];
      } catch (error) {
        console.warn(
          `[building-terrain] terrain carve fallback elevation=${group.topElevation} error=${formatErrorForLog(
            error
          )}`
        );
      }
    }

    const regions = buildContourBandRegionsFromMultiPolygon(carvedMultiPolygon);

    if (!regions.length) {
      continue;
    }

    renderableGroups.push({
      ...group,
      boundaryLoops: regions.flatMap((region) => [
        region.outerPoints,
        ...(region.holePoints || []),
      ]),
      regions,
      multiPolygon: carvedMultiPolygon,
    });
  }

  return renderableGroups;
}

function getCachedRenderableContourBandGroups(siteContext) {
  if (!siteContext || typeof siteContext !== "object") {
    return buildRenderableContourBandGroups(siteContext);
  }

  const cacheKey = `${getContourBandCacheKey(siteContext)}|${
    siteContext.options?.buildingPlacement === "embed-lowest"
      ? "embed-lowest"
      : "dominant"
  }|${siteContext.options?.includeBuildings !== false ? "with-bldg" : "no-bldg"}`;
  const owner = resolveRenderableContourCacheOwner(siteContext);
  const entry = getOrCreateWeakMapEntry(contourRenderableBandGroupCache, owner);

  if (entry instanceof Map && entry.has(cacheKey)) {
    return entry.get(cacheKey);
  }

  const bandGroups = buildRenderableContourBandGroups(siteContext);

  if (entry instanceof Map) {
    entry.set(cacheKey, bandGroups);
  }

  return bandGroups;
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

function computeLocalBoundsFromPoints(points) {
  if (!Array.isArray(points) || !points.length) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    ) {
      continue;
    }

    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

function clipLocalPolygonAgainstBoundary(points, isInside, intersect) {
  if (!Array.isArray(points) || points.length < 3) {
    return [];
  }

  const clipped = [];
  let previousPoint = points[points.length - 1];
  let previousInside = isInside(previousPoint);

  for (const currentPoint of points) {
    const currentInside = isInside(currentPoint);

    if (currentInside) {
      if (!previousInside) {
        clipped.push(intersect(previousPoint, currentPoint));
      }
      clipped.push(currentPoint);
    } else if (previousInside) {
      clipped.push(intersect(previousPoint, currentPoint));
    }

    previousPoint = currentPoint;
    previousInside = currentInside;
  }

  return clipped;
}

function interpolateLocalSegmentPoint(startPoint, endPoint, t) {
  const safeT = Number.isFinite(t) ? t : 0;
  return [
    Number((startPoint[0] + (endPoint[0] - startPoint[0]) * safeT).toFixed(6)),
    Number((startPoint[1] + (endPoint[1] - startPoint[1]) * safeT).toFixed(6)),
  ];
}

function clipLocalPolygonToRect(points, minX, minY, maxX, maxY) {
  let polygon = dedupeLocalPolygonPoints(points, 0.0001);

  if (polygon.length < 3) {
    return [];
  }

  polygon = clipLocalPolygonAgainstBoundary(
    polygon,
    (point) => point[0] >= minX - 1e-9,
    (startPoint, endPoint) => {
      const dx = endPoint[0] - startPoint[0];
      const t = Math.abs(dx) <= 1e-9 ? 0 : (minX - startPoint[0]) / dx;
      return interpolateLocalSegmentPoint(startPoint, endPoint, t);
    }
  );
  polygon = clipLocalPolygonAgainstBoundary(
    polygon,
    (point) => point[0] <= maxX + 1e-9,
    (startPoint, endPoint) => {
      const dx = endPoint[0] - startPoint[0];
      const t = Math.abs(dx) <= 1e-9 ? 0 : (maxX - startPoint[0]) / dx;
      return interpolateLocalSegmentPoint(startPoint, endPoint, t);
    }
  );
  polygon = clipLocalPolygonAgainstBoundary(
    polygon,
    (point) => point[1] >= minY - 1e-9,
    (startPoint, endPoint) => {
      const dy = endPoint[1] - startPoint[1];
      const t = Math.abs(dy) <= 1e-9 ? 0 : (minY - startPoint[1]) / dy;
      return interpolateLocalSegmentPoint(startPoint, endPoint, t);
    }
  );
  polygon = clipLocalPolygonAgainstBoundary(
    polygon,
    (point) => point[1] <= maxY + 1e-9,
    (startPoint, endPoint) => {
      const dy = endPoint[1] - startPoint[1];
      const t = Math.abs(dy) <= 1e-9 ? 0 : (maxY - startPoint[1]) / dy;
      return interpolateLocalSegmentPoint(startPoint, endPoint, t);
    }
  );

  return dedupeLocalPolygonPoints(polygon, 0.0001);
}

function computeRegionBounds(regions) {
  let bounds = null;

  for (const region of regions || []) {
    const regionBounds = computeLocalBoundsFromPoints([
      ...(region.outerPoints || []),
      ...((region.holePoints || []).flatMap((ring) => ring || [])),
    ]);

    if (!regionBounds) {
      continue;
    }

    if (!bounds) {
      bounds = { ...regionBounds };
      continue;
    }

    bounds.minX = Math.min(bounds.minX, regionBounds.minX);
    bounds.minY = Math.min(bounds.minY, regionBounds.minY);
    bounds.maxX = Math.max(bounds.maxX, regionBounds.maxX);
    bounds.maxY = Math.max(bounds.maxY, regionBounds.maxY);
  }

  return bounds;
}

function boundsOverlap(left, right, toleranceMeters = 0) {
  if (!left || !right) {
    return false;
  }

  return !(
    left.maxX < right.minX - toleranceMeters ||
    right.maxX < left.minX - toleranceMeters ||
    left.maxY < right.minY - toleranceMeters ||
    right.maxY < left.minY - toleranceMeters
  );
}

function buildContourTopSurfaceGroups(siteContext) {
  const bandGroups = getCachedContourBandGroups(siteContext);

  if (!bandGroups.length) {
    return [];
  }

  const cumulativeGroups = bandGroups
    .map((group) => ({
      ...group,
      multiPolygon:
        group.multiPolygon || buildPolygonClippingMultiPolygonFromRegions(group.regions),
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

  const cacheKey = getContourBandCacheKey(siteContext);
  const owner = resolveContourCacheOwner(siteContext);
  const entry = getOrCreateWeakMapEntry(contourTopSurfaceCache, owner);

  if (entry instanceof Map && entry.has(cacheKey)) {
    return entry.get(cacheKey);
  }

  const topSurfaceGroups = buildContourTopSurfaceGroups(siteContext);

  if (entry instanceof Map) {
    entry.set(cacheKey, topSurfaceGroups);
  }

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

function resolveContourTerrainRenderPlan(siteContext) {
  const terrainGrid = siteContext?.terrainGrid;

  if (!terrainGrid?.elevations?.length) {
    return null;
  }

  const interval = resolveEffectiveContourBandInterval(siteContext);
  const baseElevation = getTerrainBaseElevation(
    siteContext,
    terrainGrid.minElevation
  );
  const clipPolygon = getOpenRing(getOuterRing(siteContext.clipBoundary)).map((point) =>
    localMetersFromLngLat(point, siteContext.location)
  );
  const minBandElevation =
    Math.floor(Number(terrainGrid.minElevation || 0) / interval) * interval;
  const bandGroups = getCachedRenderableContourBandGroups(siteContext);
  const quantizedTopElevation = quantizeTerrainHeight(
    siteContext,
    Number.isFinite(terrainGrid.maxElevation)
      ? terrainGrid.maxElevation
      : terrainGrid.minElevation
  );
  const flatTopElevation = Number(
    Math.max(minBandElevation, quantizedTopElevation || minBandElevation).toFixed(3)
  );
  const useFlatFallback =
    clipPolygon.length >= 3 &&
    bandGroups.length === 0 &&
    flatTopElevation > baseElevation + 0.001;

  return {
    terrainGrid,
    interval,
    baseElevation,
    clipPolygon,
    minBandElevation,
    bandGroups,
    flatTopElevation,
    useFlatFallback,
  };
}

function shouldSplitTerrainAlongParcelBoundary(siteContext) {
  return Boolean(
    siteContext?.options?.splitParcelBoundary === true &&
      siteContext?.selectionMode !== "range" &&
      getTargetParcelGroupFeatures(siteContext).some(
        (feature) => getOpenRing(getOuterRing(feature)).length >= 3
      )
  );
}

function shouldGroupParcelCutContent(siteContext) {
  return shouldSplitTerrainAlongParcelBoundary(siteContext);
}

function isLineMostlyInsideParcelFeature(lineString, parcelFeature) {
  if (!Array.isArray(lineString) || lineString.length < 2 || !parcelFeature) {
    return false;
  }

  let insideCount = 0;

  for (const point of lineString) {
    if (isPointInsideFeature(point, parcelFeature)) {
      insideCount += 1;
    }
  }

  return insideCount > 0 && insideCount >= Math.ceil(lineString.length / 2);
}

function buildLocalMultiPolygonFromOpenRing(points) {
  const polygonRing = buildPolygonClippingRing(
    orientLocalPolygonCounterClockwise(points || [])
  );

  return polygonRing ? [[polygonRing]] : [];
}

function splitTerrainMultiPolygonByParcelBoundary(siteContext, multiPolygon) {
  const sourceMultiPolygon = Array.isArray(multiPolygon) ? multiPolygon : [];
  const fallbackRegions = buildContourBandRegionsFromMultiPolygon(sourceMultiPolygon);

  if (
    !sourceMultiPolygon.length ||
    !shouldSplitTerrainAlongParcelBoundary(siteContext)
  ) {
    return [
      {
        kind: "combined",
        multiPolygon: sourceMultiPolygon,
        regions: fallbackRegions,
      },
    ];
  }

  const targetParcelGroups = getTargetParcelGroupFeatures(siteContext)
    .map((feature, index) => {
      const parcelRing = getOpenRing(getOuterRing(feature)).map((point) =>
        localMetersFromLngLat(point, siteContext.location)
      );
      const parcelMultiPolygon = buildLocalMultiPolygonFromOpenRing(parcelRing);

      return parcelMultiPolygon.length
        ? {
            feature,
            groupIndex: Number(feature?.properties?.groupIndex || index + 1),
            groupId:
              String(feature?.properties?.groupId || "").trim() ||
              buildParcelSelectionKey(feature, index),
            groupName: buildParcelGroupExportName(feature, index),
            parcelMultiPolygon,
          }
        : null;
    })
    .filter(Boolean);

  if (!targetParcelGroups.length) {
    return [
      {
        kind: "combined",
        multiPolygon: sourceMultiPolygon,
        regions: fallbackRegions,
      },
    ];
  }

  let contextMultiPolygon = sourceMultiPolygon;
  const segments = [];

  for (const targetGroup of targetParcelGroups) {
    let parcelSegmentMultiPolygon = [];

    try {
      parcelSegmentMultiPolygon =
        polygonClipping.intersection(
          contextMultiPolygon,
          targetGroup.parcelMultiPolygon
        ) || [];
    } catch (error) {
      console.warn(
        `[terrain-split] parcel intersection fallback error=${formatErrorForLog(
          error
        )}`
      );
    }

    try {
      contextMultiPolygon =
        polygonClipping.difference(
          contextMultiPolygon,
          targetGroup.parcelMultiPolygon
        ) || [];
    } catch (error) {
      console.warn(
        `[terrain-split] parcel difference fallback error=${formatErrorForLog(
          error
        )}`
      );
    }

    if (!parcelSegmentMultiPolygon.length) {
      continue;
    }

    const regions = buildContourBandRegionsFromMultiPolygon(
      parcelSegmentMultiPolygon
    );

    if (regions.length) {
      segments.push({
        kind: "parcel",
        groupIndex: targetGroup.groupIndex,
        groupId: targetGroup.groupId,
        groupName: targetGroup.groupName,
        multiPolygon: parcelSegmentMultiPolygon,
        regions,
      });
    }
  }

  if (contextMultiPolygon.length) {
    const regions = buildContourBandRegionsFromMultiPolygon(contextMultiPolygon);

    if (regions.length) {
      segments.push({
        kind: "context",
        multiPolygon: contextMultiPolygon,
        regions,
      });
    }
  }

  return segments.length
    ? segments
    : [
        {
          kind: "combined",
          multiPolygon: sourceMultiPolygon,
          regions: fallbackRegions,
        },
      ];
}

function appendContourBandTerrainObjGeometry(lines, siteContext, vertexIndex) {
  const terrainPlan = resolveContourTerrainRenderPlan(siteContext);

  if (!terrainPlan) {
    return vertexIndex;
  }

  const {
    baseElevation,
    clipPolygon,
    minBandElevation,
    bandGroups,
    flatTopElevation,
    useFlatFallback,
  } = terrainPlan;

  if (useFlatFallback) {
    lines.push("o TERRAIN_CONTOUR_FLAT");
    return appendObjPrismFromPolygon(
      lines,
      clipPolygon,
      flatTopElevation,
      baseElevation,
      vertexIndex
    );
  }

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
    const effectiveBottomElevation = Number(
      Math.max(baseElevation, group.bottomElevation - TERRAIN_BAND_OVERLAP_METERS).toFixed(3)
    );

    for (
      let regionIndex = 0;
      regionIndex < group.regions.length;
      regionIndex += 1
    ) {
      vertexIndex = appendObjContourBandRegionSolid(
        lines,
        group.regions[regionIndex],
        group.topElevation,
        effectiveBottomElevation,
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
  const placementInfo = resolveBuildingPlacementForRing(
    siteContext,
    ring,
    center,
    seed
  );
  applyBuildingPlacementDebug(feature, placementInfo);
  const buildingBaseElevation = placementInfo?.finalBaseElevation ?? null;
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

function resolveRoadWidthMeters(feature) {
  const sourceLayer = String(feature?.properties?.sourceLayer || "")
    .trim()
    .toLowerCase();
  const baseWidth = Number(
    feature?.properties?.widthMeters || DEFAULT_ROAD_WIDTH_METERS
  );

  if (sourceLayer === "lt_l_sprd") {
    return Math.max(8, Number.isFinite(baseWidth) ? baseWidth * 1.9 : 12);
  }

  return Math.max(2, baseWidth);
}

function resolveRoadProjectionSegmentLength(siteContext, widthMeters) {
  const terrainStep = Number(siteContext?.terrainGrid?.step || 0);
  const preferredStep =
    Number.isFinite(terrainStep) && terrainStep > 0
      ? terrainStep * 2
      : Math.max(2, Number(widthMeters || DEFAULT_ROAD_WIDTH_METERS) * 0.5);

  return Math.max(
    1.5,
    Math.min(
      ROAD_SURFACE_MAX_SEGMENT_METERS,
      Number(preferredStep.toFixed(3))
    )
  );
}

function sampleRoadSegmentLocalPoints(startPoint, endPoint, siteContext, widthMeters) {
  const dx = endPoint[0] - startPoint[0];
  const dy = endPoint[1] - startPoint[1];
  const length = Math.hypot(dx, dy);

  if (!Number.isFinite(length) || length < 0.5) {
    return [];
  }

  const maxSegmentLength = resolveRoadProjectionSegmentLength(
    siteContext,
    widthMeters
  );
  const segmentCount = Math.max(1, Math.ceil(length / maxSegmentLength));
  const points = [];

  for (let index = 0; index <= segmentCount; index += 1) {
    const t = index / segmentCount;
    points.push([
      startPoint[0] + dx * t,
      startPoint[1] + dy * t,
    ]);
  }

  return points;
}

function buildRoadSegmentLocalQuad(
  startPoint,
  endPoint,
  widthMeters,
  minimumLengthMeters = 0.5
) {
  const dx = endPoint[0] - startPoint[0];
  const dy = endPoint[1] - startPoint[1];
  const length = Math.hypot(dx, dy);

  if (!Number.isFinite(length) || length < minimumLengthMeters) {
    return null;
  }

  const halfWidth = Math.max(1, widthMeters / 2);
  const offsetX = (-dy / length) * halfWidth;
  const offsetY = (dx / length) * halfWidth;

  return [
    [startPoint[0] + offsetX, startPoint[1] + offsetY],
    [endPoint[0] + offsetX, endPoint[1] + offsetY],
    [endPoint[0] - offsetX, endPoint[1] - offsetY],
    [startPoint[0] - offsetX, startPoint[1] - offsetY],
  ];
}

function buildRoadFeatureFootprintMultiPolygon(feature, center) {
  const multiPolygon = [];
  const widthMeters = resolveRoadWidthMeters(feature);

  if (
    feature?.geometry?.type === "Polygon" ||
    feature?.geometry?.type === "MultiPolygon"
  ) {
    for (const ring of getOuterRings(feature)) {
      const localRing = ring.map((point) => localMetersFromLngLat(point, center));
      const polygonRing = buildPolygonClippingRing(
        orientLocalPolygonCounterClockwise(localRing)
      );

      if (polygonRing) {
        multiPolygon.push([polygonRing]);
      }
    }

    return multiPolygon;
  }

  for (const lineString of getLineStringsFromGeometry(feature.geometry)) {
    for (let index = 0; index < lineString.length - 1; index += 1) {
      const startPoint = localMetersFromLngLat(lineString[index], center);
      const endPoint = localMetersFromLngLat(lineString[index + 1], center);
      const quad = buildRoadSegmentLocalQuad(startPoint, endPoint, widthMeters);

      if (!quad) {
        continue;
      }

      const polygonRing = buildPolygonClippingRing(
        orientLocalPolygonCounterClockwise(quad)
      );

      if (polygonRing) {
        multiPolygon.push([polygonRing]);
      }
    }
  }

  return multiPolygon;
}

function findClosestPolygonVertexPair(leftPolygon, rightPolygon, maxGapMeters) {
  const leftRing = Array.isArray(leftPolygon?.[0]) ? leftPolygon[0] : [];
  const rightRing = Array.isArray(rightPolygon?.[0]) ? rightPolygon[0] : [];

  if (!leftRing.length || !rightRing.length) {
    return null;
  }

  const maxGapSquared =
    Number.isFinite(maxGapMeters) && maxGapMeters > 0
      ? maxGapMeters * maxGapMeters
      : Number.POSITIVE_INFINITY;
  let best = null;

  for (const leftPoint of leftRing) {
    const leftX = Number(leftPoint?.[0]);
    const leftY = Number(leftPoint?.[1]);

    if (!Number.isFinite(leftX) || !Number.isFinite(leftY)) {
      continue;
    }

    for (const rightPoint of rightRing) {
      const rightX = Number(rightPoint?.[0]);
      const rightY = Number(rightPoint?.[1]);

      if (!Number.isFinite(rightX) || !Number.isFinite(rightY)) {
        continue;
      }

      const distanceSquared =
        (leftX - rightX) * (leftX - rightX) +
        (leftY - rightY) * (leftY - rightY);

      if (distanceSquared > maxGapSquared) {
        continue;
      }

      if (!best || distanceSquared < best.distanceSquared) {
        best = {
          leftPoint: [leftX, leftY],
          rightPoint: [rightX, rightY],
          distanceSquared,
        };
      }
    }
  }

  return best
    ? {
        ...best,
        distance: Math.sqrt(best.distanceSquared),
      }
    : null;
}

function mergeNearbyRoadSurfacePolygons(
  multiPolygon,
  gapMeters = ROAD_SURFACE_NEAR_MERGE_GAP_METERS
) {
  const polygons = (multiPolygon || []).filter(
    (polygon) => Array.isArray(polygon?.[0]) && polygon[0].length >= 4
  );

  if (polygons.length < 2 || !(gapMeters > 0)) {
    return polygons;
  }

  let mergedPolygons = [...polygons];
  let didMerge = true;
  let iterationCount = 0;

  while (didMerge && mergedPolygons.length > 1 && iterationCount < 16) {
    didMerge = false;
    iterationCount += 1;

    for (let leftIndex = 0; leftIndex < mergedPolygons.length; leftIndex += 1) {
      const leftPolygon = mergedPolygons[leftIndex];
      const leftBounds = computeLocalPolygonBounds(leftPolygon?.[0] || []);

      if (!leftBounds) {
        continue;
      }

      for (
        let rightIndex = leftIndex + 1;
        rightIndex < mergedPolygons.length;
        rightIndex += 1
      ) {
        const rightPolygon = mergedPolygons[rightIndex];
        const rightBounds = computeLocalPolygonBounds(rightPolygon?.[0] || []);

        if (!rightBounds || !boundsOverlap(leftBounds, rightBounds, gapMeters)) {
          continue;
        }

        const closestPair = findClosestPolygonVertexPair(
          leftPolygon,
          rightPolygon,
          gapMeters
        );

        if (!closestPair || !(closestPair.distance > 0)) {
          continue;
        }

        const bridgeQuad = buildRoadSegmentLocalQuad(
          closestPair.leftPoint,
          closestPair.rightPoint,
          Math.max(
            ROAD_SURFACE_NEAR_MERGE_BRIDGE_WIDTH_METERS,
            closestPair.distance + 0.2
          ),
          0.01
        );
        const bridgeRing = buildPolygonClippingRing(
          orientLocalPolygonCounterClockwise(bridgeQuad || [])
        );

        if (!bridgeRing) {
          continue;
        }

        try {
          const unionResult =
            polygonClipping.union([leftPolygon], [rightPolygon], [[bridgeRing]]) || [];

          if (unionResult.length === 1) {
            mergedPolygons[leftIndex] = unionResult[0];
            mergedPolygons.splice(rightIndex, 1);
            didMerge = true;
            break;
          }
        } catch (error) {
          console.warn(
            `[roads] near-merge fallback error=${formatErrorForLog(error)} gap=${closestPair.distance.toFixed(3)}`
          );
        }
      }

      if (didMerge) {
        break;
      }
    }
  }

  return mergedPolygons;
}

function buildRoadFootprintMultiPolygonFromFeatures(features, center) {
  const footprintPolygons = [];

  for (const feature of features || []) {
    footprintPolygons.push(...buildRoadFeatureFootprintMultiPolygon(feature, center));
  }

  if (!footprintPolygons.length) {
    return [];
  }

  try {
    const unionResult = polygonClipping.union(footprintPolygons) || [];
    return mergeNearbyRoadSurfacePolygons(unionResult);
  } catch (error) {
    console.warn(
      `[roads] footprint union fallback error=${formatErrorForLog(error)}`
    );
    return footprintPolygons;
  }
}

function buildRoadFootprintMultiPolygon(siteContext, center) {
  return buildRoadFootprintMultiPolygonFromFeatures(
    siteContext?.roads?.features || [],
    center
  );
}

function buildRoadSurfaceFeatureCollection(features, location) {
  const center = {
    lat: Number(location?.lat),
    lng: Number(location?.lng),
  };

  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {
    return featureCollection([]);
  }

  const multiPolygon = buildRoadFootprintMultiPolygonFromFeatures(
    features,
    center
  );
  const surfaceFeatures = [];

  for (let index = 0; index < multiPolygon.length; index += 1) {
    const polygon = multiPolygon[index];
    const polygonCoordinates = (polygon || [])
      .map((ring) =>
        closeRing(
          (ring || [])
            .map(([xMeters, yMeters]) => lngLatFromMeters(center, xMeters, yMeters))
            .filter(
              (point) =>
                Array.isArray(point) &&
                Number.isFinite(point[0]) &&
                Number.isFinite(point[1])
            )
        )
      )
      .filter((ring) => ring.length >= 4);

    if (!polygonCoordinates.length) {
      continue;
    }

    surfaceFeatures.push({
      type: "Feature",
      properties: {
        roadId: `road-surface-${index + 1}`,
        sourceLayer: "derived-road-surface",
        surfaceDerived: true,
      },
      geometry: {
        type: "Polygon",
        coordinates: polygonCoordinates,
      },
    });
  }

  return featureCollection(surfaceFeatures);
}

function getCachedRoadFootprintMultiPolygon(siteContext, center) {
  if (!siteContext || typeof siteContext !== "object") {
    return buildRoadFootprintMultiPolygon(siteContext, center);
  }

  const owner = resolveRoadGeometryCacheOwner(siteContext);
  const entry = getOrCreateWeakMapEntry(roadFootprintMultiPolygonCache, owner);
  const cacheKey = `${buildLocationCacheKey(center || siteContext.location)}|${
    siteContext?.roads?.features?.length || 0
  }`;

  if (entry instanceof Map && entry.has(cacheKey)) {
    return entry.get(cacheKey);
  }

  const multiPolygon = buildRoadFootprintMultiPolygon(siteContext, center);

  if (entry instanceof Map) {
    entry.set(cacheKey, multiPolygon);
  }

  return multiPolygon;
}

function buildContourRegionsFromMultiPolygon(multiPolygon) {
  const boundaryLoops = [];

  for (const polygon of multiPolygon || []) {
    for (const ring of polygon || []) {
      const simplifiedRing = simplifyLocalPolygon(ring, 0.01);

      if (simplifiedRing.length >= 3) {
        boundaryLoops.push(simplifiedRing);
      }
    }
  }

  return buildContourBandRegions(boundaryLoops);
}

function buildRoadContourSurfaceGroups(siteContext, center) {
  if (siteContext.options?.terrainMode !== "contour") {
    return [];
  }

  const owner = resolveRoadGeometryCacheOwner(siteContext);
  const entry = getOrCreateWeakMapEntry(roadContourSurfaceGroupCache, owner);
  const cacheKey = `${buildLocationCacheKey(center || siteContext.location)}|${getContourBandCacheKey(
    siteContext
  )}|${siteContext?.roads?.features?.length || 0}`;

  if (entry instanceof Map && entry.has(cacheKey)) {
    return entry.get(cacheKey);
  }

  const roadFootprintMultiPolygon = getCachedRoadFootprintMultiPolygon(siteContext, center);

  if (!roadFootprintMultiPolygon.length) {
    if (entry instanceof Map) {
      entry.set(cacheKey, []);
    }
    return [];
  }

  const topSurfaceGroups = getCachedContourTopSurfaceGroups(siteContext);
  const roadSurfaceGroups = [];

  for (const surfaceGroup of topSurfaceGroups) {
    if (!surfaceGroup.multiPolygon?.length) {
      continue;
    }

    let overlapMultiPolygon = [];

    try {
      overlapMultiPolygon =
        polygonClipping.intersection(
          roadFootprintMultiPolygon,
          surfaceGroup.multiPolygon
        ) || [];
    } catch (error) {
      console.warn(
        `[roads] contour intersection fallback elevation=${surfaceGroup.elevation} error=${formatErrorForLog(
          error
        )}`
      );
      continue;
    }

    const areaSqm = computeLocalMultiPolygonArea(overlapMultiPolygon);

    if (areaSqm <= 0.001) {
      continue;
    }

    const regions = buildContourRegionsFromMultiPolygon(overlapMultiPolygon);

    if (!regions.length) {
      continue;
    }

    roadSurfaceGroups.push({
      elevation: Number(surfaceGroup.elevation.toFixed(3)),
      areaSqm: Number(areaSqm.toFixed(3)),
      regions,
    });
  }

  if (entry instanceof Map) {
    entry.set(cacheKey, roadSurfaceGroups);
  }

  return roadSurfaceGroups;
}

function buildRoadSegmentLocalQuads(startPoint, endPoint, widthMeters, siteContext) {
  const samplePoints = sampleRoadSegmentLocalPoints(
    startPoint,
    endPoint,
    siteContext,
    widthMeters
  );

  if (samplePoints.length < 2) {
    return [];
  }

  const quads = [];

  for (let index = 0; index < samplePoints.length - 1; index += 1) {
    const quad = buildRoadSegmentLocalQuad(
      samplePoints[index],
      samplePoints[index + 1],
      widthMeters
    );

    if (quad) {
      quads.push(quad);
    }
  }

  return quads;
}

function buildRoadLocalPath(coordinates, center, siteContext, widthMeters) {
  if (!coordinates?.length || coordinates.length < 2) {
    return [];
  }

  const localPoints = coordinates.map((point) =>
    localMetersFromLngLat(point, center)
  );
  const path = [];

  for (let index = 0; index < localPoints.length - 1; index += 1) {
    const sampledPoints = sampleRoadSegmentLocalPoints(
      localPoints[index],
      localPoints[index + 1],
      siteContext,
      widthMeters
    );

    if (!sampledPoints.length) {
      continue;
    }

    if (path.length) {
      path.pop();
    }

    path.push(...sampledPoints);
  }

  return path;
}

function appendRoadPrismObjGeometry(
  lines,
  polygonPoints,
  siteContext,
  seed,
  vertexIndex
) {
  if (!polygonPoints?.length || polygonPoints.length < 3) {
    return vertexIndex;
  }

  const bottomIndices = [];
  const topIndices = [];

  for (const [xMeters, yMeters] of polygonPoints) {
    const baseElevation =
      siteHeightAtLocalPoint(siteContext, xMeters, yMeters, seed) +
      ROAD_SURFACE_OFFSET_METERS;
    const topElevation = baseElevation + ROAD_SURFACE_THICKNESS_METERS;

    appendObjVertex(lines, xMeters, yMeters, baseElevation);
    bottomIndices.push(vertexIndex);
    vertexIndex += 1;

    appendObjVertex(lines, xMeters, yMeters, topElevation);
    topIndices.push(vertexIndex);
    vertexIndex += 1;
  }

  for (let index = 0; index < polygonPoints.length; index += 1) {
    const nextIndex = (index + 1) % polygonPoints.length;
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

function appendRoadObjGeometry(
  lines,
  feature,
  center,
  siteContext,
  seed,
  vertexIndex
) {
  const roadName = sanitizeObjName(
    feature.properties?.roadName || feature.properties?.roadId,
    `ROAD_${vertexIndex}`
  );
  const widthMeters = resolveRoadWidthMeters(feature);

  if (
    feature?.geometry?.type === "Polygon" ||
    feature?.geometry?.type === "MultiPolygon"
  ) {
    let polygonIndex = 1;

    for (const ring of getOuterRings(feature)) {
      const openRing = getOpenRing(ring);

      if (openRing.length < 3) {
        continue;
      }

      lines.push(`o ROAD_${roadName}_${polygonIndex}`);
      vertexIndex = appendRoadPrismObjGeometry(
        lines,
        openRing.map((point) => localMetersFromLngLat(point, center)),
        siteContext,
        seed,
        vertexIndex
      );
      polygonIndex += 1;
    }

    return vertexIndex;
  }

  let segmentCounter = 1;

  for (const lineString of getLineStringsFromGeometry(feature.geometry)) {
    for (let index = 0; index < lineString.length - 1; index += 1) {
      const startPoint = localMetersFromLngLat(lineString[index], center);
      const endPoint = localMetersFromLngLat(lineString[index + 1], center);
      const quads = buildRoadSegmentLocalQuads(
        startPoint,
        endPoint,
        widthMeters,
        siteContext
      );

      for (const quad of quads) {
        lines.push(`o ROAD_${roadName}_${segmentCounter}`);
        vertexIndex = appendRoadPrismObjGeometry(
          lines,
          quad,
          siteContext,
          seed,
          vertexIndex
        );
        segmentCounter += 1;
      }
    }
  }

  return vertexIndex;
}

function appendContourBandRoadObjGeometry(
  lines,
  siteContext,
  center,
  vertexIndex
) {
  const roadSurfaceGroups = buildRoadContourSurfaceGroups(siteContext, center);

  for (let groupIndex = 0; groupIndex < roadSurfaceGroups.length; groupIndex += 1) {
    const group = roadSurfaceGroups[groupIndex];
    const bottomElevation = Number(
      (group.elevation + ROAD_SURFACE_OFFSET_METERS).toFixed(3)
    );
    const topElevation = Number(
      (bottomElevation + ROAD_SURFACE_THICKNESS_METERS).toFixed(3)
    );

    for (
      let regionIndex = 0;
      regionIndex < group.regions.length;
      regionIndex += 1
    ) {
      vertexIndex = appendObjContourBandRegionSolid(
        lines,
        group.regions[regionIndex],
        topElevation,
        bottomElevation,
        vertexIndex,
        `ROAD_BAND_${groupIndex + 1}_${regionIndex + 1}`
      );
    }
  }

  return vertexIndex;
}

function buildObjFromSiteContext(siteContext, reportProgress = null) {
  const location = siteContext.location;
  const center = { lat: location.lat, lng: location.lng };
  const targetParcelFeatures = getTargetParcelGroupFeatures(siteContext);
  const seed = Math.round(Math.abs(center.lat * 1000) + Math.abs(center.lng * 1000));
  const progress =
    typeof reportProgress === "function" ? reportProgress : () => null;
  const lines = [
    "# Space Work OBJ export",
    `# Generated at ${new Date().toISOString()}`,
  ];
  let vertexIndex = 1;

  progress(8, "OBJ 지형을 구성하는 중입니다.");

  if (siteContext.options?.terrainMode === "contour") {
    vertexIndex = appendContourBandTerrainObjGeometry(lines, siteContext, vertexIndex);
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
    const parcelFeatures = targetParcelFeatures.length
      ? targetParcelFeatures
      : [siteContext.parcelBoundary].filter(Boolean);

    for (const [featureIndex, feature] of parcelFeatures.entries()) {
      const groupIndex = Number(feature?.properties?.groupIndex || featureIndex + 1);

      for (const ring of getFeaturePolygonRings(feature)) {
        lines.push(
          `o ${
            parcelFeatures.length > 1
              ? `PARCEL_BOUNDARY_${groupIndex}`
              : "PARCEL_BOUNDARY"
          }`
        );
        const parcelVertexIndices = [];

        for (const point of ring) {
          const [xMeters, yMeters] = localMetersFromLngLat(point, center);
          const elevation = FLAT_EXPORT_CURVE_ELEVATION;
          appendObjVertex(lines, xMeters, yMeters, elevation);
          parcelVertexIndices.push(vertexIndex);
          vertexIndex += 1;
        }

        if (parcelVertexIndices.length >= 2) {
          lines.push(`l ${parcelVertexIndices.join(" ")}`);
        }
      }
    }
  }

  if (siteContext.options?.includeParcelBoundary !== false) {
    progress(56, "Adding surrounding parcel boundaries.");

    for (
      let parcelIndex = 0;
      parcelIndex < (siteContext.parcelContext?.features || []).length;
      parcelIndex += 1
    ) {
      const feature = siteContext.parcelContext.features[parcelIndex];
      const ring = getOuterRing(feature);

      if (!ring?.length) {
        continue;
      }

      lines.push(`o PARCEL_CONTEXT_${parcelIndex + 1}`);
      const parcelVertexIndices = [];

      for (const point of ring) {
        const [xMeters, yMeters] = localMetersFromLngLat(point, center);
        const elevation = FLAT_EXPORT_CURVE_ELEVATION;
        appendObjVertex(lines, xMeters, yMeters, elevation);
        parcelVertexIndices.push(vertexIndex);
        vertexIndex += 1;
      }

      if (parcelVertexIndices.length >= 2) {
        lines.push(`l ${parcelVertexIndices.join(" ")}`);
      }
    }
  }

  if (siteContext.options?.includeContours !== false) {
    progress(66, "등고선 레이어를 정리하는 중입니다.");
    let contourCounter = 1;

    for (const feature of siteContext.contourLines.features) {
      for (const lineString of getLineStringsFromGeometry(feature.geometry)) {
        lines.push(`o CONTOUR_${contourCounter}`);
        const contourIndices = [];

        for (const point of lineString) {
          const [xMeters, yMeters] = localMetersFromLngLat(point, center);
          const elevation = FLAT_EXPORT_CURVE_ELEVATION;
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
    progress(80, "건물 매스를 배치하는 중입니다.");
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

  if (siteContext.options?.includeRoads === true) {
    progress(90, "도로 오버레이를 추가하는 중입니다.");

    if (siteContext.options?.terrainMode === "contour") {
      vertexIndex = appendContourBandRoadObjGeometry(
        lines,
        siteContext,
        center,
        vertexIndex
      );
    } else {
      for (const feature of siteContext.roads?.features || []) {
        vertexIndex = appendRoadObjGeometry(
          lines,
          feature,
          center,
          siteContext,
          seed,
          vertexIndex
        );
      }
    }
  }

  progress(96, "OBJ 파일을 마무리하는 중입니다.");
  return lines.join("\n");
}

function buildSketchUpFacePoint(xMeters, yMeters, elevation) {
  return [
    Number(xMeters.toFixed(6)),
    Number(yMeters.toFixed(6)),
    Number(Number(elevation || 0).toFixed(6)),
  ];
}

function collectSketchUpRegionCapFaces(
  facePolygons,
  region,
  elevation,
  reverse = false
) {
  const rings = [region.outerPoints, ...(region.holePoints || [])]
    .map((ring) => dedupeLocalPolygonPoints(ring))
    .filter((ring) => ring.length >= 3);

  if (!rings.length) {
    return;
  }

  const flatCoordinates = [];
  const holeIndices = [];
  const facePoints = [];
  let pointOffset = 0;

  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const ring = rings[ringIndex];

    if (ringIndex > 0) {
      holeIndices.push(pointOffset);
    }

    for (const [xMeters, yMeters] of ring) {
      flatCoordinates.push(xMeters, yMeters);
      facePoints.push(buildSketchUpFacePoint(xMeters, yMeters, elevation));
      pointOffset += 1;
    }
  }

  const triangles = earcut(flatCoordinates, holeIndices, 2);

  for (let index = 0; index < triangles.length; index += 3) {
    const a = facePoints[triangles[index]];
    const b = facePoints[triangles[index + 1]];
    const c = facePoints[triangles[index + 2]];
    facePolygons.push(reverse ? [a, c, b] : [a, b, c]);
  }
}

function collectSketchUpVerticalLoopFaces(
  facePolygons,
  loopPoints,
  topElevation,
  bottomElevation
) {
  const polygon = dedupeLocalPolygonPoints(loopPoints);

  if (polygon.length < 2 || topElevation <= bottomElevation) {
    return;
  }

  const isCounterClockwise = computeLocalPolygonSignedArea(polygon) >= 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const nextIndex = (index + 1) % polygon.length;
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[nextIndex];
    const bottomCurrent = buildSketchUpFacePoint(x1, y1, bottomElevation);
    const bottomNext = buildSketchUpFacePoint(x2, y2, bottomElevation);
    const topCurrent = buildSketchUpFacePoint(x1, y1, topElevation);
    const topNext = buildSketchUpFacePoint(x2, y2, topElevation);

    facePolygons.push(
      isCounterClockwise
        ? [bottomCurrent, bottomNext, topNext, topCurrent]
        : [bottomNext, bottomCurrent, topCurrent, topNext]
    );
  }
}

function buildSketchUpRegionSolidGroup(
  layer,
  objectName,
  region,
  topElevation,
  bottomElevation
) {
  if (!region || topElevation <= bottomElevation) {
    return null;
  }

  const facePolygons = [];
  collectSketchUpRegionCapFaces(facePolygons, region, topElevation, false);
  collectSketchUpRegionCapFaces(facePolygons, region, bottomElevation, true);
  collectSketchUpVerticalLoopFaces(
    facePolygons,
    region.outerPoints,
    topElevation,
    bottomElevation
  );

  for (const holePoints of region.holePoints || []) {
    collectSketchUpVerticalLoopFaces(
      facePolygons,
      holePoints,
      topElevation,
      bottomElevation
    );
  }

  if (!facePolygons.length) {
    return null;
  }

  return {
    layer,
    name: objectName,
    faces: facePolygons,
    polylines: [],
  };
}

function buildSketchUpRegionSolidDefinition(region, topElevation, bottomElevation) {
  if (!region || topElevation <= bottomElevation) {
    return null;
  }

  const outerPoints = orientLocalPolygonCounterClockwise(
    region.outerPoints || []
  );

  if (outerPoints.length < 3) {
    return null;
  }

  return {
    outerLoop: outerPoints.map(([xMeters, yMeters]) =>
      buildSketchUpFacePoint(xMeters, yMeters, bottomElevation)
    ),
    holeLoops: (region.holePoints || [])
      .map((ring) => orientLocalPolygonClockwise(ring))
      .filter((ring) => ring.length >= 3)
      .map((ring) =>
        ring.map(([xMeters, yMeters]) =>
          buildSketchUpFacePoint(xMeters, yMeters, bottomElevation)
        )
      ),
    heightMeters: Number((topElevation - bottomElevation).toFixed(6)),
  };
}

function buildSketchUpPrismSolidDefinition(
  polygonPoints,
  topElevation,
  bottomElevation
) {
  return buildSketchUpRegionSolidDefinition(
    {
      outerPoints: dedupeLocalPolygonPoints(polygonPoints),
      holePoints: [],
    },
    topElevation,
    bottomElevation
  );
}

function resolveSketchUpTerrainSolidSimplifyTolerance(siteContext) {
  if (
    !isSketchUpExportFormat(siteContext) ||
    siteContext?.options?.terrainMode !== "contour"
  ) {
    return 0;
  }

  const terrainStep = Number(siteContext?.terrainGrid?.step || 0);
  const sourceContourInterval = resolveSourceContourInterval(siteContext);
  const radiusMeters = Math.max(30, Number(siteContext?.options?.radius) || 120);
  const baseTolerance = Math.max(
    0.22,
    terrainStep > 0 ? terrainStep * 1.2 : 0,
    sourceContourInterval > 0 ? sourceContourInterval * 0.35 : 0
  );
  const scaledTolerance =
    radiusMeters <= 120
      ? baseTolerance
      : radiusMeters <= 220
        ? baseTolerance * 1.18
        : radiusMeters <= 420
          ? baseTolerance * 1.35
          : baseTolerance * 1.5;

  return Number(Math.max(0.22, Math.min(1.9, scaledTolerance)).toFixed(3));
}

function simplifySketchUpSolidRegion(region, toleranceMeters = 0) {
  const tolerance = Number(toleranceMeters) || 0;

  if (!region || tolerance <= 0.05) {
    return region;
  }

  const outerPoints = simplifyLocalPolygonDouglasPeucker(
    region.outerPoints || [],
    tolerance
  );
  const outerSeedPoints =
    outerPoints.length >= 4
      ? outerPoints
      : simplifyLocalPolygonDouglasPeucker(
          region.outerPoints || [],
          Math.max(0.12, tolerance * 0.55)
        );
  const smoothedOuterPoints = smoothSketchUpSolidLoop(outerSeedPoints, tolerance);

  if (smoothedOuterPoints.length < 3) {
    return region;
  }

  const holeTolerance = Math.max(0.08, Math.min(0.9, tolerance * 0.8));
  const holePoints = (region.holePoints || [])
    .map((ring) => {
      const simplifiedHole = simplifyLocalPolygonDouglasPeucker(ring, holeTolerance);
      const holeSeedPoints =
        simplifiedHole.length >= 4
          ? simplifiedHole
          : simplifyLocalPolygonDouglasPeucker(
              ring,
              Math.max(0.08, holeTolerance * 0.55)
            );
      return smoothSketchUpSolidLoop(holeSeedPoints, holeTolerance);
    })
    .filter((ring) => ring.length >= 3);

  return {
    ...region,
    outerPoints: smoothedOuterPoints,
    holePoints,
  };
}

function buildSketchUpPrismGroup(
  layer,
  objectName,
  polygonPoints,
  topElevation,
  bottomElevation
) {
  const region = {
    outerPoints: dedupeLocalPolygonPoints(polygonPoints),
    holePoints: [],
  };

  if (region.outerPoints.length < 3) {
    return null;
  }

  return buildSketchUpRegionSolidGroup(
    layer,
    objectName,
    region,
    topElevation,
    bottomElevation
  );
}

function buildSketchUpPolyline(points, closed = false, options = {}) {
  const normalizedPoints = closed
    ? dedupeLocalPolygonPoints(points, 0.001)
    : (points || []).filter(
        (point) =>
          Array.isArray(point) &&
          point.length >= 3 &&
          point.every((value) => Number.isFinite(value))
      );

  if (normalizedPoints.length < (closed ? 3 : 2)) {
    return null;
  }

  return {
    closed,
    curve: options?.curve === true && !closed,
    points: normalizedPoints.map(([xMeters, yMeters, elevation]) =>
      buildSketchUpFacePoint(xMeters, yMeters, elevation)
    ),
  };
}

function buildSketchUpContourPolyline(points, elevation) {
  return buildSketchUpPolyline(
    (points || []).map(([xMeters, yMeters]) => [
      Number(xMeters || 0),
      Number(yMeters || 0),
      FLAT_EXPORT_CURVE_ELEVATION,
    ]),
    false,
    { curve: true }
  );
}

function createSketchUpSegmentSolidBuckets() {
  return {
    context: [],
    groups: new Map(),
  };
}

function appendSketchUpTerrainSegmentSolids(
  buckets,
  segments,
  topElevation,
  bottomElevation,
  siteContext = null
) {
  const simplifyTolerance = resolveSketchUpTerrainSolidSimplifyTolerance(siteContext);

  for (const segment of segments || []) {
    const groupIndex =
      segment?.kind === "parcel" && Number.isInteger(segment?.groupIndex)
        ? segment.groupIndex
        : null;
    const bucket =
      groupIndex !== null
        ? (() => {
            if (!buckets.groups.has(groupIndex)) {
              buckets.groups.set(groupIndex, []);
            }

            return buckets.groups.get(groupIndex);
          })()
        : buckets.context;

    for (const region of segment.regions || []) {
      const exportRegion =
        simplifyTolerance > 0
          ? simplifySketchUpSolidRegion(region, simplifyTolerance)
          : region;
      const terrainSolid = buildSketchUpRegionSolidDefinition(
        exportRegion,
        topElevation,
        bottomElevation
      );

      if (terrainSolid) {
        bucket.push(terrainSolid);
      }
    }
  }
}

function buildSketchUpParcelContainerMap(siteContext) {
  return new Map(
    getTargetParcelGroupFeatures(siteContext).map((feature, index) => [
      Number(feature?.properties?.groupIndex || index + 1),
      buildParcelGroupExportName(feature, index),
    ])
  );
}

function resolveSketchUpGroupContainer(containerMap, groupIndex) {
  if (!Number.isInteger(groupIndex)) {
    return "";
  }

  return containerMap.get(groupIndex) || "";
}

function buildSketchUpPayloadFromSiteContext(siteContext) {
  const location = siteContext.location;
  const center = { lat: location.lat, lng: location.lng };
  const seed = Math.round(Math.abs(center.lat * 1000) + Math.abs(center.lng * 1000));
  const groups = [];
  const terrainSolidBuckets = createSketchUpSegmentSolidBuckets();
  const roadSolidBuckets = createSketchUpSegmentSolidBuckets();
  const targetParcelFeatures = getTargetParcelGroupFeatures(siteContext);
  const parcelContainerMap = shouldGroupParcelCutContent(siteContext)
    ? buildSketchUpParcelContainerMap(siteContext)
    : new Map();
  const pushGroup = (group) => {
    if (
      group &&
      ((group.faces && group.faces.length) ||
        (group.polylines && group.polylines.length) ||
        (group.solids && group.solids.length))
    ) {
      groups.push(group);
    }
  };

  if (
    siteContext.options?.terrainMode === "contour" &&
    siteContext.terrainGrid?.elevations?.length
  ) {
    const terrainPlan = resolveContourTerrainRenderPlan(siteContext);
    const {
      baseElevation,
      minBandElevation,
      bandGroups,
      clipPolygon,
      flatTopElevation,
      useFlatFallback,
    } = terrainPlan || {};

    if (useFlatFallback && clipPolygon.length >= 3) {
      const flatSegments = splitTerrainMultiPolygonByParcelBoundary(
        siteContext,
        buildLocalMultiPolygonFromOpenRing(clipPolygon)
      );
      appendSketchUpTerrainSegmentSolids(
        terrainSolidBuckets,
        flatSegments,
        flatTopElevation,
        baseElevation,
        siteContext
      );
    } else {
      if (clipPolygon.length >= 3 && minBandElevation > baseElevation + 0.001) {
        const baseSegments = splitTerrainMultiPolygonByParcelBoundary(
          siteContext,
          buildLocalMultiPolygonFromOpenRing(clipPolygon)
        );
        appendSketchUpTerrainSegmentSolids(
          terrainSolidBuckets,
          baseSegments,
          minBandElevation,
          baseElevation,
          siteContext
        );
      }

      for (let groupIndex = 0; groupIndex < bandGroups.length; groupIndex += 1) {
        const group = bandGroups[groupIndex];
        const effectiveBottomElevation = Number(
          Math.max(baseElevation, group.bottomElevation - TERRAIN_BAND_OVERLAP_METERS).toFixed(3)
        );
        const groupSegments = splitTerrainMultiPolygonByParcelBoundary(
          siteContext,
          group.multiPolygon ||
            buildPolygonClippingMultiPolygonFromRegions(group.regions)
        );
        appendSketchUpTerrainSegmentSolids(
          terrainSolidBuckets,
          groupSegments,
          group.topElevation,
          effectiveBottomElevation,
          siteContext
        );
      }
    }
  }

  if (siteContext.options?.includeBuildings !== false) {
    for (const feature of siteContext.buildings?.features || []) {
      const ring = getOpenRing(getOuterRing(feature));

      if (ring.length < 3) {
        continue;
      }

      const placementInfo = resolveBuildingPlacementForRing(
        siteContext,
        ring,
        center,
        seed
      );
      applyBuildingPlacementDebug(feature, placementInfo);
      const resolvedBaseElevation = Number.isFinite(placementInfo?.finalBaseElevation)
        ? placementInfo.finalBaseElevation
        : (() => {
            const centroid = centroidOfRing(ring);

            if (!centroid) {
              return 0;
            }

            const [xMeters, yMeters] = localMetersFromLngLat(centroid, center);
            return siteHeightAtLocalPoint(siteContext, xMeters, yMeters, seed);
          })();
      const heightMeters = Math.max(
        3,
        Number(feature.properties?.heightMeters || 0) || 10.2
      );
      const layer = feature.properties?.isTarget ? "target-building" : "buildings";
      const objectName =
        feature.properties?.buildingName ||
        feature.properties?.buildingId ||
        feature.properties?.roadAddress ||
        `BUILDING_${groups.length + 1}`;

      pushGroup(
        {
          layer,
          name: objectName,
          container:
            feature.properties?.isTarget
              ? resolveSketchUpGroupContainer(
                  parcelContainerMap,
                  Number(feature.properties?.targetParcelGroupIndex || Number.NaN)
                )
              : "",
          faces: [],
          polylines: [],
          solids: [
            buildSketchUpPrismSolidDefinition(
              ring.map((point) => localMetersFromLngLat(point, center)),
              resolvedBaseElevation + heightMeters,
              resolvedBaseElevation
            ),
          ].filter(Boolean),
        }
      );
    }
  }

  if (siteContext.options?.includeRoads === true) {
    if (siteContext.options?.terrainMode === "contour") {
      const roadSurfaceGroups = buildRoadContourSurfaceGroups(siteContext, center);

      for (let groupIndex = 0; groupIndex < roadSurfaceGroups.length; groupIndex += 1) {
        const group = roadSurfaceGroups[groupIndex];
        const bottomElevation = Number(
          (group.elevation + ROAD_SURFACE_OFFSET_METERS).toFixed(3)
        );
        const topElevation = Number(
          (bottomElevation + ROAD_SURFACE_THICKNESS_METERS).toFixed(3)
        );
        const groupSegments = splitTerrainMultiPolygonByParcelBoundary(
          siteContext,
          buildPolygonClippingMultiPolygonFromRegions(group.regions)
        );
        appendSketchUpTerrainSegmentSolids(
          roadSolidBuckets,
          groupSegments,
          topElevation,
          bottomElevation,
          siteContext
        );
      }
    }
  }

  if (siteContext.options?.includeParcelBoundary !== false) {
    const parcelFeatures = targetParcelFeatures.length
      ? targetParcelFeatures
      : [siteContext.parcelBoundary].filter(Boolean);

    for (const [featureIndex, feature] of parcelFeatures.entries()) {
      const groupIndex = Number(feature?.properties?.groupIndex || featureIndex + 1);
      const containerName = resolveSketchUpGroupContainer(parcelContainerMap, groupIndex);
      const featureRings = getFeaturePolygonRings(feature);
      const polylines = featureRings
        .map((ring) =>
          buildSketchUpPolyline(
            ring.map((point) => {
              const [xMeters, yMeters] = localMetersFromLngLat(point, center);
              return [xMeters, yMeters, FLAT_EXPORT_CURVE_ELEVATION];
            }),
            true
          )
        )
        .filter(Boolean);

      pushGroup({
        layer: "site-parcel",
        name:
          parcelFeatures.length > 1
            ? `PARCEL_BOUNDARY_${groupIndex}`
            : "PARCEL_BOUNDARY",
        container: containerName,
        faces: [],
        polylines,
      });
    }
  }

  if (siteContext.options?.includeContours !== false) {
    const contourPolylines = [];
    const parcelContourPolylines = new Map();

    for (const feature of siteContext.contourLines?.features || []) {
      const elevation = Number(feature?.properties?.elevation || 0);

      for (const lineString of getLineStringsFromGeometry(feature.geometry)) {
        const localPoints = lineString.map((point) =>
          localMetersFromLngLat(point, center)
        );
        const polyline = buildSketchUpContourPolyline(localPoints, elevation);

        if (polyline) {
          const targetParcelFeature = resolveTargetParcelGroupForLineString(
            lineString,
            targetParcelFeatures
          );
          const targetGroupIndex = Number(
            targetParcelFeature?.properties?.groupIndex || Number.NaN
          );

          if (Number.isInteger(targetGroupIndex)) {
            if (!parcelContourPolylines.has(targetGroupIndex)) {
              parcelContourPolylines.set(targetGroupIndex, []);
            }
            parcelContourPolylines.get(targetGroupIndex).push(polyline);
          } else {
            contourPolylines.push(polyline);
          }
        }
      }
    }

    if (contourPolylines.length) {
      pushGroup({
        layer: "contours",
        name: "CONTOURS",
        faces: [],
        polylines: contourPolylines,
        solids: [],
      });
    }

    for (const [groupIndex, polylines] of [...parcelContourPolylines.entries()].sort(
      (left, right) => left[0] - right[0]
    )) {
      pushGroup({
        layer: "contours",
        name: `CONTOURS_PARCEL_${groupIndex}`,
        container: resolveSketchUpGroupContainer(parcelContainerMap, groupIndex),
        faces: [],
        polylines,
        solids: [],
      });
    }
  }

  const contextTerrainSolids = terrainSolidBuckets.context || [];

  if (contextTerrainSolids.length) {
    pushGroup({
      layer: "terrain",
      name: "TERRAIN",
      faces: [],
      polylines: [],
      solids: contextTerrainSolids,
    });
  }

  for (const [groupIndex, solids] of [...terrainSolidBuckets.groups.entries()].sort(
    (left, right) => left[0] - right[0]
  )) {
    pushGroup({
      layer: "terrain",
      name: `TERRAIN_PARCEL_${groupIndex}`,
      container: resolveSketchUpGroupContainer(parcelContainerMap, groupIndex),
      faces: [],
      polylines: [],
      solids,
    });
  }

  const contextRoadSolids = roadSolidBuckets.context || [];

  if (contextRoadSolids.length) {
    pushGroup({
      layer: "roads",
      name: "ROADS",
      faces: [],
      polylines: [],
      solids: contextRoadSolids,
    });
  }

  for (const [groupIndex, solids] of [...roadSolidBuckets.groups.entries()].sort(
    (left, right) => left[0] - right[0]
  )) {
    pushGroup({
      layer: "roads",
      name: `ROADS_PARCEL_${groupIndex}`,
      container: resolveSketchUpGroupContainer(parcelContainerMap, groupIndex),
      faces: [],
      polylines: [],
      solids,
    });
  }

  return {
    units: "meters",
    groups,
  };
}

function normalizeSkpExportEngine(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "sketchup-desktop") {
    return "sketchup-desktop";
  }
  if (normalized === "standalone-cli") {
    return "standalone-cli";
  }
  return "auto";
}

function resolveSkpExportRuntimeConfig(exportConfig = null) {
  const source =
    exportConfig && typeof exportConfig === "object" ? exportConfig : {};

  return {
    engine: normalizeSkpExportEngine(
      source.skpExportEngine ?? process.env.SKP_EXPORT_ENGINE ?? "auto"
    ),
    skpExporterCli: normalizeConfigString(
      source.skpExporterCli ?? process.env.SKP_EXPORTER_CLI ?? ""
    ),
    sketchUpExe: normalizeConfigString(
      source.sketchUpExe ?? process.env.SKETCHUP_EXE ?? ""
    ),
  };
}

async function findStandaloneSkpExporterPath(exportConfig = null) {
  const runtimeConfig = resolveSkpExportRuntimeConfig(exportConfig);
  const configuredPath = runtimeConfig.skpExporterCli;

  if (!configuredPath) {
    return null;
  }

  try {
    await stat(configuredPath);
    return configuredPath;
  } catch {
    return null;
  }
}

async function findSketchUpExecutablePath(exportConfig = null) {
  const runtimeConfig = resolveSkpExportRuntimeConfig(exportConfig);
  const preferredPath = runtimeConfig.sketchUpExe;

  if (preferredPath) {
    try {
      await stat(preferredPath);
      return preferredPath;
    } catch {
      // fall back to installed-path discovery
    }
  }

  const installRoots = [
    "C:\\Program Files\\SketchUp",
    "C:\\Program Files (x86)\\SketchUp",
  ];
  const candidates = [];

  for (const root of installRoots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          candidates.push(path.join(root, entry.name, "SketchUp.exe"));
        }
      }
    } catch {
      // ignore missing install roots
    }
  }

  candidates.sort().reverse();

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // try the next installed version
    }
  }

  return null;
}

function launchSketchUpExportProcess(executablePath, rubyScriptPath, workingDirectory) {
  return spawn(executablePath, ["-RubyStartup", rubyScriptPath], {
    cwd: workingDirectory,
    windowsHide: true,
    stdio: "ignore",
  });
}

function launchStandaloneSkpExporterProcess(
  executablePath,
  payloadPath,
  outputPath,
  workingDirectory
) {
  return spawn(
    executablePath,
    ["--input", payloadPath, "--output", outputPath],
    {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: "ignore",
    }
  );
}

function formatProcessExitCode(exitCode) {
  if (!Number.isInteger(exitCode)) {
    return "unknown";
  }

  if (exitCode < 0) {
    return `${exitCode}`;
  }

  return `${exitCode} (0x${exitCode.toString(16).toUpperCase()})`;
}

function hasRunningChildProcess(childProcess) {
  return (
    childProcess &&
    Number.isInteger(childProcess.pid) &&
    childProcess.exitCode === null
  );
}

function waitForChildProcessExit(childProcess, timeoutMs = 0) {
  if (!hasRunningChildProcess(childProcess)) {
    return Promise.resolve({
      exitCode: childProcess?.exitCode ?? null,
      signal: childProcess?.signalCode ?? null,
      timedOut: false,
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle = null;

    const cleanup = () => {
      childProcess.off("exit", handleExit);
      childProcess.off("error", handleError);

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    };

    const settle = (value, shouldReject = false) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (shouldReject) {
        reject(value);
      } else {
        resolve(value);
      }
    };

    const handleExit = (exitCode, signal) => {
      settle({
        exitCode,
        signal,
        timedOut: false,
      });
    };

    const handleError = (error) => {
      settle(error, true);
    };

    childProcess.once("exit", handleExit);
    childProcess.once("error", handleError);

    if (childProcess.exitCode !== null) {
      handleExit(childProcess.exitCode, childProcess.signalCode);
      return;
    }

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        settle({
          exitCode: childProcess.exitCode,
          signal: childProcess.signalCode,
          timedOut: true,
        });
      }, timeoutMs);
    }
  });
}

async function ensureChildProcessTerminated(
  childProcess,
  {
    label = "child process",
    gracefulTimeoutMs = SKETCHUP_EXPORT_EXIT_GRACE_MS,
    forceKillTimeoutMs = CHILD_PROCESS_FORCE_KILL_GRACE_MS,
  } = {}
) {
  if (!hasRunningChildProcess(childProcess)) {
    return;
  }

  const gracefulExit = await waitForChildProcessExit(
    childProcess,
    gracefulTimeoutMs
  );

  if (!gracefulExit.timedOut) {
    return;
  }

  try {
    childProcess.kill();
  } catch {
    // ignore kill errors and continue waiting for termination
  }

  const killedExit = await waitForChildProcessExit(
    childProcess,
    forceKillTimeoutMs
  );

  if (!killedExit.timedOut) {
    return;
  }

  try {
    childProcess.kill("SIGKILL");
  } catch {
    // ignore force-kill errors and continue waiting one last time
  }

  const forcedExit = await waitForChildProcessExit(
    childProcess,
    forceKillTimeoutMs
  );

  if (forcedExit.timedOut) {
    throw new Error(`${label} did not exit after a forced termination attempt.`);
  }
}

function createSketchUpRubyExportScript(payloadPath, outputPath, statusPath) {
  const rubyPath = (value) => JSON.stringify(String(value).replace(/\\/g, "/"));

  return `
require 'json'

METERS_TO_INCHES = ${SKETCHUP_METERS_TO_INCHES}
payload_path = ${rubyPath(payloadPath)}
output_path = ${rubyPath(outputPath)}
status_path = ${rubyPath(statusPath)}

def ensure_layer(model, layer_name)
  return nil if layer_name.to_s.empty?
  model.layers[layer_name] || model.layers.add(layer_name)
end

def point_from_triplet(triplet)
  Geom::Point3d.new(
    triplet[0].to_f * METERS_TO_INCHES,
    triplet[1].to_f * METERS_TO_INCHES,
    triplet[2].to_f * METERS_TO_INCHES
  )
end

def add_faces_to_group(group, faces)
  ents = group.entities
  faces.each do |face_points|
    points = (face_points || []).map { |point| point_from_triplet(point) }
    next if points.length < 3
    ents.add_face(points)
  end
end

def add_polylines_to_group(group, polylines)
  ents = group.entities
  polylines.each do |polyline|
    points = (polyline['points'] || []).map { |point| point_from_triplet(point) }
    next if points.length < 2
    if polyline['curve'] && !polyline['closed']
      ents.add_curve(points)
    else
      points << points.first if polyline['closed'] && points.first != points.last
      ents.add_edges(points)
    end
  end
end

def add_solids_to_group(group, solids)
  ents = group.entities

  solids.each do |solid|
    solid_group = ents.add_group
    solid_ents = solid_group.entities
    outer_points = (solid['outerLoop'] || []).map { |point| point_from_triplet(point) }
    next if outer_points.length < 3

    face = solid_ents.add_face(outer_points)
    next unless face && face.valid?

    (solid['holeLoops'] || []).each do |hole_loop|
      hole_points = hole_loop.map { |point| point_from_triplet(point) }
      next if hole_points.length < 3
      hole_loop_points = hole_points.dup
      hole_loop_points << hole_loop_points.first if hole_loop_points.first != hole_loop_points.last
      solid_ents.add_edges(hole_loop_points)
      hole_face = solid_ents.add_face(hole_points)
      hole_face.erase! if hole_face && hole_face.valid?
    end

    height_inches = solid['heightMeters'].to_f * METERS_TO_INCHES
    next if height_inches.abs <= 1e-6

    face.reverse! if face.valid? && face.normal.z < 0
    face.pushpull(height_inches, true) if face.valid?
  end
end

model = Sketchup.active_model
begin
  units = model.options["UnitsOptions"]
  units["LengthFormat"] = 0 if units.has_key?("LengthFormat")
  units["LengthUnit"] = 4 if units.has_key?("LengthUnit")
  units["LengthPrecision"] = 3 if units.has_key?("LengthPrecision")
rescue
end

begin
  payload = JSON.parse(File.read(payload_path))
  model.start_operation('Site Context SKP Export', true)
  model.entities.clear!
  root_group = model.entities.add_group
  root_group.name = 'Site Context Export'
  root_entities = root_group.entities
  container_groups = {}

  (payload['groups'] || []).each do |group_data|
    parent_entities = root_entities
    container_name = group_data['container'].to_s

    unless container_name.empty?
      unless container_groups.has_key?(container_name)
        container_group = root_entities.add_group
        container_group.name = container_name
        container_layer_name = group_data['containerLayer'].to_s
        container_layer = ensure_layer(model, container_layer_name.empty? ? group_data['layer'] : container_layer_name)
        container_group.layer = container_layer if container_layer
        container_groups[container_name] = container_group
      end

      parent_entities = container_groups[container_name].entities
    end

    group = parent_entities.add_group
    group.name = group_data['name'].to_s unless group_data['name'].to_s.empty?
    layer = ensure_layer(model, group_data['layer'])
    group.layer = layer if layer
    add_solids_to_group(group, group_data['solids'] || [])
    add_faces_to_group(group, group_data['faces'] || [])
    add_polylines_to_group(group, group_data['polylines'] || [])
  end

  model.commit_operation
  saved = model.save(output_path)
  File.write(status_path, saved ? "ok" : "save_failed")
rescue => error
  begin
    model.abort_operation
  rescue
  end

  File.write(
    status_path,
    "error: #{error.class}: #{error.message}\\n#{Array(error.backtrace).join("\\n")}"
  )
ensure
  UI.start_timer(0.25, false) { Sketchup.quit }
end
`;
}

async function waitForSketchUpExportResult(statusPath, outputPath, childProcess) {
  const startedAt = Date.now();
  let observedExitCode = null;
  let exitObservedAt = 0;

  while (Date.now() - startedAt < SKETCHUP_EXPORT_TIMEOUT_MS) {
    try {
      const status = String(await readFile(statusPath, "utf8")).trim();

      if (status === "ok") {
        return readFile(outputPath);
      }

      if (status) {
        throw new Error(status);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      const existingOutput = await readFile(outputPath);

      if (existingOutput?.byteLength) {
        return existingOutput;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    if (childProcess.exitCode !== null && childProcess.exitCode !== 0) {
      if (observedExitCode === null) {
        observedExitCode = childProcess.exitCode;
        exitObservedAt = Date.now();
      }

      if (Date.now() - exitObservedAt >= 30_000) {
        throw new Error(
          `SketchUp export process exited with code ${formatProcessExitCode(
            observedExitCode
          )}.`
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (childProcess.exitCode === null) {
    childProcess.kill();
  }

  if (observedExitCode !== null) {
    throw new Error(
      `SketchUp export process exited with code ${formatProcessExitCode(
        observedExitCode
      )}.`
    );
  }

  throw new Error("SketchUp export timed out before the SKP file was created.");
}

async function waitForStandaloneSkpExportResult(outputPath, childProcess) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < SKETCHUP_EXPORT_TIMEOUT_MS) {
    try {
      if (childProcess.exitCode === 0) {
        return readFile(outputPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    if (childProcess.exitCode !== null && childProcess.exitCode !== 0) {
      throw new Error(
        `Standalone SKP exporter exited with code ${formatProcessExitCode(
          childProcess.exitCode
        )}.`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (childProcess.exitCode === null) {
    childProcess.kill();
  }

  throw new Error(
    "Standalone SKP exporter timed out before the SKP file was created."
  );
}

async function buildSkpFromSiteContext(
  siteContext,
  reportProgress = null,
  exportConfig = null
) {
  const progress =
    typeof reportProgress === "function" ? reportProgress : () => null;
  const runtimeConfig = resolveSkpExportRuntimeConfig(exportConfig);

  progress(12, "SKP 변환용 SketchUp payload를 준비하는 중입니다.");
  const payload = buildSketchUpPayloadFromSiteContext(siteContext);
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "site-context-skp-"));
  const payloadPath = path.join(tempDirectory, "site-context.json");
  const rubyScriptPath = path.join(tempDirectory, "export-to-skp.rb");
  const outputPath = path.join(tempDirectory, "site-context.skp");
  const statusPath = path.join(tempDirectory, "status.txt");
  let childProcess = null;
  let childProcessLabel = "SKP export process";

  try {
    await writeFile(payloadPath, JSON.stringify(payload), "utf8");

    let skpBuffer = null;
    const standaloneExporterPath = await findStandaloneSkpExporterPath(
      runtimeConfig
    );
    const sketchUpExecutable = await findSketchUpExecutablePath(runtimeConfig);
    const resolvedEngine =
      runtimeConfig.engine === "auto"
        ? standaloneExporterPath
          ? "standalone-cli"
          : sketchUpExecutable
            ? "sketchup-desktop"
            : "standalone-cli"
        : runtimeConfig.engine;

    if (resolvedEngine === "sketchup-desktop") {
      if (!sketchUpExecutable) {
        throw new Error(
          "SketchUp desktop export could not start because SketchUp.exe was not found. Set SKETCHUP_EXE or configure SKP_EXPORTER_CLI."
        );
      }

      await writeFile(
        rubyScriptPath,
        createSketchUpRubyExportScript(payloadPath, outputPath, statusPath),
        "utf8"
      );

      progress(34, "Legacy SketchUp 변환기를 실행하는 중입니다.");
      childProcessLabel = "SketchUp export process";
      childProcess = launchSketchUpExportProcess(
        sketchUpExecutable,
        rubyScriptPath,
        tempDirectory
      );
      skpBuffer = await Promise.race([
        waitForSketchUpExportResult(statusPath, outputPath, childProcess),
        new Promise((_, reject) => {
          childProcess.once("error", reject);
        }),
      ]);
    } else {
      if (!standaloneExporterPath) {
        throw new Error(
          "SKP export is not configured. Install SketchUp Desktop or set SKP_EXPORTER_CLI to a standalone SKP exporter built on the SketchUp C SDK."
        );
      }

      progress(34, "Standalone SKP 변환기를 실행하는 중입니다.");
      childProcessLabel = "Standalone SKP exporter";
      childProcess = launchStandaloneSkpExporterProcess(
        standaloneExporterPath,
        payloadPath,
        outputPath,
        tempDirectory
      );
      skpBuffer = await Promise.race([
        waitForStandaloneSkpExportResult(outputPath, childProcess),
        new Promise((_, reject) => {
          childProcess.once("error", reject);
        }),
      ]);
    }

    progress(92, "SKP 파일을 수집하는 중입니다.");
    return Buffer.from(skpBuffer);
  } finally {
    await ensureChildProcessTerminated(childProcess, {
      label: childProcessLabel,
    }).catch((error) => {
      console.warn(`[skp-export] cleanup-warning ${error?.message || error}`);
    });
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => null);
  }
}

async function buildSkpFromSiteContextWithRetry(
  siteContext,
  reportProgress = null,
  exportConfig = null
) {
  const progress =
    typeof reportProgress === "function" ? reportProgress : () => null;
  const runtimeConfig = resolveSkpExportRuntimeConfig(exportConfig);
  const standaloneExporterPath = await findStandaloneSkpExporterPath(runtimeConfig);
  const sketchUpExecutable = await findSketchUpExecutablePath(runtimeConfig);
  const attemptObserver =
    typeof exportConfig?.onAttemptPrepared === "function"
      ? exportConfig.onAttemptPrepared
      : null;
  const resolvedEngine =
    runtimeConfig.engine === "auto"
      ? standaloneExporterPath
        ? "standalone-cli"
        : sketchUpExecutable
          ? "sketchup-desktop"
          : "standalone-cli"
      : runtimeConfig.engine;
  const baseOptions = {
    ...(siteContext?.options || {}),
  };
  let currentSiteContext = siteContext;
  let currentInterval = normalizeContourInterval(
    currentSiteContext?.stats?.effectiveContourBandInterval ||
      currentSiteContext?.options?.contourInterval
  );
  let attemptIndex = 0;
  let lastError = null;

  while (attemptIndex < 4) {
    attemptIndex += 1;

    try {
      attemptObserver?.(currentSiteContext, {
        attemptIndex,
        engine: resolvedEngine,
        interval: currentInterval,
      });

      if (attemptIndex > 1) {
        progress(
          Math.min(88, 48 + attemptIndex * 8),
          `SKP 생성을 다시 시도하고 있습니다. (${attemptIndex}/4)`
        );
      }

      return await buildSkpFromSiteContext(
        currentSiteContext,
        progress,
        exportConfig
      );
    } catch (error) {
      lastError = error;
      const nextInterval = nextContourIntervalStep(currentInterval);

      console.warn(
        `[skp-export] retry attempt=${attemptIndex} interval=${currentInterval} error=${error?.message || error}`
      );

      if (!(nextInterval > currentInterval + 1e-9) || nextInterval > 20) {
        throw error;
      }

      currentSiteContext = prepareSiteContextForExport(
        siteContext,
        {
          ...baseOptions,
          contourInterval: nextInterval,
        },
        "skp"
      );
      currentInterval = normalizeContourInterval(
        currentSiteContext?.stats?.effectiveContourBandInterval || nextInterval
      );
    }
  }

  throw lastError || new Error("SKP export failed after repeated attempts.");
}

function appendDxfPair(lines, code, value) {
  lines.push(String(code), String(value));
}

function allocateDxfHandle(state) {
  const handle = state.nextHandle.toString(16).toUpperCase();
  state.nextHandle += 1;
  return handle;
}

function normalizeDxfLayerDefinitions(layers) {
  return [
    { name: "0", color: 7 },
    ...(layers || []).filter(
      (layer) => layer?.name && String(layer.name).trim() !== "0"
    ),
  ];
}

function createDxfDocumentState(layers = []) {
  const state = {
    nextHandle: 0x10,
    bounds: {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
    layerDefinitions: normalizeDxfLayerDefinitions(layers),
    handles: {
      ltypeTable: null,
      layerTable: null,
      blockRecordTable: null,
      linetypeContinuous: null,
      layers: new Map(),
      blockRecords: {
        modelSpace: null,
        paperSpace: null,
        paperSpace0: null,
      },
      blocks: {
        modelSpace: { begin: null, end: null },
        paperSpace: { begin: null, end: null },
        paperSpace0: { begin: null, end: null },
      },
    },
  };

  state.handles.ltypeTable = allocateDxfHandle(state);
  state.handles.layerTable = allocateDxfHandle(state);
  state.handles.blockRecordTable = allocateDxfHandle(state);
  state.handles.linetypeContinuous = allocateDxfHandle(state);

  for (const layer of state.layerDefinitions) {
    state.handles.layers.set(layer.name, allocateDxfHandle(state));
  }

  state.handles.blockRecords.modelSpace = allocateDxfHandle(state);
  state.handles.blockRecords.paperSpace = allocateDxfHandle(state);
  state.handles.blockRecords.paperSpace0 = allocateDxfHandle(state);

  state.handles.blocks.modelSpace.begin = allocateDxfHandle(state);
  state.handles.blocks.modelSpace.end = allocateDxfHandle(state);
  state.handles.blocks.paperSpace.begin = allocateDxfHandle(state);
  state.handles.blocks.paperSpace.end = allocateDxfHandle(state);
  state.handles.blocks.paperSpace0.begin = allocateDxfHandle(state);
  state.handles.blocks.paperSpace0.end = allocateDxfHandle(state);

  return state;
}

function updateDxfBounds(state, points = [], elevation = 0) {
  if (!state?.bounds) {
    return;
  }

  const normalizedElevation = Number.isFinite(Number(elevation))
    ? Number(elevation)
    : 0;

  for (const point of points || []) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    ) {
      continue;
    }

    state.bounds.minX = Math.min(state.bounds.minX, Number(point[0]));
    state.bounds.minY = Math.min(state.bounds.minY, Number(point[1]));
    state.bounds.minZ = Math.min(state.bounds.minZ, normalizedElevation);
    state.bounds.maxX = Math.max(state.bounds.maxX, Number(point[0]));
    state.bounds.maxY = Math.max(state.bounds.maxY, Number(point[1]));
    state.bounds.maxZ = Math.max(state.bounds.maxZ, normalizedElevation);
  }
}

function formatDxfCoordinateValue(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(3) : "0.000";
}

function getDxfDocumentBounds(state) {
  if (
    !state?.bounds ||
    !Number.isFinite(state.bounds.minX) ||
    !Number.isFinite(state.bounds.minY) ||
    !Number.isFinite(state.bounds.maxX) ||
    !Number.isFinite(state.bounds.maxY)
  ) {
    return {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: 0,
      maxY: 0,
      maxZ: 0,
    };
  }

  return {
    minX: state.bounds.minX,
    minY: state.bounds.minY,
    minZ: Number.isFinite(state.bounds.minZ) ? state.bounds.minZ : 0,
    maxX: state.bounds.maxX,
    maxY: state.bounds.maxY,
    maxZ: Number.isFinite(state.bounds.maxZ) ? state.bounds.maxZ : 0,
  };
}

function getGeometryPolygonRings(geometry) {
  if (!geometry) {
    return [];
  }

  if (geometry.type === "Polygon") {
    return (geometry.coordinates || []).filter(
      (ring) => Array.isArray(ring) && ring.length
    );
  }

  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates || []).flatMap((polygon) =>
      (polygon || []).filter((ring) => Array.isArray(ring) && ring.length)
    );
  }

  return [];
}

function getGeometryPolygonCoordinateSets(geometry) {
  if (!geometry) {
    return [];
  }

  if (geometry.type === "Polygon") {
    const coordinates = (geometry.coordinates || []).filter(
      (ring) => Array.isArray(ring) && ring.length
    );
    return coordinates.length ? [coordinates] : [];
  }

  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates || [])
      .map((polygon) =>
        (polygon || []).filter((ring) => Array.isArray(ring) && ring.length)
      )
      .filter((polygon) => polygon.length);
  }

  return [];
}

function getFeaturePolygonRings(feature) {
  return getGeometryPolygonRings(feature?.geometry);
}

function appendDxfHeaderSection(lines, state) {
  const bounds = getDxfDocumentBounds(state);
  appendDxfPair(lines, 0, "SECTION");
  appendDxfPair(lines, 2, "HEADER");
  appendDxfPair(lines, 9, "$ACADVER");
  appendDxfPair(lines, 1, "AC1015");
  appendDxfPair(lines, 9, "$INSBASE");
  appendDxfPair(lines, 10, "0.000");
  appendDxfPair(lines, 20, "0.000");
  appendDxfPair(lines, 30, "0.000");
  appendDxfPair(lines, 9, "$EXTMIN");
  appendDxfPair(lines, 10, formatDxfCoordinateValue(bounds.minX));
  appendDxfPair(lines, 20, formatDxfCoordinateValue(bounds.minY));
  appendDxfPair(lines, 30, formatDxfCoordinateValue(bounds.minZ));
  appendDxfPair(lines, 9, "$EXTMAX");
  appendDxfPair(lines, 10, formatDxfCoordinateValue(bounds.maxX));
  appendDxfPair(lines, 20, formatDxfCoordinateValue(bounds.maxY));
  appendDxfPair(lines, 30, formatDxfCoordinateValue(bounds.maxZ));
  appendDxfPair(lines, 9, "$HANDSEED");
  appendDxfPair(lines, 5, state?.nextHandle?.toString(16).toUpperCase() || "10");
  appendDxfPair(lines, 9, "$INSUNITS");
  appendDxfPair(lines, 70, 6);
  appendDxfPair(lines, 0, "ENDSEC");
}

function appendDxfSymbolTableHeader(lines, tableName, handle, recordCount) {
  appendDxfPair(lines, 0, "TABLE");
  appendDxfPair(lines, 2, tableName);
  appendDxfPair(lines, 5, handle);
  appendDxfPair(lines, 100, "AcDbSymbolTable");
  appendDxfPair(lines, 70, recordCount);
}

function appendDxfLinetypeTable(lines, state) {
  appendDxfSymbolTableHeader(lines, "LTYPE", state.handles.ltypeTable, 1);
  appendDxfPair(lines, 0, "LTYPE");
  appendDxfPair(lines, 5, state.handles.linetypeContinuous);
  appendDxfPair(lines, 330, state.handles.ltypeTable);
  appendDxfPair(lines, 100, "AcDbSymbolTableRecord");
  appendDxfPair(lines, 100, "AcDbLinetypeTableRecord");
  appendDxfPair(lines, 2, "CONTINUOUS");
  appendDxfPair(lines, 70, 0);
  appendDxfPair(lines, 3, "Solid line");
  appendDxfPair(lines, 72, 65);
  appendDxfPair(lines, 73, 0);
  appendDxfPair(lines, 40, 0);
  appendDxfPair(lines, 0, "ENDTAB");
}

function appendDxfLayerTable(lines, state) {
  appendDxfSymbolTableHeader(
    lines,
    "LAYER",
    state.handles.layerTable,
    state.layerDefinitions.length
  );

  for (const layer of state.layerDefinitions) {
    appendDxfPair(lines, 0, "LAYER");
    appendDxfPair(lines, 5, state.handles.layers.get(layer.name));
    appendDxfPair(lines, 330, state.handles.layerTable);
    appendDxfPair(lines, 100, "AcDbSymbolTableRecord");
    appendDxfPair(lines, 100, "AcDbLayerTableRecord");
    appendDxfPair(lines, 2, layer.name);
    appendDxfPair(lines, 70, 0);
    appendDxfPair(lines, 62, layer.color);
    appendDxfPair(lines, 6, "CONTINUOUS");
    appendDxfPair(lines, 370, -1);
  }

  appendDxfPair(lines, 0, "ENDTAB");
}

function appendDxfBlockRecordTable(lines, state) {
  const blockRecords = [
    { name: "*Model_Space", handle: state.handles.blockRecords.modelSpace },
    { name: "*Paper_Space", handle: state.handles.blockRecords.paperSpace },
    { name: "*Paper_Space0", handle: state.handles.blockRecords.paperSpace0 },
  ];

  appendDxfSymbolTableHeader(
    lines,
    "BLOCK_RECORD",
    state.handles.blockRecordTable,
    blockRecords.length
  );

  for (const blockRecord of blockRecords) {
    appendDxfPair(lines, 0, "BLOCK_RECORD");
    appendDxfPair(lines, 5, blockRecord.handle);
    appendDxfPair(lines, 330, state.handles.blockRecordTable);
    appendDxfPair(lines, 100, "AcDbSymbolTableRecord");
    appendDxfPair(lines, 100, "AcDbBlockTableRecord");
    appendDxfPair(lines, 2, blockRecord.name);
    appendDxfPair(lines, 70, 6);
    appendDxfPair(lines, 280, 0);
    appendDxfPair(lines, 281, 0);
  }

  appendDxfPair(lines, 0, "ENDTAB");
}

function appendDxfTablesSection(lines, state) {
  appendDxfPair(lines, 0, "SECTION");
  appendDxfPair(lines, 2, "TABLES");
  appendDxfLinetypeTable(lines, state);
  appendDxfLayerTable(lines, state);
  appendDxfBlockRecordTable(lines, state);
  appendDxfPair(lines, 0, "ENDSEC");
}

function appendDxfBlockDefinition(lines, name, recordHandle, handles) {
  appendDxfPair(lines, 0, "BLOCK");
  appendDxfPair(lines, 5, handles.begin);
  appendDxfPair(lines, 330, recordHandle);
  appendDxfPair(lines, 100, "AcDbEntity");
  appendDxfPair(lines, 8, "0");
  appendDxfPair(lines, 100, "AcDbBlockBegin");
  appendDxfPair(lines, 2, name);
  appendDxfPair(lines, 70, 0);
  appendDxfPair(lines, 10, "0.000");
  appendDxfPair(lines, 20, "0.000");
  appendDxfPair(lines, 30, "0.000");
  appendDxfPair(lines, 3, name);
  appendDxfPair(lines, 1, "");
  appendDxfPair(lines, 0, "ENDBLK");
  appendDxfPair(lines, 5, handles.end);
  appendDxfPair(lines, 330, recordHandle);
  appendDxfPair(lines, 100, "AcDbEntity");
  appendDxfPair(lines, 8, "0");
  appendDxfPair(lines, 100, "AcDbBlockEnd");
}

function appendDxfBlocksSection(lines, state) {
  appendDxfPair(lines, 0, "SECTION");
  appendDxfPair(lines, 2, "BLOCKS");
  appendDxfBlockDefinition(
    lines,
    "*Model_Space",
    state.handles.blockRecords.modelSpace,
    state.handles.blocks.modelSpace
  );
  appendDxfBlockDefinition(
    lines,
    "*Paper_Space",
    state.handles.blockRecords.paperSpace,
    state.handles.blocks.paperSpace
  );
  appendDxfBlockDefinition(
    lines,
    "*Paper_Space0",
    state.handles.blockRecords.paperSpace0,
    state.handles.blocks.paperSpace0
  );
  appendDxfPair(lines, 0, "ENDSEC");
}

function createLegacyDxfState(layers = []) {
  return {
    bounds: {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
    layerDefinitions: normalizeDxfLayerDefinitions(layers),
  };
}

function appendLegacyDxfHeaderSection(lines, state) {
  const bounds = getDxfDocumentBounds(state);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const centerX = Number(((bounds.minX + bounds.maxX) / 2).toFixed(3));
  const centerY = Number(((bounds.minY + bounds.maxY) / 2).toFixed(3));
  const viewSize = Number((Math.max(width, height) * 1.2).toFixed(3));
  appendDxfPair(lines, 0, "SECTION");
  appendDxfPair(lines, 2, "HEADER");
  appendDxfPair(lines, 9, "$ACADVER");
  appendDxfPair(lines, 1, "AC1009");
  appendDxfPair(lines, 9, "$INSBASE");
  appendDxfPair(lines, 10, "0.000");
  appendDxfPair(lines, 20, "0.000");
  appendDxfPair(lines, 30, "0.000");
  appendDxfPair(lines, 9, "$EXTMIN");
  appendDxfPair(lines, 10, formatDxfCoordinateValue(bounds.minX));
  appendDxfPair(lines, 20, formatDxfCoordinateValue(bounds.minY));
  appendDxfPair(lines, 30, formatDxfCoordinateValue(bounds.minZ));
  appendDxfPair(lines, 9, "$EXTMAX");
  appendDxfPair(lines, 10, formatDxfCoordinateValue(bounds.maxX));
  appendDxfPair(lines, 20, formatDxfCoordinateValue(bounds.maxY));
  appendDxfPair(lines, 30, formatDxfCoordinateValue(bounds.maxZ));
  appendDxfPair(lines, 9, "$LIMMIN");
  appendDxfPair(lines, 10, formatDxfCoordinateValue(bounds.minX));
  appendDxfPair(lines, 20, formatDxfCoordinateValue(bounds.minY));
  appendDxfPair(lines, 9, "$LIMMAX");
  appendDxfPair(lines, 10, formatDxfCoordinateValue(bounds.maxX));
  appendDxfPair(lines, 20, formatDxfCoordinateValue(bounds.maxY));
  appendDxfPair(lines, 9, "$VIEWCTR");
  appendDxfPair(lines, 10, formatDxfCoordinateValue(centerX));
  appendDxfPair(lines, 20, formatDxfCoordinateValue(centerY));
  appendDxfPair(lines, 9, "$VIEWSIZE");
  appendDxfPair(lines, 40, formatDxfCoordinateValue(viewSize));
  appendDxfPair(lines, 0, "ENDSEC");
}

function appendLegacyDxfLinetypeTable(lines) {
  appendDxfPair(lines, 0, "TABLE");
  appendDxfPair(lines, 2, "LTYPE");
  appendDxfPair(lines, 70, 1);
  appendDxfPair(lines, 0, "LTYPE");
  appendDxfPair(lines, 2, "CONTINUOUS");
  appendDxfPair(lines, 70, 0);
  appendDxfPair(lines, 3, "Solid line");
  appendDxfPair(lines, 72, 65);
  appendDxfPair(lines, 73, 0);
  appendDxfPair(lines, 40, 0);
  appendDxfPair(lines, 0, "ENDTAB");
}

function appendLegacyDxfLayerTable(lines, state) {
  appendDxfPair(lines, 0, "TABLE");
  appendDxfPair(lines, 2, "LAYER");
  appendDxfPair(lines, 70, state.layerDefinitions.length);

  for (const layer of state.layerDefinitions) {
    appendDxfPair(lines, 0, "LAYER");
    appendDxfPair(lines, 2, layer.name);
    appendDxfPair(lines, 70, 0);
    appendDxfPair(lines, 62, layer.color);
    appendDxfPair(lines, 6, "CONTINUOUS");
  }

  appendDxfPair(lines, 0, "ENDTAB");
}

function appendLegacyDxfTablesSection(lines, state) {
  appendDxfPair(lines, 0, "SECTION");
  appendDxfPair(lines, 2, "TABLES");
  appendLegacyDxfLinetypeTable(lines);
  appendLegacyDxfLayerTable(lines, state);
  appendDxfPair(lines, 0, "ENDSEC");
}

function appendDxfEntityCommon(state, lines, layerName, entityHandle) {
  if (!state?.handles) {
    appendDxfPair(lines, 8, layerName);
    return;
  }

  appendDxfPair(lines, 5, entityHandle);
  appendDxfPair(lines, 330, state.handles.blockRecords.modelSpace);
  appendDxfPair(lines, 100, "AcDbEntity");
  appendDxfPair(lines, 67, 0);
  appendDxfPair(lines, 8, layerName);
  appendDxfPair(lines, 6, "BYLAYER");
  appendDxfPair(lines, 62, 256);
  appendDxfPair(lines, 370, -1);
  appendDxfPair(lines, 410, "Model");
}

function appendDxfLineEntity(
  state,
  lines,
  layerName,
  startPoint,
  endPoint,
  elevation = 0
) {
  const zElevation = Number.isFinite(Number(elevation))
    ? Number(elevation)
    : 0;
  const entityHandle = state?.handles ? allocateDxfHandle(state) : null;
  appendDxfPair(lines, 0, "LINE");
  appendDxfEntityCommon(state, lines, layerName, entityHandle);

  if (state?.handles) {
    appendDxfPair(lines, 100, "AcDbLine");
  }

  appendDxfPair(lines, 10, formatDxfCoordinateValue(startPoint[0]));
  appendDxfPair(lines, 20, formatDxfCoordinateValue(startPoint[1]));
  appendDxfPair(lines, 30, formatDxfCoordinateValue(zElevation));
  appendDxfPair(lines, 11, formatDxfCoordinateValue(endPoint[0]));
  appendDxfPair(lines, 21, formatDxfCoordinateValue(endPoint[1]));
  appendDxfPair(lines, 31, formatDxfCoordinateValue(zElevation));
}

function appendDxfPathAsLineEntities(
  state,
  lines,
  layerName,
  points,
  { closed = false, elevation = 0 } = {}
) {
  const normalizedPoints = normalizeDxfPolylinePoints(points, { closed });
  const minimumPointCount = closed ? 3 : 2;

  if (normalizedPoints.length < minimumPointCount) {
    return;
  }

  updateDxfBounds(state, normalizedPoints, elevation);

  for (let index = 1; index < normalizedPoints.length; index += 1) {
    appendDxfLineEntity(
      state,
      lines,
      layerName,
      normalizedPoints[index - 1],
      normalizedPoints[index],
      elevation
    );
  }

  if (closed) {
    appendDxfLineEntity(
      state,
      lines,
      layerName,
      normalizedPoints[normalizedPoints.length - 1],
      normalizedPoints[0],
      elevation
    );
  }
}

function appendDxfFeaturePolygonLineEntities(
  state,
  lines,
  layerName,
  feature,
  center,
  options = {}
) {
  for (const ring of getFeaturePolygonRings(feature)) {
    appendDxfPathAsLineEntities(
      state,
      lines,
      layerName,
      getOpenRing(ring).map((point) => localMetersFromLngLat(point, center)),
      {
        ...options,
        closed: true,
      }
    );
  }
}

function normalizeDxfPolylinePoints(
  points,
  { closed = false, toleranceMeters = 0.001 } = {}
) {
  const normalized = [];

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
      !normalized.length ||
      !pointsMatchInMeters(
        normalized[normalized.length - 1],
        point,
        toleranceMeters
      )
    ) {
      normalized.push([Number(point[0]), Number(point[1])]);
    }
  }

  if (
    closed &&
    normalized.length >= 2 &&
    pointsMatchInMeters(
      normalized[0],
      normalized[normalized.length - 1],
      toleranceMeters
    )
  ) {
    normalized.pop();
  }

  return normalized;
}

function appendArrayItems(target, items, chunkSize = 4096) {
  if (!Array.isArray(target) || !Array.isArray(items) || !items.length) {
    return;
  }

  for (let index = 0; index < items.length; index += chunkSize) {
    target.push(...items.slice(index, index + chunkSize));
  }
}

function resolvePositiveInteger(value, fallback) {
  const normalized = Number(value);

  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallback;
  }

  return Math.round(normalized);
}

class HttpError extends Error {
  constructor(statusCode, message, headers = {}) {
    super(String(message || "Unexpected error"));
    this.name = "HttpError";
    this.statusCode = Number(statusCode) || 500;
    this.headers = headers && typeof headers === "object" ? headers : {};
  }
}

function createHttpError(statusCode, message, headers = {}) {
  return new HttpError(statusCode, message, headers);
}

function normalizePublicError(error) {
  if (error instanceof HttpError) {
    return error;
  }

  const message = String(error?.message || error || "").trim();

  if (!message) {
    return createHttpError(500, "Unexpected error");
  }

  if (/timed out after/i.test(message)) {
    return createHttpError(
      504,
      "외부 연계 서비스 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요."
    );
  }

  if (
    /VWorld|Juso|Nominatim|EUM|Building HUB|Open-Meteo|OpenTopoData|Overpass|fetch failed/i.test(
      message
    )
  ) {
    return createHttpError(
      502,
      "외부 연계 서비스 요청 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요."
    );
  }

  return createHttpError(500, message || "Unexpected error");
}

function formatByteLimit(bytes) {
  const normalized = Math.max(1, Number(bytes) || 0);

  if (normalized >= 1024 * 1024) {
    return `${(normalized / (1024 * 1024)).toFixed(
      normalized % (1024 * 1024) === 0 ? 0 : 1
    )}MB`;
  }

  if (normalized >= 1024) {
    return `${Math.round(normalized / 1024)}KB`;
  }

  return `${normalized}B`;
}

function normalizeIpAddress(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return "";
  }

  if (normalized === "::1") {
    return "127.0.0.1";
  }

  if (normalized.startsWith("::ffff:")) {
    return normalized.slice("::ffff:".length);
  }

  return normalized;
}

function isLoopbackIp(ipAddress) {
  const normalized = normalizeIpAddress(ipAddress);
  return normalized === "127.0.0.1" || normalized === "";
}

function readSingleHeaderValue(value) {
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }

  return String(value || "").trim();
}

function getClientIp(request) {
  const socketIp = normalizeIpAddress(request?.socket?.remoteAddress);

  if (isLoopbackIp(socketIp)) {
    const cfConnectingIp = normalizeIpAddress(
      readSingleHeaderValue(request?.headers?.["cf-connecting-ip"])
    );

    if (cfConnectingIp) {
      return cfConnectingIp;
    }

    const xForwardedFor = readSingleHeaderValue(
      request?.headers?.["x-forwarded-for"]
    );
    const forwardedIp = normalizeIpAddress(
      xForwardedFor.split(",")[0] || socketIp
    );

    if (forwardedIp) {
      return forwardedIp;
    }
  }

  return socketIp || "unknown";
}

function normalizeProgressToken(value) {
  const token = String(value || "").trim();

  if (!token) {
    return "";
  }

  return /^[A-Za-z0-9._:-]{1,120}$/.test(token) ? token : "";
}

function parseRequestContentLength(request) {
  const headerValue = readSingleHeaderValue(request?.headers?.["content-length"]);

  if (!headerValue) {
    return null;
  }

  const parsed = Number(headerValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isPathInsideDirectory(parentDir, candidatePath) {
  const relativePath = path.relative(parentDir, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function formatFetchTimeout(timeoutMs) {
  if (timeoutMs % 1000 === 0) {
    return `${timeoutMs / 1000}s`;
  }

  return `${(timeoutMs / 1000).toFixed(1)}s`;
}

async function fetchWithTimeout(resource, init = {}, options = {}) {
  const timeoutMs = Math.max(
    1,
    Number(options?.timeoutMs) || DEFAULT_OUTBOUND_FETCH_TIMEOUT_MS
  );
  const requestLabel = String(
    options?.requestLabel || "Outbound request"
  ).trim();
  const upstreamSignal = init?.signal;
  const abortController = new AbortController();
  let upstreamAbortHandler = null;
  const startedAt = Date.now();
  let upstreamHost = "";

  try {
    upstreamHost = new URL(String(resource || "")).host;
  } catch {
    upstreamHost = "";
  }

  if (upstreamSignal && typeof upstreamSignal.addEventListener === "function") {
    if (upstreamSignal.aborted) {
      abortController.abort(upstreamSignal.reason);
    } else {
      upstreamAbortHandler = () => {
        abortController.abort(upstreamSignal.reason);
      };
      upstreamSignal.addEventListener("abort", upstreamAbortHandler, {
        once: true,
      });
    }
  }

  const timeoutHandle = setTimeout(() => {
    abortController.abort(
      new Error(`${requestLabel} timed out after ${formatFetchTimeout(timeoutMs)}.`)
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  try {
    const response = await fetch(resource, {
      ...init,
      signal: abortController.signal,
    });
    recordUpstreamTelemetry({
      label: requestLabel,
      host: upstreamHost,
      outcome: response.ok ? "ok" : "http-error",
      statusCode: response.status,
      timeoutMs,
      durationMs: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    const message = String(error?.message || error || "");

    recordUpstreamTelemetry({
      label: requestLabel,
      host: upstreamHost,
      outcome:
        abortController.signal.aborted && !upstreamSignal?.aborted
          ? "timeout"
          : "error",
      timeoutMs,
      durationMs: Date.now() - startedAt,
      error: message,
    });

    if (abortController.signal.aborted && !upstreamSignal?.aborted) {
      throw new Error(
        `${requestLabel} timed out after ${formatFetchTimeout(timeoutMs)}.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutHandle);

    if (upstreamAbortHandler) {
      upstreamSignal.removeEventListener("abort", upstreamAbortHandler);
    }
  }
}

function buildSecurityHeaders(options = {}) {
  const frameAncestors = normalizeFrameAncestorList(
    options?.frameAncestors,
    DEFAULT_FRAME_ANCESTORS
  );
  const headers = {
    "Content-Security-Policy": buildContentSecurityPolicy(frameAncestors),
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };

  if (frameAncestors.length === 1 && frameAncestors[0] === "'none'") {
    headers["X-Frame-Options"] = "DENY";
  }

  return headers;
}

function buildResponseHeaders(headers = {}, options = {}) {
  return {
    ...buildSecurityHeaders(options),
    ...headers,
  };
}

function pruneRateLimitStore(now = Date.now()) {
  for (const [key, entry] of rateLimitStore.entries()) {
    if (Number(entry?.resetAt || 0) <= now) {
      rateLimitStore.delete(key);
    }
  }
}

function resolveRateLimitBucket(pathname, method) {
  if (!pathname.startsWith("/api/")) {
    return null;
  }

  if (pathname === "/api/request-progress" && method === "GET") {
    return "progress";
  }

  if (
    (pathname === "/api/export-model" ||
      pathname === "/api/export-obj" ||
      pathname === "/api/export-skp-payload") &&
    method === "POST"
  ) {
    return null;
  }

  if (
    (pathname === "/api/site-context" ||
      pathname === "/api/land-info" ||
      pathname === "/api/land-info-details" ||
      pathname === "/api/building-register") &&
    method === "POST"
  ) {
    return "heavy";
  }

  if (
    (pathname === "/api/geocode" || pathname === "/api/reverse-geocode") &&
    method === "GET"
  ) {
    return "search";
  }

  return "api";
}

function enforceRateLimit(request, response, config, bucket) {
  const policy = config.rateLimits?.[bucket];

  if (!policy?.maxRequests || !policy?.windowMs) {
    return true;
  }

  pruneRateLimitStore();
  const clientIp = getClientIp(request);
  const now = Date.now();
  const key = `${bucket}:${clientIp}`;
  const existing = rateLimitStore.get(key);
  const entry =
    existing && Number(existing.resetAt || 0) > now
      ? existing
      : {
          count: 0,
          resetAt: now + policy.windowMs,
        };

  if (entry.count >= policy.maxRequests) {
    sendJson(
      response,
      429,
      {
        error: policy.message || "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
      },
      {
        "Retry-After": String(
          Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
        ),
      }
    );
    return false;
  }

  entry.count += 1;
  rateLimitStore.set(key, entry);
  return true;
}

function formatDurationLabel(milliseconds) {
  const normalized = Math.max(0, Number(milliseconds) || 0);
  const totalSeconds = Math.max(1, Math.round(normalized / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}초`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (seconds === 0) {
    return `${minutes}분`;
  }

  return `${minutes}분 ${seconds}초`;
}

function recordCompletedExportDuration(durationMs) {
  const normalized = Number(durationMs);

  if (!Number.isFinite(normalized) || normalized <= 0) {
    return;
  }

  recentExportDurationsMs.push(normalized);

  if (recentExportDurationsMs.length > EXPORT_JOB_DURATION_HISTORY_LIMIT) {
    recentExportDurationsMs.splice(
      0,
      recentExportDurationsMs.length - EXPORT_JOB_DURATION_HISTORY_LIMIT
    );
  }
}

function estimateExportJobDurationMs() {
  if (recentExportDurationsMs.length === 0) {
    return DEFAULT_EXPORT_JOB_DURATION_ESTIMATE_MS;
  }

  const total = recentExportDurationsMs.reduce(
    (sum, value) => sum + Number(value || 0),
    0
  );
  return Math.max(
    1000,
    Math.round(total / Math.max(1, recentExportDurationsMs.length))
  );
}

function buildRuntimeStatsPayload() {
  return {
    ok: true,
    snapshotAt: new Date().toISOString(),
    uptimeSeconds: Number(process.uptime().toFixed(1)),
    exportJobs: {
      active: activeExportJobs,
      queued: exportJobWaitQueue.length,
      estimatedDurationMs: estimateExportJobDurationMs(),
    },
    caches: {
      geocodeEntries: geocodeCache.size,
      openMeteoEntries: openMeteoElevationCache.size,
      siteContextEntries: siteContextCache.size,
      eumLandPageEntries: eumLandPageCache.size,
      eumLandDetailsEntries: eumLandRelationDetailsCache.size,
      buildingRegisterEntries: buildingRegisterSummaryCache.size,
      buildingFloorEntries: buildingFloorOutlineCache.size,
      exportArtifactEntries: exportArtifactCache.size,
      requestProgressEntries: requestProgressStore.size,
    },
    telemetry: {
      recentSlowApiRequests: recentSlowApiRequestEvents.map((entry) => ({ ...entry })),
      recentGeocodeEvents: recentGeocodeEvents.map((entry) => ({
        ...entry,
        stages: Array.isArray(entry?.stages)
          ? entry.stages.map((stage) => ({ ...stage }))
          : [],
      })),
      recentUpstreamEvents: recentUpstreamEvents.map((entry) => ({ ...entry })),
    },
  };
}

function incrementActiveExportJobCountForClient(clientIp) {
  const normalizedClientIp = normalizeIpAddress(clientIp);

  if (!normalizedClientIp) {
    return;
  }

  activeExportJobsByClient.set(
    normalizedClientIp,
    (activeExportJobsByClient.get(normalizedClientIp) || 0) + 1
  );
}

function decrementActiveExportJobCountForClient(clientIp) {
  const normalizedClientIp = normalizeIpAddress(clientIp);

  if (!normalizedClientIp) {
    return;
  }

  const nextCount = Math.max(
    0,
    Number(activeExportJobsByClient.get(normalizedClientIp) || 0) - 1
  );

  if (nextCount > 0) {
    activeExportJobsByClient.set(normalizedClientIp, nextCount);
    return;
  }

  activeExportJobsByClient.delete(normalizedClientIp);
}

function countPendingExportJobsForClient(clientIp) {
  const normalizedClientIp = normalizeIpAddress(clientIp);

  if (!normalizedClientIp) {
    return 0;
  }

  const activeCount = Number(activeExportJobsByClient.get(normalizedClientIp) || 0);
  const queuedCount = exportJobWaitQueue.reduce((count, queuedJob) => {
    if (!queuedJob || queuedJob.released === true) {
      return count;
    }

    return normalizeIpAddress(queuedJob.clientIp) === normalizedClientIp
      ? count + 1
      : count;
  }, 0);

  return activeCount + queuedCount;
}

function buildQueuedExportJobSnapshot(queuePosition, maxConcurrentJobs, queueTimeoutMs, waitedMs = 0) {
  const normalizedPosition = Math.max(1, Number(queuePosition) || 1);
  const estimatedDurationMs = estimateExportJobDurationMs();
  const batchesAhead = Math.max(
    1,
    Math.ceil(normalizedPosition / Math.max(1, Number(maxConcurrentJobs) || 1))
  );
  const estimatedWaitMs = estimatedDurationMs * batchesAhead;

  return {
    position: normalizedPosition,
    queuedJobs: exportJobWaitQueue.length,
    activeJobs: activeExportJobs,
    maxConcurrentJobs: Math.max(1, Number(maxConcurrentJobs) || 1),
    queueTimeoutMs: Math.max(1000, Number(queueTimeoutMs) || DEFAULT_EXPORT_JOB_QUEUE_TIMEOUT_MS),
    waitedMs: Math.max(0, Number(waitedMs) || 0),
    estimatedWaitMs,
    remainingWaitMs: Math.max(0, estimatedWaitMs - (Number(waitedMs) || 0)),
  };
}

function notifyQueuedExportJobs(maxConcurrentJobs) {
  const now = Date.now();

  exportJobWaitQueue.forEach((queuedJob, index) => {
    if (!queuedJob || queuedJob.released === true || typeof queuedJob.onQueued !== "function") {
      return;
    }

    const waitedMs = Math.max(0, now - Number(queuedJob.enqueuedAt || now));
    queuedJob.onQueued(
      buildQueuedExportJobSnapshot(
        index + 1,
        maxConcurrentJobs,
        queuedJob.queueTimeoutMs,
        waitedMs
      )
    );
  });
}

function releaseNextQueuedExportJob(maxConcurrentJobs) {
  while (
    activeExportJobs < maxConcurrentJobs &&
    exportJobWaitQueue.length > 0
  ) {
    const queuedJob = exportJobWaitQueue.shift();

    if (!queuedJob || queuedJob.released === true) {
      continue;
    }

    queuedJob.released = true;
    clearTimeout(queuedJob.timeoutHandle);
    activeExportJobs += 1;
    incrementActiveExportJobCountForClient(queuedJob.clientIp);
    queuedJob.resolve();
    notifyQueuedExportJobs(maxConcurrentJobs);
    return true;
  }

  return false;
}

async function withExportJobSlot(config, work, options = {}) {
  const maxConcurrentJobs = Math.max(
    1,
    Number(config?.maxConcurrentExportJobs) || DEFAULT_MAX_CONCURRENT_EXPORT_JOBS
  );
  const queueTimeoutMs = Math.max(
    1000,
    Number(config?.exportJobQueueTimeoutMs) || DEFAULT_EXPORT_JOB_QUEUE_TIMEOUT_MS
  );
  const maxPendingJobsPerClient = Math.max(
    1,
    Number(config?.maxPendingExportJobsPerClient) ||
      DEFAULT_MAX_PENDING_EXPORT_JOBS_PER_CLIENT
  );
  const clientIp = normalizeIpAddress(options?.clientIp);
  let slotClaimed = false;
  let jobStartedAt = 0;

  if (clientIp && countPendingExportJobsForClient(clientIp) >= maxPendingJobsPerClient) {
    throw createHttpError(
      429,
      "같은 브라우저에서 진행 중이거나 대기 중인 모델 파일 작업이 너무 많습니다. 현재 작업이 끝난 뒤 다시 시도해주세요.",
      {
        "Retry-After": String(
          Math.max(5, Math.ceil(estimateExportJobDurationMs() / 1000))
        ),
      }
    );
  }

  if (activeExportJobs < maxConcurrentJobs && exportJobWaitQueue.length === 0) {
    activeExportJobs += 1;
    incrementActiveExportJobCountForClient(clientIp);
    slotClaimed = true;
    jobStartedAt = Date.now();
  } else {
    await new Promise((resolve, reject) => {
      const queuedJob = {
        clientIp,
        enqueuedAt: Date.now(),
        onQueued: typeof options?.onQueued === "function" ? options.onQueued : null,
        queueTimeoutMs,
        released: false,
        timeoutHandle: null,
        resolve: () => {
          slotClaimed = true;
          jobStartedAt = Date.now();
          resolve();
        },
        reject,
      };

      queuedJob.timeoutHandle = setTimeout(() => {
        if (queuedJob.released) {
          return;
        }

        queuedJob.released = true;
        const index = exportJobWaitQueue.indexOf(queuedJob);

        if (index !== -1) {
          exportJobWaitQueue.splice(index, 1);
        }

        notifyQueuedExportJobs(maxConcurrentJobs);
        reject(
          createHttpError(
            429,
            "모델 내보내기 대기열이 길어져 시간 내에 작업을 시작하지 못했습니다. 잠시 후 다시 시도해주세요.",
            {
              "Retry-After": "30",
            }
          )
        );
      }, queueTimeoutMs);

      exportJobWaitQueue.push(queuedJob);
      notifyQueuedExportJobs(maxConcurrentJobs);
    });
  }

  try {
    return await work();
  } finally {
    if (slotClaimed) {
      recordCompletedExportDuration(Date.now() - jobStartedAt);
      activeExportJobs = Math.max(0, activeExportJobs - 1);
      decrementActiveExportJobCountForClient(clientIp);
      releaseNextQueuedExportJob(maxConcurrentJobs);
    }
  }
}

function appendDxfPolylineEntity(
  state,
  lines,
  layerName,
  points,
  { closed = false, elevation = 0 } = {}
) {
  const normalizedPoints = normalizeDxfPolylinePoints(points, { closed });
  const minimumPointCount = closed ? 3 : 2;

  if (normalizedPoints.length < minimumPointCount) {
    return;
  }

  const zElevation = Number.isFinite(Number(elevation))
    ? Number(elevation)
    : 0;
  const entityHandle = allocateDxfHandle(state);

  updateDxfBounds(state, normalizedPoints, zElevation);

  appendDxfPair(lines, 0, "LWPOLYLINE");
  appendDxfPair(lines, 5, entityHandle);
  appendDxfPair(lines, 330, state.handles.blockRecords.modelSpace);
  appendDxfPair(lines, 100, "AcDbEntity");
  appendDxfPair(lines, 67, 0);
  appendDxfPair(lines, 8, layerName);
  appendDxfPair(lines, 6, "BYLAYER");
  appendDxfPair(lines, 62, 256);
  appendDxfPair(lines, 370, -1);
  appendDxfPair(lines, 410, "Model");
  appendDxfPair(lines, 100, "AcDbPolyline");
  appendDxfPair(lines, 90, normalizedPoints.length);
  appendDxfPair(lines, 70, closed ? 1 : 0);

  if (Math.abs(zElevation) > 0.0005) {
    appendDxfPair(lines, 38, formatDxfCoordinateValue(zElevation));
  }

  for (const [xMeters, yMeters] of normalizedPoints) {
    appendDxfPair(lines, 10, formatDxfCoordinateValue(xMeters));
    appendDxfPair(lines, 20, formatDxfCoordinateValue(yMeters));
  }

  appendDxfPair(lines, 210, "0.000");
  appendDxfPair(lines, 220, "0.000");
  appendDxfPair(lines, 230, "1.000");
}

function appendDxfFeaturePolygonEntities(
  state,
  lines,
  layerName,
  feature,
  center,
  options = {}
) {
  for (const ring of getFeaturePolygonRings(feature)) {
    appendDxfPolylineEntity(
      state,
      lines,
      layerName,
      getOpenRing(ring).map((point) => localMetersFromLngLat(point, center)),
      {
        ...options,
        closed: true,
      }
    );
  }
}

function buildDxfFromSiteContext(siteContext, reportProgress = null) {
  const location = siteContext.location;
  const center = { lat: location.lat, lng: location.lng };
  const progress =
    typeof reportProgress === "function" ? reportProgress : () => null;
  const layers = [
    { name: "CLIP_BOUNDARY", color: 1 },
    { name: "PARCEL_BOUNDARY", color: 30 },
    { name: "PARCEL_CONTEXT", color: 94 },
    { name: "CONTOURS", color: 8 },
    { name: "BUILDINGS", color: 252 },
    { name: "TARGET_BUILDING", color: 10 },
    { name: "ROADS", color: 5 },
  ];
  const state = createLegacyDxfState(layers);
  const entityLines = [];
  const lines = [];

  progress(6, "DXF 湲곕낯 援ъ“瑜?留뚮뱶??以묒엯?덈떎.");

  progress(18, "DXF 寃쎄퀎 ?붿냼瑜??뺣━?섎뒗 以묒엯?덈떎.");
  appendDxfFeaturePolygonLineEntities(
    state,
    entityLines,
    "CLIP_BOUNDARY",
    siteContext.clipBoundary,
    center
  );

  if (siteContext.options?.includeParcelBoundary !== false) {
    appendDxfFeaturePolygonLineEntities(
      state,
      entityLines,
      "PARCEL_BOUNDARY",
      siteContext.parcelBoundary,
      center
    );

    for (const feature of siteContext.parcelContext?.features || []) {
      appendDxfFeaturePolygonLineEntities(
        state,
        entityLines,
        "PARCEL_CONTEXT",
        feature,
        center
      );
    }
  }

  if (siteContext.options?.includeContours !== false) {
    progress(42, "DXF ?깃퀬??寃쎅퀎瑜??붽??섎뒗 以묒엯?덈떎.");

    for (const feature of siteContext.contourLines?.features || []) {
      for (const lineString of getLineStringsFromGeometry(feature.geometry)) {
        appendDxfPathAsLineEntities(
          state,
          entityLines,
          "CONTOURS",
          lineString.map((point) => localMetersFromLngLat(point, center)),
          {
            closed: false,
            elevation: FLAT_EXPORT_CURVE_ELEVATION,
          }
        );
      }
    }
  }

  if (siteContext.options?.includeBuildings !== false) {
    progress(62, "DXF 嫄대Ъ footprint瑜??붽??섎뒗 以묒엯?덈떎.");

    for (const feature of siteContext.buildings?.features || []) {
      appendDxfFeaturePolygonLineEntities(
        state,
        entityLines,
        feature.properties?.isTarget ? "TARGET_BUILDING" : "BUILDINGS",
        feature,
        center
      );
    }
  }

  if (siteContext.options?.includeRoads === true) {
    progress(78, "DXF ?꾨줈 footprint瑜??붽??섎뒗 以묒엯?덈떎.");

    if (siteContext.options?.terrainMode === "contour") {
      const roadSurfaceGroups = buildRoadContourSurfaceGroups(siteContext, center);

      for (const group of roadSurfaceGroups) {
        for (const region of group.regions) {
          appendDxfPathAsLineEntities(
            state,
            entityLines,
            "ROADS",
            region.outerPoints,
            {
              closed: true,
              elevation: FLAT_EXPORT_CURVE_ELEVATION,
            }
          );

          for (const holePoints of region.holePoints || []) {
            appendDxfPathAsLineEntities(
              state,
              entityLines,
              "ROADS",
              holePoints,
              {
                closed: true,
                elevation: FLAT_EXPORT_CURVE_ELEVATION,
              }
            );
          }
        }
      }
    } else {
      const roadFootprintMultiPolygon = getCachedRoadFootprintMultiPolygon(
        siteContext,
        center
      );

      for (const polygon of roadFootprintMultiPolygon) {
        for (const ring of polygon || []) {
          appendDxfPathAsLineEntities(state, entityLines, "ROADS", ring, {
            closed: true,
          });
        }
      }
    }
  }

  appendLegacyDxfHeaderSection(lines, state);
  appendLegacyDxfTablesSection(lines, state);
  appendDxfPair(lines, 0, "SECTION");
  appendDxfPair(lines, 2, "ENTITIES");
  appendArrayItems(lines, entityLines);
  progress(94, "DXF ?뚯씪??留덈Т由ы븯??以묒엯?덈떎.");
  appendDxfPair(lines, 0, "ENDSEC");
  appendDxfPair(lines, 0, "EOF");
  return `${lines.join("\r\n")}\r\n`;
}

function createRhinoObjectAttributes(
  rhino,
  layerIndex,
  name = "",
  color = null,
  groupIndices = []
) {
  const attributes = new rhino.ObjectAttributes();
  attributes.layerIndex = layerIndex;
  attributes.name = String(name || "");

  if (color) {
    attributes.colorSource = rhino.ObjectColorSource.ColorFromObject;
    attributes.objectColor = color;
  }

  for (const groupIndex of Array.isArray(groupIndices)
    ? groupIndices
    : Number.isInteger(groupIndices)
      ? [groupIndices]
      : []) {
    if (Number.isInteger(groupIndex) && groupIndex >= 0) {
      attributes.addToGroup(groupIndex);
    }
  }

  return attributes;
}

function ensureRhinoLayer(doc, layerIndexCache, name, color) {
  if (!layerIndexCache.has(name)) {
    layerIndexCache.set(name, doc.layers().addLayer(name, color));
  }

  return layerIndexCache.get(name);
}

function ensureRhinoGroup(doc, rhino, groupIndexCache, name) {
  if (!name) {
    return null;
  }

  if (!groupIndexCache.has(name)) {
    let group = doc.groups().findName(name);

    if (!group) {
      group = new rhino.Group();
      group.name = name;
      doc.groups().add(group);
      group = doc.groups().findName(name);
    }

    groupIndexCache.set(
      name,
      Number.isInteger(group?.index) ? group.index : null
    );
  }

  return groupIndexCache.get(name);
}

function createRhinoPolylineCurve(rhino, points) {
  return new rhino.PolylineCurve(points);
}

function dedupePolylinePoints(points, toleranceMeters = 0.001) {
  const deduped = [];

  for (const point of points || []) {
    if (
      !Array.isArray(point) ||
      point.length < 3 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      !Number.isFinite(point[2])
    ) {
      continue;
    }

    const previousPoint = deduped[deduped.length - 1];

    if (
      !previousPoint ||
      Math.abs(previousPoint[0] - point[0]) > toleranceMeters ||
      Math.abs(previousPoint[1] - point[1]) > toleranceMeters ||
      Math.abs(previousPoint[2] - point[2]) > toleranceMeters
    ) {
      deduped.push([point[0], point[1], point[2]]);
    }
  }

  return deduped;
}

function createRhinoContourDisplayCurve(rhino, points) {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }

  const normalizedPoints = dedupePolylinePoints(
    points.map((point) =>
      Array.isArray(point) && point.length >= 2
        ? [Number(point[0]), Number(point[1]), FLAT_EXPORT_CURVE_ELEVATION]
        : point
    )
  ).filter(
    (point) =>
      Array.isArray(point) &&
      point.length >= 3 &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]) &&
      Number.isFinite(point[2])
  );

  if (normalizedPoints.length < 2) {
    return null;
  }

  return createRhinoPolylineCurve(rhino, normalizedPoints);
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
  objectName,
  groupIndices = []
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
    createRhinoObjectAttributes(rhino, layerIndex, objectName, null, groupIndices)
  );
}

function addRhinoContourBandRegionExtrusion(
  doc,
  rhino,
  layerIndex,
  region,
  topElevation,
  bottomElevation,
  objectName,
  groupIndices = []
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
    createRhinoObjectAttributes(rhino, layerIndex, objectName, null, groupIndices)
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

function addRhinoContourTerrainRegions(
  doc,
  rhino,
  layerIndex,
  regions,
  topElevation,
  bottomElevation,
  objectNamePrefix,
  mesh,
  vertexCache,
  groupIndices = []
) {
  if (topElevation <= bottomElevation) {
    return;
  }

  for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
    const region = regions[regionIndex];

    if (
      addRhinoContourBandRegionExtrusion(
        doc,
        rhino,
        layerIndex,
        region,
        topElevation,
        bottomElevation,
        `${objectNamePrefix}_${regionIndex + 1}`,
        groupIndices
      )
    ) {
      continue;
    }

    addRhinoMeshRegionCapFaces(mesh, vertexCache, region, topElevation, false);
    addRhinoMeshRegionCapFaces(mesh, vertexCache, region, bottomElevation, true);

    addRhinoMeshVerticalLoopFaces(
      mesh,
      vertexCache,
      region.outerPoints,
      topElevation,
      bottomElevation
    );

    for (const holePoints of region.holePoints || []) {
      addRhinoMeshVerticalLoopFaces(
        mesh,
        vertexCache,
        holePoints,
        topElevation,
        bottomElevation
      );
    }
  }
}

function resolveRhinoParcelGroupIndices(parcelGroupIndexMap, targetGroupIndex) {
  if (
    parcelGroupIndexMap instanceof Map &&
    Number.isInteger(targetGroupIndex) &&
    parcelGroupIndexMap.has(targetGroupIndex)
  ) {
    return [parcelGroupIndexMap.get(targetGroupIndex)];
  }

  return [];
}

function addRhinoContourBandTerrain(
  doc,
  rhino,
  layerIndex,
  siteContext,
  parcelGroupIndexMap = null
) {
  const terrainPlan = resolveContourTerrainRenderPlan(siteContext);

  if (!terrainPlan) {
    return;
  }

  const {
    baseElevation,
    clipPolygon,
    minBandElevation,
    bandGroups,
    flatTopElevation,
    useFlatFallback,
  } = terrainPlan;

  if (useFlatFallback) {
    const mesh = new rhino.Mesh();
    const vertexCache = new Map();
    const flatSegments = splitTerrainMultiPolygonByParcelBoundary(
      siteContext,
      buildLocalMultiPolygonFromOpenRing(clipPolygon)
    );

    for (const segment of flatSegments) {
      const segmentGroupIndices = resolveRhinoParcelGroupIndices(
        parcelGroupIndexMap,
        Number(segment?.groupIndex || Number.NaN)
      );

      if (segment.kind === "combined" && segment.regions.length === 1) {
        addRhinoPrismFromPolygon(
          doc,
          rhino,
          layerIndex,
          segment.regions[0].outerPoints,
          flatTopElevation,
          baseElevation,
          "TERRAIN_CONTOUR_FLAT",
          segmentGroupIndices
        );
        continue;
      }

      addRhinoContourTerrainRegions(
        doc,
        rhino,
        layerIndex,
        segment.regions,
        flatTopElevation,
        baseElevation,
        `TERRAIN_CONTOUR_FLAT_${String(segment.kind || "part").toUpperCase()}`,
        mesh,
        vertexCache,
        segmentGroupIndices
      );
    }

    if (mesh.vertices().count && mesh.faces().count) {
      doc.objects().add(
        mesh,
        createRhinoObjectAttributes(rhino, layerIndex, "TERRAIN_CONTOUR_FLAT_MESH")
      );
    }
    return;
  }

  if (clipPolygon.length >= 3 && minBandElevation > baseElevation + 0.001) {
    const mesh = new rhino.Mesh();
    const vertexCache = new Map();
    const baseSegments = splitTerrainMultiPolygonByParcelBoundary(
      siteContext,
      buildLocalMultiPolygonFromOpenRing(clipPolygon)
    );

    for (const segment of baseSegments) {
      const segmentGroupIndices = resolveRhinoParcelGroupIndices(
        parcelGroupIndexMap,
        Number(segment?.groupIndex || Number.NaN)
      );

      if (segment.kind === "combined" && segment.regions.length === 1) {
        addRhinoPrismFromPolygon(
          doc,
          rhino,
          layerIndex,
          segment.regions[0].outerPoints,
          minBandElevation,
          baseElevation,
          "TERRAIN_BASE",
          segmentGroupIndices
        );
        continue;
      }

      addRhinoContourTerrainRegions(
        doc,
        rhino,
        layerIndex,
        segment.regions,
        minBandElevation,
        baseElevation,
        `TERRAIN_BASE_${String(segment.kind || "part").toUpperCase()}`,
        mesh,
        vertexCache,
        segmentGroupIndices
      );
    }

    if (mesh.vertices().count && mesh.faces().count) {
      doc.objects().add(
        mesh,
        createRhinoObjectAttributes(rhino, layerIndex, "TERRAIN_BASE_MESH")
      );
    }
  }

  const mesh = new rhino.Mesh();
  const vertexCache = new Map();

  for (let groupIndex = 0; groupIndex < bandGroups.length; groupIndex += 1) {
    const group = bandGroups[groupIndex];
    const effectiveBottomElevation = Number(
      Math.max(baseElevation, group.bottomElevation - TERRAIN_BAND_OVERLAP_METERS).toFixed(3)
    );

    const groupSegments = splitTerrainMultiPolygonByParcelBoundary(
      siteContext,
      group.multiPolygon ||
        buildPolygonClippingMultiPolygonFromRegions(group.regions)
    );

    for (const segment of groupSegments) {
      const segmentGroupIndices = resolveRhinoParcelGroupIndices(
        parcelGroupIndexMap,
        Number(segment?.groupIndex || Number.NaN)
      );

      addRhinoContourTerrainRegions(
        doc,
        rhino,
        layerIndex,
        segment.regions,
        group.topElevation,
        effectiveBottomElevation,
        `TERRAIN_BAND_${groupIndex + 1}_${String(segment.kind || "part").toUpperCase()}`,
        mesh,
        vertexCache,
        segmentGroupIndices
      );
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
  seed,
  parcelGroupIndexMap = null
) {
  for (const feature of siteContext.buildings?.features || []) {
    const ring = getOpenRing(getOuterRing(feature));

    if (ring.length < 3) {
      continue;
    }

    const placementInfo = resolveBuildingPlacementForRing(
      siteContext,
      ring,
      center,
      seed
    );
    applyBuildingPlacementDebug(feature, placementInfo);
    const buildingBaseElevation = placementInfo?.finalBaseElevation ?? null;
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
        ,
        feature.properties?.isTarget
          ? resolveRhinoParcelGroupIndices(
              parcelGroupIndexMap,
              Number(feature.properties?.targetParcelGroupIndex || Number.NaN)
            )
          : []
      )
    );
  }
}

function addRhinoRoadPrismMesh(mesh, polygonPoints, siteContext, seed) {
  if (!polygonPoints?.length || polygonPoints.length < 3) {
    return;
  }

  const baseIndices = [];
  const topIndices = [];

  for (const [xMeters, yMeters] of polygonPoints) {
    const baseElevation =
      siteHeightAtLocalPoint(siteContext, xMeters, yMeters, seed) +
      ROAD_SURFACE_OFFSET_METERS;
    const topElevation = baseElevation + ROAD_SURFACE_THICKNESS_METERS;

    baseIndices.push(mesh.vertices().add(xMeters, yMeters, baseElevation));
    topIndices.push(mesh.vertices().add(xMeters, yMeters, topElevation));
  }

  for (let index = 0; index < polygonPoints.length; index += 1) {
    const nextIndex = (index + 1) % polygonPoints.length;
    mesh.faces().addQuadFace(
      baseIndices[index],
      baseIndices[nextIndex],
      topIndices[nextIndex],
      topIndices[index]
    );
  }

  if (topIndices.length >= 4) {
    mesh.faces().addQuadFace(
      topIndices[0],
      topIndices[1],
      topIndices[2],
      topIndices[3]
    );
    mesh.faces().addQuadFace(
      baseIndices[3],
      baseIndices[2],
      baseIndices[1],
      baseIndices[0]
    );
  }
}

function addRhinoRoads(doc, rhino, layerIndex, siteContext, center, seed) {
  const mesh = new rhino.Mesh();
  let polygonCount = 0;
  let segmentCount = 0;

  for (const feature of siteContext.roads?.features || []) {
    if (
      feature?.geometry?.type === "Polygon" ||
      feature?.geometry?.type === "MultiPolygon"
    ) {
      for (const ring of getOuterRings(feature)) {
        const openRing = getOpenRing(ring);

        if (openRing.length < 3) {
          continue;
        }

        addRhinoRoadPrismMesh(
          mesh,
          openRing.map((point) => localMetersFromLngLat(point, center)),
          siteContext,
          seed
        );
        polygonCount += 1;
      }

      continue;
    }

    const widthMeters = resolveRoadWidthMeters(feature);

    for (const lineString of getLineStringsFromGeometry(feature.geometry)) {
      for (let index = 0; index < lineString.length - 1; index += 1) {
        const startPoint = localMetersFromLngLat(lineString[index], center);
        const endPoint = localMetersFromLngLat(lineString[index + 1], center);
        const quads = buildRoadSegmentLocalQuads(
          startPoint,
          endPoint,
          widthMeters,
          siteContext
        );

        for (const quad of quads) {
          addRhinoRoadPrismMesh(mesh, quad, siteContext, seed);
          segmentCount += 1;
        }
      }
    }
  }

  const vertexCount = Number(mesh.vertices().count || 0);
  const faceCount = Number(mesh.faces().count || 0);

  if (vertexCount && faceCount) {
    if (typeof mesh.compact === "function") {
      mesh.compact();
    }

    try {
      if (typeof mesh.normals === "function") {
        const normals = mesh.normals();

        if (normals && typeof normals.computeNormals === "function") {
          normals.computeNormals();
        }
      }
    } catch {
      // Rhino can still display the mesh without precomputed normals.
    }

    doc.objects().add(
      mesh,
      createRhinoObjectAttributes(rhino, layerIndex, "ROADS", {
        r: 22,
        g: 119,
        b: 255,
      })
    );
  }

  return {
    vertexCount,
    faceCount,
    polygonCount,
    segmentCount,
    objectCount: vertexCount && faceCount ? 1 : 0,
  };
}

function addRhinoContourBandRoadSolids(
  doc,
  rhino,
  layerIndex,
  siteContext,
  center,
  parcelGroupIndexMap = null
) {
  const roadSurfaceGroups = buildRoadContourSurfaceGroups(siteContext, center);
  let objectCount = 0;

  for (let groupIndex = 0; groupIndex < roadSurfaceGroups.length; groupIndex += 1) {
    const group = roadSurfaceGroups[groupIndex];
    const bottomElevation = Number(
      (group.elevation + ROAD_SURFACE_OFFSET_METERS).toFixed(3)
    );
    const topElevation = Number(
      (bottomElevation + ROAD_SURFACE_THICKNESS_METERS).toFixed(3)
    );
    const groupSegments = splitTerrainMultiPolygonByParcelBoundary(
      siteContext,
      buildPolygonClippingMultiPolygonFromRegions(group.regions)
    );

    for (const segment of groupSegments) {
      const segmentGroupIndices = resolveRhinoParcelGroupIndices(
        parcelGroupIndexMap,
        Number(segment?.groupIndex || Number.NaN)
      );

      for (
        let regionIndex = 0;
        regionIndex < segment.regions.length;
        regionIndex += 1
      ) {
        if (
          addRhinoContourBandRegionExtrusion(
            doc,
            rhino,
            layerIndex,
            segment.regions[regionIndex],
            topElevation,
            bottomElevation,
            `ROAD_BAND_${groupIndex + 1}_${String(segment.kind || "part").toUpperCase()}_${regionIndex + 1}`,
            segmentGroupIndices
          )
        ) {
          objectCount += 1;
        }
      }
    }
  }

  return {
    groupCount: roadSurfaceGroups.length,
    objectCount,
  };
}

function addRhinoRoadCenterlines(doc, rhino, layerIndex, siteContext, center, seed) {
  let objectCount = 0;
  let lineCount = 0;

  for (const feature of siteContext.roads?.features || []) {
    const widthMeters = resolveRoadWidthMeters(feature);
    const coordinateSets =
      feature?.geometry?.type === "LineString" ||
      feature?.geometry?.type === "MultiLineString"
        ? getLineStringsFromGeometry(feature.geometry)
        : getOuterRings(feature);

    for (let lineIndex = 0; lineIndex < coordinateSets.length; lineIndex += 1) {
      const coordinates = coordinateSets[lineIndex];
      const path = buildRoadLocalPath(
        coordinates,
        center,
        siteContext,
        widthMeters
      );

      if (!path.length || path.length < 2) {
        continue;
      }

      const points = path.map(([xMeters, yMeters]) => {
        return [xMeters, yMeters, FLAT_EXPORT_CURVE_ELEVATION];
      });

      doc.objects().add(
        createRhinoPolylineCurve(rhino, points),
        createRhinoObjectAttributes(
          rhino,
          layerIndex,
          `ROAD_CENTERLINE_${objectCount + 1}`,
          { r: 22, g: 119, b: 255 }
        )
      );
      objectCount += 1;
      lineCount += 1;
    }
  }

  return {
    objectCount,
    lineCount,
  };
}

function addRhinoPolylineCollection(
  doc,
  rhino,
  layerIndex,
  features,
  center,
  elevationResolver,
  options = {}
) {
  const objectNamePrefix = String(options.objectNamePrefix || "");
  const groupIndicesResolver =
    typeof options.groupIndicesResolver === "function"
      ? options.groupIndicesResolver
      : null;
  let objectIndex = 0;

  for (const feature of features) {
    const coordinateSets =
      feature?.geometry?.type === "LineString" ||
      feature?.geometry?.type === "MultiLineString"
        ? getLineStringsFromGeometry(feature.geometry)
        : getFeaturePolygonRings(feature);

    for (const coordinates of coordinateSets) {
      if (!coordinates?.length) {
        continue;
      }

      const points = coordinates.map((point) => {
        const [xMeters, yMeters] = localMetersFromLngLat(point, center);
        return [xMeters, yMeters, elevationResolver(point, xMeters, yMeters)];
      });

      objectIndex += 1;
      doc.objects().add(
        createRhinoPolylineCurve(rhino, points),
        createRhinoObjectAttributes(
          rhino,
          layerIndex,
          objectNamePrefix ? `${objectNamePrefix}_${objectIndex}` : "",
          null,
          groupIndicesResolver ? groupIndicesResolver(feature, coordinates) : []
        )
      );
    }
  }
}

function prepareSiteContextForExport(siteContext, requestedOptions, format) {
  const exportSiteContext = cloneSiteContextForExport(siteContext);
  exportSiteContext.options = {
    ...(exportSiteContext?.options || {}),
    ...(requestedOptions || {}),
    exportFormat: format,
  };
  exportSiteContext.stats = {
    ...(exportSiteContext?.stats || {}),
  };
  exportSiteContext.dataSources = {
    ...(exportSiteContext?.dataSources || {}),
    terrain: exportSiteContext?.dataSources?.terrain
      ? { ...exportSiteContext.dataSources.terrain }
      : exportSiteContext?.dataSources?.terrain,
    contours: exportSiteContext?.dataSources?.contours
      ? { ...exportSiteContext.dataSources.contours }
      : exportSiteContext?.dataSources?.contours,
  };
  maybeRefineSketchUpTerrainGrid(exportSiteContext);
  const requestedContourInterval = normalizeContourInterval(
    exportSiteContext.options?.contourInterval
  );
  const sourceContourInterval = resolveSourceContourInterval(exportSiteContext);
  exportSiteContext.options.contourInterval = requestedContourInterval;
  const effectiveContourBandInterval = resolveEffectiveContourBandInterval(
    exportSiteContext
  );

  exportSiteContext.stats.requestedContourInterval = requestedContourInterval;
  exportSiteContext.stats.sourceContourInterval = sourceContourInterval;
  exportSiteContext.stats.effectiveContourBandInterval =
    effectiveContourBandInterval;
  exportSiteContext.stats.effectiveContourDisplayInterval =
    requestedContourInterval;
  exportSiteContext.stats.buildingPlacementDebug = buildBuildingPlacementDiagnostics(
    exportSiteContext
  );

  if (exportSiteContext.dataSources?.contours) {
    exportSiteContext.dataSources.contours.interval = sourceContourInterval;
  }

  const displayContourInterval = resolveRequestedContourDisplayInterval(
    exportSiteContext
  );
  const currentDisplayInterval = inferSourceContourIntervalFromContourLines(
    exportSiteContext.contourLines
  );
  const preserveNativeContourDisplayLines =
    shouldPreserveNativeContourDisplayLines(format) &&
    Boolean(exportSiteContext.contourLines?.features?.length);

  exportSiteContext.stats.effectiveContourDisplayInterval =
    preserveNativeContourDisplayLines &&
    Number.isFinite(currentDisplayInterval) &&
    currentDisplayInterval > 0
      ? normalizeContourInterval(currentDisplayInterval)
      : requestedContourInterval;

  if (
    !preserveNativeContourDisplayLines &&
    (format === "obj" ||
      format === "skp" ||
      format === "skp-payload" ||
      format === "3dm") &&
    exportSiteContext.options?.terrainMode === "contour" &&
    exportSiteContext.options?.includeContours !== false &&
    exportSiteContext.terrainGrid?.elevations?.length &&
    (
      !exportSiteContext.contourLines?.features?.length ||
      !Number.isFinite(currentDisplayInterval) ||
      Math.abs(displayContourInterval - currentDisplayInterval) > 1e-9
    )
  ) {
    exportSiteContext.contourLines = createContourLinesFromTerrainGrid(
      exportSiteContext.location,
      exportSiteContext.terrainGrid,
      {
        ...exportSiteContext.options,
        contourInterval: displayContourInterval,
      }
    );
  }

  console.log(
    `[export-terrain] format=${format} requested=${requestedContourInterval} source=${sourceContourInterval} effective=${effectiveContourBandInterval} display=${exportSiteContext.stats.effectiveContourDisplayInterval} preserveNativeContours=${preserveNativeContourDisplayLines} skpTerrainStep=${Number(exportSiteContext?.terrainGrid?.step || 0).toFixed(3)} refined=${exportSiteContext?.stats?.skpTerrainGridRefined === true}`
  );

  return exportSiteContext;
}

async function build3dmFromSiteContext(siteContext, reportProgress = null) {
  const progress =
    typeof reportProgress === "function" ? reportProgress : () => null;
  progress(6, "3DM 엔진을 준비하는 중입니다.");
  const rhino = await getRhino3dm();
  const doc = new rhino.File3dm();
  const docSettings = doc.settings();
  if (docSettings) {
    docSettings.modelUnitSystem = rhino.UnitSystem.Meters;
    docSettings.pageUnitSystem = rhino.UnitSystem.Meters;
    docSettings.modelAbsoluteTolerance = 0.001;
  }
  const center = {
    lat: Number(siteContext.location?.lat),
    lng: Number(siteContext.location?.lng),
  };
  const seed = Math.round(Math.abs(center.lat * 1000) + Math.abs(center.lng * 1000));
  const layerIndexCache = new Map();
  const groupIndexCache = new Map();
  const targetParcelFeatures = getTargetParcelGroupFeatures(siteContext);
  const parcelGroupIndexMap = shouldGroupParcelCutContent(siteContext)
    ? new Map(
        targetParcelFeatures.map((feature, index) => {
          const targetGroupIndex = Number(feature?.properties?.groupIndex || index + 1);
          const groupName = buildParcelGroupExportName(feature, index);

          return [
            targetGroupIndex,
            ensureRhinoGroup(doc, rhino, groupIndexCache, groupName),
          ];
        })
      )
    : new Map();
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
  const targetParcelLayer = ensureRhinoLayer(doc, layerIndexCache, "site-parcel", {
    r: 191,
    g: 81,
    b: 42,
  });
  const parcelContextLayer = ensureRhinoLayer(doc, layerIndexCache, "parcel-context", {
    r: 92,
    g: 122,
    b: 99,
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
    addRhinoContourBandTerrain(
      doc,
      rhino,
      terrainLayer,
      siteContext,
      parcelGroupIndexMap
    );
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
      seed,
      parcelGroupIndexMap
    );
  }

  if (siteContext.options?.includeParcelBoundary !== false) {
    progress(74, "필지 경계선을 추가하는 중입니다.");
    addRhinoPolylineCollection(
      doc,
      rhino,
      targetParcelLayer,
      targetParcelFeatures.length
        ? targetParcelFeatures
        : [siteContext.parcelBoundary].filter(Boolean),
      center,
      () => FLAT_EXPORT_CURVE_ELEVATION,
      {
        objectNamePrefix: "PARCEL_BOUNDARY",
        groupIndicesResolver: (feature) =>
          resolveRhinoParcelGroupIndices(
            parcelGroupIndexMap,
            Number(feature?.properties?.groupIndex || Number.NaN)
          ),
      }
    );

    if (siteContext.parcelContext?.features?.length) {
      addRhinoPolylineCollection(
        doc,
        rhino,
        parcelContextLayer,
        siteContext.parcelContext.features,
        center,
        () => FLAT_EXPORT_CURVE_ELEVATION
      );
    }
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
          createRhinoContourDisplayCurve(rhino, points),
          createRhinoObjectAttributes(
            rhino,
            contourLayer,
            `CONTOUR_${index + 1}_${lineIndex + 1}`,
            null,
            (() => {
              const targetParcelFeature = resolveTargetParcelGroupForLineString(
                lineStrings[lineIndex],
                targetParcelFeatures
              );
              return resolveRhinoParcelGroupIndices(
                parcelGroupIndexMap,
                Number(targetParcelFeature?.properties?.groupIndex || Number.NaN)
              );
            })()
          )
        );
      }
    }
  }

  if (siteContext.options?.includeRoads === true) {
    progress(92, "3DM 도로 레이어를 추가하는 중입니다.");
    const roadLayer = ensureRhinoLayer(doc, layerIndexCache, "roads", {
      r: 91,
      g: 112,
      b: 121,
    });
    if (siteContext.options?.terrainMode === "contour") {
      const roadSolidStats = addRhinoContourBandRoadSolids(
        doc,
        rhino,
        roadLayer,
        siteContext,
        center,
        parcelGroupIndexMap
      );
      console.log(
        `[export-3dm] roads features=${Number(
          siteContext.roads?.features?.length || 0
        )} contourGroups=${roadSolidStats.groupCount} solidObjects=${
          roadSolidStats.objectCount
        } mode=contour-solid`
      );
    } else {
      const roadMeshStats = addRhinoRoads(
        doc,
        rhino,
        roadLayer,
        siteContext,
        center,
        seed
      );
      const roadCenterlineStats = addRhinoRoadCenterlines(
        doc,
        rhino,
        roadLayer,
        siteContext,
        center,
        seed
      );
      console.log(
        `[export-3dm] roads features=${Number(
          siteContext.roads?.features?.length || 0
        )} segments=${roadMeshStats.segmentCount} polygons=${
          roadMeshStats.polygonCount
        } vertices=${roadMeshStats.vertexCount} faces=${
          roadMeshStats.faceCount
        } meshObjects=${roadMeshStats.objectCount} centerlineObjects=${
          roadCenterlineStats.objectCount
        } mode=mesh`
      );
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
  if (normalized === "3dm") {
    return "3dm";
  }

  if (normalized === "skp") {
    return "skp";
  }

  if (normalized === "skp-payload") {
    return "skp-payload";
  }

  if (normalized === "dxf") {
    return "dxf";
  }

  return "obj";
}

function estimateExportArtifactSizeBytes(payload, payloadType = "binary") {
  if (payloadType === "json") {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  }

  if (Buffer.isBuffer(payload)) {
    return payload.byteLength;
  }

  if (payload instanceof Uint8Array) {
    return payload.byteLength;
  }

  return Buffer.byteLength(String(payload || ""), "utf8");
}

function cloneSerializableValue(value) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Fall back to JSON cloning for plain export payloads.
    }
  }

  return JSON.parse(JSON.stringify(value));
}

function cloneSiteContextForExport(siteContext) {
  if (!siteContext || typeof siteContext !== "object") {
    return siteContext;
  }

  const clonedSiteContext = cloneSerializableValue(siteContext);

  if (!clonedSiteContext || typeof clonedSiteContext !== "object") {
    return {
      options: {},
      stats: {},
      dataSources: {},
    };
  }

  clonedSiteContext.options =
    clonedSiteContext.options && typeof clonedSiteContext.options === "object"
      ? clonedSiteContext.options
      : {};
  clonedSiteContext.stats =
    clonedSiteContext.stats && typeof clonedSiteContext.stats === "object"
      ? clonedSiteContext.stats
      : {};
  clonedSiteContext.dataSources =
    clonedSiteContext.dataSources &&
    typeof clonedSiteContext.dataSources === "object"
      ? clonedSiteContext.dataSources
      : {};

  return clonedSiteContext;
}

function pruneExportArtifactCache(now = Date.now()) {
  for (const [cacheKey, entry] of exportArtifactCache.entries()) {
    if (now - Number(entry?.cachedAt || 0) >= EXPORT_ARTIFACT_CACHE_TTL_MS) {
      exportArtifactCache.delete(cacheKey);
    }
  }

  const entries = [...exportArtifactCache.entries()].sort(
    (left, right) =>
      Number(left[1]?.lastAccessedAt || left[1]?.cachedAt || 0) -
      Number(right[1]?.lastAccessedAt || right[1]?.cachedAt || 0)
  );
  let totalBytes = entries.reduce(
    (sum, [, entry]) => sum + Number(entry?.sizeBytes || 0),
    0
  );

  while (
    entries.length > EXPORT_ARTIFACT_CACHE_MAX_ENTRIES ||
    totalBytes > EXPORT_ARTIFACT_CACHE_MAX_TOTAL_BYTES
  ) {
    const [cacheKey, entry] = entries.shift() || [];

    if (!cacheKey) {
      break;
    }

    exportArtifactCache.delete(cacheKey);
    totalBytes -= Number(entry?.sizeBytes || 0);
  }
}

function buildExportArtifactCacheKey(siteContext, format) {
  const normalizedFormat = normalizeExportFormat(format);
  const exportOptions = {
    ...(siteContext?.options || {}),
    exportFormat: normalizedFormat,
  };

  return JSON.stringify({
    version: 3,
    format: normalizedFormat,
    request: buildSiteContextCacheKey(
      siteContext?.location || {},
      exportOptions,
      siteContext?.location?.customBounds || null
    ),
    geometrySignature: getSiteContextGeometrySignature(siteContext),
    stats: {
      targetParcelCount: Number(siteContext?.stats?.targetParcelCount || 0),
      contourCount: Number(
        siteContext?.contourLines?.features?.length ||
          siteContext?.stats?.contourCount ||
          0
      ),
      buildingCount: Number(siteContext?.stats?.buildingCount || 0),
      roadCount: Number(siteContext?.stats?.roadCount || 0),
      effectiveContourBandInterval:
        siteContext?.stats?.effectiveContourBandInterval ?? null,
      effectiveContourDisplayInterval:
        siteContext?.stats?.effectiveContourDisplayInterval ?? null,
      terrainStep: Number(siteContext?.terrainGrid?.step || 0).toFixed(3),
    },
    parcelGroups: getTargetParcelGroupFeatures(siteContext).map((feature, index) =>
      buildParcelGroupExportName(feature, index)
    ),
  });
}

function readExportArtifactCache(cacheKey, now = Date.now()) {
  pruneExportArtifactCache(now);
  const entry = exportArtifactCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (now - Number(entry.cachedAt || 0) >= EXPORT_ARTIFACT_CACHE_TTL_MS) {
    exportArtifactCache.delete(cacheKey);
    return null;
  }

  entry.lastAccessedAt = now;
  return entry;
}

function writeExportArtifactCache(cacheKey, payload, options = {}) {
  const payloadType =
    options?.payloadType === "json" ? "json" : "binary";
  const sizeBytes = estimateExportArtifactSizeBytes(payload, payloadType);

  if (
    !Number.isFinite(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > EXPORT_ARTIFACT_CACHE_MAX_ENTRY_BYTES
  ) {
    return false;
  }

  const now = Date.now();
  exportArtifactCache.set(cacheKey, {
    cachedAt: now,
    lastAccessedAt: now,
    sizeBytes,
    payloadType,
    payload,
    contentType: String(options?.contentType || "application/octet-stream"),
  });
  pruneExportArtifactCache(now);
  return true;
}

function buildCachedSkpPayloadAttachmentBuffer(exportPayload) {
  return Buffer.from(
    JSON.stringify(exportPayload?.payload || {}, null, 2),
    "utf8"
  );
}

function buildSkpPayloadEnvelope(siteContext, exportConfig = null) {
  const payload = buildSketchUpPayloadFromSiteContext(siteContext);
  const runtimeConfig = resolveSkpExportRuntimeConfig(exportConfig);

  return {
    format: "skp-payload",
    payloadVersion: 1,
    runtime: {
      engine: runtimeConfig.engine,
      standaloneCliConfigured: Boolean(runtimeConfig.skpExporterCli),
    },
    stats: {
      requestedContourInterval:
        siteContext?.stats?.requestedContourInterval ?? null,
      sourceContourInterval: siteContext?.stats?.sourceContourInterval ?? null,
      effectiveContourBandInterval:
        siteContext?.stats?.effectiveContourBandInterval ?? null,
      effectiveContourDisplayInterval:
        siteContext?.stats?.effectiveContourDisplayInterval ?? null,
      groupCount: payload.groups?.length || 0,
    },
    payload,
  };
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
    exportTargets: ["3dm", "obj", "dxf", "skp", "skp-payload"],
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

function formatIntervalForFilename(value) {
  const numericValue = normalizeContourInterval(value);
  const roundedValue = Number(numericValue.toFixed(3));
  return Number.isInteger(roundedValue)
    ? `${roundedValue}`
    : `${roundedValue}`.replace(/0+$/, "").replace(/\.$/, "");
}

function sanitizeExportFilenamePart(value, fallback = "site-context") {
  const normalized = normalizeSystemAddress(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || fallback;
}

function buildExportDownloadFilename(siteContext, options, format) {
  const normalizedFormat = normalizeExportFormat(format);
  const fileExtension =
    normalizedFormat === "skp-payload" ? "skp.json" : normalizedFormat;
  const addressPart = sanitizeExportFilenamePart(
    siteContext?.location?.parcelAddress ||
      siteContext?.location?.roadAddress ||
      siteContext?.location?.label ||
      "",
    "site-context"
  );
  const radiusPart = `${Math.max(0, Math.round(Number(options?.radius) || 0))}m`;
  const intervalPart = `${formatIntervalForFilename(options?.contourInterval)}m`;
  const parts = [addressPart, radiusPart, intervalPart];

  if (options?.splitParcelBoundary === true && siteContext?.selectionMode !== "range") {
    parts.push("분절");
  }

  return `${parts.join("_")}.${fileExtension}`;
}

function buildResolvedExportDownloadFilename(siteContext, options, format) {
  const normalizedFormat = normalizeExportFormat(format);
  const fileExtension =
    normalizedFormat === "skp-payload" ? "skp.json" : normalizedFormat;
  const addressPart = sanitizeExportFilenamePart(
    siteContext?.location?.parcelAddress ||
      siteContext?.location?.roadAddress ||
      siteContext?.location?.label ||
      "",
    "site-context"
  );
  const radiusPart = `${Math.max(0, Math.round(Number(options?.radius) || 0))}m`;
  const intervalPart = `${formatIntervalForFilename(options?.contourInterval)}m`;
  const parts = [addressPart, radiusPart, intervalPart];

  if (
    options?.splitParcelBoundary === true &&
    siteContext?.selectionMode !== "range"
  ) {
    parts.push("\uBD84\uC808");
  }

  return `${parts.join("_")}.${fileExtension}`;
}

function createEumHandoffHtml(requestUrl) {
  const pnu = extractPnuFromValue(requestUrl.searchParams.get("pnu"));
  const sggcd = normalizeDigits(requestUrl.searchParams.get("sggcd"), 5);
  const pLocation = normalizeSystemAddress(
    requestUrl.searchParams.get("p_location") || ""
  );
  const handoffStylesheetHref = "/handoff.css?v=20260326-security3";
  const handoffScriptHref = "/handoff-auto-submit.js?v=20260326-security3";

  if (!pnu || !sggcd) {
    return `
      <!doctype html>
      <html lang="ko">
        <head>
          <meta charset="utf-8" />
          <title>토지이음 연결 실패</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="stylesheet" href="${handoffStylesheetHref}" />
        </head>
        <body class="handoff-shell handoff-shell--error">
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
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="${handoffStylesheetHref}" />
        <script defer src="${handoffScriptHref}"></script>
      </head>
      <body class="handoff-shell handoff-shell--submit">
        <div class="handoff-card">
          <h1>토지이음 결과 페이지로 이동 중입니다.</h1>
          <p>새 탭에서 자동 연결되지 않으면 아래 버튼을 눌러주세요.</p>
          <form id="handoffForm" method="post" action="https://www.eum.go.kr/web/ar/lu/luLandDet.jsp">
            ${inputs}
            <button type="submit">토지이음 열기</button>
          </form>
        </div>
      </body>
    </html>
  `;
}

function createEumLawHandoffHtml(requestUrl) {
  const authCd = String(requestUrl.searchParams.get("authCd") || "").trim();
  const ucode = String(requestUrl.searchParams.get("ucode") || "").trim();
  const uname = cleanHtmlText(requestUrl.searchParams.get("uname") || "").trim();
  const handoffStylesheetHref = "/handoff.css?v=20260326-security3";
  const handoffScriptHref = "/handoff-auto-submit.js?v=20260326-security3";

  if (!authCd || !ucode) {
    return `
      <!doctype html>
      <html lang="ko">
        <head>
          <meta charset="utf-8" />
          <title>법령 연결 실패</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="stylesheet" href="${handoffStylesheetHref}" />
        </head>
        <body class="handoff-shell handoff-shell--error">
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
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="${handoffStylesheetHref}" />
        <script defer src="${handoffScriptHref}"></script>
      </head>
      <body class="handoff-shell handoff-shell--submit">
        <div class="handoff-card">
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
      </body>
    </html>
  `;
}

async function createApp() {
  const localConfig = await loadLocalConfig();
  const config = buildRuntimeConfig(localConfig);
  const ignoredInternalOnlyFeaturePaths = (config.internalOnlyStaticPaths || []).filter(
    (pathPrefix) =>
      Boolean(findFeatureDefinitionByRequestPath(pathPrefix)) &&
      !isInternalOnlyStaticPath(pathPrefix, config)
  );

  if (config.terrainContourPathSource === "workspace-fallback") {
    console.warn(
      `[terrain-config] contour path fallback requested=${config.terrainContourPathRequested} resolved=${config.terrainContourPath}`
    );
  } else if (config.terrainContourPathSource === "workspace-default") {
    console.log(
      `[terrain-config] using workspace contour path ${config.terrainContourPath}`
    );
  } else if (config.terrainContourPathSource === "configured-missing") {
    console.warn(
      `[terrain-config] configured contour path is unavailable ${config.terrainContourPathRequested}`
    );
  }

  if (ignoredInternalOnlyFeaturePaths.length) {
    console.warn(
      `[feature-config] ignoring internal-only overlap for public feature paths=${ignoredInternalOnlyFeaturePaths.join(",")}`
    );
  }

  const requestHandler = async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const requestStartedAt = Date.now();

    response.once("finish", () => {
      recordSlowApiRequestTelemetry({
        method: request.method,
        path: requestUrl.pathname,
        statusCode: response.statusCode,
        durationMs: Date.now() - requestStartedAt,
      });
    });

    try {
      if (requestUrl.pathname === "/favicon.ico") {
        response.writeHead(204, buildResponseHeaders());
        response.end();
        return;
      }

      const rateLimitBucket = resolveRateLimitBucket(
        requestUrl.pathname,
        request.method
      );

      if (
        rateLimitBucket &&
        !enforceRateLimit(request, response, config, rateLimitBucket)
      ) {
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
          },
          features: {
            publicEnabledFeatures: config.publicEnabledFeatures,
          },
          futureSources: {
            hasBuildingHubKey: Boolean(config.buildingHubServiceKey),
          },
        });
        return;
      }

      if (requestUrl.pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, {
          ok: true,
          uptimeSeconds: Number(process.uptime().toFixed(1)),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (
        requestUrl.pathname === "/api/runtime-stats" &&
        request.method === "GET"
      ) {
        const clientIp = getClientIp(request);

        if (!isLoopbackIp(clientIp)) {
          sendJson(response, 403, {
            error: "Runtime stats are only available from localhost.",
          });
          return;
        }

        sendJson(response, 200, buildRuntimeStatsPayload());
        return;
      }

      if (
        requestUrl.pathname === "/api/request-progress" &&
        request.method === "GET"
      ) {
        pruneRequestProgressStore();
        const token = normalizeProgressToken(
          requestUrl.searchParams.get("token")
        );

        if (!token) {
          sendJson(response, 400, { error: "유효한 진행 토큰이 필요합니다." });
          return;
        }

        const entry = requestProgressStore.get(token);
        const clientIp = getClientIp(request);

        if (!entry) {
          sendJson(response, 200, {
            token,
            operation: "request",
            state: "idle",
            percent: 0,
            message: "",
            startedAt: null,
            updatedAt: null,
            completedAt: null,
            error: "",
          });
          return;
        }

        if (entry.clientIp && entry.clientIp !== clientIp) {
          sendJson(response, 404, { error: "진행 상태를 찾을 수 없습니다." });
          return;
        }

        const { clientIp: _, ...publicEntry } = entry;
        sendJson(response, 200, publicEntry);
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

        const startedAt = Date.now();
        const geocodeTrace = { query, stages: [] };
        console.log(`[search-api] query="${query}"`);

        const cachedResponse = readGeocodeCache(query);

        if (cachedResponse) {
          recordGeocodeTelemetry({
            query,
            provider: cachedResponse.provider || "",
            branch: "cache-hit",
            cacheStatus: "hit",
            resultCount: Number(cachedResponse.results?.length || 0),
            totalMs: Date.now() - startedAt,
            stages: [],
          });
          console.log(
            `[search-api] query="${query}" provider="${cachedResponse.provider || "unknown"}" results=${Number(
              cachedResponse.results?.length || 0
            )} cache=hit ms=${Date.now() - startedAt}`
          );
          sendJson(response, 200, cachedResponse);
          return;
        }

        try {
          const payload = await readOrLoadResponseCache(
            geocodeCache,
            geocodeInFlight,
            buildGeocodeCacheKey(query),
            async () => {
              const { provider, results } = await geocodeWithPreferredProviders(
                query,
                config,
                geocodeTrace
              );
              return { provider, results };
            },
            {
              ttlMs: GEOCODE_CACHE_TTL_MS,
              maxEntries: GEOCODE_CACHE_MAX_ENTRIES,
            }
          );
          recordGeocodeTelemetry({
            query,
            provider: payload.provider || geocodeTrace.provider || "",
            branch: geocodeTrace.branch || payload.provider || "",
            cacheStatus: "miss",
            resultCount: Number(payload.results?.length || 0),
            totalMs: Date.now() - startedAt,
            stages: geocodeTrace.stages,
          });
          console.log(
            `[search-api] query="${query}" provider="${payload.provider || "unknown"}" results=${Number(
              payload.results?.length || 0
            )} cache=miss ms=${Date.now() - startedAt}`
          );
          sendJson(response, 200, payload);
        } catch (error) {
          recordGeocodeTelemetry({
            query,
            provider: geocodeTrace.provider || "",
            branch: geocodeTrace.branch || "error",
            cacheStatus: "miss",
            resultCount: 0,
            totalMs: Date.now() - startedAt,
            error: error?.message || error,
            stages: geocodeTrace.stages,
          });
          throw error;
        }
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
          result = await reverseWithNominatim(lat, lng, config);
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
        const clientIp = getClientIp(request);
        beginRequestProgress(
          progressToken,
          "site-context",
          "대지 컨텍스트 요청을 준비하는 중입니다."
        );

        updateRequestProgress(progressToken, { clientIp });

        try {
          const body = await readJsonBody(request, {
            maxBytes: config.maxRequestBodyBytes,
          });
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
        const body = await readJsonBody(request, {
          maxBytes: config.maxRequestBodyBytes,
        });
        sendJson(response, 200, createModelSpec(body));
        return;
      }

      if (
        requestUrl.pathname === "/api/land-info" &&
        request.method === "POST"
      ) {
        const body = await readJsonBody(request, {
          maxBytes: config.maxRequestBodyBytes,
        });
        const parcelReference = resolveParcelReference(body);

        if (!parcelReference) {
          sendJson(response, 400, {
            error:
              "토지정보 조회용 필지 식별정보가 없습니다. 주소 검색 결과를 선택하거나 대지를 먼저 불러오세요.",
          });
          return;
        }

        const landInfo = await fetchEumLandInfo(
          parcelReference,
          body.location || {},
          config
        );
        sendJson(response, 200, landInfo);
        return;
      }

      if (
        requestUrl.pathname === "/api/land-info-details" &&
        request.method === "POST"
      ) {
        const body = await readJsonBody(request, {
          maxBytes: config.maxRequestBodyBytes,
        });
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

        const body = await readJsonBody(request, {
          maxBytes: config.maxRequestBodyBytes,
        });
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
          requestUrl.pathname === "/api/export-obj" ||
          requestUrl.pathname === "/api/export-skp-payload") &&
        request.method === "POST"
      ) {
        const progressToken = readRequestProgressToken(request);
        const clientIp = getClientIp(request);
        const isSkpPayloadRoute =
          requestUrl.pathname === "/api/export-skp-payload";
        beginRequestProgress(
          progressToken,
          isSkpPayloadRoute ? "export-skp-payload" : "export-model",
          isSkpPayloadRoute
            ? "Preparing SKP payload export."
            :
          "3D 파일 요청을 준비하는 중입니다."
        );

        updateRequestProgress(progressToken, { clientIp });

        try {
          const body = await readJsonBody(request, {
            maxBytes: config.maxExportRequestBodyBytes,
          });
          await withExportJobSlot(config, async () => {
            const {
              requestedLocation,
              requestedOptions,
              ignoredKeys,
              hasClientSuppliedSiteContext,
            } = extractExportRequestPayload(body);
            const format =
              requestUrl.pathname === "/api/export-obj"
                ? "obj"
                : isSkpPayloadRoute
                  ? "skp-payload"
                  : normalizeExportFormat(requestedOptions?.exportFormat);
            updateRequestProgress(progressToken, {
              percent: 8,
              message: "Preparing the export request.",
            });

            if (ignoredKeys.length > 0) {
              console.log(
                `[export] ignoring unsupported request keys format=${format} keys=${ignoredKeys.sort().join(",")}`
              );
            }

            if (hasClientSuppliedSiteContext) {
              console.log(
                `[export] ignoring client-supplied siteContext format=${format} requestedRoads=${
                  requestedOptions.includeRoads === true
                }`
              );
            }

            let siteContext = await buildSiteContext(
              {
                location: requestedLocation,
                options: requestedOptions,
              },
              config,
              createRangedProgressReporter(progressToken, 8, 44)
            );

            updateRequestProgress(progressToken, {
              percent: 8,
              message: "내보낼 대지 컨텍스트를 계산하는 중입니다.",
            });
            updateRequestProgress(progressToken, {
              percent: 16,
              message: "저장된 대지 컨텍스트를 확인하는 중입니다.",
            });
            assertSiteContextWithinLimits(siteContext, config);

          siteContext = prepareSiteContextForExport(
            siteContext,
            requestedOptions,
            format
          );
          const exportFilename = buildResolvedExportDownloadFilename(
            siteContext,
            requestedOptions,
            format
          );
          const exportCacheKey = buildExportArtifactCacheKey(
            siteContext,
            format
          );
          const cachedExportArtifact = readExportArtifactCache(exportCacheKey);

          if (cachedExportArtifact) {
            console.log(
              `[export] cache-hit format=${format} bytes=${Number(
                cachedExportArtifact.sizeBytes || 0
              )}`
            );
            updateRequestProgress(progressToken, {
              percent: 96,
              message: "이전 출력 결과를 다시 사용하는 중입니다.",
            });
            completeRequestProgress(
              progressToken,
              `${String(format || "model").toUpperCase()} 캐시 결과를 내려받습니다.`
            );

            if (format === "skp-payload") {
              if (isSkpPayloadRoute) {
                sendJson(response, 200, cachedExportArtifact.payload, {
                  "X-Export-Cache": "hit",
                });
              } else {
                sendBinary(
                  response,
                  200,
                  buildCachedSkpPayloadAttachmentBuffer(
                    cachedExportArtifact.payload
                  ),
                  "application/json; charset=utf-8",
                  buildResolvedExportDownloadFilename(
                    siteContext,
                    requestedOptions,
                    "skp-payload"
                  ),
                  { "X-Export-Cache": "hit" }
                );
              }
            } else {
              sendBinary(
                response,
                200,
                cachedExportArtifact.payload,
                cachedExportArtifact.contentType,
                exportFilename,
                { "X-Export-Cache": "hit" }
              );
            }
            return;
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
            writeExportArtifactCache(exportCacheKey, exportBody, {
              contentType: "application/octet-stream",
            });
            sendBinary(
              response,
              200,
              exportBody,
              "application/octet-stream",
              exportFilename,
              { "X-Export-Cache": "miss" }
            );
            return;
          }

          updateRequestProgress(progressToken, {
            percent: 48,
            message: "OBJ 모델을 생성하는 중입니다.",
          });
          if (format === "skp") {
            updateRequestProgress(progressToken, {
              percent: 48,
              message: "SKP 모델을 생성하는 중입니다.",
            });
            const exportBody = await buildSkpFromSiteContextWithRetry(
              siteContext,
              createRangedProgressReporter(progressToken, 48, 96),
              config
            );
            console.log(
              `[export] done format=skp bytes=${Number(
                exportBody?.byteLength || exportBody?.length || 0
              )} ms=${Date.now() - exportStartedAt}`
            );
            completeRequestProgress(
              progressToken,
              "SKP 파일 다운로드를 시작합니다."
            );
            writeExportArtifactCache(exportCacheKey, exportBody, {
              contentType: "application/octet-stream",
            });
            sendBinary(
              response,
              200,
              exportBody,
              "application/octet-stream",
              exportFilename,
              { "X-Export-Cache": "miss" }
            );
            return;
          }

          if (format === "skp-payload") {
            updateRequestProgress(progressToken, {
              percent: 48,
              message: "Building SKP payload JSON.",
            });
            const exportPayload = buildSkpPayloadEnvelope(siteContext, config);
            console.log(
              `[export] done format=skp-payload groups=${Number(
                exportPayload?.payload?.groups?.length || 0
              )} ms=${Date.now() - exportStartedAt}`
            );
            writeExportArtifactCache(exportCacheKey, exportPayload, {
              payloadType: "json",
              contentType: "application/json; charset=utf-8",
            });
            completeRequestProgress(
              progressToken,
              isSkpPayloadRoute
                ? "SKP payload is ready."
                : "SKP payload download is ready."
            );

            if (isSkpPayloadRoute) {
              sendJson(response, 200, exportPayload, {
                "X-Export-Cache": "miss",
              });
            } else {
              sendBinary(
                response,
                200,
                buildCachedSkpPayloadAttachmentBuffer(exportPayload),
                "application/json; charset=utf-8",
                buildResolvedExportDownloadFilename(
                  siteContext,
                  requestedOptions,
                  "skp-payload"
                ),
                { "X-Export-Cache": "miss" }
              );
            }
            return;
          }

          if (format === "dxf") {
            updateRequestProgress(progressToken, {
              percent: 48,
              message: "DXF 紐⑤뜽???앹꽦?섎뒗 以묒엯?덈떎.",
            });
            const exportBody = buildDxfFromSiteContext(
              siteContext,
              createRangedProgressReporter(progressToken, 48, 96)
            );
            console.log(
              `[export] done format=dxf bytes=${Buffer.byteLength(
                exportBody,
                "utf8"
              )} ms=${Date.now() - exportStartedAt}`
            );
            completeRequestProgress(
              progressToken,
              "DXF ?뚯씪 ?ㅼ슫濡쒕뱶瑜??쒖옉?⑸땲??"
            );
            const exportBuffer = Buffer.from(exportBody, "utf8");
            writeExportArtifactCache(exportCacheKey, exportBuffer, {
              contentType: "application/dxf; charset=utf-8",
            });
            sendBinary(
              response,
              200,
              exportBuffer,
              "application/dxf; charset=utf-8",
              exportFilename,
              { "X-Export-Cache": "miss" }
            );
            return;
          }

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
            const exportBuffer = Buffer.from(exportBody, "utf8");
            writeExportArtifactCache(exportCacheKey, exportBuffer, {
              contentType: "text/plain; charset=utf-8",
            });
            sendBinary(
              response,
              200,
              exportBuffer,
              "text/plain; charset=utf-8",
              exportFilename,
              { "X-Export-Cache": "miss" }
            );
          }, {
            clientIp,
            onQueued: ({
              position,
              estimatedWaitMs,
              queuedJobs,
              activeJobs,
              maxConcurrentJobs,
            }) => {
              const queueSummary =
                queuedJobs > 1
                  ? `대기 ${position}번 / 전체 ${queuedJobs}건`
                  : `대기 ${position}번`;
              const capacitySummary = `동시 처리 ${activeJobs}/${maxConcurrentJobs}`;
              updateRequestProgress(progressToken, {
                percent: 2,
                message: `다른 모델 파일 작업이 진행 중이라 잠시 대기하고 있습니다. (${queueSummary}, ${capacitySummary}, 예상 ${formatDurationLabel(estimatedWaitMs)})`,
              });
            },
          });
        } catch (error) {
          failRequestProgress(progressToken, error);
          if (!(error instanceof HttpError) || error.statusCode >= 500) {
            logServerError(
              `Export failed progressToken=${progressToken || "none"}`,
              error
            );
          }
          throw error;
        }
        return;
      }

      await serveStatic(request, requestUrl.pathname, response, config);
    } catch (error) {
      const publicError = normalizePublicError(error);
      const statusCode =
        publicError instanceof HttpError ? publicError.statusCode : 500;
      const errorHeaders =
        publicError instanceof HttpError ? publicError.headers : {};

      if (!(error instanceof HttpError) || statusCode >= 500) {
        logServerError(`${request.method} ${requestUrl.pathname}`, error);
      }

      sendJson(response, statusCode, {
        error:
          publicError instanceof Error ? publicError.message : "Unexpected error",
      }, errorHeaders);
    }
  };

  async function listenOnConfiguredPort(port, host) {
    const server = createServer(requestHandler);

    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        if (host) {
          server.listen(port, host, resolve);
          return;
        }

        server.listen(port, resolve);
      });

      return { port, host: host || "", server };
    } catch (error) {
      server.close();

      if (error instanceof Error && error.code === "EADDRINUSE") {
        throw new Error(
          `Port ${port} is already in use. Stop the previous Space Work server and try again.`
        );
      }

      throw error;
    }
  }

  const { port, host, server } = await listenOnConfiguredPort(
    config.port,
    config.bindHost
  );
  const displayHost =
    !host || host === "0.0.0.0" || host === "::" ? "localhost" : host;
  console.log(`Space Work running at http://${displayHost}:${port}`);
  return { port, host, server };
}

export {
  addRhinoBuildings,
  addRhinoContourBandTerrain,
  addRhinoPolylineCollection,
  addRhinoPrismFromPolygon,
  addRhinoTerrainMesh,
  buildingBaseElevationForRing,
  buildProviderTimeoutConfig,
  build3dmFromSiteContext,
  buildClipBoundary,
  buildParcelDataCacheKey,
  buildSiteContextCacheKey,
  buildVWorldDomainCandidates,
  buildCumulativeContourBandGroups,
  buildContourBandGroups,
  buildDxfFromSiteContext,
  buildExportArtifactCacheKey,
  buildObjFromSiteContext,
  buildRoadSurfaceFeatureCollection,
  buildSketchUpPayloadFromSiteContext,
  buildSkpFromSiteContext,
  buildSkpFromSiteContextWithRetry,
  createRhinoObjectAttributes,
  withExportJobSlot,
  createApp,
  centroidOfRing,
  collectBuildingFootprintElevationSamples,
  ensureRhinoLayer,
  fetchWithTimeout,
  getRhino3dm,
  isInternalOnlyStaticPath,
  isPathInsideDirectory,
  localMetersFromLngLat,
  normalizePublicError,
  normalizeSearchResultsForQuery,
  selectGeocodedVWorldResultForJusoCandidate,
  selectShortCircuitJusoCandidate,
  selectStrongJusoFastPathCandidates,
  prepareSiteContextForExport,
  pruneCacheEntries,
  readOrLoadResponseCache,
  resolveSketchUpTerrainSolidSimplifyTolerance,
  resolveRateLimitBucket,
  resolveRawTerrainHeightAtLocalPoint,
  resolveEffectiveContourBandInterval,
  resolveTerrainContourPath,
  siteHeightAtLocalPoint,
  simplifyLocalPolygonDouglasPeucker,
  simplifySketchUpSolidRegion,
};

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  createApp().catch((error) => {
    logServerError("Server startup failed", error);
    process.exitCode = 1;
  });
}
