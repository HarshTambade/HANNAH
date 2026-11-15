# Platform Audit Report

## Scope
- Client build, type-check, and bundle limits.
- Backend Python tests and server Node tests.
- Release workflow and nightly gates.
- Phase deliverables added during the Phase 11-21 evolution.

## Findings and status

### Build and packaging
- `client` production build passes: TypeScript + Vite + PWA.
- Renderer gzip target: 3.26 MiB / 5 MiB target (PASS).
- Web distribution: 27.97 MiB (PASS, includes assets/models).
- Installer size check now excludes `unpacked` directories, fixing the false 238.47 MiB failure.
- Chunk-size warning: three.js vendor chunk exceeds 500 kB after minification; not a blocker for current budget but worth future code splitting.

### Tests
- Backend pytest: 13 passed.
- Client Vitest: 26 passed.
- Server Node test: 22 passed.

### Nightly pipeline
- Full red-team run, Vitest, Pytest, and dependency audit steps are configured.
- P0 debt regression gate scans for bypass patterns and runs test suites.

### Phase deliverables
- Phase 11: task spine, side-effect ledger, undo, perception bus, router, debt docs, canary.
- Phase 12: on-device native, governed safety, memory, sync, evaluation.
- Phase 13-14: production readiness, latency budgets, tracing, cost governance, self-evolution, multimodal, interop, tool synthesis.
- Phase 15: accountability, guardian, PAP, persona kernel, regulatory compliance.
- Phase 16: oversight, rehearsal, cloud home, hardware, cast, specialist, autonomy.
- Phase 17-18: AIPF/NLIP, memory tiers, monetization, safety productization, governed agency, memory resolution.
- Phase 19-20: incentives, dreaming memory, ITU-T identity, embodied, task completion evaluator, real-time voice, distillation.
- Phase 21: ambient presence, neuro-symbolic reasoning, collective intelligence, relational governance.

### Known residual issues
- Installer size enforcement now targeted to real installers after excluding unpacked artifacts.
- Full Electron build not run locally; release job is the authoritative gate.
- The client now includes a first-party bundled marketplace for agents and skills, with local install, activation/enablement, and uninstall. Remote discovery, third-party publishing, package signing, and remote updates remain unimplemented. Real PAP OAuth, real cloud home provisioning, and real ITU-T mappings remain scaffolds.
- Runtime governance, dreaming, and hardware layers are service-level scaffolds integrated into existing systems rather than fully productionized endpoints.

## Recommended next actions
1. Publish a new release tag (`v1.0.3`) after bumping version.
2. Run Electron packaging matrix for macOS, Windows, Linux.
3. Add integration tests for new Phase services.
4. Expand memory/export and subscription enforcement paths before monetization claims.
