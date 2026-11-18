# Calendar and email: operator setup

HANNAH users connect their own Google or Microsoft account in **Settings → Calendar and email**. Each provider signs them in on its own page with OAuth 2.0 (authorization code with PKCE); HANNAH never sees their password. Before users can connect, whoever runs the HANNAH server registers one sign-in app per provider and puts its client ID and secret in `server/.env`.

Until a provider is set up, its card in Settings says "Not set up on this server yet" and its **Connect** button is disabled. Nothing else in HANNAH depends on it.

## What HANNAH can do once a user connects

| | Google | Microsoft |
| --- | --- | --- |
| Read calendar events | Google Calendar (primary calendar) | Outlook calendar |
| Add an event (after the user approves it) | ✓ | ✓ |
| Search and read mail | Gmail | Outlook mail |
| Save a draft (after the user approves it) | ✓ | ✓ |
| Send mail (after the user approves it) | ✓ | ✓ |
| Find conversations that still need a reply | Gmail threads (newest message isn't yours) | Inbox checked against Sent Items per conversation |
| Reply draft in the same conversation (after approval) | Thread id, In-Reply-To and References | `createReply` / `createReplyAll` |
| Archive, labels (after approval; never delete) | Needs `gmail.modify` | Move to Archive, categories |
| Attachments (list; download up to 10 MB) | ✓ | ✓ (file attachments) |
| Google Chat as the user: spaces, messages, post (post after approval) | Only with "Also connect Google Chat" | — |

Events are created without attendees, so HANNAH never sends invitations. Mail is plain text. Mail content that HANNAH reads is marked to the AI model as information from other people, not instructions, and every send shows the full recipients and text for approval first.

## Requirements

- A database (`DATABASE_URL`): connections belong to user accounts.
- `HANNAH_VAULT_KEY`: sign-in tokens are stored envelope-encrypted with it, like saved provider keys. Losing the key disconnects everyone.
- `HANNAH_PUBLIC_URL`: the public address of the site (for example `https://hannah.example.com`), so the redirect URI is exact. Without it, the server uses the request's host.

The redirect URIs are:

```
<HANNAH_PUBLIC_URL>/api/account/connections/google/callback
<HANNAH_PUBLIC_URL>/api/account/connections/microsoft/callback
```

Settings → Calendar and email also shows each redirect URI to the operator through `GET /api/account/connections` (field `redirectUri`).

## Google

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick one).
2. **APIs & Services → Library**: enable the **Google Calendar API** and the **Gmail API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform): choose **External**, fill in the app name, support email and developer contact. Under **Data access**, add these scopes:
   - `openid`, `email`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.modify` (archive and labels; connections made before 1.5.0 are asked to connect again)
   - For Google Chat, only if you offer it: `https://www.googleapis.com/auth/chat.spaces.readonly`, `https://www.googleapis.com/auth/chat.messages.readonly`, `https://www.googleapis.com/auth/chat.messages.create`. Enable the **Google Chat API** in the Library, and configure a Chat app under its **Configuration** tab. Google requires that even for user-authenticated access. HANNAH asks for these scopes only when a user chooses **Also connect Google Chat**.
4. **Clients → Create client → Web application**. Add the Google redirect URI above under **Authorized redirect URIs**.
5. Copy the client ID and secret into `server/.env`:

   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

**Testing and verification.** While the app's publishing status is **Testing**, only the Google accounts you add under **Audience → Test users** (up to 100) can connect, and their sign-in lasts 7 days before they have to connect again. Gmail read access is a *restricted* scope: to let anyone connect without that limit, Google requires app verification and an annual security assessment. Plan for that before offering Gmail to the public; calendar-only use needs a lighter verification.

## Microsoft

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), go to **App registrations → New registration**.
2. **Supported account types**: pick who may connect. "Accounts in any organizational directory and personal Microsoft accounts" matches the default `MICROSOFT_TENANT=common`.
3. **Redirect URI**: platform **Web**, with the Microsoft redirect URI above.
4. **Certificates & secrets → New client secret**. Copy its **Value** (not the ID). Note the expiry date and replace it before then.
5. **API permissions → Add → Microsoft Graph → Delegated**: `openid`, `email`, `offline_access`, `User.Read`, `Calendars.ReadWrite`, `Mail.ReadWrite`, `Mail.Send`.
6. Copy the **Application (client) ID** and the secret value into `server/.env`:

   ```
   MICROSOFT_CLIENT_ID=...
   MICROSOFT_CLIENT_SECRET=...
   # common (default), organizations, consumers, or your tenant ID
   MICROSOFT_TENANT=common
   ```

Work or school accounts may need an administrator to consent to the permissions before users can connect.

## How it works

- `POST /api/account/connections/<provider>/start` (signed-in user) creates a random `state` and PKCE verifier, stores them (the verifier encrypted, the state as a hash) for 10 minutes, and returns the provider's sign-in URL. On the web the page goes there; the desktop and mobile apps open the system browser, because Google and Microsoft don't allow sign-in inside an app's web view.
- The provider sends the browser to the callback. The state is single-use and identifies the user, so the callback works without the user's session (needed for the apps) and can't attach an account to someone else. The server exchanges the code with the PKCE verifier, stores the refresh and access tokens encrypted, and sends the browser back to the app's Settings (on the web) or shows "you can close this tab".
- Access tokens are refreshed when they expire. If the user revoked access, the connection is removed and Settings asks them to connect again.
- **Disconnect** deletes the stored tokens. For Google it also revokes them at Google; for Microsoft, users remove the app at <https://account.microsoft.com/privacy/app-access> (personal) or ask their administrator.
- Connecting, disconnecting and sending mail are recorded in the account's security activity. The account export lists connections without tokens.

The code is in [`server/connections.js`](../server/connections.js) (with tests in `server/connections.test.js`) and [`client/src/services/Connections.ts`](../client/src/services/Connections.ts).
