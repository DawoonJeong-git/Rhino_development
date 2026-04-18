import process from "node:process";
import {
  createApp,
  prepareSiteContextForExport,
  build3dmFromSiteContext,
  buildTerrainPipelineDiagnostics,
} from "../server.mjs";

const DEFAULT_CASES = [
  {
    name: "seoul-hillside",
    location: { lat: 37.57705, lng: 126.962095 },
    options: {
      radius: 100,
      includeBuildings: true,
      includeParcelBoundary: true,
      includeContours: true,
      includeRoads: true,
      contourInterval: 1,
      terrainMode: "contour",
      buildingPlacement: "default",
    },
  },
  {
    name: "gyeyang-large",
    location: { lat: 37.545659, lng: 126.716062 },
    options: {
      radius: 400,
      includeBuildings: true,
      includeParcelBoundary: true,
      includeContours: true,
      includeRoads: true,
      contourInterval: 1,
      terrainMode: "contour",
      buildingPlacement: "default",
    },
  },
  {
    name: "seoul-center",
    location: { lat: 37.571991, lng: 126.980074 },
    options: {
      radius: 100,
      includeBuildings: true,
      includeParcelBoundary: true,
      includeContours: true,
      includeRoads: true,
      contourInterval: 1,
      terrainMode: "contour",
      buildingPlacement: "default",
    },
  },
];

function parseArgs(argv) {
  const args = { _: [] };

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

async function fetchJson(baseUrl, pathname, payload) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `${pathname} failed with ${response.status}: ${json?.error || "unknown error"}`
    );
  }

  return json;
}

function summarizeDiagnostics(siteContext, exportSiteContext, include3dmBytes = false) {
  const diagnostics =
    exportSiteContext?.stats?.terrainPipelineDiagnostics ||
    buildTerrainPipelineDiagnostics(exportSiteContext) ||
    null;
  const buildingPlacementDebug =
    exportSiteContext?.stats?.buildingPlacementDebug || [];
  const mismatchLevels = Array.isArray(
    diagnostics?.curveTerrainAlignment?.mismatchLevels
  )
    ? diagnostics.curveTerrainAlignment.mismatchLevels
    : [];

  return {
    requestedContourInterval:
      exportSiteContext?.stats?.requestedContourInterval ?? null,
    sourceContourInterval:
      exportSiteContext?.stats?.sourceContourInterval ?? null,
    effectiveContourBandInterval:
      exportSiteContext?.stats?.effectiveContourBandInterval ?? null,
    contourFeatureCount:
      Number(siteContext?.contourLines?.features?.length || 0),
    exportContourFeatureCount:
      Number(exportSiteContext?.exportContourLines?.features?.length || 0),
    openContourClosure: diagnostics?.openContourClosure || null,
    curveTerrainAlignment: diagnostics
      ? {
          mismatchLevelCount: Number(
            diagnostics?.curveTerrainAlignment?.mismatchLevelCount || 0
          ),
          mismatchExampleLevels: mismatchLevels.slice(0, 12),
        }
      : null,
    bandBoundaryAlignment: diagnostics
      ? {
          mismatchLevelCount: Number(
            diagnostics?.bandBoundaryAlignment?.mismatchLevelCount || 0
          ),
          mismatchExampleLevels: Array.isArray(
            diagnostics?.bandBoundaryAlignment?.mismatchLevels
          )
            ? diagnostics.bandBoundaryAlignment.mismatchLevels.slice(0, 12)
            : [],
        }
      : null,
    nativeClosedLoops: diagnostics?.nativeClosedLoops || null,
    terrainBasisContours: diagnostics
      ? {
          featureCount: Number(
            diagnostics?.terrainBasisContours?.featureCount || 0
          ),
          levelCount: Number(
            diagnostics?.terrainBasisContours?.levels?.length || 0
          ),
        }
      : null,
    bandCounts: {
      source: Number(diagnostics?.sourceBandGroups?.length || 0),
      cumulative: Number(diagnostics?.cumulativeBandGroups?.length || 0),
      renderable: Number(diagnostics?.renderableBandGroups?.length || 0),
      topSurface: Number(diagnostics?.topSurfaceGroups?.length || 0),
    },
    buildingPlacement: diagnostics?.buildingPlacement || {
      sampleCount: Number(buildingPlacementDebug.length || 0),
      unresolvedCount: Number(
        buildingPlacementDebug.filter(
          (entry) => !Number.isFinite(entry?.finalBaseElevation)
        ).length
      ),
      sourceCounts: {},
    },
    include3dmBytes,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selectedCaseNames = String(args.case || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const include3dm = /^(1|true|yes)$/i.test(String(args["include-3dm"] || ""));
  const port = Number(args.port || process.env.TERRAIN_PROGRESS_PORT || 3052);

  process.env.PORT = String(port);
  process.env.HOST = "127.0.0.1";

  const cases =
    selectedCaseNames.length > 0
      ? DEFAULT_CASES.filter((testCase) => selectedCaseNames.includes(testCase.name))
      : DEFAULT_CASES;
  const { server } = await createApp();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const results = [];

    for (const testCase of cases) {
      const startedAt = Date.now();
      const siteContext = await fetchJson(baseUrl, "/api/site-context", {
        location: testCase.location,
        options: testCase.options,
      });
      const exportSiteContext = prepareSiteContextForExport(
        siteContext,
        {
          ...(testCase.options || {}),
          exportFormat: "3dm",
        },
        "3dm"
      );
      const summary = summarizeDiagnostics(siteContext, exportSiteContext, include3dm);

      if (include3dm) {
        const threeDmBytes = await build3dmFromSiteContext(exportSiteContext);
        summary.threeDmBytes = Number(
          threeDmBytes?.byteLength || threeDmBytes?.length || 0
        );
      }

      results.push({
        name: testCase.name,
        elapsedMs: Date.now() - startedAt,
        ...summary,
      });
    }

    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          baseUrl,
          include3dm,
          cases: results,
        },
        null,
        2
      )
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
