import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { chromium } from "@playwright/test";

const DEFAULT_BASE_URL =
  process.env.VERIFY_UI_BASE_URL || "http://127.0.0.1:3000";
const DEFAULT_QUERY =
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

function parseSiteContextRequest(postData) {
  try {
    const payload = JSON.parse(String(postData || "{}"));
    return {
      previewOnly:
        payload?.previewOnly === true || payload?.options?.previewOnly === true,
      radius: Number(payload?.options?.radius || 0),
      includeContours: payload?.options?.includeContours !== false,
      includeRoads: payload?.options?.includeRoads === true,
      includeBuildings: payload?.options?.includeBuildings !== false,
      hasCustomBounds: Boolean(payload?.customBounds),
      lat: Number(payload?.location?.lat || 0),
      lng: Number(payload?.location?.lng || 0),
    };
  } catch {
    return {
      previewOnly: null,
    };
  }
}

function matchesSiteContextResponse(response, expectedPreviewOnly = null) {
  if (
    !response.url().includes("/api/site-context") ||
    response.request().method() !== "POST"
  ) {
    return false;
  }

  if (expectedPreviewOnly === null) {
    return true;
  }

  const payload = parseSiteContextRequest(response.request().postData());
  return payload.previewOnly === expectedPreviewOnly;
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

async function searchAndConfirmSelection(page, searchQuery, timeoutMs = 30000) {
  await page.locator("#searchInput").fill(searchQuery);
  await page.locator('#searchForm button[type="submit"]').click();

  const confirmButton = page
    .locator('#searchResults .result-item [data-action="confirm"]')
    .first();

  await confirmButton.waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  await confirmButton.click();

  return waitForStableText(page, "#selectionMeta", ["선택 후 표시"], timeoutMs);
}

async function snapshotUi(page) {
  const buttonState = await page.evaluate(() => {
    const button = document.querySelector("#previewSiteContextButton");
    return {
      disabled: Boolean(button?.disabled),
      ariaBusy: String(button?.getAttribute("aria-busy") || "false"),
      text: String(button?.textContent || "").replace(/\s+/g, " ").trim(),
    };
  });
  const uiState = await page.evaluate(() => {
    const api = window.__SPACEWORK_UI_TEST__;
    return typeof api?.getState === "function" ? api.getState() : null;
  });

  return {
    previewButton: buttonState,
    specPreview: String(
      await page.locator("#specPreview").innerText().catch(() => "")
    ).replace(/\s+/g, " ").trim(),
    siteContextChip: String(
      await page.locator("#siteContextStatusChip").innerText().catch(() => "")
    ).replace(/\s+/g, " ").trim(),
    siteContextNote: String(
      await page.locator("#siteContextNote").innerText().catch(() => "")
    ).replace(/\s+/g, " ").trim(),
    selectionSummary: String(
      await page.locator("#selectionSummary").innerText().catch(() => "")
    ).replace(/\s+/g, " ").trim(),
    uiState,
  };
}

async function main() {
  const baseUrl = readArgValue("--base-url") || DEFAULT_BASE_URL;
  const query = readArgValue("--query") || DEFAULT_QUERY;
  const outputPath = readArgValue("--output");
  const screenshotPath = readArgValue("--screenshot");
  const browserPath = resolveBrowserExecutable();

  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  const siteContextEvents = [];

  page.on("response", (response) => {
    if (!matchesSiteContextResponse(response, null)) {
      return;
    }

    const requestMeta = parseSiteContextRequest(response.request().postData());
    siteContextEvents.push({
      url: response.url(),
      status: response.status(),
      ok: response.ok(),
      previewOnly: requestMeta.previewOnly,
      radius: requestMeta.radius,
      includeContours: requestMeta.includeContours,
      includeRoads: requestMeta.includeRoads,
      includeBuildings: requestMeta.includeBuildings,
      hasCustomBounds: requestMeta.hasCustomBounds,
      lat: requestMeta.lat,
      lng: requestMeta.lng,
      recordedAt: new Date().toISOString(),
    });
  });

  try {
    await openStudioPage(page, baseUrl);
    await waitForUiVerificationApi(page, 30000);

    const selectionPreviewResponsePromise = page
      .waitForResponse((response) => matchesSiteContextResponse(response, true), {
        timeout: 60000,
      })
      .catch(() => null);

    const selectionMeta = await searchAndConfirmSelection(page, query, 60000);
    const selectionPreviewResponse = await selectionPreviewResponsePromise;
    await page.waitForTimeout(1500);
    const beforePreview = await snapshotUi(page);

    await waitForButtonEnabled(page, "#previewSiteContextButton", 60000);
    const fullPreviewResponsePromise = page.waitForResponse(
      (response) => matchesSiteContextResponse(response, false),
      { timeout: 120000 }
    );
    await page.locator("#previewSiteContextButton").click();
    const fullPreviewResponse = await fullPreviewResponsePromise;
    await waitForStableText(
      page,
      "#specPreview",
      [
        "모델 미리보기를 누르면",
        "설정이 바뀌었습니다. 미리보기 또는 다운로드를 누르면",
      ],
      120000
    );
    await page.waitForTimeout(1500);
    const afterPreview = await snapshotUi(page);

    if (screenshotPath) {
      await page.screenshot({
        path: screenshotPath,
        fullPage: true,
      });
    }

    const result = {
      inspectedAt: new Date().toISOString(),
      baseUrl,
      browserPath: browserPath || "playwright-default",
      query,
      selectionMeta: String(selectionMeta || "").replace(/\s+/g, " ").trim(),
      selectionPreviewRequest: selectionPreviewResponse
        ? {
            status: selectionPreviewResponse.status(),
            ok: selectionPreviewResponse.ok(),
            request: parseSiteContextRequest(
              selectionPreviewResponse.request().postData()
            ),
          }
        : null,
      fullPreviewRequest: {
        status: fullPreviewResponse.status(),
        ok: fullPreviewResponse.ok(),
        request: parseSiteContextRequest(fullPreviewResponse.request().postData()),
      },
      beforePreview,
      afterPreview,
      siteContextEvents,
    };

    const output = JSON.stringify(result, null, 2);

    if (outputPath) {
      await writeFile(outputPath, output, "utf8");
    }

    console.log(output);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
