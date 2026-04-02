import assert from "node:assert/strict";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
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
  },
  {
    name: "seoul-center",
    location: { lat: 37.571991, lng: 126.980074 },
    options: { radius: 100 },
  },
];

function readArgValue(flag) {
  const index = process.argv.indexOf(flag);

  if (index === -1 || index === process.argv.length - 1) {
    return "";
  }

  return String(process.argv[index + 1] || "").trim();
}

async function fetchJson(baseUrl, pathname, payload = null) {
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

async function fetchText(baseUrl, pathname, payload) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `${pathname} failed with ${response.status}: ${text.slice(0, 200)}`
    );
  }

  return text;
}

function countDxfLineEntities(text) {
  return (String(text || "").match(/\r?\n0\r?\nLINE\r?\n/g) || []).length;
}

function collectDxfLineElevations(text) {
  const values = String(text || "").trim().split(/\r?\n/);
  const elevations = [];

  for (let index = 0; index < values.length - 1; ) {
    const code = values[index];
    const value = values[index + 1];

    if (code === "0" && value === "LINE") {
      let startZ = 0;
      let endZ = 0;
      index += 2;

      while (index < values.length - 1 && values[index] !== "0") {
        const entityCode = values[index];
        const entityValue = values[index + 1];

        if (entityCode === "30") {
          startZ = Number(entityValue);
        } else if (entityCode === "31") {
          endZ = Number(entityValue);
        }

        index += 2;
      }

      elevations.push(startZ, endZ);
      continue;
    }

    index += 2;
  }

  return elevations.filter(Number.isFinite);
}

function summarizeGeometryTypes(features) {
  return [...new Set((features || []).map((feature) => feature?.geometry?.type).filter(Boolean))];
}

async function verifyCase(baseUrl, testCase) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...(testCase.options || {}),
  };
  const siteContext = await fetchJson(baseUrl, "/api/site-context", {
    location: testCase.location,
    options,
  });
  const buildingFeatures = siteContext?.buildings?.features || [];
  const roadFeatures = siteContext?.roads?.features || [];
  const buildingGeometryTypes = summarizeGeometryTypes(buildingFeatures);
  const roadGeometryTypes = summarizeGeometryTypes(roadFeatures);

  assert.ok(
    Number(siteContext?.stats?.buildingCount || 0) > 0,
    `${testCase.name}: buildingCount should be greater than zero.`
  );
  assert.ok(
    Number(siteContext?.stats?.roadCount || 0) > 0,
    `${testCase.name}: roadCount should be greater than zero.`
  );
  assert.ok(
    buildingFeatures.every((feature) =>
      ["Polygon", "MultiPolygon"].includes(feature?.geometry?.type)
    ),
    `${testCase.name}: building geometries should stay polygonal.`
  );
  assert.ok(
    roadFeatures.every((feature) =>
      ["Polygon", "MultiPolygon"].includes(feature?.geometry?.type)
    ),
    `${testCase.name}: road geometries should stay polygonal.`
  );
  assert.notEqual(
    String(siteContext?.dataSources?.buildings?.provider || "unavailable"),
    "unavailable",
    `${testCase.name}: building provider should not be unavailable.`
  );
  assert.notEqual(
    String(siteContext?.dataSources?.roads?.provider || "unavailable"),
    "unavailable",
    `${testCase.name}: road provider should not be unavailable.`
  );

  const dxfText = await fetchText(baseUrl, "/api/export-model", {
    location: testCase.location,
    siteContext,
    options: {
      ...options,
      exportFormat: "dxf",
    },
  });
  const dxfLineCount = countDxfLineEntities(dxfText);
  const dxfElevations = collectDxfLineElevations(dxfText);
  const dxfMaxAbsZ = dxfElevations.reduce(
    (max, value) => Math.max(max, Math.abs(Number(value || 0))),
    0
  );

  assert.ok(dxfLineCount > 0, `${testCase.name}: DXF should contain LINE entities.`);
  assert.match(
    dxfText,
    /BUILDINGS|TARGET_BUILDING|ROADS/,
    `${testCase.name}: DXF should contain core layer names.`
  );
  assert.ok(
    dxfMaxAbsZ <= 0.001,
    `${testCase.name}: DXF linework should stay flattened at z=0, received max |z| ${dxfMaxAbsZ}.`
  );

  return {
    name: testCase.name,
    buildingCount: Number(siteContext?.stats?.buildingCount || 0),
    roadCount: Number(siteContext?.stats?.roadCount || 0),
    buildingProvider: siteContext?.dataSources?.buildings?.provider || "unknown",
    roadProvider: siteContext?.dataSources?.roads?.provider || "unknown",
    buildingGeometryTypes,
    roadGeometryTypes,
    dxfLineCount,
    dxfMaxAbsZ: Number(dxfMaxAbsZ.toFixed(6)),
  };
}

async function main() {
  const baseUrl = readArgValue("--base-url") || DEFAULT_BASE_URL;
  const health = await fetchJson(baseUrl, "/api/health");
  assert.equal(health?.ok, true, "Health endpoint should return ok=true.");

  const results = [];

  for (const testCase of CASES) {
    results.push(await verifyCase(baseUrl, testCase));
  }

  console.log(
    JSON.stringify(
      {
        baseUrl,
        verifiedAt: new Date().toISOString(),
        cases: results,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
