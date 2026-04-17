import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

const DEFAULT_BASE_URL =
  process.env.VERIFY_UI_BASE_URL || "http://127.0.0.1:3000";
const DEFAULT_SUITE = process.env.VERIFY_UI_SUITE || "smoke";
const DEFAULT_SEARCH_QUERY =
  process.env.VERIFY_UI_QUERY || "서울 중구 세종대로 110";
const DEFAULT_MULTI_PARCEL_QUERIES = [
  "서울 중구 세종대로 110",
  "서울 중구 덕수궁길 15",
];
const DEFAULT_RANGE_BOUNDS = Object.freeze({
  minLat: 37.56595,
  minLng: 126.97745,
  maxLat: 37.56715,
  maxLng: 126.9792,
});
const DEFAULT_BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const DEFAULT_VIEWPORT = {
  width: 1440,
  height: 1100,
};

function readArgValue(flag) {
  const index = process.argv.indexOf(flag);

  if (index === -1 || index === process.argv.length - 1) {
    return "";
  }

  return String(process.argv[index + 1] || "").trim();
}

function resolveBrowserExecutable() {
  const requestedPath =
    readArgValue("--browser-path") ||
    process.env.VERIFY_UI_BROWSER_PATH ||
    "";

  if (requestedPath && existsSync(requestedPath)) {
    return requestedPath;
  }

  return DEFAULT_BROWSER_CANDIDATES.find((candidate) => existsSync(candidate)) || "";
}

function normalizeSuiteName(value) {
  return /^(extended|full)$/i.test(String(value || "").trim()) ? "extended" : "smoke";
}

function normalizeScenarioName(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return "";
  }

  if (/^(smoke|address-dxf-smoke)$/.test(normalized)) {
    return "address-dxf-smoke";
  }

  if (/^(multi|multi-parcel|multi-parcel-preview)$/.test(normalized)) {
    return "multi-parcel-preview";
  }

  if (/^(range|manual-range|manual-range-3dm)$/.test(normalized)) {
    return "manual-range-3dm";
  }

  if (/^(skp|1km|large-skp|address-1km-skp|address-large-skp)$/.test(normalized)) {
    return "address-large-skp";
  }

  return normalized;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function isRetriableBrowserLaunchError(error) {
  const message = String(error?.message || error || "");
  return /spawn\s+eperm/i.test(message) || /\bEPERM\b/i.test(message);
}

async function launchBrowserWithRetry(options, attemptCount = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, attemptCount); attempt += 1) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      lastError = error;

      if (!isRetriableBrowserLaunchError(error) || attempt >= attemptCount) {
        throw error;
      }

      const delayMs = 350 * attempt;
      console.warn(
        `[verify-ui] browser launch retry ${attempt}/${attemptCount} after ${delayMs}ms: ${String(
          error?.message || error
        )}`
      );
      await wait(delayMs);
    }
  }

  throw lastError;
}

async function waitForStableText(
  page,
  selector,
  excludedSnippets = [],
  timeoutMs = 30000
) {
  await page.waitForFunction(
    ({ selector: targetSelector, excludedSnippets: disallowedSnippets }) => {
      const text = String(
        document.querySelector(targetSelector)?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      return (
        Boolean(text) &&
        disallowedSnippets.every((snippet) => !text.includes(snippet))
      );
    },
    { selector, excludedSnippets },
    { timeout: timeoutMs }
  );

  return page.locator(selector).innerText();
}

async function waitForChipText(page, selector, pattern, timeoutMs = 30000) {
  await page.waitForFunction(
    ({ selector: targetSelector, patternSource, patternFlags }) => {
      const text = String(
        document.querySelector(targetSelector)?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      if (!text) {
        return false;
      }

      return new RegExp(patternSource, patternFlags).test(text);
    },
    {
      selector,
      patternSource: pattern.source,
      patternFlags: pattern.flags,
    },
    { timeout: timeoutMs }
  );

  return page.locator(selector).innerText();
}

async function waitForButtonEnabled(page, selector, timeoutMs = 30000) {
  await page.waitForFunction(
    (targetSelector) => {
      const button = document.querySelector(targetSelector);
      return Boolean(button) && !button.disabled;
    },
    selector,
    { timeout: timeoutMs }
  );
}

async function openStudioPage(page, baseUrl) {
  await page.goto(`${baseUrl}/contour3dmodel`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
}

async function waitForUiVerificationApi(page, timeoutMs = 30000) {
  await page.waitForFunction(
    () => Boolean(window.__SPACEWORK_UI_TEST__),
    undefined,
    { timeout: timeoutMs }
  );
}

async function searchAndConfirmSelection(
  page,
  searchQuery,
  timeoutMs = 30000,
  retryCount = 0
) {
  await page.locator("#searchInput").fill(searchQuery);
  await page.locator('#searchForm button[type="submit"]').click();

  const confirmButton = page
    .locator('#searchResults .result-item [data-action="confirm"]')
    .first();

  try {
    await confirmButton.waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  } catch (error) {
    if (retryCount < 1) {
      await page.waitForTimeout(750);
      return searchAndConfirmSelection(page, searchQuery, timeoutMs, retryCount + 1);
    }

    throw error;
  }

  await confirmButton.click();

  return waitForStableText(page, "#selectionMeta", ["선택 전"], timeoutMs);
}

function isFullSiteContextResponse(response) {
  if (
    !response.url().includes("/api/site-context") ||
    response.request().method() !== "POST"
  ) {
    return false;
  }

  const postData = String(response.request().postData() || "");
  return !postData.includes('"previewOnly":true');
}

async function runSiteContextPreview(page, timeoutMs = 120000) {
  await waitForButtonEnabled(page, "#previewSiteContextButton", timeoutMs);
  const siteContextResponsePromise = page.waitForResponse(isFullSiteContextResponse, {
    timeout: timeoutMs,
  });
  await page.locator("#previewSiteContextButton").click();
  const siteContextResponse = await siteContextResponsePromise;

  assert.equal(
    siteContextResponse.ok(),
    true,
    "Preview flow should load site-context successfully."
  );

  const specSummary = await waitForStableText(
    page,
    "#specPreview",
    [
      "모델 미리보기를 누르면",
      "설정이 바뀌었습니다. 미리보기 또는 다운로드를 누르면",
    ],
    timeoutMs
  );
  const siteContextChip = await waitForChipText(
    page,
    "#siteContextStatusChip",
    /준비 완료/i,
    timeoutMs
  );

  const siteContextNote = await waitForStableText(
    page,
    "#siteContextNote",
    [],
    timeoutMs
  );
  assert.match(
    String(siteContextNote || ""),
    /미리보기가 갱신되었습니다/,
    "Preview flow should visibly confirm that the map preview was refreshed."
  );

  return {
    specSummary,
    siteContextChip,
    siteContextNote,
  };
}

async function loadLandInfo(page, timeoutMs = 60000) {
  if (await hasUiVerificationMethod(page, "loadLandInfo")) {
    const hookResult = await callUiVerificationMethod(page, "loadLandInfo");
    assert.ok(
      hookResult?.parcelReference?.pnu || hookResult?.state?.selectedLocation?.pnu,
      "Land info UI hook should resolve a parcel reference."
    );
  } else {
    await waitForButtonEnabled(page, "#loadLandInfoButton", timeoutMs);
    const landInfoResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/land-info") &&
        response.request().method() === "POST",
      { timeout: timeoutMs }
    );
    await page.locator("#loadLandInfoButton").click();
    const landInfoResponse = await landInfoResponsePromise;

    assert.equal(
      landInfoResponse.ok(),
      true,
      "Land info request should complete successfully."
    );
  }

  return {
    landInfoSummary: await waitForStableText(
      page,
      "#landInfoList",
      ["토지정보 요약 결과가 여기에 표시됩니다."],
      timeoutMs
    ),
    landInfoChip: await waitForChipText(
      page,
      "#landInfoStatusChip",
      /조회 완료/i,
      timeoutMs
    ),
  };
}

async function loadBuildingRegister(page, timeoutMs = 60000) {
  if (await hasUiVerificationMethod(page, "loadBuildingRegister")) {
    const hookResult = await callUiVerificationMethod(
      page,
      "loadBuildingRegister"
    );
    assert.ok(
      hookResult && typeof hookResult === "object",
      "Building-register UI hook should return a result envelope."
    );
  } else {
    await waitForButtonEnabled(page, "#loadBuildingRegisterButton", timeoutMs);
    const buildingRegisterResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/building-register") &&
        response.request().method() === "POST",
      { timeout: timeoutMs }
    );
    await page.locator("#loadBuildingRegisterButton").click();
    const buildingRegisterResponse = await buildingRegisterResponsePromise;

    assert.equal(
      buildingRegisterResponse.ok(),
      true,
      "Building-register request should complete successfully."
    );
  }

  return {
    buildingRegisterSummary: await waitForStableText(
      page,
      "#buildingRegisterList",
      [
        "건축물대장 요약 결과가 여기에 표시됩니다.",
        "건축HUB 키를 설정하면 결과가 표시됩니다.",
      ],
      timeoutMs
    ),
    buildingRegisterChip: await waitForChipText(
      page,
      "#buildingRegisterStatusChip",
      /조회 완료/i,
      timeoutMs
    ),
  };
}

async function setModelOptions(page, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "modelOptionOverrides")) {
    const supportsModelOptionOverrides = await hasUiVerificationMethod(
      page,
      "setModelOptionOverrides"
    );

    if (supportsModelOptionOverrides) {
      await callUiVerificationMethod(
        page,
        "setModelOptionOverrides",
        options.modelOptionOverrides
      );
    }
  }

  if (options.radius != null) {
    const radiusInput = page.locator('input[name="radius"]');
    await radiusInput.fill(String(options.radius));
    await radiusInput.press("Tab");
  }

  if (options.contourInterval != null) {
    await page.selectOption(
      'select[name="contourInterval"]',
      String(options.contourInterval)
    );
  }

  if (options.exportFormat) {
    await page.selectOption('select[name="exportFormat"]', options.exportFormat);
  }
}

async function downloadModel(page, format, timeoutMs = 120000) {
  await page.selectOption('select[name="exportFormat"]', format);
  await waitForButtonEnabled(page, "#downloadObjButton", timeoutMs);

  const downloadPromise = page.waitForEvent("download", {
    timeout: timeoutMs,
  });
  const exportResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/export-model") &&
      response.request().method() === "POST",
    { timeout: timeoutMs }
  );
  await page.locator("#downloadObjButton").click();
  const [download, exportResponse] = await Promise.all([
    downloadPromise,
    exportResponsePromise,
  ]);

  assert.equal(
    exportResponse.ok(),
    true,
    `Model export request should complete successfully for ${format}.`
  );
  assert.equal(
    await download.failure(),
    null,
    "Browser download should complete without failure."
  );
  assert.match(
    download.suggestedFilename(),
    new RegExp(`\\.${format}$`, "i"),
    `${format.toUpperCase()} export should suggest a .${format} filename.`
  );

  return {
    downloadFilename: download.suggestedFilename(),
  };
}

async function hasUiVerificationMethod(page, methodName) {
  return page.evaluate((nextMethodName) => {
    const api = window.__SPACEWORK_UI_TEST__;
    return Boolean(api && typeof api[nextMethodName] === "function");
  }, methodName);
}

async function callUiVerificationMethod(page, methodName, payload) {
  return page.evaluate(
    async ({ nextMethodName, nextPayload }) => {
      const api = window.__SPACEWORK_UI_TEST__;

      if (!api || typeof api[nextMethodName] !== "function") {
        throw new Error(`UI verification hook is missing method: ${nextMethodName}`);
      }

      return api[nextMethodName](nextPayload);
    },
    { nextMethodName: methodName, nextPayload: payload }
  );
}

async function runSmokeScenario(context, baseUrl, searchQuery) {
  const page = await context.newPage();

  try {
    await openStudioPage(page, baseUrl);

    const chipIds = [
      "#siteContextStatusChip",
      "#landInfoStatusChip",
      "#buildingRegisterStatusChip",
    ];
    for (const chipSelector of chipIds) {
      await page.locator(chipSelector).waitFor({
        state: "attached",
        timeout: 30000,
      });
    }

    const selectionSummary = await searchAndConfirmSelection(page, searchQuery, 30000);
    const previewResult = await runSiteContextPreview(page, 120000);
    const landInfoResult = await loadLandInfo(page, 60000);
    const buildingResult = await loadBuildingRegister(page, 60000);
    const downloadResult = await downloadModel(page, "dxf", 120000);

    return {
      name: "address-dxf-smoke",
      searchQuery,
      selectionSummary,
      ...previewResult,
      ...landInfoResult,
      ...buildingResult,
      ...downloadResult,
    };
  } finally {
    await page.close();
  }
}

async function runMultiParcelScenario(context, baseUrl) {
  const page = await context.newPage();

  try {
    console.error("[verify-ui] multi-parcel: open page");
    await openStudioPage(page, baseUrl);
    await waitForUiVerificationApi(page);

    console.error("[verify-ui] multi-parcel: select mock parcels");
    const hookResult = await callUiVerificationMethod(
      page,
      "selectMockMultiParcel"
    );

    assert.equal(
      hookResult?.selectionMode,
      "multi-parcel",
      "Multi-parcel scenario should enter multi-parcel selection mode."
    );
    assert.ok(
      Number(hookResult?.selectedParcelCount || 0) >= 2,
      "Multi-parcel scenario should select at least two parcels."
    );

    console.error("[verify-ui] multi-parcel: wait for selection summary");
    const selectionSummary = await waitForStableText(
      page,
      "#selectionMeta",
      ["선택 전"],
      60000
    );
    console.error("[verify-ui] multi-parcel: wait for group-mode chips");
    const landInfoChip = await waitForChipText(
      page,
      "#landInfoStatusChip",
      /그룹 모드/i,
      30000
    );
    const buildingRegisterChip = await waitForChipText(
      page,
      "#buildingRegisterStatusChip",
      /그룹 모드/i,
      30000
    );

    return {
      name: "multi-parcel-preview",
      selectionSource: "mock-parcels",
      parcelLabels: DEFAULT_MULTI_PARCEL_QUERIES,
      selectionSummary,
      siteContextChip: await page.locator("#siteContextStatusChip").innerText(),
      landInfoChip,
      buildingRegisterChip,
      selectedParcelCount: hookResult.selectedParcelCount,
    };
  } finally {
    await page.close();
  }
}

async function runManualRange3dmScenario(context, baseUrl) {
  const page = await context.newPage();

  try {
    await openStudioPage(page, baseUrl);
    await waitForUiVerificationApi(page);

    const hookResult = await callUiVerificationMethod(
      page,
      "selectRangeFromBounds",
      DEFAULT_RANGE_BOUNDS
    );

    assert.equal(
      hookResult?.selectionMode,
      "range",
      "Manual-range scenario should enter range selection mode."
    );

    await setModelOptions(page, {
      exportFormat: "3dm",
    });

    const selectionSummary = await waitForStableText(
      page,
      "#selectionMeta",
      ["선택 전"],
      60000
    );
    const previewResult = await runSiteContextPreview(page, 120000);
    const landInfoChip = await waitForChipText(
      page,
      "#landInfoStatusChip",
      /범위 모드/i,
      30000
    );
    const buildingRegisterChip = await waitForChipText(
      page,
      "#buildingRegisterStatusChip",
      /범위 모드/i,
      30000
    );
    const downloadResult = await downloadModel(page, "3dm", 180000);

    return {
      name: "manual-range-3dm",
      bounds: DEFAULT_RANGE_BOUNDS,
      selectionSummary,
      ...previewResult,
      landInfoChip,
      buildingRegisterChip,
      ...downloadResult,
    };
  } finally {
    await page.close();
  }
}

async function runOneKmSkpScenario(context, baseUrl, searchQuery) {
  const page = await context.newPage();
  const radiusMeters = 600;
  const contourIntervalMeters = 5;
  const modelOptionOverrides = {
    includeRoads: false,
  };

  try {
    await openStudioPage(page, baseUrl);
    const selectionSummary = await searchAndConfirmSelection(page, searchQuery, 30000);
    await setModelOptions(page, {
      radius: radiusMeters,
      contourInterval: contourIntervalMeters,
      exportFormat: "skp",
      modelOptionOverrides,
    });

    const previewResult = await runSiteContextPreview(page, 180000);
    const downloadResult = await downloadModel(page, "skp", 480000);

    return {
      name: "address-large-skp",
      searchQuery,
      radiusMeters,
      contourIntervalMeters,
      modelOptionOverrides,
      selectionSummary,
      ...previewResult,
      ...downloadResult,
    };
  } finally {
    await page.close();
  }
}

async function main() {
  const baseUrl = readArgValue("--base-url") || DEFAULT_BASE_URL;
  const suite = normalizeSuiteName(readArgValue("--suite") || DEFAULT_SUITE);
  const onlyScenario = normalizeScenarioName(readArgValue("--only"));
  const searchQuery = readArgValue("--query") || DEFAULT_SEARCH_QUERY;
  const executablePath = resolveBrowserExecutable();
  const headless = !/^(1|true|yes)$/i.test(
    String(process.env.VERIFY_UI_HEADFUL || "")
  );

  assert.ok(
    executablePath,
    "No Chrome/Edge executable was found. Set VERIFY_UI_BROWSER_PATH to continue."
  );

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  const healthPayload = await healthResponse.json().catch(() => ({}));
  assert.equal(healthResponse.ok, true, "UI verification target should be healthy.");
  assert.equal(healthPayload?.ok, true, "Health endpoint should return ok=true.");

  const browser = await launchBrowserWithRetry({
    executablePath,
    headless,
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: DEFAULT_VIEWPORT,
  });

  try {
    const scenarios = [];
    if (!onlyScenario || onlyScenario === "address-dxf-smoke") {
      scenarios.push(await runSmokeScenario(context, baseUrl, searchQuery));
    }

    if (suite === "extended") {
      if (!onlyScenario || onlyScenario === "multi-parcel-preview") {
        scenarios.push(await runMultiParcelScenario(context, baseUrl));
      }

      if (!onlyScenario || onlyScenario === "manual-range-3dm") {
        scenarios.push(await runManualRange3dmScenario(context, baseUrl));
      }

      if (!onlyScenario || onlyScenario === "address-large-skp") {
        scenarios.push(await runOneKmSkpScenario(context, baseUrl, searchQuery));
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          verifiedAt: new Date().toISOString(),
          baseUrl,
          browser: executablePath,
          suite,
          onlyScenario,
          scenarios,
        },
        null,
        2
      )
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);

  if (error?.cause) {
    console.error(
      error.cause instanceof Error
        ? error.cause.stack || error.cause.message
        : error.cause
    );
  }

  process.exitCode = 1;
});
