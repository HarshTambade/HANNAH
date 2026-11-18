# HANNAH Known Issues

| ID | Subsystem | Issue | Severity | Evidence | Recommended fix |
|---|---|---|---|---|---|
| KI-1 | Automation execution | Cross-device lease timing can delay cancellation | Medium | `AutomationService.ts` checkpoint wait | Tune timeouts; add tests |
| KI-2 | Native plugins | Not verified on physical devices | High | Android/iOS wiring only | Device smoke tests |
| KI-3 | Secondary frontend | Separate app path not in CI | Medium | `apps/frontend` | Document experimental or integrate |
| KI-4 | Landing page | Content/UX needs redesign | Low | `LandingPage.tsx` | Redesign |
| KI-5 | Hash anchors | Plain section anchors on landing | Low | `LandingPage.tsx` | Acceptable |
| KI-6 | Audit exceptions | Recorded high-severity deps | Medium | `.audit-exceptions.json` | Review before expiry |