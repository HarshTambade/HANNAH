# Provider capability matrix

Status: 1.7.0 · Last reviewed 2026-11-20

What each connection really allows. The same information is in the app (Actions → Connections), built from the live state of the account. States are defined in `docs/architecture/AUTONOMOUS_OPERATOR_ARCHITECTURE.md`.

"Verified against" says what the automated tests talked to. A stand-in is a small fake of the provider's API at the network edge; it proves what HANNAH sends and how it handles answers, not that the provider accepts it.

## Development

| Provider | Connect with | HANNAH can | HANNAH can't | Verified against | State |
|---|---|---|---|---|---|
| GitHub | A fine-grained personal access token (Contents, Pull requests, Issues: read and write; Actions, Metadata: read) | Read code, commits, issues, pull requests, Actions results and logs; index and scan; commit to a new branch; open pull requests, issues, comments, reviews; merge when the repository allows it and you approve | Force push; delete branches or repositories; change settings or secrets; run the repository's code on HANNAH's server | Stand-in API; a real public archive for the reader | IMPLEMENTED BUT NOT FULLY VERIFIED |
| GitHub OAuth app / GitHub App | — | — | — | — | NOT IMPLEMENTED (BLOCKED BY USER PERMISSION OR CREDENTIALS: needs an app the owner registers) |
| GitLab, Bitbucket | — | — | — | — | NOT IMPLEMENTED |
| Local git repository | `HANNAH_CODE_ROOTS` on your own server | Everything above that needs no host, plus running the project's tests in a separate worktree | Anything outside the listed folders; pushing a branch it didn't create; installs | Real git, real tests | IMPLEMENTED AND VERIFIED |
| CI providers other than GitHub Actions | — | CI files are listed in the index | Read their results | — | NOT IMPLEMENTED |

## Productivity

| Provider | Connect with | HANNAH can | HANNAH can't | Verified against | State |
|---|---|---|---|---|---|
| Google Calendar | Google sign-in (OAuth, PKCE) | Read events; find free time; create events with attendees, repeats, a reminder and a Meet link; change; delete; warn about conflicts and duplicates | Calendars other than the primary; other people's calendars beyond the free/busy they share | Stand-in API for read, free/busy, create, delete | IMPLEMENTED BUT NOT FULLY VERIFIED. Real account: BLOCKED BY USER PERMISSION OR CREDENTIALS (`GOOGLE_CLIENT_ID` and secret aren't set on the live server) |
| Outlook Calendar | Microsoft sign-in | The same, with a Teams link | The same | Not run | IMPLEMENTED BUT NOT FULLY VERIFIED; BLOCKED BY USER PERMISSION OR CREDENTIALS |
| Gmail | Google sign-in | Search, read, find what needs a reply, drafts and reply drafts, archive and label, send with files HANNAH made attached | Delete mail; confirm delivery or reading | Stand-in API for search, drafts, send | IMPLEMENTED BUT NOT FULLY VERIFIED; BLOCKED BY USER PERMISSION OR CREDENTIALS |
| Outlook mail | Microsoft sign-in | The same, with categories instead of labels | The same | Earlier tests of the existing functions; the new send check not run | IMPLEMENTED BUT NOT FULLY VERIFIED; BLOCKED BY USER PERMISSION OR CREDENTIALS |
| Notion, Linear and the other services in Marketplace → Connectors | Their own remote MCP server | Whatever tools that server offers, each approved | Anything the service's server doesn't offer | 1.5.1 | Existing. Calls now pass the permission manager as `connectors.call` |
| Task managers, cloud storage (as first-class adapters) | — | — | — | — | NOT IMPLEMENTED (available only through connectors above) |

## Communication

A bot is not your account. That is the platform's rule, not a missing feature.

| Provider | Connect with | HANNAH can | HANNAH can't | Verified against | State |
|---|---|---|---|---|---|
| Telegram | A bot token (Bot API) | Answer direct messages from you and people you approve; send a message you approve to one of those people | Read your personal chats; write to someone who hasn't started a chat with the bot; groups and channels; delivery or read status | Stand-in API | IMPLEMENTED AND VERIFIED for sending; real bot BLOCKED BY USER PERMISSION OR CREDENTIALS |
| WhatsApp | A WhatsApp Business number through Meta's Cloud API | Answer people who write to the business number; send text within 24 hours of their last message | Your personal WhatsApp inbox (BLOCKED BY EXTERNAL PROVIDER: there is no official API for it); messages after 24 hours (approved templates only; NOT IMPLEMENTED); delivery webhooks | Sending path shared with Telegram; not run for WhatsApp | IMPLEMENTED BUT NOT FULLY VERIFIED; needs a Meta business account |
| Slack | A Slack app (Events API) | Answer direct messages; send a direct message you approve to a member who wrote to the app | Read channels; post in channels | Not run for sending | IMPLEMENTED BUT NOT FULLY VERIFIED |
| Google Chat (as you) | Google sign-in with the Chat permissions | List spaces, read recent messages, post a message you approve | Start a direct message with someone new | Earlier tests; the engine path not run | IMPLEMENTED BUT NOT FULLY VERIFIED |
| Discord, Microsoft Teams, Google Chat bot | Their bot credentials | Answer when written to | Start a message. The engine refuses and says why | Refusal verified | Existing; sending BLOCKED BY EXTERNAL PROVIDER for these bot types |
| iMessage, Signal | The desktop app on your Mac | Reply to approved people (1.5.0) | Start a conversation | — | Existing; not on the engine |
| Unread counts, search and summaries across your personal messaging accounts | — | — | — | — | NOT IMPLEMENTED; for WhatsApp and Telegram personal accounts BLOCKED BY EXTERNAL PROVIDER |

## Research

| Provider | Needs | State |
|---|---|---|
| Groq browser search, Wikipedia, OpenAlex, arXiv | A Groq key for the first; nothing for the rest | Existing (1.6.0), verified live |
| Tavily, Brave Search, SearXNG | `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, `SEARXNG_URL` | IMPLEMENTED BUT NOT FULLY VERIFIED (recorded responses; no key here) |
| OSV advisories, npm registry | Nothing | IMPLEMENTED AND VERIFIED live |

## Bookings

| Category | State |
|---|---|
| Restaurants, hotels, flights, trains, healthcare, salons, events, activities, consultations | NOT IMPLEMENTED. BLOCKED BY EXTERNAL PROVIDER for the large networks (their booking APIs are for approved partners) and BLOCKED BY USER PERMISSION OR CREDENTIALS for any provider that needs an account |

What HANNAH does instead, and says it is doing: finds and compares options through research with sources; prepares a booking request as an email or message for you to approve; adds the appointment to your calendar. It does not state availability, a price, a slot or a confirmation number that a provider didn't return, and it never says a booking was made.

## Device control

| Platform | Through | State |
|---|---|---|
| macOS, Windows, Linux | The desktop app: shared folders, approved commands, a browser window, app and window control (macOS), screen reading | Existing (1.5.0). File writes, settings, dialer and outside tools now pass the permission manager; desktop commands and browser typing keep the app's own dialogs and aren't in the engine's history yet (PARTIALLY IMPLEMENTED) |
| Android, iOS | Reminders, notifications, dialer and message drafts | Existing |
