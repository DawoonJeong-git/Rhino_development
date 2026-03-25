import process from "node:process";
import {
  prepareSiteContextForExport,
  build3dmFromSiteContext,
  buildSketchUpPayloadFromSiteContext,
  buildObjFromSiteContext,
} from "../server.mjs";

const BASE_URL = process.env.SITE_CONTEXT_BASE_URL || "http://127.0.0.1:3000";

const CASES = [
  {
    name: "seoul-hillside",
    location: { lat: 37.57705, lng: 126.962095 },
    options: {
      radiusMeters: 100,
      includeBuildings: true,
      includeParcelBoundary: true,
      includeContours: true,
      includeRoads: true,
      contourInterval: 1,
      terrainMode: "contour",
      buildingPlacement: "dominant",
    },
  },
  {
    name: "gyeyang-large",
    location: { lat: 37.545659, lng: 126.716062 },
    options: {
      radiusMeters: 400,
      includeBuildings: true,
      includeParcelBoundary: true,
      includeContours: true,
      includeRoads: true,
      contourInterval: 1,
      terrainMode: "contour",
      buildingPlacement: "dominant",
    },
  },
];

async function fetchJson(pathname, payload = null) {
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
  };
}

async function verifyCase(testCase) {
  const siteContext = await fetchJson("/api/site-context", {
    location: testCase.location,
    options: testCase.options,
  });

  const threeDm = summarizeExportContext(siteContext, "3dm");
  const skp = summarizeExportContext(siteContext, "skp");
  const obj = summarizeExportContext(siteContext, "obj");

  const threeDmBytes = await build3dmFromSiteContext(threeDm.exportSiteContext);
  const skpPayload = buildSketchUpPayloadFromSiteContext(skp.exportSiteContext);
  const objText = buildObjFromSiteContext(obj.exportSiteContext);

  return {
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
        bytes: threeDmBytes.length,
      },
      skp: {
        requested: skp.requested,
        source: skp.source,
        effective: skp.effective,
        groups: skpPayload.groups?.length || 0,
      },
      obj: {
        requested: obj.requested,
        source: obj.source,
        effective: obj.effective,
        length: objText.length,
      },
    },
  };
}

async function main() {
  const health = await fetchJson("/api/health");
  const results = [];

  for (const testCase of CASES) {
    const startedAt = Date.now();
    const result = await verifyCase(testCase);
    result.elapsedMs = Date.now() - startedAt;
    results.push(result);
  }

  console.log(
    JSON.stringify(
      {
        health,
        verifiedAt: new Date().toISOString(),
        cases: results,
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
