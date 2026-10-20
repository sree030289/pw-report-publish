import assert from "node:assert/strict";
import { test } from "node:test";
import { firstLine, parseResults } from "../src/results.js";
import { formatDuration, MARKER, renderMarkdown, testUrl, traceUrl } from "../src/markdown.js";
import { renderIndex, safeName } from "../src/pages.js";
import { readFileSync } from "node:fs";
import { makeReport, tmp } from "./helpers.js";

test("parses counts, failed and flaky tests, and maps traces into the report", () => {
  const { reportDir, resultsFile, sha1 } = makeReport(tmp());
  const r = parseResults(JSON.parse(readFileSync(resultsFile, "utf8")), { reportDir });
  assert.deepEqual(r.counts, { passed: 2, failed: 1, flaky: 1, skipped: 1 });
  assert.equal(r.total, 5);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed[0].path, ["Login"]);
  assert.equal(r.failed[0].error, "Error: expect(locator).toBeVisible() failed");
  assert.equal(r.failed[0].trace, `data/${sha1}.zip`);
  assert.equal(r.flaky[0].retries, 1);
  assert.equal(r.flaky[0].trace, null);
});

test("helpers", () => {
  assert.equal(formatDuration(75000), "1m 15s");
  assert.equal(formatDuration(4000), "4s");
  assert.equal(safeName("feature/login page!"), "feature-login-page");
  assert.equal(firstLine("\n\n  hello\nworld"), "hello");
  assert.equal(testUrl("https://x.github.io/r/reports/pr-1/", "a b"), "https://x.github.io/r/reports/pr-1/index.html#?testId=a%20b");
  assert.equal(traceUrl("https://x.github.io/r/reports/pr-1", "data/1.zip"), "https://x.github.io/r/reports/pr-1/trace/index.html?trace=https://x.github.io/r/reports/pr-1/data/1.zip");
});

test("markdown lists failures with test and trace links", () => {
  const { reportDir, resultsFile } = makeReport(tmp());
  const r = parseResults(JSON.parse(readFileSync(resultsFile, "utf8")), { reportDir });
  const md = renderMarkdown(r, { reportUrl: "https://x.github.io/r/reports/pr-1/", commit: "abcdef123456", runUrl: "https://github.com/x/r/actions/runs/9", runNumber: 9 });
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /❌ 1 failed/);
  assert.match(md, /\| 2 \| 1 \| 1 \| 1 \| 1m 15s \|/);
  assert.match(md, /\[Login › rejects a bad password\]\(https:\/\/x\.github\.io\/r\/reports\/pr-1\/index\.html#\?testId=a3\)/);
  assert.match(md, /\[trace\]\(https:\/\/x\.github\.io\/r\/reports\/pr-1\/trace\/index\.html\?trace=/);
  assert.match(md, /#### ⚠️ Flaky \(1\)/);
  assert.match(md, /commit `abcdef1`/);
});

test("markdown without results still links the report", () => {
  const md = renderMarkdown(null, { reportUrl: "https://x/r/" });
  assert.match(md, /Open the report/);
  assert.match(md, /No JSON results found/);
});

test("index page escapes titles and shows status", () => {
  const html = renderIndex([{ name: "pr-1", title: "PR #1: <script>", counts: { passed: 1, failed: 2, flaky: 0, skipped: 0 }, updatedAt: "2026-10-20T10:00:00Z" }], { repository: "x/r" });
  assert.match(html, /PR #1: &lt;script&gt;/);
  assert.match(html, /2 failed/);
  assert.doesNotMatch(html, /<script>/);
});
