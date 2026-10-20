// Runs the whole action against a local bare git repo and a fake GitHub API.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/main.js";
import { bareRepo, fakeGitHub, git, makeReport, tmp } from "./helpers.js";

function setup({ prNumber = 7, fork = false, mode = "publish", extra = {} } = {}) {
  const dir = tmp();
  const { reportDir, resultsFile } = makeReport(dir);
  const remote = extra.remote ?? bareRepo(dir);
  const eventFile = join(dir, "event.json");
  const pr = prNumber ? { number: prNumber, title: "Add login", head: { sha: "1234567890abcdef", repo: { full_name: fork ? "someone/demo" : "me/demo" } } } : undefined;
  writeFileSync(eventFile, JSON.stringify(pr ? { pull_request: pr } : {}));
  const env = {
    GITHUB_WORKSPACE: dir,
    GITHUB_REPOSITORY: "me/demo",
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_SHA: "fedcba0987654321",
    GITHUB_REF_NAME: "main",
    GITHUB_HEAD_REF: pr ? "feature/login" : "",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_NUMBER: "5",
    GITHUB_OUTPUT: join(dir, "output.txt"),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    PW_REPORT_PUBLISH_REMOTE: remote,
    "INPUT_GITHUB-TOKEN": "fake-token",
    "INPUT_REPORT-DIR": reportDir,
    "INPUT_RESULTS-JSON": resultsFile,
    INPUT_MODE: mode,
    ...extra.env,
  };
  return { dir, remote, env };
}

async function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("INPUT_") || key.startsWith("GITHUB_")) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const show = (remote, path) => git(remote, "show", `gh-pages:${path}`);

test("publishes the report, comments once, updates the comment, and cleans up", async () => {
  const api = await fakeGitHub();
  try {
    const { remote, env, dir } = setup({ extra: { env: { GITHUB_API_URL: api.url } } });
    const first = await withEnv(env, () => run(env));
    assert.equal(first.reportUrl, "https://me.github.io/demo/reports/pr-7/");

    // branch content
    assert.match(show(remote, "reports/pr-7/index.html"), /report/);
    assert.equal(git(remote, "rev-list", "--count", "gh-pages"), "1");
    assert.equal(show(remote, ".nojekyll"), "");
    const manifest = JSON.parse(show(remote, "reports/reports.json"));
    assert.equal(manifest.reports[0].title, "PR #7: Add login");
    assert.deepEqual(manifest.reports[0].counts, { passed: 2, failed: 1, flaky: 1, skipped: 1 });
    assert.match(show(remote, "reports/index.html"), /PR #7: Add login/);

    // comment + summary + outputs
    assert.equal(api.comments.length, 1);
    assert.match(api.comments[0].body, /rejects a bad password/);
    assert.ok(api.calls.every((c) => c.auth === "Bearer fake-token"));
    assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /Open the full report/);
    assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /report-url=https:\/\/me\.github\.io\/demo\/reports\/pr-7\/\npassed=2\nfailed=1\nflaky=1\nskipped=1/);

    // second run: same comment updated, still one commit on the branch
    await withEnv(env, () => run(env));
    assert.equal(api.comments.length, 1);
    assert.ok(api.calls.some((c) => c.method === "PATCH"));
    assert.equal(git(remote, "rev-list", "--count", "gh-pages"), "1");

    // a push to main lands next to the PR report
    const main = setup({ prNumber: 0, extra: { remote, env: { GITHUB_API_URL: api.url } } });
    await withEnv(main.env, () => run(main.env));
    assert.deepEqual(JSON.parse(show(remote, "reports/reports.json")).reports.map((r) => r.name).sort(), ["main", "pr-7"]);

    // PR closed: cleanup removes only its folder
    const cleanup = setup({ mode: "cleanup", extra: { remote, env: { GITHUB_API_URL: api.url } } });
    await withEnv(cleanup.env, () => run(cleanup.env));
    assert.deepEqual(JSON.parse(show(remote, "reports/reports.json")).reports.map((r) => r.name), ["main"]);
    assert.throws(() => show(remote, "reports/pr-7/index.html"));
    assert.ok(existsSync(dir));
  } finally {
    api.close();
  }
});

test("retention removes reports older than the limit", async () => {
  const api = await fakeGitHub();
  try {
    const first = setup({ prNumber: 3, extra: { env: { GITHUB_API_URL: api.url } } });
    await withEnv(first.env, () => run(first.env));
    // age the PR 3 report by rewriting its date
    const work = tmp();
    git(work, "clone", "-q", "-b", "gh-pages", first.remote, "w");
    const file = join(work, "w", "reports", "reports.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.reports[0].updatedAt = "2020-01-01T00:00:00Z";
    writeFileSync(file, JSON.stringify(data));
    git(join(work, "w"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "age");
    git(join(work, "w"), "push", "-q", "origin", "gh-pages");

    const next = setup({ prNumber: 4, extra: { remote: first.remote, env: { GITHUB_API_URL: api.url, "INPUT_RETENTION-DAYS": "30" } } });
    await withEnv(next.env, () => run(next.env));
    assert.deepEqual(JSON.parse(show(first.remote, "reports/reports.json")).reports.map((r) => r.name), ["pr-4"]);
    assert.throws(() => show(first.remote, "reports/pr-3/index.html"));
  } finally {
    api.close();
  }
});

test("pull requests from forks are not published and get no comment", async () => {
  const api = await fakeGitHub();
  try {
    const { remote, env } = setup({ fork: true, extra: { env: { GITHUB_API_URL: api.url } } });
    const result = await withEnv(env, () => run(env));
    assert.equal(result.published, false);
    assert.equal(api.comments.length, 0);
    assert.throws(() => show(remote, "reports/reports.json"));
    assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /comes from a fork/);
  } finally {
    api.close();
  }
});

test("a missing HTML report fails with a clear message", async () => {
  const { env } = setup({ extra: { env: { "INPUT_REPORT-DIR": "/nope" } } });
  await assert.rejects(() => withEnv(env, () => run(env)), /No HTML report at \/nope/);
});
