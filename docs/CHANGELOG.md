# Changelog

All notable changes to HANNAH. Versions follow [Semantic Versioning](https://semver.org/). Android `versionCode` and the iOS build number are `MAJOR×10000 + MINOR×100 + PATCH`.

## Unreleased

Robotics, Block 1: the foundation for HANNAH to work with robots. Proven end to end with a built-in simulator; **not run with Gazebo, ROS 2 or any physical robot.** HANNAH is not safety-certified. Documents: [`docs/robotics`](./robotics/ROBOTICS_ARCHITECTURE.md).

### Added

- **Robot registry** (`server/robotics`). A signed-in person creates a robot record and gets a one-time code; the robot's runtime enrolls with it and from then on authenticates as itself. Stored per robot: identity, type, sensors, actuators, capabilities, limits, software and firmware versions, state. Migration 18.
- **Capability contract.** Twelve named operations with input and output schemas, preconditions, risk, timeout, cancel behaviour and how the result is verified. Seven have a runtime: report state, read a sensor, stop, drive to a place, return to dock, visit points, switch an onboard device. Five (camera, follow, arm, grasp, release) are defined only. No capability reaches an actuator.
- **Robotics Safety Gateway**, on the server and again on the robot: a goal outside the workspace or in a keep-out zone, a capability the robot doesn't offer, a speed above its limit, an engaged emergency stop, a fault, a low battery or an offline robot is refused with the reason, before anyone is asked to approve.
- **Robots as an Action Engine service.** Movement goes through the same permission levels, approval and history as everything else. A physical robot's movement always asks. Stopping never needs approval and works during the account's emergency stop.
- **HANNAH Robotics Runtime** (`robotics/runtime`, Python, standard library only), for the robot's own computer: verifies each command's signature, robot id, expiry and sequence; applies the robot's own limits; stops the robot when its link to HANNAH is silent for five seconds, on an emergency stop, a fault or a mission timeout; never resumes by itself.
- **Hardware abstraction layer** with two adapters: a built-in kinematic simulator of a differential-drive robot (speed and acceleration limits, collisions, drifting odometry, a ray-cast range sensor, path planning around obstacles that aren't on its map), and a ROS 2 adapter for Nav2 robots.
- **Robots screen** (`/robotics`): the registry, enrollment, each robot on its map, missions and how each was verified, telemetry, warnings, capabilities and limits. Every robot is labelled SIMULATION or PHYSICAL; an offline robot's state is marked as old.
- **Robot Agent** and nine robot tools, offered only to an account that has a robot.
- **Gazebo Harmonic and Nav2 package** for ROS 2 Jazzy (`robotics/ros2_ws`), its world and map generated from the same file the built-in simulator reads, a container and a manual CI job to run it.

- **Commissioning.** A physical robot no longer moves because it enrolled: a signed-in person takes it through seven checks, the server verifying what it can see (the emergency stop engaging and releasing, diagnostics, a verified trial at 0.2 m/s). Changed hardware or limits withdraw it. Tested with a stand-in; no physical robot.
- **Destinations** bound to the robot's map and frame, validated when added; a physical robot goes by name only to ones a person defined or approved.
- **Pause, resume and cancel** for missions. Pausing and cancelling never need approval; resuming is checked and approved like starting, and its command expires and works once.
- **Sensors and perception** in the simulator: IMU, temperature and humidity, readings with time and source, sensor faults, heading fused from wheels and gyroscope, obstacles grouped from range returns with confidence, a blocked-route report, map changes. A robot is not moved without its range sensor.
- **A home world** with rooms and doorways and **five navigation scenarios** with a regression runner, including recovery when a blocked doorway clears.
- **Fleet:** HANNAH chooses the robot for a task, says why, and why not the others; two robots aren't sent to the same spot. **Diagnostics** from what a robot reported, each finding with its evidence; a maintenance log.
- **Screens** for all of the above, **nine more robot tools**, and two more agents (Fleet, Robot care).
- **Manipulation in simulation.** A built-in planar arm simulator (not MoveIt 2 or Gazebo) with kinematics, joint limits, collision-checked motion and a gripper with feedback; `move_robot_arm`, `grasp_object` and `release_object` with a runtime, both gateways and verification from joint and gripper feedback; an arm view and a Manipulation agent. Arm steps ask every time. A pick and place is verified end to end.
- **Signed robot packages:** a manifest with every file's hash and an Ed25519 signature, a verifier and a command-line tool. Verifying installs nothing.
- Migration 19. Requests in one robot's name are rate-limited.

### Not done

- The ROS 2 adapter, its watchdog, the Gazebo robot and the container have never been run: ROS 2 and Gazebo could not be installed on the development machine.
- No physical robot. No MoveIt 2 and no physical arm or gripper. No camera. No firmware updates (design only). No mission queues or traffic management between robots. No industrial or IoT connectors. No installing of robot packages. State per stage: [`robotics/STAGE_STATUS.md`](./robotics/STAGE_STATUS.md).

### Changed

- The permission evaluator allows an action defined as de-escalating at every level and during the emergency stop. Only stopping, pausing and cancelling a robot's mission use it.
- The account's emergency stop also sends a stop to every robot that could be moving.

## 1.7.0 — 2026-11-20

HANNAH can act, not only answer: one engine that asks permission, waits for approval, does the thing once, checks it happened and keeps the record; and a coding service on top of it.

### Added

- **Action Engine** (`server/actions`). Every action HANNAH takes for an account goes through it, whoever asks: chat, voice, an agent, a workflow, an MCP host or a device. It shows what will happen before it runs, runs it at most once, reads the result back from the service, and records the request, the permission decision, the approval, the response and the check. "Done" means confirmed; accepted-but-unconfirmed, failed and unknown are said as they are.
- **Permission manager.** Five levels per service (Read only, Suggest, Approval before action, Scoped autonomy, Advanced delegation). Standing permissions limited to an action, a repository or recipient, a daily count, hours of the day and an end date; revocable at once. Paying, deleting, merging and committing to a default branch always ask. An emergency stop cancels what is waiting and leaves HANNAH able only to read.
- **Actions screen** (`/actions`): approvals, the history of actions with how each was confirmed, permission levels and standing permissions with their last use, what every connection can and can't do, and code.
- **Calendar**: find free time (working hours, buffers, attendees' free/busy where it can be read), events with attendees, repeats, reminders and a meeting link, change and delete, conflict and duplicate warnings, time zones.
- **Email**: sending and drafts through the engine, with files HANNAH made attached; a send is confirmed in the Sent folder.
- **Messaging**: send a message you approve through a connected Telegram, Slack or WhatsApp Business bot, or Google Chat, to a person that channel already knows, matched exactly.
- **Coding service** (`server/coding`): connect GitHub (a fine-grained token) or a local repository; read and index it; scan for files that don't parse, broken imports, undeclared dependencies, committed secrets, conflict markers and dependencies with published advisories (OSV); a model review whose findings are kept only when the quoted line is in the file; prepare a change as a reviewed diff; run the project's own tests in a separate working copy; publish to a new branch and pull request after approval; read CI results. Tasks are saved after every stage and continue from where they stopped.
- **Tools for every agent**: `calendar_find_free_time`, `calendar_schedule`, `calendar_update_event`, `calendar_delete_event`, `message_people`, `message_send`, `code_repos`, `code_overview`, `code_search`, `code_read_file`, `code_github`, `code_scan`, `code_change`, `code_publish`, `code_task`, `code_issue_create`, `code_comment`.
- **Workflows**: steps "Do an action (with your permissions)" and "Check a repository". **MCP**: tool `hannah_action` (it can ask; it can't approve).
- `GET /api/account/integrations`: every connection with its account, what it supports, what it doesn't, its last success and last error.

### Changed

- The existing calendar and email tools now run through the engine for a signed-in account, so they follow the permission levels and appear in the history. Without an account they ask on the device as before.
- File writes, device settings, the dialer, message drafts and outside connector tools ask the permission manager first and report their outcome.
- The Tasks specialist is the personal assistant (calendar, email, messaging); the Coding specialist has the code tools.

### Not included

- Bookings: no booking provider's API is connected. HANNAH researches options, drafts a request and adds a calendar event; it never reports a booking as made.
- Personal WhatsApp and Telegram accounts: the platforms offer no official API for them. Bots answer and send only to people who wrote to them.
- GitLab, Bitbucket, GitHub OAuth sign-in, installing dependencies, runtime profiling.
- Nothing here was run against a real Google, Microsoft, Telegram or GitHub account. Details: `docs/testing/AUTONOMOUS_ACTION_TESTS.md`.

### Operators

- Migration 17 adds six tables on first start.
- New settings: `HANNAH_CODE_ROOTS` (folders local repositories may live in; off when unset and on serverless hosting), `HANNAH_GITHUB_API` (GitHub Enterprise Server).
- New dependency: acorn 8.19.0 (MIT), to check that JavaScript files parse.

## 1.6.0 — 2026-11-20

### New

- **Search the web, with sources you can open.** A Search the web switch in chat, with five modes.
  - **Quick search** answers a question from a few pages. **Latest** puts the newest sources first. **Deep research** plans the work, follows up on what's missing and writes a report. **Academic** searches papers (OpenAlex and arXiv) and says which are peer-reviewed and which are preprints. **Compare** builds a side-by-side table.
  - **You watch it work.** Each search, each page opened and each page that couldn't be read appears as it happens.
  - **Citations are checked.** Every `[n]` in an answer links to its source. A citation to a source that wasn't read is removed, and a figure or quotation that isn't in the cited text is flagged.
  - **A sources panel** shows each source's publisher, publication date, what kind of source it is, how many other sites agree, and the passages HANNAH read. It also lists pages that were blocked, and how the research was done.
  - **Honest when it can't.** If no search could run, HANNAH says so and doesn't answer from memory as though it had looked.
  - **Follow-ups** keep the earlier sources. **Research history** is in Library.
- **PowerPoint, PDF, Word and Excel files from a sentence.** "Create a 12-slide presentation on …", "make a PDF of what we discussed", "build an Excel dashboard from this CSV".
  - **Real, editable files.** Slides have native charts, tables and speaker notes. Word files use heading styles and a table of contents. PDFs have a cover, contents, page numbers and live links.
  - **Excel formulas are formulas.** Totals, growth and summaries are written as formulas with their computed values, plus tables with filters, frozen headers, conditional formatting, data validation and charts. A formula that doesn't compute is left out and named, never shipped.
  - **Your data is copied, not retyped.** A dataset goes into the workbook straight from your file.
  - **No invented numbers.** Without data to draw on, HANNAH makes no charts of figures and tells you.
  - **Every file is opened again and checked** before you get it; the card shows the checks.
  - **Change it by asking.** "Make it more professional", "change the theme", "drop the last slide": only those parts are rewritten, as a new version.
  - **Research to file in one message**, or one press under any research answer.
- **Attach files to a chat.** PDF, Word, PowerPoint, Excel, CSV, text, JSON and images. The chip shows how much was read (for example "9/12 pages"), and scanned PDFs are reported as unreadable instead of guessed at. Ask questions about them, or convert one to another format.
- **Library** (next to Attach): the files HANNAH made and your research history, on this device. Signed-in accounts also keep files for 30 days, or longer if you choose.
- **The same two services everywhere.** Team specialists and marketplace agents use the same research and document tools as chat. Workflows have **Research a question** and **Create a document** steps, so "every Monday, research X, make a PDF and tell me" runs on the server. MCP hosts get `hannah_research` and `hannah_create_document`. A new **Data analyst** agent is in the marketplace.
- **More search providers.** Tavily, Brave Search or your own SearXNG for the open web when the server has a key; Wikipedia, OpenAlex and arXiv need none. Without a search key, web search uses your Groq key.

### Changed

- **Vercel, Intercom and Square connectors are listed only on a local install.** They register sign-in only for addresses on their own allowlists, so on a public site their Connect button could never work. 28 sign-in connectors and 5 no-sign-in connectors were checked from the live site on 2026-11-20.

### Limits

- Charts in Word documents are editable bar tables, not native Word charts.
- A converted file keeps the content, not the original's layout.
- Scanned PDFs have no text to read; there is no OCR.
- Generated files were checked with Apple's viewers and independent parsers here, not with Microsoft Office.

## 1.5.1 — 2026-11-19

### New

- **Agents and skills that do something you can see.** The marketplace now has 10 agents and 12 skills (it had 3 and 3).
  - **Agents** set how HANNAH works for a whole conversation: Study coach, Writing partner, Project planner, Research analyst, Code reviewer, Interview coach, Language tutor, Meeting assistant, Travel planner and Daily organizer. Each has its own method, keeps the tools it needs to hand (Research analyst always has web search and the page reader; Daily organizer always has your reminders), and suggests prompts to start with.
  - **Skills** adjust every reply: Summary first, Step by step, Cite sources, Tables for comparisons, Devil's advocate, Honest uncertainty and more. Up to five can be on at once.
  - **One click turns a package on.** Before, you had to install and then activate, and a package that was only installed did nothing.
  - **Chat shows which agent is active**, lets you switch or turn it off, and offers that agent's prompts in an empty chat.
  - **"Try it with"** on each card opens the chat with the package on and the prompt in the message box.
- **Test your integrations from the Integrations page.** "Test this server now" runs the REST API, the OpenAI-compatible API, a real reply, the MCP endpoint, A2A and webhooks with the credential in your browser, and shows what each one answered and how long it took. Signed-in accounts can create a developer key there.
- **A home page you can start from.**
  - Type your first message on the home page, or pick one of six things to try; it's waiting in the chat's message box once you've connected, with the right agent on.
  - The page asks the server what it offers: where accounts can use the server's own models, it says "no API key needed" and the connect dialog opens on "Create account". Otherwise it explains the free Groq key as before.
  - New sections: the connectors you can use (with their icons, from the live directory), how to start in three steps, and counts taken from the product's own data.
  - On phones, a "Talk to HANNAH" button stays within reach after the first screen.

### Fixed

- **Connectors failed for every visitor who wasn't signed in.** Pressing Connect on any connector answered "Add your Groq API key or a HANNAH access token". Connecting Notion or Linear doesn't use an AI model, so the directory's connectors now connect without any key. A custom connector address still needs a sign-in, so the server can't be used as a relay to arbitrary addresses, and visitors have a lower request limit.
- **Figma is no longer listed as a connector.** Its server refuses apps it hasn't approved, so Connect could never work. 31 of the 32 that remain were checked against the vendors' own servers on 2026-11-19 (GitHub takes a token you paste, so it wasn't).
- **The remote MCP endpoint didn't exist on the hosted site.** `/mcp` was mounted only when the server ran as a long-lived process, and it accepted a single operator token. It now answers on serverless hosting too, and takes the credential you already have: a developer key, the operator token, or your Groq key. `MCP_ENABLED=false` turns it off.
- **Reading a long web page ended the reply with "The agent response exceeded the configured output limit".** A tool result longer than 8,000 characters is now shortened with a note instead of failing the turn.
- **After a failed reply, HANNAH answered the previous question instead of the new one.** The conversation then held two of your messages in a row. The request now says the earlier one went unanswered.
- **A rate-limited web search was retried three more times in the same reply**, which used up the limit further. The tool now says not to retry, and HANNAH tells you instead.
- **The OpenAI-compatible API reported `finish_reason: "stop"` for a reply the token limit cut off.** With a small `max_tokens`, a reasoning model can use the whole limit before writing anything; the response now says `"length"`.
- **Creating an account without a key, on a server that needs one, said the key was "optional".** The form now says HANNAH needs it to answer, and where to get one.

- **Auto mode failed on every request.** HANNAH's model profiles still listed Groq models that Groq has retired (Llama 3.1 8B, Llama 3.3 70B, Llama 4 Scout and Maverick, Qwen3 32B, Kimi K2), and Auto routed simple messages to one of them, so even "hi" failed. Auto now checks which models each provider serves today and never picks a retired one; a busy (rate-limited) model hands over to another model the provider serves; and the plain chat endpoint no longer sends the word "auto" to Groq as a model name.
- **Model pickers offered models that can't chat.** The model lists (chat settings, Agents) showed Groq's speech-to-text (Whisper), text-to-speech (Orpheus) and safety-classifier models; picking one broke the agent. Only chat models the provider serves are listed now, and the Models page no longer recommends retired models. The workflow editor's model list was updated the same way, and a workflow saved with a retired model uses the provider's current default.
- **Raw tool output in chat.** After HANNAH used a tool, chat showed its JSON (`{"saved":true,"id":…}`, whole web pages). It now shows one readable line, such as "Saved to memory: My dog is called Biscuit." or "Searched the web for “…” · 5 sources"; the model still gets the full result.
- **HANNAH asked before doing what you asked.** "Remind me in 3 minutes to stretch" got "Should I set a reminder?" instead of a reminder. She now uses the tool right away and leaves confirmation to the app's own approval card, which appears only for actions that need one. Asked to remember several facts, she saves each.
- **Questions about your documents went unanswered.** HANNAH said she didn't know details that were in your Knowledge documents unless you said "document" or "notes". The passages that match your question now go with it (like memories do), and she answers with their citation, such as [Trip notes §1].
- **Memory, reminders and web search could disappear from a request.** A second, word-matching filter dropped every tool whose description didn't share a word with your message, so "What's my dog's name?" lost the memory tools. Memory, reminders, web search and document search are always available now.
- **A reply cut off by a reload was lost silently.** When the page closed or reloaded before HANNAH answered, your message sat unanswered and the next reply could answer the wrong question. Chat now says HANNAH didn't finish and offers "Ask again".
- **Web search failed more often than needed.** A search that Groq answered with an error is tried once more on Groq's other search model; each try is capped so the whole search ends well within the app's wait, and a rate limit is reported at once.
- **"Export training examples" waited up to two minutes and changed your memory.** It waited for an "idle window", said "No idle window was available" when you had fewer than three rated replies, and copied random chat notes into long-term memory on the way. It now exports at once and changes nothing. The background consolidation keeps a short note only when it came up more than once (it used to keep 30% of them at random).
- **The self-hosted sync relay didn't match the app.** The app sent changes to one address and fetched them from another the relay didn't serve, the relay's ids were guessable and it had no size limits. The relay and the app now share one protocol (see docs/SYNC_PRIVACY.md), with limits, CORS for browsers, and tests that sync two devices through the real relay.
- **The OpenAI-compatible API and agent-to-agent endpoint also picked retired models.** `POST /v1/chat/completions` with `auto` and `POST /api/a2a` failed with "Groq doesn't offer that model", and `GET /v1/models` listed retired, speech and classifier models. They now use the provider's live model list like chat does. An agent-to-agent reply is never empty: an empty model answer is asked once more on the default model, then reported as an error.
- **A signed-in browser's changes are refused when they come from another site.** The session cookie was already `SameSite=Lax`; requests that change something now also need to come from HANNAH's own pages (an allowed origin or the server's own address). Developer keys and the apps are unaffected.
- **A rate limit on a local install showed a second, confusing error** ("Python fallback: Could not reach … 127.0.0.1:8000") when no Python fallback was running.

## 1.5.0 — 2026-11-18

### New

- **Workflows can use your phone and your desktop.**
  - **Phone steps:** Check my phones, Find a contact on my phone, Call on my phone, Text on my phone. They go through the same Phone Bridge as chat. You approve every call or text in the run, and then tap Call or Send on the phone. An offline phone fails the step at once, and nothing is kept for later.
  - **Desktop steps:** Open apps and links (an app with a shared project folder, such as VS Code with your repository, plus links in your browser, after one dialog that lists them) and Desktop notification.
  - **Example:** a "Morning startup" workflow: a schedule, then open VS Code with the project, then your work links.
- **More from your mail, and Google Chat.**
  - **Needs your reply:** HANNAH finds the conversations where the newest message is from someone else and you haven't answered. Automated senders are left out.
  - **Replies:** she prepares reply drafts that stay in the same Gmail thread or Outlook conversation.
  - **Organizing:** she archives and labels (Gmail) or categorizes (Outlook), after your approval. She never deletes.
  - **Attachments:** she lists them, and can download one up to 10 MB.
  - **Google Chat:** in Settings → Calendar and email, choose **Also connect Google Chat**. HANNAH then reads the spaces you're in, summarizes them, and posts as you only after you approve.
  - **Dashboard:** a Communications card shows what needs your reply, with Draft reply and Archive buttons and your Chat spaces, each labelled with its account.
  - **Workflows:** the Email step can find conversations that need a reply, read one message, or save a reply draft. A new Google Chat step reads a space or posts, with approval on every post.
- **"Hey HANNAH" keeps listening.**
  - **Desktop app:** it keeps listening while the window is hidden, and the menu bar says so.
  - **Android:** a native background listener runs in a foreground service, with a notification and Stop button the whole time. Detection stays on the phone, and nothing is sent until you talk to HANNAH. Not yet built or run on a phone: KI-28.
  - **iPhone:** iOS doesn't let apps listen for their own name, so "Hey Siri, talk to HANNAH" opens HANNAH ready to listen. It's also available in the Shortcuts app.
- **Memory keeps up with you.**
  - **Changed facts:** when a fact changes ("I live in Pune" after "I live in Mumbai"), the new one replaces the old, which is kept as its history. There's no second, contradicting memory.
  - **Temporary chat** (the eye button in chat): it doesn't use or save memories, and it isn't kept in your chat history.
  - **Export:** memories now export as Markdown as well as JSON.
- **One risk scale for approvals.** Every action that needs your yes has a level: low (reading), medium (drafts, labels, files in a shared folder), high (messages, calls, email, posts, outside tools) or critical (payments, deleting). Chat, voice and workflows all use the same levels.
- **Capability matrix** ([docs/CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md)): what works on each platform, and how far each feature has been verified.

- **HANNAH Desktop can use your apps (macOS, beta).** Ask her to press a button, fill in a field, type, use a shortcut, scroll, switch apps, arrange windows or quit an app.
  - **How she sees:** she reads the window in front through macOS's Accessibility API (its buttons, fields, menus, text and errors) and acts on those elements; a mouse click at a point is only the fallback.
  - **Checking her work:** after each action she looks again, and calls it done only when the app shows it.
  - **Control session:** it starts with your yes in a system dialog, shows "Controlling" in the menu bar, and stops at once from the HANNAH menu or with Control+Option+Shift+Escape.
  - **Rules:** she asks before sending, deleting, posting, quitting or closing, and before anything in a terminal or System Settings. She never types passwords, never pays, and can't touch HANNAH's own dialogs, security prompts or password managers.
  - **Record:** every task keeps its plan and each action with its result.
  - **Setup:** needs Accessibility permission (System Settings → Privacy & Security → Accessibility → HANNAH).
  - **Other systems:** Windows and Linux say control isn't available yet.
- **Connectors (Marketplace → Connectors).** 33 services you connect with your own account, each one the vendor's own MCP server, shown with its official icon: GitHub, Linear, Notion, Atlassian (Jira and Confluence), Sentry, Stripe, PayPal, Square, Vercel, Supabase, Neon, Netlify, Cloudflare, Figma, Canva, Airtable, monday.com, Zapier, Intercom, Webflow, Wix, Fireflies, Hugging Face, Context7, DeepWiki, Microsoft Learn, AWS Knowledge and more. Search them, filter by category, or add any remote MCP server by URL.
  - **Signing in:** sign-in is OAuth with PKCE and self-registration (the MCP authorization standard), on the service's own page.
  - **Your tokens:** they stay in your browser; HANNAH's server stores none of them.
  - **Safety:** every tool use asks you first, and requests go only to public https addresses.
  - **Not yet:** Asana, Box, HubSpot and Slack aren't listed, because their servers accept only apps they've approved.
- **HANNAH searches the web everywhere.** On the website and phones, HANNAH had no way to search, so she said she couldn't browse. She now searches with Groq's browser search, using your own key, and cites her sources. She can also read any public page. Requests like "search for…", "what's the latest…" or "look this up" always bring these tools. The desktop app keeps its own visible browser.
- **Set up HANNAH on Vercel and Supabase from the app.** Paste a Vercel token and a Supabase token in Settings → Account (or Integrations → Database). HANNAH then:
  - finds the Vercel project serving this site;
  - creates a Supabase database for it;
  - connects to the database to check it;
  - saves `DATABASE_URL`, a vault key and a cron secret as sensitive Vercel variables;
  - deploys again.

  Nothing is stored, and existing settings are never replaced without asking.
- **Talk to HANNAH from your chat apps (Marketplace → Chat apps):** Telegram, Slack, Discord, Google Chat, Microsoft Teams and WhatsApp.
  - **Connecting:** each uses the platform's own official API. HANNAH checks your bot's credentials with the platform, seals them in the vault, and shows the webhook URL to paste where the platform needs it.
  - **Checking every request:** HANNAH verifies each one the platform's way before reading it: Telegram's secret header, Slack's and WhatsApp's signatures, Discord's Ed25519 signature, Google's and Microsoft's signed tokens.
  - **Pairing:** you pair your own chat with a one-time code.
  - **New people:** anyone else is told it's private and listed for you to **approve** or **deny**, like OpenClaw's pairing requests. Approved people get answers, each with their own history.
  - **Limits:** group chats are ignored, and replies use your account's AI key.
  - **WhatsApp:** it uses Meta's official Cloud API, not the unofficial WhatsApp Web protocol.
- **iMessage and Signal in the desktop app.**
  - **iMessage (macOS):** HANNAH reads Messages on this Mac (with Full Disk Access) and replies through the Messages app.
  - **Signal (any desktop):** it works through `signal-cli`.
  - **Rules for both:** off until you turn them on in a system dialog. Only people you approve are read, and anyone else is listed as asking. HANNAH can only reply, once, to a message someone just sent; she can't start a conversation.
- **Command sandbox (Settings → Desktop access).** A shared folder can run HANNAH's approved commands in a throwaway Docker container that sees only that folder. It's offline unless you allow network, has no extra privileges, and has memory, CPU and process limits.
- **`hannah` command-line tool (`cli/`).** Sign in, ask, chat in the terminal with streamed answers, list and run workflows with live step status, and list chat apps. Credentials are stored with owner-only permissions (0600) and never printed.
- **Docker self-hosting.** One image with the server and the web app (`HANNAH_SERVE_CLIENT`), plus a compose file with Postgres 16, with the workflow worker running in-process. See [DEPLOYMENT.md](./DEPLOYMENT.md).
- **Build a plugin.** HANNAH plugins are remote MCP servers added as custom connectors. A documented, dependency-free example with tests is in `examples/hannah-plugin` ([API-INTEGRATION.md](./API-INTEGRATION.md)).
- **“Remember on this browser” for your Groq key (website).** The key is kept for 30 days in a secure cookie that the page's scripts can't read, so you aren't asked again in every new tab. Disconnect forgets it.
- **Connect Supabase in one click on Vercel.** Press **Connect Supabase on Vercel** (Settings → Account while the server has no database, or Integrations → Database) and approve it for the HANNAH project. After Vercel's redeploy, accounts and encrypted key storage are on, with nothing to copy: HANNAH reads `POSTGRES_URL`, which the integration adds, and derives its vault key from the Supabase secret it adds (`SUPABASE_JWT_SECRET`). That secret is never stored in the database. Setting your own `HANNAH_VAULT_KEY` still works, and it takes over and re-encrypts saved keys as they're read.
- **HANNAH's browser, YouTube study notes and PDF notes (desktop app).**
  - **HANNAH's browser:** "find a GATE lecture on YouTube" or "look this up" opens HANNAH's own browser window, visible and signed out of everything.
    - She can search, open pages, read, scroll, follow links, click and look.
    - She asks before typing anything other than a search, and before pressing buttons that send, order, post, follow or change something.
    - She never types passwords or card details and never presses pay or place order.
  - **YouTube study notes:** HANNAH reads the transcript YouTube shows under the video. Long lectures are condensed part by part from what is said, and she says plainly when a video has no transcript.
  - **PDF notes:** saved to a shared folder after you confirm, then checked on disk. The PDF names the video, channel and link, and says on its first page if no transcript was available.
- **Desktop chat requests no longer fail from too many tools.** The desktop app offered every tool (28, now 44) for most requests, but the server accepts 20, so those requests failed; signed-in web users were affected too. Tools are now chosen per request. Long tool results (a big file or page) no longer make a turn fail, and a provider's "too large for your plan" error is reported clearly.
- **HANNAH Desktop can look at your screen, open apps, and run a startup routine.**
  - **"What's on my screen?" / "Explain this error":**
    - HANNAH takes one screenshot after you allow it, once or for 15 minutes, and a vision model answers.
    - While allowed, the menu bar or tray and an in-app banner show it, with Pause and Stop.
    - The screenshot isn't saved, Private mode keeps it on self-hosted models, and text on the screen is never treated as instructions.
    - HANNAH can only look; she can't click or type.
  - **"Open VS Code with my project":** HANNAH finds the app from your system's own launchers, asks first (or not, if you chose "always"), and says it's open only when she sees its process running.
  - **Startup routine:** apps, links and waits, run in order when you sign in, with a history of what worked.
    - It's off until you turn on "Start HANNAH when I sign in", and HANNAH then appears in your system's login items.
    - Saving a routine shows every step first.
  - **Verified on macOS:** opening apps, the startup routine, the login item, launching at sign-in, and the vision answer. Windows and Linux are covered by tests. See docs/DEVICE_INTELLIGENCE.md.
- **Visual workflows that run on the server.** Automations → Workflows: build on a canvas (drag, connect, configure, copy and paste, undo, tidy up, import and export), test the draft with sample data, publish versions and activate. A server engine runs them with a durable queue, leases and heartbeats, retries with backoff, step and workflow time limits, checkpoints after every step, recovery after a restart with a dead-letter state, and schedules that fire once per slot. 42 step types across triggers, actions, logic, data and AI (37 available, 3 in beta, 2 coming and refused by validation until they exist); webhooks with token or HMAC authentication and replay protection; an encrypted credential store; a permission review before activation; a runs center with each step's input, output, timing and exact error, retry from the failed step, cancel and approvals. Describe a workflow in a sentence and HANNAH drafts it. See docs/WORKFLOWS.md.
- **Workflows start from new email or an uploaded file, and can run code.**
  - **New email:** a workflow runs once for each new message in your connected Gmail or Outlook, optionally filtered by a search, checked every 5 minutes or more. Only mail that arrives after activation counts, and a test run uses your newest matching message.
  - **File uploaded:** upload a CSV, JSON or text file (up to 1 MB) from the workflow list or the editor's Test run, and each row can become an item.
  - **Code (beta):** write JavaScript that runs in an isolated sandbox: QuickJS in WebAssembly in its own worker, with no network, files or credentials, at most 2 seconds and 32 MB. Its console output appears in the run.
  - A new **Invoice emails** template uses the email trigger.
- **Workflow steps on your desktop (beta).**
  - **What they do:** "Read a web page on your desktop" opens a page in a hidden, signed-out window on your computer, which works for pages that need JavaScript or are only reachable from your network. "Coding task on your desktop" runs HANNAH's Coding agent in a folder you shared.
  - **Turning them on:** turn on **Run workflow tasks** in Settings → Desktop access. Each task asks you in a system dialog first, a coding task still asks before every file change and command, and it can use only the folder you approved.
  - **Limits:** pages on this computer itself and cloud metadata addresses are refused.
- **Use your phone from your computer (HANNAH Phone Bridge).**
  - **Pairing:** pair your Android phone or iPhone in Settings → Phone with a one-time code. The phone gets its own key, and both screens show the same fingerprint.
  - **Asking:** from your computer, ask in chat ("call Aman using my phone", "text my brother I'm running late") or use the Phone panel.
  - **On the phone:** the phone looks the name up in its own contacts and sends back only the matches, then its own dialer or Messages opens with everything filled in. You tap Call or Send.
  - **Confirmations:** HANNAH confirms the name and number with you first, and reports only what the phone verified: dialer opened, composer opened, and on iPhone sent or cancelled. It never claims a call connected.
  - **Never later:** requests last a minute, an offline phone gets nothing, and nothing is queued for later.
  - **Refused:** emergency numbers and `*`/`#` codes.
  - **No restricted permissions:** no `CALL_PHONE` or `SEND_SMS`, only Contacts when you first look up a name.
  - **Verified:** run end to end on Android in the emulator.
- **A redesigned website.** New sections for AI models (providers and Auto routing), AI agents (how Team works, and what runs on your computer, labelled by status), developers, a what-works-where table, the roadmap with Available, Beta and Coming labels, and help and support. The About page is rewritten to match the product. Every link, download and anchor was checked, and pages are checked for horizontal overflow at four widths.
- **HANNAH's own icon on every platform.** The desktop apps (macOS, Windows, Linux, the Windows installer), Android (legacy, round and adaptive icons, plus a monochrome layer for themed icons) and iOS shipped framework default icons; they're now generated from the official mark by `client/scripts/generate-brand-assets.mjs`, with a CI check that refuses default icons. The web app gains favicon.ico and a maskable PWA icon. v1.4.0's downloads still have Electron's icon on macOS and Capacitor's on Android (checked in the released files); a second CI check now opens the packaged macOS app and Linux package and fails if the icon isn't HANNAH's.
- **Website: an automation section** with screenshots of a real workflow run, the steps and integrations with their status (available, beta, coming), and a FAQ on where workflows run.

- **Daily briefing.** Say "good morning" in chat, use the new **Daily briefing** automation step (the **Morning briefing** template runs it at 07:30 and speaks it), or press **Preview today's briefing** in Settings → Daily briefing. HANNAH collects today's calendar and the newest mail (once an account is connected), reminders due today, the routines she remembers and, if you turn them on, the weather (Open-Meteo, for a place you choose by name) and the Hacker News front page, then has your AI narrate them in a short spoken style. Mail and headlines are marked as other people's content; sensitive memories are left out; weather and news are off by default and send nothing about you.
- **Knowledge.** Memory & trust → Knowledge: add text files or paste text (in the desktop app, index a shared folder's text files), and HANNAH answers questions from them with citations such as `[Trip notes §3]`, through the new `knowledge_search` and `knowledge_documents` tools (also given to the Research specialist). Passages are ranked with BM25 in any script, kept on this device within a 2 MB budget, included in backups, and never synced. PDFs and Office files aren't read yet.
- **Setup check.** Settings → Setup check runs one pass over the server, your AI model (including Ollama through the server), account, calendar and email, voice, microphone, notifications, storage, the desktop app's tray and shortcut, the briefing's place and recent errors, with a verdict and a fix for each.

### Changed

- **Placeholder modules now work.** The library modules that faked their work now do it:
  - **Encrypted sync** (AES-256-GCM under a passphrase) and a CRDT that really merges.
  - **Memory sync** that keeps deletes.
  - **Orchestration and research agents** that make real model and web calls.
  - **A real server check**, PAP sign-in with PKCE, and a working hardware device protocol.
  - **Memory integrity:** memories are checked again before they reach the model.

  Docs that called unwired modules active safety features were corrected.
- **Linting in CI.** ESLint (bug rules only) now checks the app and the server on every build, alongside the app's typecheck.
- **Shared rate limits on Vercel.** Limits for feedback, reports and events are counted in the database when there is one, so every serverless instance enforces the same limit.

### Fixed

- **The Android, iOS and desktop apps no longer register the website's offline service worker.** On Android its install failed (the app shell answers `/favicon.ico` with an empty response), and in any app it could keep serving the previous version's files after an update. The apps now remove a worker an older version left; the website keeps it.
- **Feedback and Report didn't work for anyone but the server operator.** The Feedback form and the button for reporting an AI reply answered "Add your Groq API key or a HANNAH access token" for every guest and signed-in user. They now work for everyone using the app. They're validated and limited per credential and per network address. Reports and feedback are kept in the server's database (on Vercel, a local file was lost).
- **Stop really stops.** Pressing Stop now cancels the AI request in flight, and an answer that arrives afterwards is no longer shown or spoken.
- **Long agent tasks no longer fail partway.** Trimming a long run could separate tool results from the step that asked for them, which Groq rejects. When one step reads several pages, all of them now reach the model whole.
- **On-device AI keeps your question.** With a phone's offline model, a long prompt kept its start and lost your latest message (or the reverse lost the safety rules). Both are now kept, within the model's 2,048-token window.
- **Copy buttons work everywhere.** Where the browser denies clipboard access (Android web views, plain-http pages), the copy buttons threw an error and copied nothing. They now fall back, and show "Copied" only when it worked.
- **The chat header no longer sticks on "checking".** It used to, after the first 30 seconds of a working connection.
- **Replies that contain JSON are shown.** An answer such as `Use this config: {"port": 3000}` used to be replaced with "invalid response".
- **Faster spoken replies.** Each reply no longer waits for the operator-only server voice to refuse before the device voice starts.
- **HANNAH stopped partway through speaking, and answered her own words in a loop.**
  - **Cutting off:** interrupting by talking (barge-in) calibrated on a moment of room noise and then treated anything louder as you, including her own voice from the speakers, which echo cancellation doesn't remove. It now learns her level at the microphone once she starts and stops only for sound well above it.
  - **Long replies:** Chrome stops long speech partway and never says so, Android refuses more than 4,000 characters, and the server voices cut long text. Every voice now reads the reply sentence by sentence to the end, without Markdown, code or links, and a stalled piece can't leave her stuck "speaking".
  - **The loop:** the microphone reopened 0.35 seconds after she finished, while speakers (Bluetooth especially) were still playing her last words. A short fragment like "you today" got past the echo check and was sent as your message. Listening now waits 0.9 seconds, and her last words heard within 4 seconds of her stopping count as echo, however short. Garbled recognitions of her reply are caught too.
  - **Stop:** it now also stops the server voice.
- **Memory export no longer claims encryption.** The profile export added a base64 copy of the data labelled as encrypted. Base64 isn't encryption, so the field is gone, and the export is plainly a readable file. Sync still encrypts on its own.
- **Reminders on Android could stop reaching the phone.**
  - **Cause:** Android 12 and later must allow "exact alarms", and Android 14 doesn't by default. Without that permission, every time HANNAH handed reminders to the phone, the notifications plugin opened the "Alarms & reminders" settings screen and waited. HANNAH queues each hand-over behind the last, so one unanswered screen held up every reminder after it.
  - **Fix:** HANNAH checks the permission first and schedules an inexact reminder when it's missing. It's still delivered, perhaps a few minutes late. Each hand-over now has a time limit.
  - **Visible state:** the Reminders card in the phone apps shows the phone's real state, with buttons to allow notifications and exact alarms. It used to show the browser's notification state, which doesn't exist in the apps, and wrongly said alerts only arrive while HANNAH is open.
- **Finished workflow runs no longer keep unmasked step data.** Each run's checkpoint, used to resume and to retry from a failed step, held every step's full data for the 30 days runs are kept. That included values a service echoed back, such as a token. The masked step records were the only part the privacy policy described. A completed run now keeps only its steps' statuses and masked logs. Failed and stopped runs keep their checkpoint so they can be retried, and the privacy policy now says so. Found by a new real-network proof of webhooks, schedules, events and credentials in serverless mode (`server/scripts/triggers-proof.mjs`).
- **Supabase connections no longer fail TLS verification.** Supabase's certificates come from its own certificate authority, so verified connections failed with "self-signed certificate in certificate chain", and the advice was to turn verification off. HANNAH now has Supabase's root built in and verifies against it, whatever `sslmode` the URL asks for.
- **Long workflow runs on Vercel finish instead of being cut off.**
  - **Before:** on serverless hosting a run executed inside one request until it ended. A run longer than the function's time limit was stopped mid-step and treated as a crash, and after four stops it was given up. Meanwhile the Run button waited for the whole run.
  - **Now:** a run hands itself back between steps when the request's time budget is used up, and the next tick, or the open run page, continues it from there. Finished steps never run again, and handing back isn't counted as a crash. The workflow's time limit counts the time it actually ran.
  - **Settings:** `WORKFLOW_REQUEST_BUDGET_MS` and `WORKFLOW_TICK_BUDGET_MS` set the budgets.
  - **Scheduler:** the repository's scheduled tick (`workflow-tick.yml`) now has a timeout and never overlaps itself.
- **Links use the repository's current name, HANNAH.** The website, the app, downloads and the desktop updater's feed no longer depend on GitHub redirecting the old name.
- **Workflows: pause, resume, and recovery you can trust.**
  - **Pause:** runs can be paused (before their next step) and resumed from that step. Finished steps never run again.
  - **Recovery:** a run was dead-lettered the first time its server stopped if it had already waited or been approved a few times, with a wrong "the worker stopped N times" message. Only real restarts count now. The run page says when a run continued after a restart.
  - **Loops:** a workflow whose HTTP step calls its own webhook (or two calling each other's) now stops after 5 hops instead of running until the daily limit.
  - **Run page:** it names the step running or retrying (attempt, time, last error), keeps updating while a run waits, and the canvas highlights the running step.
  - **Proof:** checked against real services (GitHub's API, real 404s and 503s) and by killing the server mid-run (`server/scripts/workflow-proof.mjs`).

- **Workflows no longer fail when the AI provider is busy.**
  - **Before:** with a free Groq key, 4 of 6 workflows started together failed at their first AI step with "Provider returned HTTP 429."
  - **Waiting:** a rate-limited AI step now waits for the provider and keeps trying for up to 30 minutes. Long waits pause the run, and the run page says why; nothing is lost if the server restarts.
  - **Other keys:** with the Auto model, HANNAH first tries your other saved provider keys.
  - **Clear errors:** a rejected key or an over-size request says what to change.
  - **Drafting:** describing a workflow while the provider is busy waits briefly, then says how long to wait.
- **"Completed" runs that did nothing now say why.** When a step finds nothing (no reminders today, no new mail), the steps after it are skipped; the run page now names that step. The Aggregate step has a new option, **When nothing arrives: Continue with an empty list**, for workflows that should still tell you there's nothing. The morning mail template uses it.
- **No `#features` or `#download` in the address bar.** Links from the About page to sections of the home page, and the About page's own section links, scroll without leaving a hash in the address bar.
- **Workflow runs show how many tokens an AI step used.** Token counts were hidden as if they were secrets; real tokens and passwords still are.
- **The Windows desktop build passes its dependency audit again.** The audit gate compared Windows paths (`client\electron`) with the recorded exceptions (`client/electron`), so every Windows build since 2026-11-17 failed.

- **In voice conversations HANNAH could answer herself in a loop.** On Android and iOS the device voice reported "done" as soon as a reply was queued, not when it had been said, so the microphone reopened while HANNAH was still talking, heard her reply and sent it back as your next message. HANNAH now waits until the phone reports the reply was spoken (or stops on its own, or you interrupt), and on every platform a sentence that is mostly her own reply from the last few seconds is ignored and the microphone keeps listening. Short answers like "yes" always get through.
- **Automations failed at their first AI step.** The server rejected agent turns with no tools ("The agent tool schemas are invalid."), which is exactly what automation steps, the daily briefing and tool-less specialists send, so every cloud automation failed. Fixed, with a regression test.
- **CI failed its dependency audit.** New advisories hit build tooling: minimatch (fixed by an override) and picomatch (no fixed release exists). Audits now go through `scripts/audit-gate.mjs`: high and critical findings still fail unless recorded in `.audit-exceptions.json` with a reason, an exposure analysis and an expiry date; production dependencies are audited separately at moderate level with no exceptions.

- **The crash screen says what happened.** "A moment of stillness" now shows the error in one line (keys and paths removed) and offers **Copy details**, **Export diagnostics** and **Disconnect and reload** beside Reload, so a crash right after connecting can be reported and escaped without clearing the app.
- **Desktop app: the boot script was blocked.** The script that marks the apps and applies your text size before the first paint was inline, which the desktop app's content security policy refuses; it's now a file, so the desktop splash and text size work there too.
- **Link preview matches the app.** The social card behind WhatsApp, Slack and Twitter previews is now the app's own light bento look (`client/scripts/social-card.html`, rendered by `scripts/render-social-card.mjs`), not the dark card.
- **The Android and iOS apps are identified as `com.hannah.companion`.** They still used the old `com.shanaya.companion`, unlike the app config, the desktop app and the store forms, so a signed iOS build would have fetched a provisioning profile for an ID the app didn't have. A store ID can't change after the first upload, so this is fixed before any store release. A 1.4.0 Android build installed from GitHub stays as a separate app: uninstall it after installing 1.5.0.

## 1.4.0 — 2026-11-17

### New

- **Automations that run.** Saved routines now run daily, on weekdays or every few hours while HANNAH is open in a tab or the desktop app; a run that was due while HANNAH was closed happens once when it reopens. Each step passes its result to the next. Actions (save to memory, create a reminder) pause until you approve or deny them, and every run is kept in a run history with its steps and result. You can run any automation on demand, edit it, and turn its schedule on or off.
- **Files and terminal on desktop.** Share folders in Settings → Desktop access, and HANNAH and the Coding agent can read them, change files in read-write folders, and run commands such as your tests. The desktop app enforces the limits in its main process, outside the AI model: paths can't leave a shared folder (symlinks included), and every write and every command waits for your yes in a system dialog. Commands run without a shell, with a time limit.
- **Tasks across devices.** Signed in on more than one device, you can follow agent team tasks and automations from any of them (Dashboard → Across your devices) and approve or deny the next step from whichever device is in your hand. Every approval chat or an automation asks for is mirrored to your other devices; the first answer wins, decided once on the server, and requests expire. A new `approval.requested` webhook lets you forward requests to a phone push service.
- **Agent team tasks you can continue on another device.** Signed in, a Team run saves a checkpoint to your account after every step: the plan, each step's result and its status (running, paused, failed, completed or cancelled). One device works on a run at a time. Pause it on your laptop, or close the laptop, and resume it from your phone: the phone carries on from the last checkpoint and finished steps don't run again. The Agents screen shows which device is working on each run and can cancel it there; that device stops before its next step. Checkpoints made offline go out when the device reconnects, and a retried save is applied once. Runs are part of the account export, and you only ever see your own.
- **Memory you can see and steer.** Each memory now has a category (preferences, about you, people, work and projects, routines, other), a record of where it came from (added by you, "Remember this" in chat, saved by HANNAH or an automation after your approval, an insight, an import), when it was last used, and a sensitivity flag. Chat no longer sends your 12 newest memories with every message. It sends the ones that relate to what you're asking (ranked by matching words, rarer words counting more, in any language), plus a few preferences. Memories about health, money, beliefs or contact details are marked sensitive and go only to Ollama or to Auto in Private routing. Passwords, PINs, API keys, tokens, card and ID numbers are refused, wherever a save comes from. Saving something that says nearly the same as an existing memory updates it instead of adding a duplicate. The Memory screen adds search, category filters, editing, an export, a switch for each kind of memory, and an off switch for memory as a whole.
- **Desktop: update channels, tray, shortcut and links.** Settings → Desktop app shows the version, lets you choose the **Stable** or **Beta** update channel (beta installs GitHub pre-releases such as `v1.5.0-beta.1`), checks for updates on demand and lists the versions this installation has run. HANNAH sits in the system tray or macOS menu bar (open, talk, check for updates, quit), **Ctrl/⌘+Shift+H** brings her to the front on Chat from anywhere, and `hannah://chat`, `hannah://settings` and the other screens open the installed app. When an update has downloaded, the toast says which version and links to its notes.
- **Text size.** Settings → Appearance scales the whole interface (default, large, larger), applied before the first paint so nothing jumps.
- **Backup and restore.** Settings → Backup and restore makes one file with your conversation, memories, reminders, automations, agent settings, skills, personalization, preferences, and which providers and models you chose. It never holds keys, your access token, sign-in or device identity, so moving to a new device means restoring the file and signing in again there. A passphrase encrypts the file (AES-256-GCM, PBKDF2); every file carries a checksum, so one that was changed is refused, and a file from a newer HANNAH is refused with a clear message instead of a half restore. Restore merges by default (adds what's missing, keeps the newer copy of anything both sides have) or replaces a section. The old one-way "Export my data" is replaced by this.
- **Diagnostics.** Settings → Diagnostics keeps what went wrong on this device: crashes, uncaught errors, a start that didn't finish, interface freezes, failed or slow server connections, agent, automation and sync failures (the last 300). Keys, tokens, URL query strings and file paths are removed before anything is recorded, repeats fold into one entry, and the list is searchable by words and level. "Export diagnostics" downloads a report with these entries, the app version, platform and memory use; never your conversation, memories, keys or account. The feedback form can attach that report, only when you tick the box; the server keeps only its allow-listed shape.
- **Automations that follow you across devices.** Signed in, your automations and their schedules sync to your account, so a routine due while the laptop is closed runs on the phone if HANNAH is open there, and a routine saved on one device appears on the others. Each scheduled slot runs once: when two devices are open at the same time, the first to claim it runs it and the other skips it. Every run is saved to your account step by step, so you can approve an action from any device (while the device that started the run is awake, your answer is sent there; once it has gone quiet, the run continues on the device you answer from), continue a run that was cut off when its device closed, or cancel a run from another device (it stops before its next step). Signed out, or offline, automations run on this device only, as before.
- **Agent team steps show when they're waiting for you.** While a step waits for your approval (including the desktop app's file and command dialogs), the run shows "Waiting for you", here and on your other signed-in devices, and its saved status is `waiting-approval`.
- **Calendar and email.** Connect Google (Calendar, Gmail) or Microsoft (Outlook) with the provider's own sign-in (OAuth with PKCE; tokens encrypted in your account). HANNAH lists events, searches and reads mail when you ask, and adds events, saves drafts or sends mail only after you approve exactly what will happen. Needs the operator's Google and Microsoft sign-in apps: see `docs/CALENDAR_AND_EMAIL.md`.
- **“Hey HANNAH” wake word.** Turn it on in Settings → Voice to start talking hands-free in the desktop app, on Android or in a desktop browser. Detection runs on the device (Vosk in WebAssembly, listening only for its name); the ~41 MB model downloads once from the website.

### Improved

- **Apps open like apps.** The desktop, Android and iOS apps show a HANNAH splash screen (Android 12+ system splash, iOS launch screen, desktop splash window, then the same splash while the app starts) and open on their own welcome-and-connect screen instead of the website's landing page. Once connected they open straight on chat, and they remember your key in the app's private storage until you disconnect, instead of asking again on every launch.
- **Search and sharing.** The home, Integrations and Marketplace pages are rendered to HTML at build time, so search engines and link previews get the real headings and text; Integrations and Marketplace are now indexed too. Every public page has its own title, description and canonical address on hannah.eliteforums.in, a PNG social card (SVG cards don't show on most social sites), schema.org data (app, organization, FAQ matching the visible FAQ, breadcrumbs), a sitemap, robots.txt and an `llms.txt` summary for AI search tools. Footer and menu links to Marketplace and Integrations are real links. Four new FAQ answers (what HANNAH is, which models it works with, hands-free use, its license). PNG app icons for iOS and Android home screens.
- **App tour on the website.** The screenshots section is now a tour of five real screens (Chat, Models, Automations, Agents, Integrations) in a browser frame with the screen's address and what it does.

### Fixed

- A Team run cancelled from another device was listed as still running under Across your devices.
- **Accessibility.** Fixed what an automated audit (axe, WCAG 2.1 AA) found on every screen: the phone tab bar's links and the landing header had accessible names that didn't include their visible text; template cards hid their summary from assistive technology; the voice buttons were named differently from their labels; several small labels (the "New in" pill, the active tab, the voice and call buttons) fell short of the contrast ratio; the dashboard's activity bars were marked as an image while holding buttons; and two wide tables couldn't be scrolled from the keyboard. The audit now runs in CI on eight screens at desktop and phone widths and fails the build on serious or critical findings.
- **The desktop, Android and iOS apps couldn't connect.** The server only accepted browser requests from the origins in `CLIENT_ORIGIN`, which in production listed just the website, so every request from the apps was blocked and entering a key failed. The apps' own origins are now always allowed.
- **The app could fall to its crash screen after connecting.** Leaving the landing page unmounted the 3D avatar while its loading overlay was still inside the scene, React failed to remove it, and the app showed "A moment of stillness". The avatar's loading and error overlays are now ordinary page elements.
- The on-device model library tried to reach its native plugin on every start, which failed (uncaught) on the web and desktop. It now loads only on Android and iOS when it's used.
- **Download buttons pointed at the old domain** (shanaya.eliteforums.in), as did every other request from the website, because the website build carried an old `VITE_API_BASE_URL`. On Vercel the website now always calls its own domain, download buttons are links on the same site, and the desktop and mobile apps use https://hannah.eliteforums.in unless a build sets another server. The server also accepts the desktop app's origin by default.
- The desktop app's launch check in CI gave up after 60 seconds, but CI's macOS machines take about two minutes to start an unsigned app. It now waits up to four minutes there (the app itself starts in seconds).
- Links that open a new window in the desktop app now open in the system browser.
- **Automations' "Ask HANNAH" steps failed for most people.** They called the server without the provider, model and API key chosen in chat, so they only worked when the server had its own key. They now use the same AI as chat (cloud provider and model, your key, or Ollama), with no tools. On-device chat models show a clear message instead, because they only run while you chat.
- Saved automations could disappear: the task list kept only the newest 100 entries, and HANNAH's background memory tasks pushed older automations out. Automations are now always kept.
- An automation's "Show a notification" result was invisible unless browser notifications were allowed. Results and approval requests now also appear as a card in the app, with a link to Automations.
- A new scheduled automation was saved switched off, so it never ran until you found "Run on schedule". It now starts on its schedule when you first save it.
- Saving now refuses steps that aren't connected to the trigger, and says which ones; they'd never run. Runs cut off by a reload no longer stay "Running" forever, and with HANNAH open in two tabs a scheduled automation runs once, not twice.
- **Automations editor rebuilt.** The drag-and-connect canvas made it easy to build automations that silently didn't work: a new step landed unconnected (and unconnected steps never run), and connecting steps by dragging small handles was close to impossible on a phone. Automations are now edited as a list: when it runs (with day buttons for any days of the week), then the steps in order, with add, move up, move down and remove. Saving says exactly what's missing. Your automations, approvals and run history come first on the page, there are four ready-made templates, deleting asks first, and leaving with unsaved changes asks too. Older automations open with their steps in run order, and the editor says if any were never connected. The page no longer repeats results in a floating card while you're on it, and the canvas library is gone from the app.
- **Desktop apps crashed on launch in 1.3.0** (macOS, Windows and Linux). The main process imported the auto-updater in a way that is undefined at runtime. Fixed, and CI now starts each packaged desktop app and fails the build if it doesn't load.
- Settings (and the sign-in check on the landing page) could crash when the server answered the account check with something other than HANNAH's JSON, for example a web page.
- The website said the downloadable desktop app can use your screen, mouse and keyboard (computer use). That still needs a desktop app you build yourself, so it's now listed on the roadmap instead.
- Download buttons showed the app's "Page not found" screen for visitors who had opened the site before: the offline service worker answered `/download/…` with the cached app page instead of letting the request reach the server. Server paths (`/download`, `/api`, `/v1`, `/mcp`, `/.well-known`) now always go to the network.
- Download buttons on the website led to a GitHub 404 whenever the newest published release didn't have a file with that exact name. They now go to `/download/<platform>` on HANNAH's own site, which starts the download from the newest release that has the package (including older file names) and shows a clear "not available yet" page instead of a 404.

## 1.3.0 — 2026-11-16

The first published release since 1.0.2. The tags `v1.0.3`, `v1.1.0` and `v1.2.0` were created but never published: their release step stopped because signing credentials weren't configured. This release includes all of that work.

### New

- **Your personal AI, any model.** 20 providers on one gateway (Groq, OpenAI, Anthropic, Gemini, OpenRouter, Together, Cerebras, DeepSeek, Mistral, xAI, Fireworks, NVIDIA NIM and more), plus self-hosted Ollama, LM Studio, llama.cpp and vLLM, with live model discovery, streaming and normalized errors.
- **Smart routing.** The Auto model picks a provider and model per message in Balanced, Best quality, Budget, Fastest, Private or Custom mode. A preview shows the choice, the reason and alternatives before you send, and requests fall back to the next allowed provider if one fails. Private mode is enforced on the server.
- **Agent team.** Team mode plans a task, runs Research, Coding, Memory and Tasks specialists in parallel, verifies the result, and can resume after a restart. The Agents screen shows every run.
- **Accounts on your own database.** Sign in with email and password on a server connected to Postgres (Supabase, Neon and others) or SQLite. Provider keys are stored encrypted, data syncs across devices, and you can export or delete everything.
- **Voice.** Device or OpenAI voices, device or Whisper speech recognition, and interrupting HANNAH by talking.
- **Expressive avatar.** The 3D model smiles, blinks, follows your pointer, gestures with each emotion, and moves its mouth while talking.
- **WebLLM that actually loads.** In-browser AI now shows real download progress, explains failures, offers a retry, and keeps the model loaded between screens.
- **Developer platform.** OpenAI-compatible `/v1` API with routing modes, per-account developer keys, MCP server and client, A2A messaging, signed webhooks and a JavaScript SDK.
- **Models screen.** Recommendations for your task, budget and hardware. "Use in chat" now opens the chat with that model, including local Ollama models.
- **Reminders** by chat or Dashboard, with system notifications in the Android and iOS apps.
- **Skills marketplace** with integrity checks and publisher signatures.

### Improved

- **Real page addresses.** Screens live at `/chat`, `/models`, `/agents`, `/memory`, `/settings` and so on, instead of `#/models`. Refresh, direct links, and the browser and Android back buttons work, old `#/…` links redirect, and unknown addresses show a "Page not found" screen.
- **Platform conventions.** Phones get a bottom tab bar. Android draws edge-to-edge with readable status-bar icons and resizes for the keyboard. The desktop app has a full menu bar (Edit, View, Go with ⌘/Ctrl+1…6, Settings ⌘/Ctrl+, and Check for Updates), a minimum window size, and an About panel. Windows reminders now show as system notifications.
- **Windows installer.** Windows now ships an installer with a Start-menu entry and an uninstaller, replacing the portable executable. That's also what makes desktop auto-update possible.
- **Integrations guide.** The Integrations page now documents every way in (REST API, OpenAI-compatible `/v1`, MCP server and client, A2A, webhooks, your own database) with the credential each one needs, copyable examples, config file locations for Claude Desktop, Cursor and VS Code, server settings, rate limits, error codes and troubleshooting.
- **New landing page** that describes what HANNAH does today, separates the roadmap from shipped features, and lists downloads with install notes.
- **One version everywhere.** The web app, desktop, Android and iOS builds all identify as 1.3.0, and CI fails if any of them disagree or if a tag doesn't match.

### Fixed

- **Desktop:** the avatar didn't render and the interface fonts didn't load, because the desktop app's security policy blocked WebAssembly, `blob:` workers and Google Fonts. The policy now allows exactly those. This also lets WebLLM run on desktop.
- **macOS:** voice input couldn't get microphone access, because the app lacked the microphone entitlement and usage description.
- Desktop auto-update and several website links pointed at a repository that doesn't exist.
- iOS permission prompts and the home-screen name still said "Shanaya".
- The iOS web-app status bar used white text on HANNAH's light background.
- Cost estimates now appear only for prices with a verification date (none yet), instead of from unverified list prices.
- The chat layout scrolled sideways on narrow phones.
- On the Integrations page, the remote MCP configuration was nearly invisible (white text on a white card), and the local MCP example left out the `HANNAH_API_TOKEN` it needs to chat.
- The WebLLM engine was bundled twice (about 2 MB extra gzipped), which put the app over its size budget and failed the web and desktop builds. It now loads only in its worker.
- The release workflow no longer requires signing secrets that aren't configured. It publishes what it can build and labels each package's signing status.

### Known limitations

- macOS builds are not notarized and Windows builds are not code-signed yet. The release notes explain how to open them.
- The Android APK is a debug-signed test build (no Play Store listing). The iOS app isn't distributed; it needs an Apple Developer signing identity.
- Not built yet: wake word, calendar and email connectors, running saved automations, desktop file and terminal tools.

## 1.0.2 — 2026-11-11

- Native app projects for Android and iOS, and release publishing fixes.

## 1.0.1 — 2026-11-11

- MCP integration with server endpoints and tools.
