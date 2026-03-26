import { readFile } from "node:fs/promises";
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

function parseEnv(text) {
  const values = new Map();

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    values.set(key, normalizeScalar(value));
  }

  return values;
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

function isLoopbackHost(value) {
  const normalized = normalizeScalar(value).toLowerCase();
  return (
    normalized === "" ||
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

function isContainerWildcardHost(value) {
  const normalized = normalizeScalar(value).toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
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

  const composeText = await readTextIfExists(path.join(repoRoot, "compose.yaml"));
  const envExampleText = await readTextIfExists(
    path.join(repoRoot, ".env.production.example")
  );
  const configExampleText = await readTextIfExists(
    path.join(repoRoot, "config.local.json.example")
  );
  const caddyAllowlistText = await readTextIfExists(
    path.join(repoRoot, "deploy", "Caddyfile.home.example")
  );
  const homeDeploymentDocText = await readTextIfExists(
    path.join(repoRoot, "docs", "home-pc-deployment.md")
  );
  const releaseGateDocText = await readTextIfExists(
    path.join(repoRoot, "docs", "security-release-gates.md")
  );

  recordCheck(
    checks,
    "compose-host-loopback-default",
    String(composeText || "").includes('"${HOST_BIND_IP:-127.0.0.1}:${PORT:-3000}:3000"'),
    "compose.yaml should keep the host-published app port on 127.0.0.1 by default."
  );
  recordCheck(
    checks,
    "compose-container-bind-default",
    String(composeText || "").includes('BIND_HOST: "${BIND_HOST:-0.0.0.0}"'),
    "compose.yaml should keep the container listener reachable from Docker port publishing."
  );

  const envExample = parseEnv(envExampleText);
  recordCheck(
    checks,
    "env-example-host-bind",
    isLoopbackHost(envExample.get("HOST_BIND_IP")),
    ".env.production.example should keep HOST_BIND_IP on loopback."
  );
  recordCheck(
    checks,
    "env-example-container-bind",
    isContainerWildcardHost(envExample.get("BIND_HOST")),
    ".env.production.example should keep BIND_HOST on 0.0.0.0 inside Docker."
  );

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
    recordCheck(
      checks,
      "config-example-direct-bind",
      isLoopbackHost(configExample.BIND_HOST),
      "config.local.json.example should keep direct Node binds on loopback."
    );
  }

  recordCheck(
    checks,
    "caddy-allowlist-fallback",
    /remote_ip/.test(String(caddyAllowlistText || "")),
    "deploy/Caddyfile.home.example should keep an explicit IP allowlist fallback example."
  );
  recordCheck(
    checks,
    "home-deploy-doc-access-layer",
    /Cloudflare Tunnel plus Cloudflare Access/i.test(String(homeDeploymentDocText || "")),
    "home deployment docs should keep the Tunnel plus Access recommendation visible."
  );
  recordCheck(
    checks,
    "release-gates-doc",
    /Hard Stops/i.test(String(releaseGateDocText || "")) &&
      /Cloudflare Access/i.test(String(releaseGateDocText || "")) &&
      /allowlist/i.test(String(releaseGateDocText || "")),
    "security-release-gates.md should define access expectations and hard stops."
  );

  const productionEnvText = await readTextIfExists(path.join(repoRoot, ".env.production"));

  if (productionEnvText === null) {
    recordInfo(
      checks,
      "local-production-env",
      ".env.production is not present in this workspace, so only example defaults were checked."
    );
  } else {
    const productionEnv = parseEnv(productionEnvText);
    recordCheck(
      checks,
      "local-production-host-bind",
      isLoopbackHost(productionEnv.get("HOST_BIND_IP")),
      "The local .env.production file should keep HOST_BIND_IP on loopback for controlled sharing."
    );
    recordCheck(
      checks,
      "local-production-domain",
      /^https:\/\//i.test(normalizeScalar(productionEnv.get("VWORLD_API_DOMAIN"))),
      "The local .env.production file should use an HTTPS VWORLD_API_DOMAIN."
    );
  }

  const localConfigText = await readTextIfExists(path.join(repoRoot, "config.local.json"));

  if (localConfigText === null) {
    recordInfo(
      checks,
      "local-direct-config",
      "config.local.json is not present, so direct-node bind checks were skipped."
    );
  } else {
    let localConfig = {};

    try {
      localConfig = JSON.parse(normalizeJsonText(localConfigText));
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
        const localContourPath = normalizeScalar(localConfig.TERRAIN_CONTOUR_PATH);
        const localContourExists =
          localContourPath !== "" &&
          (await readTextIfExists(localContourPath).catch((error) => {
            if (error?.code === "EISDIR") {
              return "__DIRECTORY_EXISTS__";
            }

            if (error?.code === "ENOENT") {
              return null;
            }

            throw error;
          })) !== null;

        recordCheck(
          checks,
          "strict-runtime-config-domain",
          /^https:\/\//i.test(localConfigDomain) &&
            !/localhost|127\.0\.0\.1|::1/i.test(localConfigDomain),
          "In strict runtime mode, config.local.json should point VWORLD_API_DOMAIN at the real HTTPS share origin."
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
  console.error("[FAIL] verify-deployment-security:", error);
  process.exitCode = 1;
});
