# Deploying HANNAH

How to run HANNAH in production: the website and its server on Vercel with a Postgres database, and signed apps for Android, iOS, macOS, Windows and Linux.

| Part | Needed for | What you need |
| --- | --- | --- |
| [1. Database and Vercel settings](#1-database-and-vercel-settings) | Accounts, sync across devices, saved AI keys, workflows, calendar and email, Telegram, Phone Bridge pairing | A Vercel token and a Supabase token (both free) |
| [2. The workflow scheduler](#2-the-workflow-scheduler) | Scheduled and waiting workflows on Vercel | Two GitHub secrets |
| [3. Check it works](#3-check-it-works) | | |
| [4. Signed apps](#4-signed-apps) | Installs without security warnings, app stores, desktop auto-updates | Paid developer accounts (see each platform) |
| [5. Publish a release](#5-publish-a-release) | New downloads | A version tag |

Without part 1, the website still works for chat with a visitor's own AI key. Everything tied to an account is switched off: `/api/account/status` shows `"database":{"configured":false}`.

**Self-hosting instead of Vercel:** the repository's `Dockerfile` builds one image with the API server and the web app. The server serves the built app when `HANNAH_SERVE_CLIENT` names it; see `server/static-client.js`. `docker-compose.yml` adds a Postgres 16 database.

1. Create `.env` next to `docker-compose.yml`, and never commit it:
   - `POSTGRES_PASSWORD`: a long random password.
   - `HANNAH_VAULT_KEY`: `openssl rand -hex 32`. Keep a copy.
   - `CRON_SECRET`: `openssl rand -hex 32`.
   - Optional: `GROQ_API_KEY`, `HANNAH_PUBLIC_URL`, `HANNAH_API_TOKEN` and any other setting from `server/.env.example`.
2. Run `docker compose up -d`, then open http://localhost:3001.

**How it runs:**
- The workflow worker runs inside the server, so part 2 (the scheduler) isn't needed.
- The database is reached only on the compose network, without TLS (`DATABASE_SSL=off`).
- For a public address, put a TLS proxy (Caddy, nginx, Traefik) in front. Chat apps and calendar sign-in need https.

## 1. Database and Vercel settings

The server needs three settings:

| Variable | What it is | If it's lost |
| --- | --- | --- |
| `DATABASE_URL` | The Postgres connection string. On Vercel, use a pooled connection: Supabase's transaction pooler (port 6543), Neon's pooled string. | Nothing is lost; set it again. |
| `HANNAH_VAULT_KEY` | 64 hex characters. Encrypts the AI keys, bot tokens and calendar connections people save. | **Saved keys become unreadable.** Keep a copy in a password manager. |
| `CRON_SECRET` | A random string. Lets the scheduler (part 2) run workflows. | Make a new one and update it in both places. |

Choose one of the three routes below. Route A is the quickest.

### Route A: from HANNAH itself (recommended)

HANNAH creates the database and saves the settings for you.

1. **Create a Vercel token:** [vercel.com/account/settings/tokens](https://vercel.com/account/settings/tokens) → Create. Scope it to the team that owns the HANNAH project. Choose a short expiry, such as 1 day.
2. **Create a Supabase token:** [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) → Generate new token.
3. **Open the live site:** Settings → Account → **Set up HANNAH on Vercel and Supabase** (also under Marketplace → Connectors while no database is configured). Paste both tokens.
4. **Pick the settings:**
   - **Project:** the Vercel project serving the site; HANNAH marks the one whose domain you're on.
   - **Organization:** the Supabase organization.
   - **Region:** Mumbai is the default; pick the one nearest your users.
5. **Wait:** HANNAH creates the Supabase project and waits for it to start, which takes a minute or two. It then connects to the database to check it, saves the three settings in Vercel as *sensitive* variables (Production and Preview), and starts a new production deployment from Git.
6. **Copy the two secrets it shows** (`HANNAH_VAULT_KEY` and `CRON_SECRET`) into a password manager. They're shown once. You need `CRON_SECRET` again in part 2.
7. **Revoke both tokens:** HANNAH doesn't keep them.

**Things to know:**
- **Existing settings:** if any of the three is already set in Vercel, HANNAH stops and asks before replacing it. Replacing the vault key makes keys saved with the old one unreadable.
- **Using an existing Supabase project:** choose "An existing project". This **resets that database's password**, so anything else using the old password stops connecting. HANNAH asks you to confirm.
- **If the redeploy fails** (for example, the project isn't connected to Git): open the project in Vercel → Deployments → ⋯ → Redeploy.

### Route B: Vercel's Supabase integration

1. **Connect the database:** in Vercel, open the project → Storage → Connect Database → Supabase. Create a database, or link an existing one, for the Production and Preview environments.
2. **What the integration sets:** it adds `POSTGRES_URL` and `SUPABASE_JWT_SECRET`, among others. HANNAH uses `POSTGRES_URL` when `DATABASE_URL` is empty. It derives the vault key from `SUPABASE_JWT_SECRET` when `HANNAH_VAULT_KEY` is empty.
   - **Caution:** rotating the Supabase JWT secret then makes saved keys unreadable. To avoid that, set your own `HANNAH_VAULT_KEY` now (`openssl rand -hex 32`).
3. **Add `CRON_SECRET`** under Settings → Environment Variables (`openssl rand -hex 32`), marked Sensitive.
4. **Redeploy.**

### Route C: any Postgres, by hand

1. **Create a database** on Supabase, Neon, RDS, Railway or any other Postgres, and copy its **pooled** connection string.
2. **Make two secrets:** `openssl rand -hex 32` twice, one for `HANNAH_VAULT_KEY` and one for `CRON_SECRET`.
3. **Add the variables:** in Vercel → the project → Settings → Environment Variables, add `DATABASE_URL`, `HANNAH_VAULT_KEY` and `CRON_SECRET`. Mark each Sensitive, for Production and Preview.
4. **Redeploy.**

Tables are created on the first request. TLS is verified; Supabase's certificate authority is built in. For another provider's private authority, set `DATABASE_CA_CERT`.

### Other server settings

| Variable | Set it when |
| --- | --- |
| `HANNAH_PUBLIC_URL` | Recommended: `https://hannah.eliteforums.in`. Used for webhook links, the Telegram webhook and calendar sign-in redirects, instead of the request's host. |
| `HANNAH_ALLOW_SIGNUP` | `false` stops new accounts. |
| `GROQ_API_KEY` | The server's own key, which guests share (see KI-6 in [KNOWN_ISSUES](./architecture/KNOWN_ISSUES.md)). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, Microsoft equivalents | Calendar and email: [CALENDAR_AND_EMAIL.md](./CALENDAR_AND_EMAIL.md). |
| `SENTRY_DSN` | Error reports (scrubbed of prompts and keys). |

Every option, with its default, is in [server/.env.example](../server/.env.example).

## 2. The workflow scheduler

On Vercel nothing runs between requests. Something has to call `/api/workflows/tick` every few minutes, so that scheduled workflows start and waiting runs continue. Vercel's free plan runs its own cron jobs at most once a day, so the repository's GitHub Action ([workflow-tick.yml](../.github/workflows/workflow-tick.yml)) calls it every 5 minutes. Until its secrets exist, it skips.

```sh
gh secret set CRON_SECRET            # paste the same value as in Vercel
gh secret set HANNAH_PRODUCTION_URL --body "https://hannah.eliteforums.in"
gh workflow run workflow-tick.yml    # run it once now
gh run list --workflow workflow-tick.yml --limit 1   # should succeed with HTTP 200
```

**Two limits of GitHub's scheduler:**
- Scheduled runs can start several minutes late.
- GitHub turns schedules off in a repository with no activity for 60 days; re-enable it under Actions.

## 3. Check it works

```sh
curl -s https://hannah.eliteforums.in/api/account/status
```

Expect `"database":{"configured":true,"ready":true,…}` and `"vault":true`. Then on the site:

1. **Accounts:** Settings → Account → create an account, sign out and sign in again.
2. **Saved keys:** save your Groq key to the account, then sign in on a second device or a private window. The key works there without being pasted again.
3. **Workflows:** run a workflow with a Wait step, close the tab, and check that it finishes within a few minutes (the tick from part 2).
4. **Telegram (optional):** Marketplace → Chat apps.

If `ready` is `false`, the reason is in the Vercel function logs (Deployments → the deployment → Logs). The database connection error names the problem: wrong password, an address that can't be reached, or TLS.

## 4. Signed apps

CI builds every platform on each push, and publishes them when a version tag is pushed (part 5). Signing is switched on per platform by adding its secrets: **GitHub → the repository → Settings → Secrets and variables → Actions**, or `gh secret set NAME`. Without them the release still publishes, and its notes say which files are unsigned and how to install them.

Secret files such as keystores and certificates are stored base64-encoded:

```sh
base64 -i file | gh secret set NAME
```

| Platform | Without signing | Account | Cost |
| --- | --- | --- | --- |
| Android | Debug-signed APK; can't go on Google Play; every release has a different key, so updates need an uninstall | Google Play Console | US$25 once |
| iOS | No app at all (iOS installs only signed apps) | Apple Developer Program | US$99 a year |
| macOS | Blocked by Gatekeeper ("can't be opened"); auto-update doesn't work | Same Apple account | (included) |
| Windows | SmartScreen warning | A code-signing service | ~US$10/month and up |
| Linux | Checksums only | A GPG key | Free |

### Android

1. **Create the upload key** once, with `keytool` from any JDK 17+ (`brew install openjdk@21`):
   ```sh
   keytool -genkeypair -v -keystore hannah-upload.jks -alias hannah -keyalg RSA -keysize 4096 -validity 10000
   ```
   **Back up the file and both passwords.** Without them you can't publish updates outside Google Play.
2. **Add four secrets:**
   ```sh
   base64 -i hannah-upload.jks | gh secret set ANDROID_KEYSTORE_BASE64
   gh secret set ANDROID_KEYSTORE_PASSWORD
   gh secret set ANDROID_KEY_ALIAS --body hannah
   gh secret set ANDROID_KEY_PASSWORD
   ```
   The release then ships a release-signed `HANNAH-Android.apk` and the `HANNAH-Android.aab` that Play needs.
3. **Google Play:**
   1. Create the app with package name `com.hannah.companion`; it can't be changed later.
   2. Turn on Play App Signing.
   3. Upload the `.aab`.
   4. Fill in the Data safety form from [DATA_SAFETY_FORM.md](./DATA_SAFETY_FORM.md).
   5. New personal developer accounts must run a closed test before production (currently at least 12 testers for 14 days).
   6. Work through [STORE_SUBMISSION_CHECKLIST.md](./STORE_SUBMISSION_CHECKLIST.md).

### iOS

You need an Apple Developer Program membership, and you set this up once in the Apple Developer site and App Store Connect:

1. **Register the app ID:** Certificates, IDs & Profiles → Identifiers → register the App ID `com.hannah.companion`.
2. **Create the distribution certificate:** Certificates → **Apple Distribution**. Install it in Keychain Access, then export it with its private key as a `.p12` file, with a password.
3. **Create the provisioning profile:** Profiles → an **App Store** profile for `com.hannah.companion`, using that certificate.
4. **Create the app:** App Store Connect → Apps → new app with that bundle ID.
5. **Create an API key:** App Store Connect → Users and Access → Integrations → App Store Connect API → a Team key with the App Manager role. Note the Issuer ID and Key ID, and download the `.p8` file, which can only be downloaded once.
6. **Add the secrets and switch signing on:**
   ```sh
   base64 -i distribution.p12 | gh secret set APPLE_DEVELOPER_CERTIFICATE_P12
   gh secret set APPLE_DEVELOPER_CERTIFICATE_PASSWORD
   gh secret set APPLE_TEAM_ID               # 10 characters, Membership details
   gh secret set APPSTORE_ISSUER_ID
   gh secret set APPSTORE_API_KEY_ID
   gh secret set APPSTORE_API_PRIVATE_KEY < AuthKey_XXXXXXXXXX.p8
   gh variable set IOS_SIGNING_ENABLED --body true
   ```
7. **Upload the build:** the release then includes `HANNAH-iOS.ipa`. Upload it with Apple's Transporter app (Mac App Store), then test it in TestFlight before submitting for review.

Before you rely on CI for iOS, read KI-23 in [KNOWN_ISSUES](./architecture/KNOWN_ISSUES.md): the app doesn't build with Xcode 27 yet.

### macOS

This uses the same Apple Developer account.

1. **Create the certificate:** Certificates → **Developer ID Application**. Export it with its private key as a `.p12` file.
2. **Create an app-specific password:** [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords. CI uses it to notarize the app.
3. **Add five secrets:**
   ```sh
   base64 -i developer-id.p12 | gh secret set MACOS_CSC_LINK
   gh secret set MACOS_CSC_KEY_PASSWORD
   gh secret set APPLE_ID                    # your Apple Account email
   gh secret set APPLE_APP_SPECIFIC_PASSWORD
   gh secret set APPLE_TEAM_ID               # skip if already set for iOS
   ```

With these, release builds are signed, notarized and stapled. The packaged app's hardened runtime and entitlements are already configured, and installed apps update themselves.

### Windows

Since June 2023, certificate authorities issue code-signing keys only on hardware tokens or cloud signing services, so a downloadable `.pfx` file is no longer available for new certificates. The pipeline currently signs with a `.pfx` (`WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`), which covers only an older certificate you can still export. The realistic options are:

- **Microsoft's Azure signing service (Trusted Signing):** about US$10 a month. Its eligibility for individual developers depends on your country.
- **A certificate authority's cloud signing:** for example DigiCert KeyLocker or SSL.com eSigner.
- **SignPath Foundation:** free for open-source projects that qualify.

Pick one and the release job can be wired to it; electron-builder 26, which HANNAH uses, supports Azure signing directly. Until then the installer works but shows SmartScreen's "Windows protected your PC". Choose **More info → Run anyway**.

### Linux

1. **Create a key:**
   ```sh
   gpg --quick-gen-key "HANNAH releases <you@example.com>" ed25519 sign never
   ```
2. **Add two secrets:**
   ```sh
   gpg --armor --export-secret-keys "HANNAH releases" | gh secret set GPG_PRIVATE_KEY
   gh secret set GPG_PASSPHRASE
   ```
3. **Publish the public key:** `gpg --armor --export "HANNAH releases"`. Put it in the README or on a key server, so people can check the `.asc` signatures attached to the AppImage and `.deb`.

## 5. Publish a release

1. **Set the version:** in `package.json`, `client/package.json` and `server/package.json`, and in their lockfiles.
2. **Sync the native apps:** run `node client/scripts/sync-native-versions.mjs`. It sets Android's `versionCode` and iOS's build number.
3. **Write the notes:** add a `## X.Y.Z — date` section at the top of [CHANGELOG.md](./CHANGELOG.md).
4. **Check:** `node scripts/check-versions.mjs --tag vX.Y.Z` must pass.
5. **Commit, push, and wait** for CI on `main` to pass.
6. **Tag:**
   ```sh
   git tag -a vX.Y.Z -m "HANNAH vX.Y.Z" && git push origin vX.Y.Z
   ```

The tag build makes every package, checks them, including that the icons are HANNAH's, and attests where they came from. It then publishes the GitHub Release and checks that every file arrived. Installed desktop apps pick the update up from that release.

**After publishing**, before announcing:
1. Download the installers and open each on a real machine.
2. Check the release notes' signing table.
3. Follow [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md).
