"use strict";

/**
 * GitHub's REST API with the person's own token: a fine-grained personal
 * access token limited to the repositories they chose, or an OAuth token.
 * Nothing here is specific to HANNAH's pipelines; it is the adapter the
 * coding service and the Action Engine's code actions share. Another host
 * (GitLab, Bitbucket) would be another object with these methods.
 *
 * Rules kept in this file, so no caller can get them wrong:
 *   - a ref is updated with force: false, always. There is no force push.
 *   - nothing here deletes a repository or a branch.
 *   - the token is sent to the API host only, never logged, never returned.
 */
const API = () => (process.env.HANNAH_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
const AGENT = "HANNAH-coding/1.0";
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/|.*(?:\/\/|\.\.|@\{|\\))[A-Za-z0-9._/-]{1,200}(?<!\.lock|\/|\.)$/;

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clip = (value, max) => String(value ?? "").slice(0, max);

function assertRepo(name) {
  if (!REPO.test(String(name))) throw fail(400, "A repository is written owner/name.", "bad-request");
  return String(name);
}
function assertBranch(name) {
  if (!BRANCH.test(String(name))) throw fail(400, `“${clip(name, 80)}” isn't a valid branch name.`, "bad-request");
  return String(name);
}
const encodePath = (path) => String(path).split("/").map(encodeURIComponent).join("/");

function createGitHub({ token, fetchImpl = (...args) => fetch(...args), api = API() } = {}) {
  if (!token) throw fail(401, "GitHub isn't connected. Add a token in Settings → Integrations → GitHub.", "not-connected");

  async function request(path, { method = "GET", body, raw = false, accept, timeoutMs = 25_000, maxBytes = 0 } = {}) {
    const url = path.startsWith("http") ? path : `${api}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": AGENT, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw fail(504, `GitHub didn't answer (${error?.name === "TimeoutError" ? "timed out" : "network error"}).`, "github-unreachable");
    }
    if (response.status === 401) throw fail(401, "GitHub refused the token. It may have expired or been revoked; add a new one in Settings → Integrations.", "token-rejected");
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000 || null;
      if (remaining === "0" || response.status === 429 || response.headers.get("retry-after")) throw fail(429, "GitHub's rate limit is used up for now.", "rate-limited", { retryAt: reset, retryAfter: Number(response.headers.get("retry-after")) || null });
      const data = await response.json().catch(() => ({}));
      throw fail(403, `GitHub didn't allow this: ${clip(data.message, 200) || "the token lacks the permission"}.`, "forbidden");
    }
    if (response.status === 404) throw fail(404, "GitHub has nothing there, or the token can't see it.", "not-found");
    if (response.status === 409 || response.status === 422) {
      const data = await response.json().catch(() => ({}));
      const detail = Array.isArray(data.errors) ? data.errors.map((item) => item.message || item.code).filter(Boolean).join("; ") : "";
      throw fail(response.status, `GitHub refused: ${clip(data.message, 200)}${detail ? ` (${clip(detail, 200)})` : ""}`, response.status === 409 ? "conflict" : "invalid");
    }
    if (!response.ok) throw fail(502, `GitHub answered ${response.status}.`, "github-error");
    if (raw) {
      const length = Number(response.headers.get("content-length")) || 0;
      if (maxBytes && length > maxBytes) throw fail(413, "That download is larger than HANNAH reads.", "too-large");
      const buffer = Buffer.from(await response.arrayBuffer());
      if (maxBytes && buffer.length > maxBytes) throw fail(413, "That download is larger than HANNAH reads.", "too-large");
      return { buffer, headers: response.headers };
    }
    if (response.status === 204) return { data: null, headers: response.headers };
    return { data: await response.json().catch(() => null), headers: response.headers };
  }
  const get = async (path, options) => (await request(path, options)).data;

  const repoShape = (item) => ({ name: item.full_name, private: Boolean(item.private), defaultBranch: item.default_branch, description: clip(item.description, 300), language: item.language || "", pushedAt: item.pushed_at || null, archived: Boolean(item.archived), canPush: Boolean(item.permissions?.push), canAdmin: Boolean(item.permissions?.admin), url: item.html_url });

  return {
    /** Who the token is, and what it says about its own reach. */
    async whoami() {
      const { data, headers } = await request("/user");
      const scopes = headers.get("x-oauth-scopes");
      return { login: data.login, name: data.name || "", scopes: scopes === null ? null : scopes.split(",").map((item) => item.trim()).filter(Boolean), tokenKind: scopes === null ? "fine-grained or app token" : "classic token", expires: headers.get("github-authentication-token-expiration") || null };
    },
    async repos({ max = 60 } = {}) {
      const list = await get(`/user/repos?per_page=${Math.min(100, max)}&sort=pushed`);
      return (list || []).map(repoShape);
    },
    async repo(name) { return repoShape(await get(`/repos/${assertRepo(name)}`)); },
    async branches(name) {
      const list = await get(`/repos/${assertRepo(name)}/branches?per_page=100`);
      return (list || []).map((item) => ({ name: item.name, sha: item.commit?.sha, protected: Boolean(item.protected) }));
    },
    async head(name, ref) {
      const data = await get(`/repos/${assertRepo(name)}/commits/${encodeURIComponent(ref)}`);
      return { sha: data.sha, tree: data.commit?.tree?.sha, message: clip(data.commit?.message, 300), date: data.commit?.committer?.date || null, author: data.commit?.author?.name || "" };
    },
    async commits(name, { ref, max = 15, path } = {}) {
      const list = await get(`/repos/${assertRepo(name)}/commits?per_page=${Math.min(50, max)}${ref ? `&sha=${encodeURIComponent(ref)}` : ""}${path ? `&path=${encodeURIComponent(path)}` : ""}`);
      return (list || []).map((item) => ({ sha: item.sha, message: clip(item.commit?.message, 300), author: item.commit?.author?.name || item.author?.login || "", date: item.commit?.author?.date || null }));
    },
    /** The repository at a commit as a gzipped tar. */
    async tarball(name, ref, { maxBytes = 60 * 1024 * 1024 } = {}) {
      return (await request(`/repos/${assertRepo(name)}/tarball/${encodeURIComponent(ref)}`, { raw: true, timeoutMs: 60_000, maxBytes })).buffer;
    },
    async file(name, path, ref) {
      const data = await get(`/repos/${assertRepo(name)}/contents/${encodePath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
      if (Array.isArray(data) || data?.type !== "file") throw fail(400, "That path isn't a file.", "bad-request");
      return { path: data.path, sha: data.sha, size: data.size, text: Buffer.from(data.content || "", "base64").toString("utf8") };
    },
    async issues(name, { state = "open", max = 30 } = {}) {
      const list = await get(`/repos/${assertRepo(name)}/issues?state=${state === "closed" ? "closed" : state === "all" ? "all" : "open"}&per_page=${Math.min(100, max)}`);
      return (list || []).filter((item) => !item.pull_request).map((item) => ({ number: item.number, title: clip(item.title, 300), state: item.state, author: item.user?.login || "", labels: (item.labels || []).map((label) => label.name || label).slice(0, 10), comments: item.comments, createdAt: item.created_at, url: item.html_url, body: clip(item.body, 4000) }));
    },
    async pulls(name, { state = "open", max = 30 } = {}) {
      const list = await get(`/repos/${assertRepo(name)}/pulls?state=${state === "closed" ? "closed" : state === "all" ? "all" : "open"}&per_page=${Math.min(100, max)}`);
      return (list || []).map((item) => ({ number: item.number, title: clip(item.title, 300), state: item.state, draft: Boolean(item.draft), author: item.user?.login || "", head: item.head?.ref, headSha: item.head?.sha, base: item.base?.ref, createdAt: item.created_at, url: item.html_url }));
    },
    async pull(name, number) {
      const item = await get(`/repos/${assertRepo(name)}/pulls/${Number(number)}`);
      const files = await get(`/repos/${assertRepo(name)}/pulls/${Number(number)}/files?per_page=100`);
      return {
        number: item.number, title: clip(item.title, 300), state: item.state, merged: Boolean(item.merged), mergeable: item.mergeable, mergeableState: item.mergeable_state || "", draft: Boolean(item.draft),
        head: item.head?.ref, headSha: item.head?.sha, base: item.base?.ref, body: clip(item.body, 8000), url: item.html_url, additions: item.additions, deletions: item.deletions,
        files: (files || []).map((file) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, patch: clip(file.patch, 12_000) })),
      };
    },
    async pullComments(name, number) {
      const [reviews, issue] = await Promise.all([get(`/repos/${assertRepo(name)}/pulls/${Number(number)}/comments?per_page=100`), get(`/repos/${assertRepo(name)}/issues/${Number(number)}/comments?per_page=100`)]);
      return [
        ...(reviews || []).map((item) => ({ kind: "review", id: item.id, author: item.user?.login || "", path: item.path, line: item.line || item.original_line || null, body: clip(item.body, 3000), at: item.created_at })),
        ...(issue || []).map((item) => ({ kind: "comment", id: item.id, author: item.user?.login || "", body: clip(item.body, 3000), at: item.created_at })),
      ];
    },
    /** Workflow runs, newest first. */
    async runs(name, { branch, sha, max = 10 } = {}) {
      const data = await get(`/repos/${assertRepo(name)}/actions/runs?per_page=${Math.min(50, max)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}${sha ? `&head_sha=${encodeURIComponent(sha)}` : ""}`);
      return (data?.workflow_runs || []).map((run) => ({ id: run.id, name: run.name, event: run.event, status: run.status, conclusion: run.conclusion, branch: run.head_branch, sha: run.head_sha, title: clip(run.display_title, 200), createdAt: run.created_at, url: run.html_url }));
    },
    async jobs(name, runId) {
      const data = await get(`/repos/${assertRepo(name)}/actions/runs/${Number(runId)}/jobs?per_page=100`);
      return (data?.jobs || []).map((job) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, startedAt: job.started_at, failedSteps: (job.steps || []).filter((step) => step.conclusion === "failure").map((step) => step.name) }));
    },
    /** The end of a job's log, where the failure usually is. */
    async jobLog(name, jobId, { tailChars = 12_000 } = {}) {
      const { buffer } = await request(`/repos/${assertRepo(name)}/actions/jobs/${Number(jobId)}/logs`, { raw: true, timeoutMs: 40_000, maxBytes: 30 * 1024 * 1024 });
      const text = buffer.toString("utf8").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, "");
      return text.length > tailChars ? text.slice(-tailChars) : text;
    },
    /** Checks reported on a commit (Actions and other apps). */
    async checks(name, sha) {
      const data = await get(`/repos/${assertRepo(name)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`);
      return (data?.check_runs || []).map((run) => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url, summary: clip(run.output?.summary, 600) }));
    },
    async compare(name, base, head) {
      const data = await get(`/repos/${assertRepo(name)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      return { ahead: data.ahead_by, behind: data.behind_by, status: data.status, files: (data.files || []).map((file) => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions })) };
    },

    // ---------- writes: each one is called only through the Action Engine ----------

    async createIssue(name, { title, body, labels = [] }) {
      const item = await get(`/repos/${assertRepo(name)}/issues`, { method: "POST", body: { title: clip(title, 250), body: clip(body, 60_000), ...(labels.length ? { labels } : {}) } });
      return { number: item.number, url: item.html_url };
    },
    async comment(name, number, body) {
      const item = await get(`/repos/${assertRepo(name)}/issues/${Number(number)}/comments`, { method: "POST", body: { body: clip(body, 60_000) } });
      return { id: item.id, url: item.html_url };
    },
    async review(name, number, { body, event = "COMMENT" }) {
      const item = await get(`/repos/${assertRepo(name)}/pulls/${Number(number)}/reviews`, { method: "POST", body: { body: clip(body, 60_000), event: ["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(event) ? event : "COMMENT" } });
      return { id: item.id, url: item.html_url, state: item.state };
    },
    async createBranch(name, branch, sha) {
      await get(`/repos/${assertRepo(name)}/git/refs`, { method: "POST", body: { ref: `refs/heads/${assertBranch(branch)}`, sha } });
      return { branch, sha };
    },
    /**
     * One commit on `branch` with these changes: [{ path, content }] writes a
     * file, [{ path, delete: true }] removes it. The branch moves forward only
     * (force: false): if someone else pushed meanwhile, GitHub refuses and
     * nothing of theirs is overwritten.
     */
    async commit(name, { branch, parentSha, message, changes }) {
      const repo = assertRepo(name);
      const parent = await get(`/repos/${repo}/git/commits/${parentSha}`);
      const tree = [];
      for (const change of changes) {
        if (change.delete) { tree.push({ path: change.path, mode: "100644", type: "blob", sha: null }); continue; }
        const blob = await get(`/repos/${repo}/git/blobs`, { method: "POST", body: { content: Buffer.from(change.content, "utf8").toString("base64"), encoding: "base64" } });
        tree.push({ path: change.path, mode: change.mode || "100644", type: "blob", sha: blob.sha });
      }
      const created = await get(`/repos/${repo}/git/trees`, { method: "POST", body: { base_tree: parent.tree.sha, tree } });
      const commit = await get(`/repos/${repo}/git/commits`, { method: "POST", body: { message: clip(message, 5000), tree: created.sha, parents: [parentSha] } });
      await get(`/repos/${repo}/git/refs/heads/${encodePath(assertBranch(branch))}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
      return { sha: commit.sha, branch, url: commit.html_url || "" };
    },
    async createPull(name, { title, head, base, body, draft = false }) {
      const item = await get(`/repos/${assertRepo(name)}/pulls`, { method: "POST", body: { title: clip(title, 250), head, base, body: clip(body, 60_000), draft } });
      return { number: item.number, url: item.html_url, headSha: item.head?.sha };
    },
    async updatePull(name, number, { title, body }) {
      const item = await get(`/repos/${assertRepo(name)}/pulls/${Number(number)}`, { method: "PATCH", body: { ...(title ? { title: clip(title, 250) } : {}), ...(body !== undefined ? { body: clip(body, 60_000) } : {}) } });
      return { number: item.number, url: item.html_url };
    },
    async merge(name, number, { method = "squash", sha } = {}) {
      const item = await get(`/repos/${assertRepo(name)}/pulls/${Number(number)}/merge`, { method: "PUT", body: { merge_method: ["merge", "squash", "rebase"].includes(method) ? method : "squash", ...(sha ? { sha } : {}) } });
      return { merged: Boolean(item?.merged), sha: item?.sha || null, message: clip(item?.message, 200) };
    },
  };
}

module.exports = { assertBranch, assertRepo, createGitHub };
