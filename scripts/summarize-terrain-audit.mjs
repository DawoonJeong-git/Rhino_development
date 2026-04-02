import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    files: argv.filter((arg) => !arg.startsWith("--")),
  };
}

function formatList(values) {
  return (values || []).length ? values.join(", ") : "-";
}

function inferTopCapOnly(nativeElevations, missingBottoms) {
  const native = (nativeElevations || []).filter(Number.isFinite).sort((a, b) => a - b);
  const missing = (missingBottoms || []).filter(Number.isFinite).sort((a, b) => a - b);

  if (!native.length) {
    return false;
  }

  return missing.length === 1 && missing[0] === native[native.length - 1];
}

function evaluateStatus(summary) {
  const nativeOk =
    summary.nativeMissingExport.length === 0 &&
    (summary.nativeMissingRenderable.length === 0 || summary.topCapOnly === true);
  const bandOk = Number.isFinite(summary.expectedBandCount)
    ? summary.renderableBands === summary.expectedBandCount
    : false;
  const formatParityOk = summary.threeDmContours === summary.skpContours;
  const roadsOk =
    summary.sourceRoadCount === 0 ||
    (summary.threeDmRoadObjects > 0 && summary.skpRoadSolids > 0);

  if (nativeOk && bandOk && formatParityOk && roadsOk) {
    return "pass";
  }

  if (nativeOk || bandOk || formatParityOk || roadsOk) {
    return "partial";
  }

  return "fail";
}

function summarizeCase(filePath, json) {
  const rawCaseName = path.basename(filePath, path.extname(filePath));
  const caseName = rawCaseName
    .replace(/^tmp_audit_/, "")
    .replace(/_clean$/, "")
    .replace(/_/g, " ");
  const nativeElevations = json?.terrainPipeline?.nativeElevations || [];
  const requestedInterval = Number(json?.source?.options?.contourInterval || 0);
  const minNative = nativeElevations.length ? Math.min(...nativeElevations) : null;
  const maxNative = nativeElevations.length ? Math.max(...nativeElevations) : null;
  const expectedBandCount =
    Number.isFinite(minNative) &&
    Number.isFinite(maxNative) &&
    Number.isFinite(requestedInterval) &&
    requestedInterval > 0
      ? Math.round((maxNative - minNative) / requestedInterval)
      : null;
  const nativeMissingRenderable =
    json?.terrainPipeline?.renderableMissingNativeBottomElevations || [];
  const topCapOnly = inferTopCapOnly(nativeElevations, nativeMissingRenderable);

  const summary = {
    case: caseName,
    requestedInterval,
    sourceInterval: Number(json?.siteContext?.stats?.sourceContourInterval || 0),
    nativeElevations,
    expectedBandCount,
    sourceContourCount: Number(json?.terrainPipeline?.sourceContours?.featureCount || 0),
    exportContourCount: Number(json?.terrainPipeline?.exportContours?.featureCount || 0),
    generatedContourCount: Number(
      json?.terrainPipeline?.exportContours?.generatedFeatureCount || 0
    ),
    renderableBands: Number(json?.terrainPipeline?.renderableBandGroups?.groupCount || 0),
    nativeMissingExport: json?.terrainPipeline?.exportMissingNativeElevations || [],
    nativeMissingRenderable,
    topCapOnly,
    threeDmContours: Number(json?.comparisons?.threeDmContourCurves || 0),
    skpContours: Number(json?.comparisons?.skpContourCurves || 0),
    sourceRoadCount: Number(json?.siteContext?.stats?.roadCount || 0),
    threeDmRoadObjects: Number(json?.exports?.threeDm?.summary?.layers?.roads?.objects || 0),
    skpRoadSolids: Number(json?.comparisons?.skpRoadSolids || 0),
    skpTerrainSolids: Number(json?.comparisons?.skpTerrainSolids || 0),
  };
  summary.status = evaluateStatus(summary);
  return summary;
}

function renderMarkdown(summaries) {
  const lines = [
    "| Case | Req | Source | Status | Native levels | Export contours | Bands | 3DM/SKP contours | Roads | Notes |",
    "| --- | ---: | ---: | --- | --- | ---: | --- | --- | --- | --- |",
  ];

  for (const summary of summaries) {
    const notes = [];
    if (summary.topCapOnly) {
      notes.push(`top-cap only missing ${formatList(summary.nativeMissingRenderable)}`);
    } else if (summary.nativeMissingRenderable.length) {
      notes.push(`renderable missing ${formatList(summary.nativeMissingRenderable)}`);
    }
    if (summary.nativeMissingExport.length) {
      notes.push(`export missing ${formatList(summary.nativeMissingExport)}`);
    }

    lines.push(
      `| ${summary.case} | ${summary.requestedInterval}m | ${summary.sourceInterval}m | ${summary.status} | ${formatList(
        summary.nativeElevations
      )} | ${summary.exportContourCount} (${summary.generatedContourCount} gen) | ${summary.renderableBands}/${summary.expectedBandCount ?? "-"} | ${summary.threeDmContours}/${summary.skpContours} | ${summary.threeDmRoadObjects}/${summary.skpRoadSolids} | ${notes.join("; ") || "-"} |`
    );
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.files.length) {
    console.error(
      "Usage: node scripts/summarize-terrain-audit.mjs <inspect-json> [more-files] [--json]"
    );
    process.exitCode = 1;
    return;
  }

  const summaries = [];

  for (const file of args.files) {
    const content = await readFile(path.resolve(file), "utf8");
    const json = JSON.parse(content);
    summaries.push(summarizeCase(file, json));
  }

  if (args.json) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  console.log(renderMarkdown(summaries));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
