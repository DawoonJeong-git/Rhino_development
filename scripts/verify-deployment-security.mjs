import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    strictRuntime: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--root") {
      const nextValue = argv[index + 1];

      if (!nextValue) {
        throw new Error("Missing value for --root");
      }

      parsed.root = path.resolve(nextValue);
      index += 1;
      continue;
    }

    if (token === "--strict-runtime") {
      parsed.strictRuntime = true;
    }
  }

  return parsed;
}

function normalizeScalar(value) {
  return String(value ?? "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function normalizeJsonText(text) {
  return String(text ?? "").replace(/^\uFEFF/, "");
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function pathExists(filePath, { directoryOnly = false } = {}) {
  try {
    const details = await stat(filePath);
    return directoryOnly ? details.isDirectory() : true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isLoopbackHost(value) {
  const normalized = normalizeScalar(value).toLowerCase();
  return (
    normalized === "" ||
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

function recordCheck(checks, id, ok, message) {
  checks.push({
    id,
    status: ok ? "pass" : "fail",
    message,
  });
}

function recordInfo(checks, id, message) {
  checks.push({
    id,
    status: "info",
    message,
  });
}

function printCheck(check) {
  const label =
    check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "INFO";
  console.log(`[${label}] ${check.id}: ${check.message}`);
}

async function main() {
  const { root: repoRoot, strictRuntime } = parseArgs(process.argv.slice(2));
  const checks = [];

  const configExampleText = await readTextIfExists(
    path.join(repoRoot, "config.local.json.example")
  );
  const cloudflareExampleText = await readTextIfExists(
    path.join(repoRoot, "deploy", "cloudflared-config.example.yml")
  );
  const sparseManifestText = await readTextIfExists(
    path.join(repoRoot, "deploy", "runtime-sparse-checkout.txt")
  );
  const readmeText = await readTextIfExists(path.join(repoRoot, "README.md"));
  const homeDeploymentDocText = await readTextIfExists(
    path.join(repoRoot, "docs", "home-pc-deployment.md")
  );
  const releaseGateDocText = await readTextIfExists(
    path.join(repoRoot, "docs", "security-release-gates.md")
  );
  const localConfigText = await readTextIfExists(path.join(repoRoot, "config.local.json"));

  let configExample = {};

  try {
    configExample = JSON.parse(normalizeJsonText(configExampleText || "{}"));
  } catch (error) {
    recordCheck(
      checks,
      "config-example-json",
      false,
      `config.local.json.example must stay valid JSON: ${error.message}`
    );
  }

  if (Object.keys(configExample).length > 0) {
    const bindHost = Object.prototype.hasOwnProperty.call(configExample, "BIND_HOST")
      ? configExample.BIND_HOST
      : "";

    recordCheck(
      checks,
      "config-example-direct-bind",
      isLoopbackHost(bindHost),
      "config.local.json.example should keep direct Node binds on loopback."
    );
    recordCheck(
      checks,
      "config-example-route-base-path",
      Object.prototype.hasOwnProperty.call(configExample, "ROUTE_BASE_PATH"),
      "config.local.json.example should document ROUTE_BASE_PATH for /main and /test routing."
    );
  }

  recordCheck(
    checks,
    "cloudflare-example-main-route",
    /path:\s+\^\/main\(\?:\/\.\*\)\?\$/i.test(String(cloudflareExampleText || "")) &&
      /service:\s+http:\/\/127\.0\.0\.1:3000/i.test(String(cloudflareExampleText || "")),
    "deploy/cloudflared-config.example.yml should route /main to 127.0.0.1:3000."
  );
  recordCheck(
    checks,
    "cloudflare-example-test-route",
    /path:\s+\^\/test\(\?:\/\.\*\)\?\$/i.test(String(cloudflareExampleText || "")) &&
      /service:\s+http:\/\/127\.0\.0\.1:3001/i.test(String(cloudflareExampleText || "")),
    "deploy/cloudflared-config.example.yml should route /test to 127.0.0.1:3001."
  );
  recordCheck(
    checks,
    "cloudflare-example-root-route",
    /path:\s+\^\/\$/i.test(String(cloudflareExampleText || "")) &&
      /service:\s+http:\/\/127\.0\.0\.1:3000/i.test(String(cloudflareExampleText || "")),
    "deploy/cloudflared-config.example.yml should route / to 127.0.0.1:3000."
  );

  recordCheck(
    checks,
    "runtime-sparse-core-files",
    [
      "/deploy/run-home-site.bat",
      "/deploy/start-cloudflare-tunnel.ps1",
      "/deploy/update-home-prod.ps1",
    ].every((requiredPath) => String(sparseManifestText || "").includes(requiredPath)),
    "deploy/runtime-sparse-checkout.txt should keep the core Cloudflare runtime files."
  );
  recordCheck(
    checks,
    "runtime-sparse-security-script",
    String(sparseManifestText || "").includes("/scripts/verify-deployment-security.mjs"),
    "deploy/runtime-sparse-checkout.txt should keep verify-deployment-security available."
  );

  recordCheck(
    checks,
    "readme-main-test-flow",
    /SpaceWork_develop/i.test(String(readmeText || "")) &&
      /SpaceWork_deploy/i.test(String(readmeText || "")) &&
      /https:\/\/spaceswork\.net\/test/i.test(String(readmeText || "")) &&
      /https:\/\/spaceswork\.net\/main/i.test(String(readmeText || "")),
    "README.md should describe the develop/test and deploy/main split."
  );

  if (homeDeploymentDocText === null) {
    recordInfo(
      checks,
      "home-deploy-doc",
      "docs/home-pc-deployment.md is not present in this workspace, so only runtime files were checked."
    );
  } else {
    recordCheck(
      checks,
      "home-deploy-doc-access-layer",
      /Cloudflare Tunnel/i.test(String(homeDeploymentDocText || "")) &&
        /\/main/i.test(String(homeDeploymentDocText || "")) &&
        /\/test/i.test(String(homeDeploymentDocText || "")),
      "home deployment docs should keep the Cloudflare tunnel and /main /test routing visible."
    );
  }

  if (releaseGateDocText === null) {
    recordInfo(
      checks,
      "release-gates-doc",
      "docs/security-release-gates.md is not present in this workspace, so the release gate text was skipped."
    );
  } else {
    recordCheck(
      checks,
      "release-gates-doc",
      /Hard Stops/i.test(String(releaseGateDocText || "")) &&
        /Cloudflare/i.test(String(releaseGateDocText || "")) &&
        /\/main/i.test(String(releaseGateDocText || "")) &&
        /\/test/i.test(String(releaseGateDocText || "")),
      "security-release-gates.md should define Cloudflare routing expectations and hard stops."
    );
  }

  if (localConfigText === null) {
    recordInfo(
      checks,
      "local-direct-config",
      "config.local.json is not present, so local runtime checks were skipped."
    );
  } else {
    try {
      const localConfig = JSON.parse(normalizeJsonText(localConfigText));
      const bindHost = Object.prototype.hasOwnProperty.call(localConfig, "BIND_HOST")
        ? localConfig.BIND_HOST
        : "";

      recordCheck(
        checks,
        "local-direct-bind",
        isLoopbackHost(bindHost),
        bindHost
          ? "The local config.local.json file should keep BIND_HOST on loopback for direct sharing."
          : "config.local.json omits BIND_HOST, so the server loopback default remains in effect."
      );

      if (strictRuntime) {
        const localConfigDomain = normalizeScalar(localConfig.VWORLD_API_DOMAIN);
        const publicBaseUrl = normalizeScalar(localConfig.PUBLIC_BASE_URL);
        const routeBasePath = normalizeScalar(localConfig.ROUTE_BASE_PATH);
        const localContourPath = normalizeScalar(localConfig.TERRAIN_CONTOUR_PATH);
        const localContourExists =
          localContourPath !== "" && (await pathExists(localContourPath, { directoryOnly: true }));

        recordCheck(
          checks,
          "strict-runtime-config-domain",
          /^https:\/\//i.test(localConfigDomain) &&
            !/localhost|127\.0\.0\.1|::1/i.test(localConfigDomain),
          "In strict runtime mode, config.local.json should point VWORLD_API_DOMAIN at the real HTTPS share origin."
        );
        recordCheck(
          checks,
          "strict-runtime-public-base-url",
          /^https:\/\//i.test(publicBaseUrl) &&
            /\/(main|test)\/?$/i.test(publicBaseUrl),
          "In strict runtime mode, config.local.json should publish an HTTPS PUBLIC_BASE_URL ending in /main or /test."
        );
        recordCheck(
          checks,
          "strict-runtime-route-base-path",
          routeBasePath === "" || routeBasePath === "/main" || routeBasePath === "/test",
          "In strict runtime mode, ROUTE_BASE_PATH should be blank, /main, or /test."
        );
        recordCheck(
          checks,
          "strict-runtime-contour-path",
          localContourExists,
          "In strict runtime mode, config.local.json should reference an existing contour dataset path."
        );
      }
    } catch (error) {
      recordCheck(
        checks,
        "local-direct-config-json",
        false,
        `config.local.json must stay valid JSON: ${error.message}`
      );
    }
  }

  for (const check of checks) {
    printCheck(check);
  }

  const failures = checks.filter((check) => check.status === "fail");
  const infos = checks.filter((check) => check.status === "info");
  const summary = {
    ok: failures.length === 0,
    verifiedAt: new Date().toISOString(),
    root: repoRoot,
    strictRuntime,
    checks: checks.length,
    failures: failures.length,
    infos: infos.length,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
