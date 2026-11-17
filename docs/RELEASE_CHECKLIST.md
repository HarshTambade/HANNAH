# Release Checklist

1. Bump version in `client/package.json`, `server/package.json`, and root `package.json`.
2. Run the gates CI runs on every push, locally: `node scripts/check-versions.mjs`, `node scripts/scan-secrets.mjs`, `node scripts/check-native-permissions.mjs`, `node scripts/check-licenses.mjs`, then unit tests: `npm test --prefix client` and `npm test --prefix server`. Also `node scripts/check-brand-assets.mjs` (HANNAH's icon everywhere; regenerate with `node client/scripts/generate-brand-assets.mjs`) and the dependency audit gate: `node scripts/audit-gate.mjs <dir>` for `.`, `client`, `server` and `client/electron`, plus `--omit-dev --level moderate` for the first three. Review `.audit-exceptions.json`: no stable release with an expired exception or an unexplained high-severity production finding.
3. Run Playwright E2E, which includes the accessibility audit (axe, WCAG 2.1 AA, serious or critical findings fail): `CI=1 npm run test:e2e --prefix client`.
4. Build web: `npm run build --prefix client`.
5. Build desktop (macOS, Windows, Linux) via GitHub Actions Electron matrix.
6. Build mobile (Android, iOS) via GitHub Actions.
7. Sign artifacts with configured secrets (macOS notarization, Windows cert, Android keystore).
8. Let the release job publish: it adds the CycloneDX SBOMs (client and server), inspects every staged package (`scripts/inspect-release-assets.sh`: checksums match, no signing material inside archives, release notes pass the secret scan), attests build provenance for each file, then uploads. Afterwards verify one package: `gh attestation verify HANNAH-Linux.AppImage --repo HarshTambade/Shanaya-Your-AI-companion`.
9. Write release notes (features, fixes, breaking changes).
10. Submit to App Store / Google Play with updated metadata.
11. Verify auto-update (Electron: Stable channel sees the release, Beta sees pre-releases) and OTA (Capacitor) flows post-release. For a pre-release, tag it `vX.Y.Z-beta.N` and mark it as a pre-release on GitHub so only the Beta channel installs it.
12. Update `docs/PLATFORM_SUPPORT.md`: every advertised capability has a class-1 or class-2 cell on each platform the notes name, and class-4 cells are listed under "Credentials needed".
13. Confirm Sentry and analytics dashboards receive events.
```