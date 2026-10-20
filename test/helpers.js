import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tmp = (prefix = "prp-test-") => mkdtempSync(join(tmpdir(), prefix));

/** A tiny HTML report + JSON results, with one failed test that has a trace. */
export function makeReport(dir, { failed = true } = {}) {
  const reportDir = join(dir, "playwright-report");
  mkdirSync(join(reportDir, "data"), { recursive: true });
  writeFileSync(join(reportDir, "index.html"), "<!doctype html><title>report</title>");
  const tracePath = join(dir, "test-results", "trace.zip");
  mkdirSync(join(dir, "test-results"), { recursive: true });
  writeFileSync(tracePath, "fake trace zip");
  const sha1 = createHash("sha1").update("fake trace zip").digest("hex");
  writeFileSync(join(reportDir, "data", `${sha1}.zip`), "fake trace zip");

  const spec = (id, title, status, extra = {}) => ({
    id, title, file: "tests/login.spec.ts", line: 10,
    tests: [{ projectName: "chromium", status, results: extra.results ?? [{ status: status === "expected" ? "passed" : "failed", attachments: [] }] }],
  });
  const results = {
    stats: { duration: 75000, expected: 2, unexpected: failed ? 1 : 0, flaky: 1, skipped: 1 },
    suites: [{
      title: "login.spec.ts", file: "tests/login.spec.ts", line: 0,
      suites: [{
        title: "Login", file: "tests/login.spec.ts", line: 3,
        specs: [
          spec("a1", "signs in", "expected"),
          spec("a2", "signs out", "expected"),
          failed && spec("a3", "rejects a bad password", "unexpected", { results: [{ status: "failed", errors: [{ message: "\u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m\n\nLocator: getByText('Wrong')" }], attachments: [{ name: "trace", contentType: "application/zip", path: tracePath }] }] }),
          spec("a4", "remembers me", "flaky", { results: [{ status: "failed", errors: [{ message: "Timeout 5000ms exceeded" }], attachments: [] }, { status: "passed", attachments: [] }] }),
          spec("a5", "two factor", "skipped"),
        ].filter(Boolean),
      }],
    }],
  };
  const resultsFile = join(dir, "results.json");
  writeFileSync(resultsFile, JSON.stringify(results));
  return { reportDir, resultsFile, sha1 };
}

export function bareRepo(dir) {
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  return remote;
}

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Fake GitHub API that stores issue comments in memory. */
export async function fakeGitHub() {
  const comments = [];
  const calls = [];
  let nextId = 1;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url.endsWith("/pages")) return send(404, { message: "Not Found" });
    if (/\/issues\/\d+\/comments/.test(req.url) && req.method === "GET") return send(200, comments);
    if (/\/issues\/\d+\/comments/.test(req.url) && req.method === "POST") { const c = { id: nextId++, body: body.body }; comments.push(c); return send(201, c); }
    const patch = /\/issues\/comments\/(\d+)$/.exec(req.url);
    if (patch && req.method === "PATCH") { const c = comments.find((x) => x.id === Number(patch[1])); c.body = body.body; return send(200, c); }
    send(404, { message: "unknown" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, comments, calls, close: () => server.close() };
}
