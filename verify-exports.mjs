import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import process from "node:process";
import {
  createApp,
  prepareSiteContextForExport,
  build3dmFromSiteContext,
  buildClipBoundary,
  buildRoadSurfaceFeatureCollection,
  buildSketchUpPayloadFromSiteContext,
  buildObjFromSiteContext,
  buildSkpFromSiteContextWithRetry,
  fetchWithTimeout,
  getRhino3dm,
  isPathInsideDirectory,
  normalizePublicError,
  normalizeSearchResultsForQuery,
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
  buildingPlacement: "dominant",
};

const CASES = [
  {
    name: "seoul-hillside",
    location: { lat: 37.57705, lng: 126.962095 },
    options: { radiusMeters: 100 },
    expect: { maxEffective: 5, min3dmBytes: 500_000, minSkpGroups: 5, minObjLength: 100_000 },
  },
  {
    name: "gyeyang-large",
    location: { lat: 37.545659, lng: 126.716062 },
    options: { radiusMeters: 400 },
    expect: { maxEffective: 5, min3dmBytes: 500_000, minSkpGroups: 5, minObjLength: 100_000 },
  },
  {
    name: "seoul-center",
    location: { lat: 37.571991, lng: 126.980074 },
    options: { radiusMeters: 100 },
    expect: { maxEffective: 5, min3dmBytes: 100_000, minSkpGroups: 1, minObjLength: 10_000 },
  },
  {
    name: "chungnam-rural",
    location: { lat: 36.427297, lng: 126.780739 },
    options: { radiusMeters: 150 },
    expect: { maxEffective: 5, min3dmBytes: 100_000, minSkpGroups: 1, minObjLength: 50_000 },
  },
].filter((testCase) => CASE_FILTER.size === 0 || CASE_FILTER.has(testCase.name));

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

function summarizeExportContext(siteContext, format) {
  const exportSiteContext = prepareSiteContextForExport(
    siteContext,
    {
      ...(siteContext?.options || {}),
      exportFormat: format,
    },
    format
  );

  return {
    exportSiteContext,
    requested: exportSiteContext.stats?.requestedContourInterval,
    source: exportSiteContext.stats?.sourceContourInterval,
    effective: exportSiteContext.stats?.effectiveContourBandInterval,
    contourCount: exportSiteContext?.contourLines?.features?.length || 0,
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

  if (result.formats.skp.curvePolylineMaxAbsZ > 0.001) {
    failures.push(
      `${testCase.name}/skp: curve polyline max |z| ${result.formats.skp.curvePolylineMaxAbsZ} should stay at 0`
    );
  }

  return failures;
}

async function verifyCase(testCase) {
  const siteContext = await fetchJson("/api/site-context", {
    location: testCase.location,
    options: {
      ...DEFAULT_OPTIONS,
      ...(testCase.options || {}),
    },
  });

  const threeDm = summarizeExportContext(siteContext, "3dm");
  const skp = summarizeExportContext(siteContext, "skp");
  const obj = summarizeExportContext(siteContext, "obj");

  const threeDmBytes = await build3dmFromSiteContext(threeDm.exportSiteContext);
  const skpPayload = buildSketchUpPayloadFromSiteContext(skp.exportSiteContext);
  const objText = buildObjFromSiteContext(obj.exportSiteContext);
  const threeDmCurveSummary = await summarize3dmCurveHeights(threeDmBytes);
  const skpCurveSummary = summarizeSketchUpCurveHeights(skpPayload);
  const skpBytes = FULL_SKP_EXPORT
    ? (await buildSkpFromSiteContextWithRetry(skp.exportSiteContext)).length
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

    const hubResponse = await fetch(`${baseUrl}/`);
    const hubHtml = await hubResponse.text();
    assert.equal(hubResponse.status, 200, "Hub route should respond.");
    assert.match(hubHtml, /Space Work Hub/, "Hub page title/content should exist.");
    assert.match(
      hubHtml,
      /\/contour3dmodel/,
      "Hub page should link to the feature route."
    );
    assert.match(
      hubHtml,
      /\/heritage-risk/,
      "Hub page should link to the heritage-risk route."
    );
    assert.match(
      hubHtml,
      /\/max-mass/,
      "Hub page should link to the max-mass route."
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
    assert.match(
      featureHtml,
      /3D 대지모형 스튜디오/,
      "Feature page heading should remain visible."
    );
    assert.match(featureHtml, /토지이음 열기/, "Land-use CTA should remain visible.");
    assert.match(featureHtml, /세움터 열기/, "Building register CTA should remain visible.");
    assert.match(featureHtml, /필지 그룹 분리/, "Split parcel option should remain visible.");
    assert.match(featureHtml, /모델 미리보기/, "Preview CTA should remain visible.");

    assert.doesNotMatch(
      featureHtml,
      /unpkg\.com/i,
      "Feature page should no longer reference unpkg-hosted frontend assets."
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
    const leafletMarkerResponse = await fetch(`${baseUrl}/vendor/leaflet/images/marker-icon.png`);
    assert.equal(
      leafletMarkerResponse.status,
      200,
      "Self-hosted Leaflet marker assets should be served."
    );

    const heritageResponse = await fetch(`${baseUrl}/heritage-risk`);
    const heritageHtml = await heritageResponse.text();
    assert.equal(heritageResponse.status, 200, "Heritage route should respond.");
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
    assert.equal(maxMassResponse.status, 200, "Max-mass route should respond.");
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
    const refinedDxfSiteContext = prepareSiteContextForExport(
      syntheticContourSiteContext,
      syntheticContourSiteContext.options,
      "dxf"
    );
    assert.equal(
      refinedDxfSiteContext?.stats?.effectiveContourDisplayInterval,
      2,
      "DXF export should preserve the native official contour display interval."
    );
    assert.deepEqual(
      refinedDxfSiteContext?.contourLines,
      syntheticContourSiteContext.contourLines,
      "DXF export should preserve official contour geometries instead of regenerating grid contours."
    );

    const exportCacheRequestBody = {
      location: syntheticContourSiteContext.location,
      siteContext: syntheticContourSiteContext,
      options: {
        ...syntheticContourSiteContext.options,
        exportFormat: "skp-payload",
      },
    };
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
            "config-shape",
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
            "road-surface-merge",
            "search-ranking-tokens",
            "skp-terrain-refine",
            "skp-contour-curves",
            "export-cache-hit",
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
