import assert from "node:assert/strict";
import process from "node:process";
import {
  prepareSiteContextForExport,
  build3dmFromSiteContext,
  buildSketchUpPayloadFromSiteContext,
  buildObjFromSiteContext,
  buildSkpFromSiteContextWithRetry,
} from "./server.mjs";

const BASE_URL = process.env.SITE_CONTEXT_BASE_URL || "http://127.0.0.1:3000";
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

function isRetriableFetchError(error) {
  const message = String(error?.message || error || "");
  return /ECONNRESET|fetch failed|socket hang up|ETIMEDOUT/i.test(message);
}

async function fetchJson(pathname, payload = null, retryCount = 0) {
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
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
      },
      skp: {
        requested: skp.requested,
        source: skp.source,
        effective: skp.effective,
        contourCount: skp.contourCount,
        groups: skpPayload.groups?.length || 0,
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

async function main() {
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
