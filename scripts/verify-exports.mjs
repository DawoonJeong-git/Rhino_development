import process from "node:process";
import {
  prepareSiteContextForExport,
  build3dmFromSiteContext,
  buildSketchUpPayloadFromSiteContext,
  buildObjFromSiteContext,
  getRhino3dm,
  localMetersFromLngLat,
  resolveContourTerrainRenderPlan,
} from "../server.mjs";

const BASE_URL = process.env.SITE_CONTEXT_BASE_URL || "http://127.0.0.1:3000";

const CASES = [
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
  const terrainPlan = resolveContourTerrainRenderPlan(exportSiteContext);

  return {
    exportSiteContext,
    requested: exportSiteContext.stats?.requestedContourInterval,
    source: exportSiteContext.stats?.sourceContourInterval,
    effective: exportSiteContext.stats?.effectiveContourBandInterval,
    terrainPlan,
    exportContourFeatureCount: Number(
      exportSiteContext?.exportContourLines?.features?.length || 0
    ),
    canonicalNativeContourLevelCount: Number(
      exportSiteContext?.stats?.canonicalNativeContourLevelCount || 0
    ),
    canonicalGeneratedContourLevelCount: Number(
      exportSiteContext?.stats?.canonicalGeneratedContourLevelCount || 0
    ),
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
  const model = rhino.File3dm.fromByteArray(Uint8Array.from(threeDmBytes));
  const layers = model.layers();
  const objects = model.objects();
  const layerNames = new Map();

  for (let index = 0; index < layers.count; index += 1) {
    const layer = layers.get(index);
    layerNames.set(layer.index, layer.name);
  }

  const terrainBands = [];

  for (let index = 0; index < objects.count; index += 1) {
    const object = objects.get(index);
    const attributes = object.attributes();
    const layerName = layerNames.get(attributes.layerIndex);
    const objectName = String(attributes.name || "").trim();

    if (
      !["MODEL_TERRAIN", "terrain"].includes(layerName) ||
      !objectName.startsWith("TERRAIN_BAND_")
    ) {
      continue;
    }

    const geometry = object.geometry();
    const bbox = geometry?.getBoundingBox ? geometry.getBoundingBox() : null;

    if (!bbox) {
      continue;
    }

    const width = Number((bbox.max.x - bbox.min.x).toFixed(3));
    const height = Number((bbox.max.y - bbox.min.y).toFixed(3));
    const minZ = Number(bbox.min.z.toFixed(3));
    const maxZ = Number(bbox.max.z.toFixed(3));

    terrainBands.push({
      name: objectName,
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

async function verifyCase(testCase) {
  const siteContext = await fetchJson("/api/site-context", {
    location: testCase.location,
    options: testCase.options,
  });

  const threeDm = summarizeExportContext(siteContext, "3dm");
  const skp = summarizeExportContext(siteContext, "skp");
  const obj = summarizeExportContext(siteContext, "obj");

  const threeDmBytes = await build3dmFromSiteContext(threeDm.exportSiteContext);
  const threeDmTerrainBands = await summarize3dmTerrainBands(
    threeDmBytes,
    threeDm.exportSiteContext
  );

  if (threeDmTerrainBands.trailingFullFootprintBandCount > 0) {
    throw new Error(
      `3dm terrain pathology detected for ${testCase.name}: trailing full-footprint bands ` +
        `${threeDmTerrainBands.trailingFullFootprintBands
          .map((band) => `${band.name}@${band.minZ}-${band.maxZ}`)
          .join(", ")}`
    );
  }

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
        exportContourFeatureCount: threeDm.exportContourFeatureCount,
        canonicalNativeContourLevelCount: threeDm.canonicalNativeContourLevelCount,
        canonicalGeneratedContourLevelCount: threeDm.canonicalGeneratedContourLevelCount,
        rawAnchoredContourBandCount: Number(
          threeDm.terrainPlan?.bandGroups?.rawAnchoredContourBandCount ||
            threeDm.terrainPlan?.bandGroups?.length ||
            0
        ),
        rawAnchoredGridFallbackBandCount: Number(
          threeDm.terrainPlan?.bandGroups?.rawAnchoredGridFallbackBandCount || 0
        ),
        bytes: threeDmBytes.length,
        terrainBands: threeDmTerrainBands,
      },
      skp: {
        requested: skp.requested,
        source: skp.source,
        effective: skp.effective,
        exportContourFeatureCount: skp.exportContourFeatureCount,
        canonicalNativeContourLevelCount: skp.canonicalNativeContourLevelCount,
        canonicalGeneratedContourLevelCount: skp.canonicalGeneratedContourLevelCount,
        rawAnchoredContourBandCount: Number(
          skp.terrainPlan?.bandGroups?.rawAnchoredContourBandCount ||
            skp.terrainPlan?.bandGroups?.length ||
            0
        ),
        rawAnchoredGridFallbackBandCount: Number(
          skp.terrainPlan?.bandGroups?.rawAnchoredGridFallbackBandCount || 0
        ),
        groups: skpPayload.groups?.length || 0,
      },
      obj: {
        requested: obj.requested,
        source: obj.source,
        effective: obj.effective,
        exportContourFeatureCount: obj.exportContourFeatureCount,
        canonicalNativeContourLevelCount: obj.canonicalNativeContourLevelCount,
        canonicalGeneratedContourLevelCount: obj.canonicalGeneratedContourLevelCount,
        rawAnchoredContourBandCount: Number(
          obj.terrainPlan?.bandGroups?.rawAnchoredContourBandCount ||
            obj.terrainPlan?.bandGroups?.length ||
            0
        ),
        rawAnchoredGridFallbackBandCount: Number(
          obj.terrainPlan?.bandGroups?.rawAnchoredGridFallbackBandCount || 0
        ),
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
