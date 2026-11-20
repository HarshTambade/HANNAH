# Permission and trust model

Status: 1.7.0 · Last reviewed 2026-11-20

How HANNAH is allowed to act for an account, and what stops it. Code: `server/actions/permissions.js` (the rules), `server/actions/engine.js` (enforcement), `server/actions/router.js` (who may change them). Screen: Actions → Permissions. Tests: `server/actions.permissions.test.js`, `server/operator.test.js`.

## Levels

Set per service. The default is 3 for every service.

| Level | Name | Reads | Drafts | Changes, sends | Notes |
|---|---|---|---|---|---|
| 1 | Read only | Yes | No | No | |
| 2 | Suggest | Yes | Yes | Prepared and shown; never submitted | A suggestion can't later be approved into an action; ask again at level 3 |
| 3 | Approval before action | Yes | Yes | After you approve each one | The default |
| 4 | Scoped autonomy | Yes | Yes | Without asking where a standing permission names the action and its limits; otherwise asks | |
| 5 | Advanced delegation | Yes | Yes | As 4; a standing permission may cover every action of the service, and then must have an end date | |

A higher level never unlocks the always-ask list below.

Services: code and repositories · calendar · email · messaging · web and browser · connectors and outside tools · bookings · files · this device.

## Standing permissions

A standing permission says: these actions, of this service, optionally only for this resource, within these limits, until this date.

| Scope | How | State |
|---|---|---|
| Service and action type | `service`, `actions` (ids, or `*` at level 5) | IMPLEMENTED AND VERIFIED |
| Repository | `resource.match`: `owner/name`, or `owner/*` | IMPLEMENTED AND VERIFIED |
| Recipient | `resource.match`: an address, or `*@company.com`. Every recipient of a message must match | IMPLEMENTED AND VERIFIED |
| File location, command, site, tool | The same matching on the target a device reports | IMPLEMENTED BUT NOT FULLY VERIFIED |
| Amount | `limits.maxAmount` with a currency. Committing money needs a permission that names the exact action and an amount; a service-wide permission never commits money | IMPLEMENTED AND VERIFIED as a rule; no action that spends by standing permission exists yet |
| Rate | `limits.perDay` | IMPLEMENTED AND VERIFIED |
| Hours of the day | `limits.hours` in a time zone | IMPLEMENTED AND VERIFIED |
| Time period and expiry | `expiresAt`, a year at most | IMPLEMENTED AND VERIFIED |
| Connected account, project, data category, device | — | NOT IMPLEMENTED. A permission applies to the service whatever account, project or device is involved |

Revoking takes effect with the next action: every evaluation reads the policy and permissions from the database. Lowering a service's level ends the permissions that needed the higher level. The screen shows each permission's use count and last use, and each service's last action.

## What always asks

No level and no standing permission changes these.

| What | Why |
|---|---|
| Paying, purchasing, anything that commits money | `spend`; only an exact, amount-limited permission can ever cover a booking, and none can cover a payment |
| Deleting a calendar event or a file; merging a pull request | `destroy` |
| Committing to a repository's default branch | Also off per repository unless you turn it on |
| Anything an action's own check flags | An invitation to other people, an overlap or duplicate on the calendar, an attachment, text that looks like a password or a key, a failing test, a new static finding, a CI workflow or lock file in a change |

Refused outright, whatever you approve: a recipient that isn't a full address or an exact match; publishing a change in which a file no longer parses; merging over failing checks or conflicts; a path outside a repository; a command that isn't one of the project's own scripts. Force pushes and deleting branches or repositories are not in the code.

## Approval

- The approval card shows the engine's own preview: the exact recipients, subject and text; the exact date, time, place and attendees; the branch, the files with their line counts and the check results.
- Only a person signed in to the app can approve. A developer key, an MCP host or a workflow can ask and can never approve. Any of the person's devices can answer; the first answer wins.
- A request expires (24 hours; 30 minutes for something a device is waiting to do).
- Between approval and execution the stop switch and the level are checked again. An approval given after the level was lowered does not run the action.

## Emergency stop

Actions → Activity → Stop everything. Everything waiting is cancelled, coding tasks pause, and until a signed-in person turns it off HANNAH can only read. Anything holding only a key can turn the stop on, never off.

## The record of an action

Every action, including reads and refusals, is a row with:

| Field | Content |
|---|---|
| Request, intent, agent, source | What the person asked, which agent or caller (chat, workflow, API key), and why |
| Action, service, kind | What it is |
| Account, resource | The connected account and what it touched (a calendar, a recipient, a repository) |
| Permission | The level, the outcome, the reason, the standing permission used, the flags |
| Approval | Not needed, waiting, approved or declined, by which device, when |
| Preview | What was shown |
| Response | The service's answer (shortened) |
| Verification | Whether it was confirmed, and the evidence |
| Error, times | The service's error; created, executed |

Kept 180 days, at most 5,000 per account. Only the account's own rows are ever returned.

## Trust boundaries

| Input | Treated as | Enforced by |
|---|---|---|
| Web pages, emails, chat messages, repository files, issues, comments, CI logs | Data. An instruction inside them is never the person's instruction | They reach a model inside a labelled block; the model's output there is text that code then checks. They can't approve, can't change a level, can't name a command |
| A model's output | A proposal | Recipients must be exact, edits must match the file, findings must quote a real line, scripts must exist in the project; everything else is refused |
| A developer key or MCP host | The account, without the power to widen it | Session-only routes for approvals, levels, permissions, tokens and lifting the stop |
| A device | The account's device | It is trusted to act only when authorized and to report honestly; operating-system dialogs still appear and are never bypassed |
| Tokens | Secrets | Sealed with the vault (AES-256-GCM, per-secret key, bound to the user and purpose); sent only to their provider; never in a response, a record or a log |

Passwords are never asked for. GitHub is connected by a token pasted into Actions → Code, not into chat; Google and Microsoft by their own sign-in.

## Not covered

- Without an account there is no engine: HANNAH asks on the device before every change, as before, and keeps no server-side history.
- Desktop commands and the desktop browser keep their own system dialogs and local log; they aren't in this history yet.
- Running a project's test script is not sandboxed.
- The memory tools (save, delete) and removing a saved key keep their on-device confirmation and aren't engine actions.
