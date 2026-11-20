"use strict";

/**
 * Where a repository's code is read, changed and checked. Two kinds, one shape:
 *
 *   remote (GitHub)   read at a commit through the API; a change becomes one
 *                     commit on a new branch made with the Git Data API; the
 *                     project's own CI is what runs the tests.
 *   local             a checkout on the machine the HANNAH server runs on,
 *                     inside a folder the operator listed in HANNAH_CODE_ROOTS.
 *                     Work happens in a separate git worktree on a new branch,
 *                     so the person's working tree, their uncommitted changes
 *                     and their current branch are never touched. The
 *                     project's own scripts can be run there.
 *
 * Commands (local only) are deliberately narrow:
 *   - only a script the project itself defines (package.json "test", "lint",
 *     …, or pytest / go test / cargo test when the project uses them), chosen
 *     by name from the index. Text from a README, an issue or a model is never
 *     turned into a command line.
 *   - no shell: the program and its arguments are passed as a list.
 *   - the server's own environment (API keys, database URL) is not passed on;
 *     the script sees PATH, HOME, a language setting and CI=1.
 *   - a time limit and an output limit.
 * This limits what HANNAH asks to run; it is not a sandbox. A project's test
 * script can do anything its author wrote, as it can when the person runs it
 * themselves, which is why running one needs their approval.
 *
 * There is no force push, no reset, no clean, no checkout in the person's
 * working tree, and nothing here deletes a branch HANNAH didn't create.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { fromDirectory, fromTarball, git } = require("./snapshot");
const { assertBranch } = require("./github");

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const PASS_ENV = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SHELL", "SystemRoot", "APPDATA", "LOCALAPPDATA", "NVM_DIR", "GOPATH", "GOCACHE", "CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "JAVA_HOME"];

/** Folders the operator allowed local repositories to live in. Never on a serverless host. */
function codeRoots(env = process.env) {
  if (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME) return [];
  return String(env.HANNAH_CODE_ROOTS || "").split(path.delimiter).map((item) => item.trim()).filter(Boolean).map((item) => { try { return fs.realpathSync(item); } catch { return null; } }).filter(Boolean);
}

function insideRoots(target, roots) {
  let real;
  try { real = fs.realpathSync(target); } catch { throw fail(404, "That folder doesn't exist on the machine HANNAH's server runs on.", "not-found"); }
  if (!roots.some((root) => real === root || real.startsWith(root + path.sep))) throw fail(403, "That folder is outside the folders this server may open for code (HANNAH_CODE_ROOTS).", "outside-roots");
  return real;
}

const slug = (text) => String(text || "change").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "change";
const branchFor = (title, id) => assertBranch(`hannah/${slug(title)}-${String(id).replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`);

/** The exact argv for one of the project's own checks. Nothing else can be run. */
function commandFor(index, { script, dir = "." }) {
  const entry = index.tests.commands.find((item) => item.script === script && item.dir === dir) || index.tests.commands.find((item) => item.script === script);
  if (!entry) throw fail(400, `This project has no check called “${String(script).slice(0, 60)}”. It has: ${[...new Set(index.tests.commands.map((item) => item.script))].join(", ") || "none"}.`, "unknown-script");
  const manager = index.packageManager || "npm";
  const argv = entry.script === "pytest" ? ["python3", "-m", "pytest", "-q"]
    : entry.script === "go test" ? ["go", "test", "./..."]
      : entry.script === "cargo test" ? ["cargo", "test"]
        : [manager, "run", entry.script, ...(manager === "npm" ? ["--silent"] : [])];
  return { argv, dir: entry.dir, script: entry.script, shown: `${argv.join(" ")}${entry.dir === "." ? "" : ` (in ${entry.dir})`}`, runs: entry.runs };
}

function run(argv, cwd, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const env = { CI: "1", NODE_ENV: "test", FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const name of PASS_ENV) if (process.env[name]) env[name] = process.env[name];
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, env, timeout: timeoutMs, maxBuffer: OUTPUT_LIMIT, windowsHide: true, shell: false }, (error, stdout, stderr) => {
      const tail = (text) => { const value = String(text || "").replace(/\u001b\[[0-9;]*m/g, ""); return value.length > 12_000 ? `… (${value.length - 12_000} earlier characters not shown)\n${value.slice(-12_000)}` : value; };
      resolve({
        exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
        timedOut: Boolean(error?.killed && error?.signal === "SIGTERM"), notFound: error?.code === "ENOENT", outputLimit: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        stdout: tail(stdout), stderr: tail(stderr), durationMs: Date.now() - started,
      });
    });
  });
}

// ---------- local ----------

function createLocalWorkspace({ root, roots = codeRoots() }) {
  const repo = insideRoots(root, roots);
  if (!fs.existsSync(path.join(repo, ".git"))) throw fail(400, "That folder isn't a git repository.", "not-a-repo");
  // One folder per repository, so a task id can never open another repository's copy.
  const worktreesDir = () => path.join(os.tmpdir(), "hannah-worktrees", require("node:crypto").createHash("sha1").update(repo).digest("hex").slice(0, 12));
  const worktreeOf = (taskId) => path.join(worktreesDir(), String(taskId).replace(/[^A-Za-z0-9_-]/g, ""));

  async function status() {
    const text = await git(repo, ["status", "--porcelain=v1", "-b"]);
    const lines = text.split("\n").filter(Boolean);
    const branchLine = lines[0] || "";
    const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(branchLine)?.[1] || "";
    const changed = lines.slice(1);
    return { branch, detached: /HEAD \(no branch\)/.test(branchLine), uncommitted: changed.length, files: changed.slice(0, 30).map((row) => row.slice(3)), ahead: Number(/ahead (\d+)/.exec(branchLine)?.[1] || 0), behind: Number(/behind (\d+)/.exec(branchLine)?.[1] || 0) };
  }
  async function head() {
    const sha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const state = await status();
    return { sha, branch: state.branch, uncommitted: state.uncommitted };
  }
  async function defaultBranch() {
    const remote = await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).then((text) => text.trim().replace(/^origin\//, "")).catch(() => "");
    if (remote) return remote;
    const names = (await git(repo, ["branch", "--list", "--format=%(refname:short)"])).split("\n").map((item) => item.trim());
    return names.find((name) => name === "main") || names.find((name) => name === "master") || (await status()).branch;
  }
  async function origin() {
    const url = await git(repo, ["remote", "get-url", "origin"]).then((text) => text.trim()).catch(() => "");
    const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
    return { url: url.replace(/\/\/[^@/]+@/, "//"), github: match ? `${match[1]}/${match[2]}` : null };
  }

  return {
    kind: "local", root: repo, status, head, defaultBranch, origin,
    /** The working tree as it is now, uncommitted changes included (for a scan). */
    snapshot: () => fromDirectory(repo),
    /** A worktree on a new branch from HEAD, for one task. The person's checkout stays as it is. */
    async openWorktree(taskId, branch) {
      const dir = worktreeOf(taskId);
      if (fs.existsSync(dir)) {
        // Still this repository's working copy? A leftover from a crash or a deleted checkout is cleared and made again.
        const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).then((text) => fs.realpathSync(text.trim())).catch(() => "");
        if (common === fs.realpathSync(path.join(repo, ".git"))) return { dir, branch, existed: true };
        fs.rmSync(dir, { recursive: true, force: true });
        await git(repo, ["worktree", "prune"]).catch(() => {});
      }
      fs.mkdirSync(worktreesDir(), { recursive: true });
      const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
      await git(repo, ["worktree", "add", "-b", assertBranch(branch), dir, base]);
      // The project's installed dependencies, so its checks can run without a fresh install.
      for (const name of (await git(repo, ["ls-files", "--", "package.json", "*/package.json"])).split("\n").filter(Boolean)) {
        const modules = path.join(repo, path.dirname(name), "node_modules");
        const link = path.join(dir, path.dirname(name), "node_modules");
        if (fs.existsSync(modules) && !fs.existsSync(link)) { try { fs.symlinkSync(modules, link, "junction"); } catch { /* checks will say what's missing */ } }
      }
      return { dir, branch, base, existed: false };
    },
    worktreeSnapshot: (taskId) => fromDirectory(worktreeOf(taskId)),
    /** Write a task's changes into its worktree. Every path is checked to stay inside it. */
    async writeChanges(taskId, changes) {
      const dir = fs.realpathSync(worktreeOf(taskId));
      for (const change of changes) {
        const target = path.resolve(dir, change.path);
        if (!target.startsWith(dir + path.sep)) throw fail(400, `${change.path} is outside the repository.`, "bad-path");
        if (change.after === null) { fs.rmSync(target, { force: true }); continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const parent = fs.realpathSync(path.dirname(target));
        if (parent !== dir && !parent.startsWith(dir + path.sep)) throw fail(400, `${change.path} leads outside the repository through a link.`, "bad-path");
        if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw fail(400, `${change.path} is a link; HANNAH doesn't write through links.`, "bad-path");
        fs.writeFileSync(target, change.after);
      }
      return { written: changes.length };
    },
    async diff(taskId) { return git(worktreeOf(taskId), ["diff", "--stat", "HEAD"]).catch(() => ""); },
    /** Run one of the project's own checks in the task's worktree. */
    async runCheck(taskId, index, wanted) {
      const command = commandFor(index, wanted);
      const cwd = path.join(worktreeOf(taskId), command.dir);
      if (!fs.existsSync(cwd)) throw fail(409, "The task's working copy is gone. Start the task again.", "worktree-missing");
      const result = await run(command.argv, cwd);
      return { command: command.shown, script: command.script, dir: command.dir, ...result, passed: result.exitCode === 0 && !result.timedOut };
    },
    /** Commit the worktree's changes on its branch, as the repository's configured author. */
    async commit(taskId, message) {
      const dir = worktreeOf(taskId);
      const name = await git(dir, ["config", "user.name"]).then((text) => text.trim()).catch(() => "");
      const email = await git(dir, ["config", "user.email"]).then((text) => text.trim()).catch(() => "");
      if (!name || !email) throw fail(409, "This repository has no git author configured (user.name and user.email), so HANNAH can't commit as you. Set them and try again.", "no-author");
      // The linked node_modules folders are HANNAH's convenience, not part of the change.
      await git(dir, ["add", "-A", "--", ".", ":(exclude,glob)**/node_modules", ":(exclude)node_modules"]);
      const staged = (await git(dir, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
      if (!staged.length) throw fail(409, "There is nothing to commit.", "nothing-to-commit");
      // The project's own commit hooks run, with the same stripped environment as its checks.
      const committed = await run(["git", "commit", "-q", "-m", String(message).slice(0, 5000)], dir, { timeoutMs: 5 * 60_000 });
      if (committed.exitCode !== 0) throw fail(409, `git refused the commit: ${(committed.stderr || committed.stdout).trim().split("\n").slice(-4).join(" ").slice(0, 400) || "a commit hook failed"}`, "commit-refused");
      const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
      const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      return { sha, branch, files: staged };
    },
    /** Push the task's branch to origin. Never forced; never the checkout's own branch. */
    async push(taskId) {
      const dir = worktreeOf(taskId);
      const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (!branch.startsWith("hannah/")) throw fail(403, "HANNAH only pushes branches it created for a task.", "forbidden");
      await git(dir, ["push", "--set-upstream", "origin", branch], { timeoutMs: 120_000 });
      const remoteSha = (await git(dir, ["ls-remote", "origin", `refs/heads/${branch}`], { timeoutMs: 60_000 })).split(/\s+/)[0] || "";
      return { branch, remoteSha };
    },
    async verifyCommit(sha) {
      const branches = (await git(repo, ["branch", "--contains", sha, "--format=%(refname:short)"]).catch(() => "")).split("\n").filter(Boolean);
      return { exists: branches.length > 0, branches };
    },
    /** Remove the task's worktree (HANNAH's own copy). The branch and its commits stay. */
    async closeWorktree(taskId) {
      const dir = worktreeOf(taskId);
      if (!fs.existsSync(dir)) return false;
      await git(repo, ["worktree", "remove", "--force", dir]).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
      await git(repo, ["worktree", "prune"]).catch(() => {});
      return true;
    },
  };
}

// ---------- remote (GitHub) ----------

const cache = new Map();
function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > 3) cache.delete(cache.keys().next().value);
  return value;
}

function createRemoteWorkspace({ github, name, userId = "" }) {
  return {
    kind: "remote", name,
    async head(ref) {
      const info = await github.repo(name);
      const branch = ref || info.defaultBranch;
      const commit = await github.head(name, branch);
      return { sha: commit.sha, branch, defaultBranch: info.defaultBranch, canPush: info.canPush, private: info.private, message: commit.message };
    },
    defaultBranch: async () => (await github.repo(name)).defaultBranch,
    async snapshot(sha) {
      const key = `${userId}:${name}@${sha}`;
      if (cache.has(key)) return remember(key, cache.get(key));
      return remember(key, fromTarball(await github.tarball(name, sha)));
    },
    /** One commit on a new branch from `baseSha`. */
    async commitBranch({ branch, baseSha, message, changes }) {
      await github.createBranch(name, branch, baseSha).catch((error) => { if (error.status !== 422) throw error; });
      const current = await github.head(name, branch);
      return github.commit(name, { branch, parentSha: current.sha, message, changes: changes.map((change) => (change.after === null ? { path: change.path, delete: true } : { path: change.path, content: change.after })) });
    },
    async verifyBranch(branch, sha) {
      const found = await github.head(name, branch);
      return { matches: found.sha === sha, sha: found.sha };
    },
  };
}

module.exports = { branchFor, codeRoots, commandFor, createLocalWorkspace, createRemoteWorkspace, insideRoots, run, slug };
