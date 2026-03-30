import assert from "node:assert/strict";

const DEFAULT_BASE_URL =
  process.env.VERIFY_PUBLIC_ORIGIN_BASE_URL || "";

function readArgValue(flag) {
  const index = process.argv.indexOf(flag);

  if (index === -1 || index === process.argv.length - 1) {
    return "";
  }

  return String(process.argv[index + 1] || "").trim();
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/u, "");
}

async function readResponseBody(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/json")) {
    return response.json().catch(() => ({}));
  }

  return response.text().catch(() => "");
}

function summarizeBody(body) {
  if (typeof body === "string") {
    return body.trim();
  }

  if (body && typeof body === "object") {
    return JSON.stringify(body);
  }

  return String(body ?? "");
}

async function main() {
  const baseUrl = normalizeBaseUrl(readArgValue("--base-url") || DEFAULT_BASE_URL);

  assert.ok(
    /^https?:\/\//i.test(baseUrl),
    "A public base URL is required. Pass --base-url https://your-domain.example."
  );

  const healthResponse = await fetch(`${baseUrl}/api/health`, {
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  });
  const healthPayload = await readResponseBody(healthResponse);

  assert.equal(
    healthResponse.status,
    200,
    `Public health endpoint should stay reachable at ${baseUrl}.`
  );
  assert.equal(
    healthPayload?.ok,
    true,
    "Public health endpoint should return ok=true."
  );

  const runtimeStatsResponse = await fetch(`${baseUrl}/api/runtime-stats`, {
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  });
  const runtimeStatsPayload = await readResponseBody(runtimeStatsResponse);
  const runtimeStatsSummary = summarizeBody(runtimeStatsPayload);

  assert.equal(
    runtimeStatsResponse.status,
    403,
    "Sensitive runtime stats should stay blocked on the public origin."
  );
  assert.match(
    runtimeStatsSummary,
    /localhost|forbidden/i,
    "Blocked public runtime stats response should explain that access is forbidden."
  );

  const hubResponse = await fetch(`${baseUrl}/`, {
    redirect: "manual",
    headers: {
      Accept: "text/html",
      "Cache-Control": "no-cache",
    },
  });
  const hubHtml = await readResponseBody(hubResponse);
  const hubSummary = summarizeBody(hubHtml);

  assert.equal(hubResponse.status, 200, "Public hub route should stay reachable.");
  assert.doesNotMatch(
    hubSummary,
    /\/heritage-risk|\/max-mass/i,
    "Public hub should not expose unfinished internal routes."
  );

  const hiddenRoutes = ["/heritage-risk", "/max-mass"];

  for (const pathname of hiddenRoutes) {
    const hiddenResponse = await fetch(`${baseUrl}${pathname}`, {
      redirect: "manual",
      headers: {
        Accept: "text/html,application/json",
        "Cache-Control": "no-cache",
      },
    });

    assert.equal(
      hiddenResponse.status,
      404,
      `Unfinished route ${pathname} should stay blocked on the public origin.`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        verifiedAt: new Date().toISOString(),
        baseUrl,
        checks: [
          {
            id: "public-health-open",
            status: "pass",
            httpStatus: healthResponse.status,
          },
          {
            id: "public-runtime-stats-blocked",
            status: "pass",
            httpStatus: runtimeStatsResponse.status,
          },
          {
            id: "public-hub-hides-internal-routes",
            status: "pass",
            httpStatus: hubResponse.status,
          },
          ...hiddenRoutes.map((pathname) => ({
            id: `public-hidden-route-${pathname.slice(1)}-blocked`,
            status: "pass",
            httpStatus: 404,
          })),
        ],
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
