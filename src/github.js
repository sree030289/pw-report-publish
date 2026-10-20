// Minimal GitHub REST client (built-in fetch, no dependencies).
import { MARKER } from "./markdown.js";

export function createClient({ token, apiUrl = "https://api.github.com", repository }) {
  const request = async (method, path, body) => {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "pw-report-publish",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${path} -> ${response.status}: ${data?.message ?? text}`);
      error.status = response.status;
      throw error;
    }
    return data;
  };

  return {
    /** Creates the action's PR comment, or updates it if it already exists. */
    async upsertComment(issueNumber, body) {
      for (let page = 1; page <= 10; page++) {
        const comments = await request("GET", `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
        const mine = comments.find((c) => c.body?.includes(MARKER));
        if (mine) return request("PATCH", `/repos/${repository}/issues/comments/${mine.id}`, { body });
        if (comments.length < 100) break;
      }
      return request("POST", `/repos/${repository}/issues/${issueNumber}/comments`, { body });
    },

    /** The Pages site URL, or null when Pages is not set up or the token can't read it. */
    async pagesUrl() {
      try {
        const site = await request("GET", `/repos/${repository}/pages`);
        return site?.html_url ?? null;
      } catch {
        return null;
      }
    },
  };
}
