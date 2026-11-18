# HANNAH implementation roadmap

Ordered by real dependencies, not only by the P-levels: something that blocks everything after it comes first. Issue ids (KI-n) are in [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## P0: critical failures

| Item | Status | Depends on | Notes |
| --- | --- | --- | --- |
| Automation runs failing on provider rate limits (KI-1) | **Done 2026-11-18** | — | Engine waits out rate limits (in place, or parked durably) for up to 30 minutes; Auto moves to another provider's key; clear errors. Unit, API (SQLite and Postgres) and real-Groq evidence. |
| CI red on Windows (KI-3) | **Done 2026-11-18**; CI run 44250391204 green on every job | — | Audit gate scope path fix. |
| Production account database, vault key and scheduler tick (KI-2) | **Owner action** | Secrets only the owner can create | Exact steps in KI-2. Unblocks accounts, sync, server workflows, the Phone Bridge and webhooks for real users. |
| Shared free AI key for all guests (KI-6) | Owner decision | KI-2 for per-account keys | Options in KI-6. |
| Auth and authorization defects | None found | — | Account isolation tested across workflows, credentials, runs, Phone Bridge and task runs. Sessions are hashed, passwords use scrypt, and cookies are HttpOnly SameSite=Lax. |
| Data integrity | None found | — | Conditional claims, leases, idempotency keys and dead-lettering are tested on both databases. |

## P1: core intelligence and execution

| Item | Status | Depends on |
| --- | --- | --- |
| Durable workflow execution | **Milestone 1 done:** pause and resume, recovery counted separately from resumes (KI-15), webhook loop guard (KI-17), live run page (KI-18), real-process restart tests and a real-services proof | KI-2 in production |
| "Completed but did nothing" made visible (KI-4) | **Done** | — |
| Framework icons in v1.4.0 downloads (KI-9) | **Fixed on main, needs a release**; packaged-icon CI check added | A green CI run |
| AI agent integration (tool limits, long results) | Done in the previous round | — |
| AI request size on free plans (KI-11) | Next (usage is now visible, KI-14) | — |
| Desktop Vision & Action: accessibility-tree control | Not started | The user's Accessibility permission; macOS first |
| Execution verification | In place: re-read files, PDF checks, run checkpoints | — |

## P2: cross-device intelligence

| Item | Status | Depends on |
| --- | --- | --- |
| Secure desktop–phone pairing | Built (code pairing) | KI-2; QR pairing not built |
| Android and iOS Phone Bridge | Built, not run on devices (KI-13) | Physical devices, signed builds |
| Calls and SMS handoff | Built (handoff to the phone's own apps; no emergency automation) | KI-13 |
| Cross-device task orchestration | Task runs and device jobs built | KI-2 |
| Push wake-up for the Phone Bridge | Missing | Push credentials (APNs, FCM) |

## P3: product quality

| Item | Status | Depends on |
| --- | --- | --- |
| Routing without `#` | **Done** (KI-7 was the last case) | — |
| Release management (KI-8) | Open | The owner's choice on old tags |
| Secondary app path (KI-10) | Open | The owner's choice: archive or keep |
| Website content | Product decision | — |

## P4: productionization

Regression testing, a security audit, performance testing, packaging and a GitHub release. A release is only cut from a green CI run (Windows included), with the release checklist in `docs/RELEASE_CHECKLIST.md`.

## Next engineering steps, in order

1. ~~Confirm the Windows build is green (KI-3).~~ Done: run 44250391204 passed every job, including the packaged-icon check on macOS and Linux.
2. **Cut a release from a green run** (for example v1.5.0), so downloads finally carry HANNAH's icon (KI-9). The CHANGELOG "Unreleased" section is the release notes.
3. **Request less from the AI per step on free plans (KI-11).** If Groq counts the requested `max_tokens` against the per-minute budget (unconfirmed; measure first), a smaller default for short tasks (classify, extract) would raise throughput on free keys.
4. **Production setup (KI-2)**, once the owner provides the secrets, then a live check of signup → workflow → webhook on the real site.
5. **Accessibility-tree app control** on macOS, behind the user's permission.
6. **Device runs** of the Phone Bridge on Android and iOS (KI-13).
