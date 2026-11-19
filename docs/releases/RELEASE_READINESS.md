# Release readiness: 1.5.1

Date: 2026-11-19. Version fields are 1.5.1 everywhere (`node scripts/check-versions.mjs --tag v1.5.1` passes). The release is **prepared, not published**: pushing and tagging start a production deployment and a public release, which wait for the owner's go-ahead.

## Gates

| Gate | Result |
|---|---|
| Server tests | 327 pass, 1 skipped |
| Client tests | 364 pass |
| End-to-end | 82 pass |
| Lint, typecheck | 0 errors |
| Secret scan, dependency audit, audit gate, permissions, brand | Pass |
| Web production build | Builds; served by the server and used for the live checks |
| Changelog | `## 1.5.1` section present |

## Per platform

| Platform | Built for 1.5.1 | Verified | Ready |
|---|---|---|---|
| Web | Locally (production build) | Live checks in this audit | Yes |
| Server (Vercel) | Runs locally with the changes | Tests and live checks; production not yet deployed | Yes, on push |
| macOS, Windows, Linux desktop | Not yet; CI builds them on the tag | For 1.5.0: CI build and launch check. No desktop code changed in 1.5.1 except the bundled web app | When CI is green on the tag |
| Android | Not yet; CI builds on the tag | 1.5.0 debug APK ran on an emulator | When CI is green; unsigned debug APK |
| iOS | Not yet; CI builds on the tag | Build only | Not distributable without signing |

No platform is claimed as tested on real hardware.

## To publish

1. Commit and push `main` (this deploys the website and server on Vercel).
2. Wait for "Build HANNAH" to pass on that commit.
3. `git tag -a v1.5.1 -m "HANNAH v1.5.1" && git push origin v1.5.1`; CI builds all installers and publishes the GitHub Release.
4. Confirm the release and its assets on GitHub, and that `/download/<platform>` on the live site resolves to v1.5.1.

## Known limits of this release

See "Not complete" in [REPAIR_TRACKER.md](../audit/REPAIR_TRACKER.md): real-account verification of Google/Microsoft/WhatsApp, phone features on a device, signing, and the two GitHub secrets for scheduled workflows.
