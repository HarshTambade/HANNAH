# Autonomous task recovery

Status: 1.7.0 · Last reviewed 2026-11-20

What survives a restart, a time limit, a rate limit or a lost connection, and what to do when something is stuck.

## Actions (`hannah_actions`)

| Situation | What the record shows | What to do |
|---|---|---|
| The server stopped before an action ran | `waiting-approval`, or not created | Approve it, or ask again. Nothing ran |
| The server stopped while an action was running | `executing`, shown as **Outcome unknown** after 3 minutes | Check the service (the calendar, Sent, the repository). HANNAH never retries this by itself, because the action may have happened |
| The request was sent twice (a retry, a double click, a workflow retry) | One record. The second request returns the first (`replayed: true`) when it carries the same idempotency key | Nothing |
| Two devices answered at once | The first answer; the second gets "already answered" | Nothing |
| The approval came too late | `expired` | Ask again |
| The service answered with an error | `failed`, with the service's message | Fix the cause (reconnect the account, check the token), then ask again |
| The service accepted it and it couldn't be confirmed | `unverified`, with what was and wasn't seen | Check the service. HANNAH says "accepted, not confirmed" |
| A device was told it may act and didn't report | **Outcome unknown** after 30 minutes | Check the device |
| The emergency stop was pressed | Waiting actions `cancelled` | Turn the stop off (signed in, in the app), then ask again |

A workflow's actions use the key `wf:<execution>:<step>:<item>`, so a retried step is the same action.

## Coding tasks (`hannah_coding_tasks`)

A task is saved after every stage. Continuing (`POST /api/coding/tasks/:id/continue`, the Continue button, or the `code_task` tool) starts from the last finished stage; finished stages aren't repeated.

| Stage | Saved after it | If interrupted during it |
|---|---|---|
| index | The commit, the repository's shape, what was skipped | Read again (seconds) |
| checks, dependencies | Findings | Run again |
| review | Findings and which files were reviewed, after every batch | The next batch starts where the list stopped |
| plan | The plan | Planned again |
| edit | The changed files, the diff, the computed review | Edited again from the plan |
| verify | Each check's result | Checks already run aren't run again |
| ready | — | Waits for you; nothing is committed |
| publish | The branch, commit and pull request | See below |
| ci | The checks' state | Read again |

| Status | Meaning | What to do |
|---|---|---|
| `running` | The server's time for one request ran out (about 40 s on serverless hosting, 150 s elsewhere) | Continue. The app does this by itself while the screen is open |
| `waiting-approval` | It wants to run one of the project's scripts | Approve or decline in Actions → Activity, then Continue |
| `needs-input` | The plan needs an answer | Continue with the answer |
| `ready` | The change is prepared and not published | Publish, or cancel |
| `paused` | A rate limit, an unreachable service, the emergency stop, or you paused it | Continue. A rate limit clears by itself |
| `published`, `watching-ci` | Pushed; the repository's CI hasn't finished | Check CI |
| `failed` | An error that continuing won't fix; the message says which stage | Start a new task |
| `cancelled` | You cancelled it | — |

**If a publish was interrupted.** A second publish of the same task is refused once the commit is recorded. If the server stopped between GitHub accepting the commit and the task being saved, the action reads **Outcome unknown**: look for a `hannah/…` branch in the repository. If it is there, the change was pushed; open the pull request by hand or delete the branch and publish again. Nothing was forced and the default branch was not touched.

**Local working copies.** A task's worktree is in the system's temporary folder under `hannah-worktrees/<repository>/<task>`. It is removed when the task is published or cancelled. A leftover from a crash is detected (it no longer belongs to the repository) and replaced. `git worktree prune` in the repository clears stale entries. Branches named `hannah/…` are HANNAH's; deleting one loses only that prepared change.

**Changing devices.** Tasks and actions live on the server, so a task started on one device continues on another.

## Team runs and automations

Unchanged from 1.5.0: `hannah_task_runs` holds a checkpoint after every step, one device holds the lease, another can take over (`docs/ARCHITECTURE.md`, M12 and M14). Their tool calls now create action records too.

## Operators

- Migration 17 creates the tables on first start. It only adds tables.
- `HANNAH_CODE_ROOTS`: folders (separated like `PATH`) that local repositories may live in. Unset, or on serverless hosting, local repositories are off.
- `HANNAH_GITHUB_API`: another GitHub API address (GitHub Enterprise Server). Default `https://api.github.com`.
- A token GitHub rejects is recorded on the connection (`last_error`) and shown in Actions → Connections.
- To remove everything for an account, delete the account; every table here cascades.
