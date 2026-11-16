# Release Checklist

1. Bump version in `client/package.json`, `server/package.json`, and root `package.json`.
2. Run lint and unit tests: `npm test --prefix client` and `npm test --prefix server`.
3. Run Playwright E2E: `CI=1 npm run test:e2e --prefix client`.
4. Build web: `npm run build --prefix client`.
5. Build desktop (macOS, Windows, Linux) via GitHub Actions Electron matrix.
6. Build mobile (Android, iOS) via GitHub Actions.
7. Sign artifacts with configured secrets (macOS notarization, Windows cert, Android keystore).
8. Upload artifacts to GitHub Release.
9. Write release notes (features, fixes, breaking changes).
10. Submit to App Store / Google Play with updated metadata.
11. Verify auto-update (Electron) and OTA (Capacitor) flows post-release.
12. Confirm Sentry and analytics dashboards receive events.
```