# Shanaya Release Cadence

Shanaya ships on a monthly cadence. The goal is to turn support, audit, and usage signals into small, reviewed improvements without destabilizing the core companion.

## Monthly timeline

### Days 1–7: Collect signals
- Review Sentry P0/P1/P2 issues and crash-free sessions.
- Review `logs/content_reports.jsonl` and `logs/shanaya_audit.jsonl`.
- Run `python3 scripts/bad_case_harvest.py` to collect disliked or rejected interactions.
- Review provider usage, cost, latency, and fallback rates from `logs/llm_traces.jsonl`.
- Collect user feedback from Discord/MongoDB and support email.
- Identify the top 3 user-visible issues and top 3 safety or cost issues.

### Days 8–21: Implement fixes and improvements
- Fix P0/P1 issues first.
- Improve prompts, tool schemas, and provider routing based on harvested bad cases.
- Update localized copy and store metadata if needed.
- Add or adjust tests for every behavior change.
- Keep changes small and behind existing confirmation flows.

### Days 22–28: Red-team, regression, and release candidate
- Run `python3 scripts/run_redteam.py` against a staging deployment.
- Run client, server, and Python test suites.
- Run `npm run build`, bundle-size checks, and Playwright e2e tests.
- Verify iOS/Android/desktop packaging if the release includes native changes.
- Publish a release candidate and smoke-test it on real devices.
- Review privacy policy, Data Safety mapping, and terms for provider or data-flow changes.

### Days 29–30: Publish
- Tag the release as `vMAJOR.MINOR.PATCH`.
- Let GitHub Actions build and stage platform artifacts.
- Promote desktop updates gradually: 10% → 25% → 50% → 100%.
- Publish store updates with staged rollout where supported.
- Announce the release, monitor for 48 hours, and open follow-up tickets for anything deferred.

## Release rules
- No new core AI features are added during a monthly release unless they are already approved and tested.
- Every release must include red-team and regression results.
- Pricing, billing, and entitlement changes require a separate review.
- Privacy or data-flow changes require legal review before publication.
- Roll back or hotfix if a P0 appears within 48 hours.
PY