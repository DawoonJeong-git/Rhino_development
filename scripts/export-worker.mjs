import { writeFile } from "node:fs/promises";
import process from "node:process";
import {
  assertSiteContextWithinLimits,
  build3dmFromSiteContext,
  buildCachedSkpPayloadAttachmentBuffer,
  buildDxfFromSiteContext,
  buildObjFromSiteContext,
  buildResolvedExportDownloadFilename,
  buildSiteContext,
  buildSkpPayloadEnvelope,
  buildSkpFromSiteContextWithRetry,
  prepareSiteContextForExport,
} from "../server.mjs";

function sendMessage(message) {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function reportProgress(percent, message) {
  sendMessage({
    type: "progress",
    percent: Math.max(0, Math.min(100, Number(percent) || 0)),
    message: typeof message === "string" ? message : "",
  });
}

function createRangedProgressReporter(startPercent, endPercent) {
  const start = Number(startPercent) || 0;
  const end = Number(endPercent) || 100;
  const span = end - start;

  return (percent, message) => {
    const normalizedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
    reportProgress(start + (span * normalizedPercent) / 100, message);
  };
}

function normalizeExportBuffer(value, contentType) {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  if (typeof value === "string") {
    return Buffer.from(value, contentType.includes("dxf") ? "utf8" : "utf8");
  }

  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

async function runExport(payload) {
  const config = payload?.config || {};
  const requestedLocation = payload?.requestedLocation || {};
  const requestedOptions = payload?.requestedOptions || {};
  const format = String(payload?.format || requestedOptions?.exportFormat || "obj");
  const resultPath = String(payload?.resultPath || "");

  if (!resultPath) {
    throw new Error("Export worker result path is missing.");
  }

  reportProgress(4, "백그라운드 모델 작업을 준비하고 있습니다.");
  let siteContext = await buildSiteContext(
    {
      location: requestedLocation,
      options: requestedOptions,
    },
    config,
    createRangedProgressReporter(6, 42)
  );

  assertSiteContextWithinLimits(siteContext, config);
  reportProgress(44, "출력용 대지 컨텍스트를 정리하고 있습니다.");
  siteContext = prepareSiteContextForExport(siteContext, requestedOptions, format);
  const filename = buildResolvedExportDownloadFilename(
    siteContext,
    requestedOptions,
    format
  );
  let contentType = "application/octet-stream";
  let exportBody = null;

  if (format === "3dm") {
    reportProgress(48, "3DM 모델을 생성하고 있습니다.");
    exportBody = await build3dmFromSiteContext(
      siteContext,
      createRangedProgressReporter(48, 96)
    );
  } else if (format === "skp") {
    reportProgress(48, "SKP 모델을 생성하고 있습니다.");
    exportBody = await buildSkpFromSiteContextWithRetry(
      siteContext,
      createRangedProgressReporter(48, 96),
      config
    );
  } else if (format === "skp-payload") {
    reportProgress(48, "SKP payload를 생성하고 있습니다.");
    const exportPayload = buildSkpPayloadEnvelope(siteContext, config);
    exportBody = buildCachedSkpPayloadAttachmentBuffer(exportPayload);
    contentType = "application/json; charset=utf-8";
  } else if (format === "dxf") {
    reportProgress(48, "DXF 파일을 생성하고 있습니다.");
    exportBody = buildDxfFromSiteContext(
      siteContext,
      createRangedProgressReporter(48, 96)
    );
    contentType = "application/dxf; charset=utf-8";
  } else {
    reportProgress(48, "OBJ 파일을 생성하고 있습니다.");
    exportBody = buildObjFromSiteContext(
      siteContext,
      createRangedProgressReporter(48, 96)
    );
    contentType = "text/plain; charset=utf-8";
  }

  const buffer = normalizeExportBuffer(exportBody, contentType);
  await writeFile(resultPath, buffer);
  reportProgress(100, "모델 파일이 준비되었습니다.");
  sendMessage({
    type: "done",
    filename,
    contentType,
    resultPath,
    sizeBytes: buffer.length,
  });
  setTimeout(() => process.exit(0), 0);
}

process.on("message", (message) => {
  if (!message || message.type !== "start") {
    return;
  }

  runExport(message.payload).catch((error) => {
    sendMessage({
      type: "error",
      error: error?.stack || error?.message || String(error),
    });
    setTimeout(() => process.exit(1), 0);
  });
});

sendMessage({ type: "ready" });
