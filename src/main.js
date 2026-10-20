// Entry point of the GitHub Action.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "./github.js";
import { renderMarkdown } from "./markdown.js";
import { addReport, removeReport, safeName, updatePagesBranch } from "./pages.js";
import { findResultsFile, parseResults } from "./results.js";

const input = (name, fallback = "") => (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim();
const bool = (name, fallback) => !/^(false|0|no|off)$/i.test(input(name, String(fallback)));
const log = (message) => console.log(message);
const notice = (message) => console.log(`::notice::${message}`);
const warn = (message) => console.log(`::warning::${message}`);

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function readEvent() {
  const file = process.env.GITHUB_EVENT_PATH;
  return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

/** Merges sharded blob reports into one HTML report and one JSON report. */
function mergeBlobs(blobDir, workspace) {
  const out = mkdtempSync(join(tmpdir(), "pw-merged-"));
  const htmlDir = join(out, "html");
  const json = join(out, "results.json");
  log(`Merging blob reports from ${blobDir}`);
  execFileSync("npx", ["--no-install", "playwright", "merge-reports", "--reporter", "html,json", blobDir], {
    cwd: workspace,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PLAYWRIGHT_HTML_OUTPUT_DIR: htmlDir, PLAYWRIGHT_HTML_REPORT: htmlDir, PLAYWRIGHT_HTML_OPEN: "never", PLAYWRIGHT_JSON_OUTPUT_FILE: json, PLAYWRIGHT_JSON_OUTPUT_NAME: json },
  });
  return { reportDir: htmlDir, resultsFile: json };
}

export async function run(env = process.env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const at = (p) => (isAbsolute(p) ? p : resolve(workspace, p));
  const repository = env.GITHUB_REPOSITORY;
  const [owner, repo] = (repository ?? "/").split("/");
  const serverUrl = env.GITHUB_SERVER_URL || "https://github.com";
  const token = input("github-token");
  const event = readEvent();
  const pr = event.pull_request;
  const mode = input("mode", "publish").toLowerCase();
  const branch = input("branch", "gh-pages");
  const folder = input("folder", "reports").replace(/^\/+|\/+$/g, "");
  const retentionDays = Number(input("retention-days", "30")) || 0;
  const branchName = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "main";
  const name = safeName(input("name") || (pr ? `pr-${pr.number}` : branchName));
  const remoteUrl = env.PW_REPORT_PUBLISH_REMOTE || `${serverUrl}/${repository}.git`;
  const client = createClient({ token, apiUrl: env.GITHUB_API_URL || "https://api.github.com", repository });

  if (mode === "cleanup") {
    updatePagesBranch({ remoteUrl, token, branch, folder, retentionDays, repository, change: removeReport(name) });
    log(`Removed report "${name}" from ${branch}/${folder}`);
    return { removed: name };
  }

  // Inputs: merge shards if asked, then find the HTML report and the JSON results.
  let reportDir = at(input("report-dir", "playwright-report"));
  let resultsFile = findResultsFile(input("results-json") ? at(input("results-json")) : "", workspace);
  if (input("blob-dir")) ({ reportDir, resultsFile } = mergeBlobs(at(input("blob-dir")), workspace));
  if (!existsSync(join(reportDir, "index.html"))) throw new Error(`No HTML report at ${reportDir}. Add the "html" reporter, or set report-dir.`);
  const results = resultsFile ? parseResults(JSON.parse(readFileSync(resultsFile, "utf8")), { reportDir }) : null;
  if (!results) warn("No Playwright JSON report found, so the comment has no summary. Add the json reporter (see README).");

  // Pull requests from forks get a read-only token: nothing can be published or commented.
  const fromFork = pr && pr.head?.repo?.full_name && pr.head.repo.full_name !== repository;
  let siteUrl = input("site-url");
  if (!siteUrl && !fromFork) siteUrl = (await client.pagesUrl()) ?? "";
  if (!siteUrl) siteUrl = repo?.toLowerCase() === `${owner?.toLowerCase()}.github.io` ? `https://${owner.toLowerCase()}.github.io/` : `https://${owner?.toLowerCase()}.github.io/${repo}/`;
  const reportUrl = `${siteUrl.replace(/\/?$/, "/")}${folder ? `${folder}/` : ""}${name}/`;

  const runUrl = env.GITHUB_RUN_ID ? `${serverUrl}/${repository}/actions/runs/${env.GITHUB_RUN_ID}` : "";
  const commit = pr?.head?.sha || env.GITHUB_SHA || "";
  let note;
  if (fromFork) {
    note = "This pull request comes from a fork, so the report was not published (fork workflows get a read-only token). Download it from the run's artifacts instead.";
    notice(note);
  } else {
    updatePagesBranch({
      remoteUrl,
      token,
      branch,
      folder,
      retentionDays,
      repository,
      change: addReport({
        sourceDir: reportDir,
        entry: {
          name,
          title: pr ? `PR #${pr.number}: ${pr.title ?? ""}`.trim() : branchName,
          branch: branchName,
          pr: pr?.number ?? null,
          commit,
          runUrl,
          counts: results?.counts ?? null,
          updatedAt: new Date().toISOString(),
        },
      }),
    });
    log(`Published ${reportDir} -> ${branch}/${folder}/${name}`);
    log(`Report: ${reportUrl}`);
  }

  const markdown = renderMarkdown(results, { reportUrl: fromFork ? "" : reportUrl, commit, runUrl, runNumber: env.GITHUB_RUN_NUMBER, note });
  if (bool("summary", true) && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  if (bool("comment", true) && pr && !fromFork) {
    try {
      await client.upsertComment(pr.number, markdown);
      log(`Updated the comment on PR #${pr.number}`);
    } catch (error) {
      warn(`Could not comment on the PR (${error.message}). Give the job "pull-requests: write" permission.`);
    }
  }

  if (!fromFork) setOutput("report-url", reportUrl);
  for (const key of ["passed", "failed", "flaky", "skipped"]) setOutput(key, results?.counts[key] ?? "");
  return { reportUrl, results, published: !fromFork };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
