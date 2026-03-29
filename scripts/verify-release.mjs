import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
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
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "logs", "verify-release");
const DEFAULT_KEEP_REPORT_COUNT = Math.max(
  5,
  Number(process.env.VERIFY_RELEASE_KEEP_REPORTS || 40)
);

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

function tailText(text, maxLength = 4000) {
  const normalized = String(text || "").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(-maxLength);
}

function extractTrailingJson(text) {
  const trimmed = String(text || "").trimEnd();

  for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {
      // Keep scanning backward until the trailing JSON block is found.
    }
  }

  return null;
}

function getGitMetadata(repoRoot) {
  const readGit = (...args) => {
    const result = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });

    if (result.status !== 0) {
      return "";
    }

    return String(result.stdout || "").trim();
  };

  return {
    branch: readGit("rev-parse", "--abbrev-ref", "HEAD"),
    commit: readGit("rev-parse", "HEAD"),
    shortCommit: readGit("rev-parse", "--short", "HEAD"),
  };
}

function buildReportStamp(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

async function pruneOldReports(outputDir, keepCount = DEFAULT_KEEP_REPORT_COUNT) {
  const entries = await readdir(outputDir, {
    withFileTypes: true,
  }).catch(() => []);
  const reportFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^verify-release-\d{8}-\d{6}-(passed|failed)\.json$/i.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const staleFiles = reportFiles.slice(Math.max(0, keepCount));

  await Promise.all(
    staleFiles.map((name) =>
      rm(path.join(outputDir, name), {
        force: true,
      })
    )
  );
}

async function writeVerificationReport(report, outputDir = DEFAULT_OUTPUT_DIR) {
  await mkdir(outputDir, {
    recursive: true,
  });

  const stamp = buildReportStamp(new Date(report.finishedAt || report.verifiedAt || Date.now()));
  const statusSuffix = report.ok ? "passed" : "failed";
  const reportFilename = `verify-release-${stamp}-${statusSuffix}.json`;
  const reportPath = path.join(outputDir, reportFilename);
  const latestPath = path.join(outputDir, "latest.json");
  const payload = {
    ...report,
    reportFilename,
    reportPath,
  };

  await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(latestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await pruneOldReports(outputDir);

  return {
    reportFilename,
    reportPath,
    latestPath,
  };
}

async function runNodeStep(name, scriptRelativePath, args = []) {
  const startedAt = Date.now();
  const scriptPath = path.join(REPO_ROOT, scriptRelativePath);
  const command = `${process.execPath} ${[scriptPath, ...args].join(" ")}`;

  console.log("");
  console.log(`[verify-release] ${name}: start`);
  console.log(`[verify-release] ${name}: ${command}`);

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const stepResult = {
        name,
        status:
          code === 0 && !signal ? "passed" : "failed",
        durationMs: Date.now() - startedAt,
        command,
        summary: extractTrailingJson(stdout),
        stdoutTail: tailText(stdout),
        stderrTail: tailText(stderr),
      };

      if (code === 0) {
        resolve(stepResult);
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
      error.stepResult = stepResult;
      reject(error);
    });
  });
}

async function main() {
  const baseUrl = readArgValue("--base-url") || DEFAULT_BASE_URL;
  const uiSuite = normalizeUiSuite(readArgValue("--ui-suite") || DEFAULT_UI_SUITE);
  const outputDir = readArgValue("--output-dir") || DEFAULT_OUTPUT_DIR;
  const shouldWriteLog = !hasFlag("--no-write-log");
  const skipBaseline = hasFlag("--skip-baseline");
  const skipLive = hasFlag("--skip-live");
  const skipUi = hasFlag("--skip-ui");
  const steps = [];
  const startedAt = Date.now();
  const git = getGitMetadata(REPO_ROOT);
  const report = {
    ok: false,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: "",
    verifiedAt: "",
    baseUrl,
    uiSuite,
    git,
    steps,
  };
  let failure = null;

  try {
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

    report.ok = true;
  } catch (error) {
    failure = error;

    if (error?.stepResult) {
      steps.push(error.stepResult);
    }

    report.error = {
      message: error instanceof Error ? error.message : String(error || "Unknown error"),
      stepName: error?.stepName || "",
      exitCode: Number.isFinite(error?.exitCode) ? error.exitCode : null,
      signal: error?.signal || null,
    };
  } finally {
    const finishedAt = Date.now();
    report.finishedAt = new Date(finishedAt).toISOString();
    report.verifiedAt = report.finishedAt;
    report.totalDurationMs = finishedAt - startedAt;
    report.totalDurationText = formatDuration(report.totalDurationMs);
    report.steps = steps.map((step) => ({
      ...step,
      durationText: formatDuration(step.durationMs),
    }));

    if (shouldWriteLog) {
      try {
        const writeResult = await writeVerificationReport(report, outputDir);
        report.reportFilename = writeResult.reportFilename;
        report.reportPath = writeResult.reportPath;
        report.latestPath = writeResult.latestPath;
      } catch (writeError) {
        report.logWriteError =
          writeError instanceof Error ? writeError.message : String(writeError);
      }
    }
  }

  console.log("");
  console.log(JSON.stringify(report, null, 2));

  if (failure) {
    console.error(
      failure instanceof Error ? failure.stack || failure.message : failure
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
