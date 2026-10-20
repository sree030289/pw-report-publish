# Playwright Report Publish

**Open your Playwright report and traces from every pull request, without downloading artifacts.**

A GitHub Action that hosts Playwright's own HTML report on GitHub Pages, one folder per pull request and per branch. It then posts a single comment on the PR, updated on every run, with:

- passed / failed / flaky / skipped counts and duration
- a link to the full report
- every failed and flaky test, each linked **straight to that test in the report and to its trace**, with the first line of the error

```
🎭 Playwright report: ❌ 1 failed

| ✅ Passed | ❌ Failed | ⚠️ Flaky | ⏭️ Skipped | ⏱️ Duration |
|    42     |     1     |     2    |     3      |   4m 12s    |

Open the full report · CI run #128 · commit 1a2b3c4

❌ Failed (1)
- Checkout › applies a discount code  chromium · trace · checkout.spec.ts:48
  > Error: expect(locator).toHaveText(expected) failed
```

No server to run, no external service, no dependencies. It uses the report Playwright already generates.

## Quick start

**1. Make Playwright write an HTML and a JSON report** (in `playwright.config.ts`):

```ts
reporter: [["html", { open: "never" }], ["json", { outputFile: "results.json" }]],
use: { trace: "retain-on-failure" }, // or "on-first-retry"
```

**2. Add the action after your tests:**

```yaml
name: Playwright
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: write       # push the report to the gh-pages branch
  pull-requests: write  # comment on the PR

jobs:
  test:
    runs-on: ubuntu-latest
    concurrency: { group: pages-publish, cancel-in-progress: false }
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 24 }
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test
      - uses: sree030289/pw-report-publish@v1
        if: ${{ !cancelled() }}   # publish even when tests fail
```

**3. Turn on GitHub Pages, once.** After the first run creates the `gh-pages` branch, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then select `gh-pages` / `/ (root)`.

Reports then live at `https://<owner>.github.io/<repo>/reports/pr-<number>/`, with an index of all reports at `…/reports/`.

**4. (Optional) Remove a PR's report when it closes:**

```yaml
name: Remove PR report
on:
  pull_request:
    types: [closed]
permissions:
  contents: write
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: sree030289/pw-report-publish@v1
        with:
          mode: cleanup
```

## Sharded runs

Let each shard upload its blob report, then publish once from a final job. The action merges the shards into one report with Playwright's `merge-reports`:

```yaml
  # in each shard job: npx playwright test --shard=${{ matrix.shard }}/4 --reporter=blob
  #                    then upload-artifact the blob-report folder

  report:
    needs: test
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 24 }
      - run: npm ci                      # merge-reports needs @playwright/test installed
      - uses: actions/download-artifact@v5
        with: { pattern: blob-report-*, path: all-blob-reports, merge-multiple: true }
      - uses: sree030289/pw-report-publish@v1
        with:
          blob-dir: all-blob-reports
```

## Inputs

| Input | Default | What it does |
|---|---|---|
| `report-dir` | `playwright-report` | Folder with the HTML report |
| `results-json` | auto | Playwright JSON report. Default: `$PLAYWRIGHT_JSON_OUTPUT_FILE`, then `results.json`, `test-results/results.json` |
| `blob-dir` | | Blob reports from sharded runs, merged into one report first |
| `name` | `pr-<n>` or branch | Folder name for this report |
| `branch` | `gh-pages` | Branch GitHub Pages serves from |
| `folder` | `reports` | Folder on that branch for all reports |
| `comment` | `true` | Post / update one PR comment |
| `summary` | `true` | Write the summary to the job summary page |
| `retention-days` | `30` | Delete reports not updated for this many days (`0` keeps them) |
| `site-url` | auto | Pages URL; read from the API, or `https://<owner>.github.io/<repo>/` |
| `mode` | `publish` | `cleanup` removes the report named by `name` (default: this PR's) |
| `github-token` | `github.token` | Needs `contents: write` and `pull-requests: write` |

**Outputs:** `report-url`, `passed`, `failed`, `flaky`, `skipped`. For example, post the link to Slack or Teams with `${{ steps.<id>.outputs.report-url }}`.

## How it works

- The report folder is copied to `gh-pages/reports/<name>/`, next to the other PRs' and branches' reports, and the index page is rebuilt.
- Each update replaces the branch with **a single commit**, so traces and screenshots never pile up in git history and the repo stays small.
- If two jobs publish at the same time, the push uses `--force-with-lease` and retries, so neither overwrites the other.
- Test links use the report's own deep links (`index.html#?testId=…`). Trace links open the trace viewer bundled inside the report, on the same site, so there are no CORS problems.
- The comment carries a hidden marker, so each run edits the same comment instead of adding a new one.

## Good to know

- **Forks:** workflows triggered by PRs from forks get a read-only token, so the action skips publishing and commenting for them, and says so in the job summary.
- **Private repos:** GitHub Pages for private repositories needs a paid plan. Check who can see the site under your plan's Pages visibility settings before publishing reports from a private repo.
- **Pages delay:** a new report can take a minute to appear while GitHub Pages deploys.
- **Security:** no dependencies and no network calls except to GitHub. The token is passed to git through a header in memory, never written to disk or logs.

## Licence

MIT
