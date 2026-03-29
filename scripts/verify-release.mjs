import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL =
  process.env.VERIFY_RELEASE_BASE_URL || "http://127.0.0.1:3000";
const DEFAULT_UI_SUITE =
  process.env.VERIFY_RELEASE_UI_SUITE || "extended";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function readArgValue(flag) {
  const index = process.argv.indexOf(flag);

  if (index === -1 || index === process.argv.length - 1) {
    return "";
  }

  return String(process.argv[index + 1] || "").trim();
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function normalizeUiSuite(value) {
  return /^(smoke|extended|full)$/i.test(String(value || "").trim())
    ? String(value || "").trim().toLowerCase()
    : "extended";
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

async function runNodeStep(name, scriptRelativePath, args = []) {
  const startedAt = Date.now();
  const scriptPath = path.join(REPO_ROOT, scriptRelativePath);

  console.log("");
  console.log(`[verify-release] ${name}: start`);
  console.log(
    `[verify-release] ${name}: ${process.execPath} ${[scriptPath, ...args].join(" ")}`
  );

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "inherit",
      windowsHide: false,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const error = new Error(
        `[verify-release] ${name} failed with ${
          signal ? `signal ${signal}` : `exit code ${code}`
        }.`
      );
      error.stepName = name;
      error.exitCode = code;
      error.signal = signal;
      reject(error);
    });
  });

  return {
    name,
    status: "passed",
    durationMs: Date.now() - startedAt,
  };
}

async function main() {
  const baseUrl = readArgValue("--base-url") || DEFAULT_BASE_URL;
  const uiSuite = normalizeUiSuite(readArgValue("--ui-suite") || DEFAULT_UI_SUITE);
  const skipBaseline = hasFlag("--skip-baseline");
  const skipLive = hasFlag("--skip-live");
  const skipUi = hasFlag("--skip-ui");
  const steps = [];
  const startedAt = Date.now();

  if (!skipBaseline) {
    steps.push(
      await runNodeStep("baseline", "verify-exports.mjs", ["--baseline"])
    );
  }

  if (!skipLive) {
    steps.push(
      await runNodeStep("live-site-context", "scripts/verify-live-site-context.mjs", [
        "--base-url",
        baseUrl,
      ])
    );
  }

  if (!skipUi) {
    steps.push(
      await runNodeStep("ui-suite", "scripts/verify-ui-flow.mjs", [
        "--suite",
        uiSuite,
        "--base-url",
        baseUrl,
      ])
    );
  }

  console.log("");
  console.log(
    JSON.stringify(
      {
        ok: true,
        verifiedAt: new Date().toISOString(),
        baseUrl,
        uiSuite,
        totalDurationMs: Date.now() - startedAt,
        totalDurationText: formatDuration(Date.now() - startedAt),
        steps: steps.map((step) => ({
          ...step,
          durationText: formatDuration(step.durationMs),
        })),
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
