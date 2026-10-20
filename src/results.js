// Reads Playwright's JSON report: totals, plus failed and flaky tests with their error and trace.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

/** First meaningful line of an error message. */
export function firstLine(message = "") {
  const line = stripAnsi(message).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** The HTML report stores each trace as data/<sha1 of the file>.zip. */
function reportTracePath(attachment, reportDir) {
  if (!attachment?.path || !existsSync(attachment.path)) return null;
  const sha1 = createHash("sha1").update(readFileSync(attachment.path)).digest("hex");
  const relative = `data/${sha1}.zip`;
  return reportDir && existsSync(join(reportDir, relative)) ? relative : null;
}

export function parseResults(report, { reportDir } = {}) {
  const failed = [];
  const flaky = [];
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };

  const walk = (suite, path) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const status = test.status; // expected | unexpected | flaky | skipped
        if (status === "expected") counts.passed += 1;
        else if (status === "skipped") counts.skipped += 1;
        else if (status === "flaky") counts.flaky += 1;
        else if (status === "unexpected") counts.failed += 1;
        if (status !== "unexpected" && status !== "flaky") continue;

        const results = test.results ?? [];
        const failing = status === "flaky" ? results.find((r) => r.status !== "passed") : results.at(-1);
        const error = failing?.errors?.[0]?.message ?? failing?.error?.message ?? "";
        const trace = (failing?.attachments ?? []).find((a) => a.name === "trace");
        const entry = {
          testId: spec.id,
          title: spec.title,
          path,
          file: spec.file,
          line: spec.line,
          project: test.projectName ?? "",
          retries: Math.max(0, results.length - 1),
          error: firstLine(error),
          trace: reportTracePath(trace, reportDir),
        };
        (status === "flaky" ? flaky : failed).push(entry);
      }
    }
    for (const child of suite.suites ?? []) {
      const isFile = !child.line || child.title === child.file || child.title === basename(child.file ?? "");
      walk(child, isFile ? path : [...path, child.title]);
    }
  };
  for (const suite of report.suites ?? []) walk(suite, []);

  const stats = report.stats ?? {};
  return {
    counts,
    total: counts.passed + counts.failed + counts.flaky + counts.skipped,
    duration: Math.round(stats.duration ?? 0),
    startTime: stats.startTime ?? null,
    failed,
    flaky,
    ok: counts.failed === 0,
  };
}

/** Finds the JSON report: explicit path, then env, then common locations. */
export function findResultsFile(explicit, cwd = process.cwd()) {
  const candidates = [explicit, process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, "results.json", "test-results/results.json", "playwright-report/results.json"]
    .filter(Boolean)
    .map((p) => (p.startsWith("/") ? p : join(cwd, p)));
  return candidates.find((p) => existsSync(p)) ?? null;
}
