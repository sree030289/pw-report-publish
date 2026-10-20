// Markdown for the PR comment and the job summary.
export const MARKER = "<!-- pw-report-publish -->";
const MAX_LISTED = 20;

export function formatDuration(ms) {
  if (!ms) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const esc = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
const join = (base, path) => `${base.replace(/\/?$/, "/")}${path}`;

export function testUrl(reportUrl, testId) {
  return `${join(reportUrl, "index.html")}#?testId=${encodeURIComponent(testId)}`;
}

export function traceUrl(reportUrl, trace) {
  return `${join(reportUrl, "trace/index.html")}?trace=${join(reportUrl, trace)}`;
}

/**
 * @param {ReturnType<import("./results.js").parseResults> | null} results
 * @param {{ reportUrl?: string, title?: string, commit?: string, runUrl?: string, runNumber?: string|number, note?: string }} info
 */
export function renderMarkdown(results, info = {}) {
  const lines = [MARKER];
  const title = info.title ?? "Playwright report";

  if (!results) {
    lines.push(`### 🎭 ${title}`, "");
    if (info.reportUrl) lines.push(`**[Open the report](${info.reportUrl})**`, "");
    lines.push("_No JSON results found, so there is no summary. Add the `json` reporter to see one._");
  } else {
    const { counts } = results;
    const headline = counts.failed ? `❌ ${counts.failed} failed` : counts.flaky ? `⚠️ passed with ${counts.flaky} flaky` : "✅ all passed";
    lines.push(`### 🎭 ${title}: ${headline}`, "");
    lines.push("| ✅ Passed | ❌ Failed | ⚠️ Flaky | ⏭️ Skipped | ⏱️ Duration |", "|:---:|:---:|:---:|:---:|:---:|");
    lines.push(`| ${counts.passed} | ${counts.failed} | ${counts.flaky} | ${counts.skipped} | ${formatDuration(results.duration)} |`, "");

    const links = [];
    if (info.reportUrl) links.push(`**[Open the full report](${info.reportUrl})**`);
    if (info.runUrl) links.push(`[CI run${info.runNumber ? ` #${info.runNumber}` : ""}](${info.runUrl})`);
    if (info.commit) links.push(`commit \`${info.commit.slice(0, 7)}\``);
    if (links.length) lines.push(links.join(" · "), "");

    const item = (t) => {
      const name = [...t.path, t.title].map(esc).join(" › ");
      const project = t.project ? ` <sub>${esc(t.project)}</sub>` : "";
      const linked = info.reportUrl ? `[${name}](${testUrl(info.reportUrl, t.testId)})` : name;
      const trace = info.reportUrl && t.trace ? ` · [trace](${traceUrl(info.reportUrl, t.trace)})` : "";
      const where = t.file ? ` · \`${esc(t.file)}:${t.line}\`` : "";
      const error = t.error ? `\n  > ${esc(t.error)}` : "";
      return `- ${linked}${project}${trace}${where}${error}`;
    };
    const section = (heading, list) => {
      if (!list.length) return;
      lines.push(`#### ${heading} (${list.length})`, "", ...list.slice(0, MAX_LISTED).map(item));
      if (list.length > MAX_LISTED) lines.push(`- …and ${list.length - MAX_LISTED} more in the report`);
      lines.push("");
    };
    section("❌ Failed", results.failed);
    section("⚠️ Flaky", results.flaky);
  }

  if (info.note) lines.push("", `> ${info.note}`);
  lines.push("", `<sub>Updated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by pw-report-publish. Links can take a minute to work while GitHub Pages deploys.</sub>`);
  return `${lines.join("\n")}\n`;
}
