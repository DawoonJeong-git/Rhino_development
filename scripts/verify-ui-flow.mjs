import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

const DEFAULT_BASE_URL =
  process.env.VERIFY_UI_BASE_URL || "http://127.0.0.1:3000";
const DEFAULT_SEARCH_QUERY =
  process.env.VERIFY_UI_QUERY || "서울 중구 세종대로 110";
const DEFAULT_BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

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

async function main() {
  const baseUrl = readArgValue("--base-url") || DEFAULT_BASE_URL;
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

  const browser = await chromium.launch({
    executablePath,
    headless,
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: {
      width: 1440,
      height: 1100,
    },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${baseUrl}/contour3dmodel`, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    await page.locator("#searchInput").fill(searchQuery);
    await page.locator("#searchForm button[type=\"submit\"]").click();

    const confirmButton = page
      .locator("#searchResults .result-item [data-action=\"confirm\"]")
      .first();
    await confirmButton.waitFor({
      state: "visible",
      timeout: 30000,
    });
    await confirmButton.click();

    const selectionSummary = await waitForStableText(
      page,
      "#selectionMeta",
      ["선택 전"],
      30000
    );

    await page.selectOption('select[name="exportFormat"]', "dxf");

    const siteContextResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/site-context") &&
        response.request().method() === "POST",
      { timeout: 120000 }
    );
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
      ["모델 미리보기를 누르면"],
      120000
    );

    const landInfoResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/land-info") &&
        response.request().method() === "POST",
      { timeout: 60000 }
    );
    await page.locator("#loadLandInfoButton").click();
    const landInfoResponse = await landInfoResponsePromise;
    assert.equal(
      landInfoResponse.ok(),
      true,
      "Land info request should complete successfully."
    );
    const landInfoSummary = await waitForStableText(
      page,
      "#landInfoList",
      ["토지정보 요약 결과가 여기에 표시됩니다."],
      60000
    );

    const buildingRegisterResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/building-register") &&
        response.request().method() === "POST",
      { timeout: 60000 }
    );
    await page.locator("#loadBuildingRegisterButton").click();
    const buildingRegisterResponse = await buildingRegisterResponsePromise;
    assert.equal(
      buildingRegisterResponse.ok(),
      true,
      "Building-register request should complete successfully."
    );
    const buildingRegisterSummary = await waitForStableText(
      page,
      "#buildingRegisterList",
      [
        "건축물대장 요약 결과가 여기에 표시됩니다.",
        "건축HUB 키를 설정하면 결과가 표시됩니다.",
      ],
      60000
    );

    const downloadPromise = page.waitForEvent("download", {
      timeout: 120000,
    });
    const exportResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/export-model") &&
        response.request().method() === "POST",
      { timeout: 120000 }
    );
    await page.locator("#downloadObjButton").click();
    const [download, exportResponse] = await Promise.all([
      downloadPromise,
      exportResponsePromise,
    ]);
    assert.equal(
      exportResponse.ok(),
      true,
      "Model export request should complete successfully."
    );
    assert.equal(
      await download.failure(),
      null,
      "Browser download should complete without failure."
    );
    assert.match(
      download.suggestedFilename(),
      /\.dxf$/i,
      "DXF export should suggest a .dxf filename."
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          verifiedAt: new Date().toISOString(),
          baseUrl,
          browser: executablePath,
          searchQuery,
          selectionSummary,
          specSummary,
          landInfoSummary,
          buildingRegisterSummary,
          downloadFilename: download.suggestedFilename(),
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
  process.exitCode = 1;
});
