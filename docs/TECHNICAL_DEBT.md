# HANNAH Technical Debt Inventory

| ID | Area | Item | Severity | Effort | Owner | Acceptance criterion |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | AgentRuntime | Single loop couples routing, tools, and provider calls. | P0 | L | Core maintainer | RouterAgent delegates to sub-agents with isolated profiles. |
| D2 | SafetyGuard | Confirmation and execution are coupled; no undo window. | P0 | M | Security maintainer | SideEffectLedger records and delays irreversible actions. |
| D3 | eBPF sidecar | Optional kernel monitor is isolated and Linux-only. | P1 | M | Platform maintainer | Documented, opt-in, and tested on supported Linux. |
| D4 | ChatUI | State sync between quota, messages, and modals is manual. | P1 | M | Client maintainer | Centralized state hook with tests. |
| D5 | Dependencies | Moderate minimatch advisories remain in electron-builder. | P1 | S | DevOps maintainer | Audit passes or documented accepted risk. |
| D6 | Test coverage | E2E only covers one happy path. | P1 | M | QA maintainer | At least 3 e2e scenarios. |
| D7 | Electron vs Tauri | Desktop shell choice is undecided. | P2 | L | Architecture maintainer | Decision record with migration plan. |
| D8 | Cost tracking | Token usage is logged but not surfaced. | P1 | S | Ops maintainer | Cost report runs in CI. |
| D9 | Red-team | Suite requires live provider keys. | P1 | M | Security maintainer | Mock provider for CI. |
| D10 | Localization | Only en/hi/mr permission strings exist. | P2 | S | Localization maintainer | Additional languages documented. |
| D11 | Accessibility | Keyboard and screen-reader coverage is limited. | P2 | M | UX maintainer | Axe checks in CI. |
| D12 | Observability | No automated alert for audit chain failure. | P0 | S | Security maintainer | Alert fires on chain mismatch. |
