# Coding agent capabilities

Status: 1.7.0 · Last reviewed 2026-11-20

What HANNAH can do with a repository, how each part works, and what state it is in. States are defined in `docs/architecture/AUTONOMOUS_OPERATOR_ARCHITECTURE.md`. Code: `server/coding/`. Screen: Actions → Code. Tools: `code_*` (`client/src/services/Operator.ts`).

## Two kinds of repository

| | GitHub repository | Local repository |
|---|---|---|
| How it is read | At a commit, as the archive GitHub serves | The files git tracks in a folder on the machine HANNAH's server runs on |
| Needs | A GitHub token for the account | The server on your own machine, with `HANNAH_CODE_ROOTS` listing the folders it may open. Off on serverless hosting |
| Where a change is made | One commit on a new branch through GitHub's Git Data API | A separate git worktree on a new branch. Your checkout, its branch and your uncommitted work are not touched |
| Running the project's tests | Not here. The repository's own CI runs them after the push, and HANNAH reads the result | In the worktree, after you approve, with the project's own script |
| State | IMPLEMENTED BUT NOT FULLY VERIFIED: every call is tested against a stand-in GitHub API; the archive reader was checked against a real GitHub archive; no write was made to real GitHub | IMPLEMENTED AND VERIFIED: a real git repository, real worktree, real `npm run test`, real commit, in unit, API and browser tests |

GitLab and Bitbucket: NOT IMPLEMENTED. The host is one object (`server/coding/github.js`) with a fixed set of methods; another host is another object.

## 1.1 Understanding a repository

| Capability | How | State |
|---|---|---|
| Structure, languages, frameworks, build tools, package manager | `indexer.js` reads manifests (package.json, pyproject, go.mod, Cargo.toml, pom.xml, Gradle, Gemfile, composer.json, Dockerfile) | IMPLEMENTED AND VERIFIED |
| Entry points, scripts, tests, CI workflows | From package.json, conventional file names, `.github/workflows` and other CI files | IMPLEMENTED AND VERIFIED |
| Symbols and where they are used | Lexical: comments and string contents are blanked first, then functions, classes, types, methods and exports are found per language (JavaScript, TypeScript, Python, Go, Rust, and class/function shapes for Java, Kotlin, C#, Swift, Ruby, PHP) | IMPLEMENTED AND VERIFIED for JavaScript; other languages IMPLEMENTED BUT NOT FULLY VERIFIED |
| How files relate | Import graph for JavaScript and TypeScript: relative paths, `tsconfig` path aliases, `.js`→`.ts`, index files; who imports each file | IMPLEMENTED AND VERIFIED |
| Finding the code for a question | BM25 over 50-line chunks, with paths and symbol definitions weighted; returns real lines with numbers, plus each file's neighbours | IMPLEMENTED AND VERIFIED |
| HTTP routes, environment variable names, database tables and migrations | Pattern-based. Values of environment variables are never read into the index | IMPLEMENTED AND VERIFIED for Express and names; database relationships NOT IMPLEMENTED |
| Remembered between sessions | The repository's shape (`overviewOf`) is stored per account. Its code is not stored | IMPLEMENTED AND VERIFIED |
| Type-aware analysis, language servers, embeddings | — | NOT IMPLEMENTED. The index doesn't know types, overloads or dynamic dispatch |

Limits: files over 400 KB, binaries, minified files and dependency folders are skipped and listed; a repository over 48 MB of text is read in part and marked truncated.

## 1.2 Finding bugs

A finding always names a file and a line, quotes the line, and says how it is known.

| Kind | What | How it is known | State |
|---|---|---|---|
| Doesn't parse | JavaScript files (acorn), JSON files | certain | IMPLEMENTED AND VERIFIED |
| Broken imports | A relative import of a file that isn't there; a name the target doesn't export | certain / likely | IMPLEMENTED AND VERIFIED |
| Undeclared dependency | A package imported but not in package.json | likely | IMPLEMENTED AND VERIFIED |
| Leftovers | Merge conflict markers; a script that runs a missing file; a committed `.env` | certain / likely | IMPLEMENTED AND VERIFIED |
| Secrets | Known token shapes and hard-coded credentials. The value is never copied into a finding | certain (likely in tests and examples) | IMPLEMENTED AND VERIFIED |
| Vulnerable dependencies | The exact locked versions (package-lock.json, pinned requirements) against OSV | certain | IMPLEMENTED AND VERIFIED, including a live query to osv.dev. If OSV can't be reached, the scan says the check didn't run; it doesn't report clean |
| Outdated dependencies | Direct npm dependencies against the registry (optional) | certain | IMPLEMENTED AND VERIFIED by a live query; not in the default scan |
| Logic, error handling, security, concurrency | A model reads the most important files with line numbers. A finding is kept only if the line it quotes is really in that file; the rest are dropped and counted | suspected, not reproduced | IMPLEMENTED AND VERIFIED for the checking, with a scripted model, and in one live run with a real model that found the seeded logic bug. Quality on large codebases was not measured |
| CI failures | Failing runs, jobs and steps on GitHub Actions, with the end of the log | from GitHub | IMPLEMENTED BUT NOT FULLY VERIFIED (stand-in API) |
| Tracing a failure to its cause | `code_search` and `code_read_file` return the real code and its neighbours; the change plan must state the cause | — | PARTIALLY IMPLEMENTED: the model reasons over real code; nothing executes the failing path |
| Type errors, lint | Only by running the project's own `typecheck` or `lint` script in a local repository | — | PARTIALLY IMPLEMENTED |
| Runtime investigation, profiling, memory and resource use, slow queries, test coverage | — | — | NOT IMPLEMENTED. HANNAH doesn't attach to a running program |

A scan reports its coverage: files read, files skipped, files a model reviewed. It never says a repository has no bugs.

## 1.3 Changing code

`change` task stages: index → plan → edit → verify → ready → (publish) → CI.

| Step | What code enforces | State |
|---|---|---|
| Plan | The model sees real source chosen by the index and must name existing files, a cause and how to verify. Files it invents are dropped. Checks it names must be scripts the project defines | IMPLEMENTED AND VERIFIED |
| Edit | Edits are FIND/REPLACE blocks. One applies only if its FIND text is in the file exactly once. A file outside the plan, a path outside the repository, `.git` and missing text are refused with the reason; the model gets one chance to correct | IMPLEMENTED AND VERIFIED |
| Review | Computed, not narrated: unified diff, added and removed lines, changed files that no longer parse, static findings the change introduced or resolved (in changed files and their importers), and notes for CI workflows, lock files, environment files, deletions and files outside the plan | IMPLEMENTED AND VERIFIED |
| Verify (local) | The project's own script runs in the worktree after approval (`code.run`). If it fails, the same script runs on untouched code to tell a regression from an existing failure | IMPLEMENTED AND VERIFIED |
| Verify (GitHub) | Nothing runs here; the task says so, and reads CI after the push | IMPLEMENTED BUT NOT FULLY VERIFIED |
| Publish | Through the Action Engine (`code.publish`): the branch, files and check results are shown; a changed file that doesn't parse blocks it | IMPLEMENTED AND VERIFIED (local, real git); GitHub against a stand-in |
| Installing or upgrading dependencies | — | NOT IMPLEMENTED. HANNAH never runs an install. A worktree links the checkout's existing `node_modules` |
| Large multi-part changes as separate repair groups | One task is one change (up to 12 files). Several tasks can be started from one scan's findings | PARTIALLY IMPLEMENTED |

## 1.4 GitHub

| Capability | State |
|---|---|
| Connect with a fine-grained personal access token, checked with GitHub, sealed in the vault, never shown again | IMPLEMENTED AND VERIFIED (stand-in API for the check; real sealing) |
| OAuth app or GitHub App sign-in | NOT IMPLEMENTED. BLOCKED BY USER PERMISSION OR CREDENTIALS: it needs an app registered by the owner |
| List repositories and branches; read code, commits, issues, pull requests with files and comments, Actions runs, failing jobs and logs, checks on a commit | IMPLEMENTED BUT NOT FULLY VERIFIED (stand-in API) |
| Create a branch, commit to it (never forced), open a pull request, update its text | IMPLEMENTED BUT NOT FULLY VERIFIED |
| Open an issue, comment, comment-only review | IMPLEMENTED BUT NOT FULLY VERIFIED |
| Merge a pull request | IMPLEMENTED BUT NOT FULLY VERIFIED. Always asks; refused unless the repository's access includes merging; refused when GitHub reports conflicts or a check failed; merges exactly the commit that was shown |
| Commit to the default branch | Off by default per repository ("direct" access), and asks every time when on. IMPLEMENTED AND VERIFIED that it is refused when off |
| Deployments and deployment status | NOT IMPLEMENTED |
| Force push, deleting branches or repositories, changing settings or secrets | Not in the code at all |

Repository access, set per repository in Actions → Code: read · suggest · branch · pull-request (default) · merge · direct.

## 1.5 Execution environment

| | State |
|---|---|
| Local repositories: git worktree per task, project scripts by name, no shell, the server's environment not passed on, 10-minute and 2 MB output limits | IMPLEMENTED AND VERIFIED |
| Desktop app: files in folders you share, commands you approve in a system dialog, optional Docker sandbox, a browser window (1.5.0) | Existing; those commands are not yet in the Action Engine's history |
| Container isolation for coding tasks, database tools, browser debugging, process monitoring, development servers | NOT IMPLEMENTED |

Running a project's script is not sandboxed: it does what the script's author wrote, as when you run it. That is why it needs your approval or a standing permission for that repository.

## 1.6 Continuous engineering

"Check a repository" (Actions → Code → Check now, or the workflow step on a schedule) reports failing CI on the default branch, new issues and pull requests, dependencies with advisories and high-severity static findings. It changes nothing. State: IMPLEMENTED AND VERIFIED for the report; a scheduled run of the step was not exercised. Opening repair branches automatically under a policy: NOT IMPLEMENTED.

## Security of the coding service

- Repository text, issues, comments and CI logs are untrusted. They reach a model inside a prompt that says so, and the model has no tools there: it can only return text that the checks above accept or refuse. A test has a model "obey" an injected README; the out-of-repository file, the `.git` hook and the command line are all refused.
- A command line is never built from text. Only a script name the index found in the project can be run.
- Tokens are sealed, sent only to the API host, and absent from every response and log.
- Commits are made as the repository's configured author. HANNAH adds no author or co-author line.
