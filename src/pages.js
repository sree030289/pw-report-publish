// Publishes report folders to the Pages branch, keeps reports.json + index.html, applies retention.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const safeName = (name) => String(name).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 80) || "report";

function gitRunner(cwd, token) {
  // The token goes in an auth header for this process only; it is never written to disk or printed.
  const auth = token ? ["-c", `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : [];
  return (args, { allowFail = false } = {}) => {
    try {
      return execFileSync("git", [...auth, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
      if (allowFail) return null;
      const detail = (error.stderr || error.message || "").replaceAll(token || "\u0000", "***");
      throw new Error(`git ${args[0]} failed: ${detail.trim()}`);
    }
  };
}

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderIndex(entries, { repository } = {}) {
  const rows = entries
    .map((e) => {
      const c = e.counts ?? {};
      const status = e.counts ? (c.failed ? `<span class="bad">${c.failed} failed</span>` : c.flaky ? `<span class="warn">${c.flaky} flaky</span>` : `<span class="ok">passed</span>`) : "–";
      return `<tr><td><a href="${esc(e.name)}/index.html">${esc(e.title || e.name)}</a></td><td>${status}</td><td>${e.counts ? `${c.passed ?? 0} / ${c.failed ?? 0} / ${c.flaky ?? 0} / ${c.skipped ?? 0}` : "–"}</td><td>${e.commit ? `<code>${esc(e.commit.slice(0, 7))}</code>` : ""}</td><td>${e.runUrl ? `<a href="${esc(e.runUrl)}">run</a>` : ""}</td><td>${esc((e.updatedAt ?? "").slice(0, 16).replace("T", " "))}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Playwright reports${repository ? ` · ${esc(repository)}` : ""}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f8fa; --card: #fff; --text: #1f2328; --muted: #59636e; --line: #d1d9e0; --link: #0969da; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --card: #151b23; --text: #e6edf3; --muted: #9198a1; --line: #30363d; --link: #4493f8; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 1000px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; } p { color: var(--muted); margin: 0 0 16px; }
  .wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; } tr:last-child td { border-bottom: 0; } a { color: var(--link); }
  .ok { color: #1a7f37; } .bad { color: #d1242f; font-weight: 600; } .warn { color: #9a6700; }
</style></head>
<body><main>
<h1>Playwright reports</h1>
<p>${esc(repository ?? "")} · ${entries.length} report${entries.length === 1 ? "" : "s"} · passed / failed / flaky / skipped</p>
<div class="wrap"><table><thead><tr><th>Report</th><th>Status</th><th>Tests</th><th>Commit</th><th>CI</th><th>Updated (UTC)</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6">No reports yet.</td></tr>'}
</tbody></table></div>
</main></body></html>
`;
}

/** Applies one change to the Pages branch and pushes it as a single commit, retrying on races. */
export function updatePagesBranch({ remoteUrl, token, branch = "gh-pages", folder = "reports", change, retentionDays = 30, repository, now = new Date(), attempts = 5 }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const dir = mkdtempSync(join(tmpdir(), "pw-report-publish-"));
    try {
      const git = gitRunner(dir, token);
      git(["init", "-q"]);
      git(["config", "user.name", "github-actions[bot]"]);
      git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
      git(["remote", "add", "origin", remoteUrl]);
      const fetched = git(["fetch", "-q", "--depth=1", "origin", branch], { allowFail: true }) !== null;
      const base = fetched ? git(["rev-parse", "FETCH_HEAD"]) : "";
      if (fetched) git(["checkout", "-q", "-B", branch, "FETCH_HEAD"]);
      else git(["checkout", "-q", "--orphan", branch]);

      const root = folder ? join(dir, folder) : dir;
      mkdirSync(root, { recursive: true });
      const manifestFile = join(root, "reports.json");
      let entries = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")).reports ?? [] : [];

      entries = change({ root, entries }) ?? entries;

      if (retentionDays > 0) {
        const cutoff = now.getTime() - retentionDays * 86400000;
        for (const old of entries.filter((e) => Date.parse(e.updatedAt) < cutoff)) rmSync(join(root, safeName(old.name)), { recursive: true, force: true });
        entries = entries.filter((e) => !(Date.parse(e.updatedAt) < cutoff));
      }
      entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      writeFileSync(manifestFile, `${JSON.stringify({ reports: entries }, null, 2)}\n`);
      writeFileSync(join(root, "index.html"), renderIndex(entries, { repository }));
      writeFileSync(join(dir, ".nojekyll"), "");

      git(["add", "-A"]);
      const tree = git(["write-tree"]);
      const commit = git(["commit-tree", tree, "-m", `Update Playwright reports (${entries.length})`]);
      const lease = `--force-with-lease=refs/heads/${branch}:${base}`;
      const pushed = git(["push", "-q", lease, "origin", `${commit}:refs/heads/${branch}`], { allowFail: attempt < attempts });
      if (pushed !== null) return { entries };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(`Could not push to ${branch} after ${attempts} attempts`);
}

/** Change that copies a report folder in and records it in the manifest. */
export const addReport = ({ sourceDir, entry }) => ({ root, entries }) => {
  const target = join(root, safeName(entry.name));
  rmSync(target, { recursive: true, force: true });
  cpSync(sourceDir, target, { recursive: true });
  return [...entries.filter((e) => safeName(e.name) !== safeName(entry.name)), { ...entry, name: safeName(entry.name) }];
};

/** Change that removes a report folder (e.g. when a PR closes). */
export const removeReport = (name) => ({ root, entries }) => {
  rmSync(join(root, safeName(name)), { recursive: true, force: true });
  return entries.filter((e) => safeName(e.name) !== safeName(name));
};
