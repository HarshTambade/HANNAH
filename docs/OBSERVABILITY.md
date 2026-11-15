# Observability and launch operations

Phase 7 adds opt-in error tracking, metadata-only LLM traces, an audit-log
monitor, local-agent health checks, in-app feedback, and first-run onboarding.
Everything is disabled or local-only until an operator configures it.

The privacy rule is simple: **telemetry may describe an operation, never a
conversation.** No prompt, completion, tool argument, API key, Authorization
header, or local file path is sent to a third party.

## What runs where

| Surface | Entry point | Output |
| --- | --- | --- |
| Browser errors | `client/src/services/telemetry.ts` | Sentry, when `VITE_SENTRY_DSN` is set |
| Express errors | `server/observability/sentry.js` | Sentry, when `SENTRY_DSN` is set |
| FastAPI errors | `backend/sentry_setup.py` | Sentry, when `SENTRY_DSN` is set |
| Node LLM calls | `server/observability/llm-tracing.js` | `logs/llm_traces.jsonl`, optional Langfuse |
| Python LLM calls | `backend/llm_telemetry.py` | Same JSONL schema, optional Langfuse |
| HITL audit trail | `scripts/audit_monitor.py` | Verified daily summary |
| Agent readiness | `GET /api/health/agent` | Python fallback + Ollama probes |
| User feedback | `POST /api/feedback` | Discord webhook and/or MongoDB |
| First-run setup | `client/src/components/Onboarding.tsx` | Three-step setup, then chat |

## Sentry

Sentry is a no-op without a DSN. `sendDefaultPii` is always off, Session Replay
is never enabled, and each SDK installs a scrubber before events leave the
process.

- Browser: `VITE_SENTRY_DSN`, `VITE_SENTRY_ENVIRONMENT`,
  `VITE_SENTRY_RELEASE`, `VITE_SENTRY_TRACES_SAMPLE_RATE` (default `0.05`).
- Express: `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`,
  `SENTRY_TRACES_SAMPLE_RATE` (default `0.1`), `SENTRY_ENABLED=false` to force
  it off.
- FastAPI: same server variables as Express.

The browser bundle wraps `App` in a Sentry error boundary with a themed reload
screen. A DSN-less build still gets the boundary; it just does not upload.

### What the scrubbers remove

`client/src/services/telemetry.ts`, `server/observability/privacy.js`, and
`backend/privacy_scrub.py` apply the same policy:

- identity: `user`, email, IP address, server name;
- request payloads: body, cookies, query strings, environment;
- headers: everything except `Accept`, `Accept-Language`, `Content-Type`, and
  `Content-Length` (and those are still credential-scanned);
- key-shaped values: `gsk_…`, `sk-…`, `AIza…`, GitHub, Slack, JWT, and
  `Bearer …` tokens;
- local paths: `/Users/…`, `/home/…`, `/private/var/…`, `C:\…`, UNC paths;
- chat fields by key name, including dotted Sentry span keys: `prompt`,
  `messages`, `completion`, `reply`, `content`, `transcript`, `conversation`,
  `chat`, `input`, `body`, `query`, `statement`, `text`, and similar;
- stack-frame local variables (`vars`) and source context (`context_line`,
  `pre_context`, `post_context`), so a captured exception cannot carry prompt
  text or file contents;
- console and `ui.input` breadcrumbs: data dropped and message replaced with
  `[redacted]`.

Stack frames are kept for debugging, but local directories are removed: an
`/Users/name/project/server/index.js` frame becomes `<file-path>/index.js`, and
bundled URLs lose query strings and fragments. Application basenames remain so
a trace is still actionable.

## LLM traces

Both runtimes write newline-delimited JSON to `logs/llm_traces.jsonl`
(override with `LLM_TRACE_LOG`, disable with `LLM_TRACING_DISABLED=true`).
Each line records only:

- trace id, timestamp, source (`node` or `python`), provider id/label;
- requested model and the model that answered;
- status, attempt failures (`errorType`, HTTP status, duration);
- fallback events (`fromModel`, `toModel`, `reason`, `httpStatus`);
- latency (`timeToFirstByteMs`, `timeToFirstTokenMs`, `totalMs`);
- token usage (`promptTokens`, `completionTokens`, `totalTokens`).

Provider calls are currently non-streaming, so `timeToFirstTokenMs` is `null`
and `timeToFirstByteMs` is exported to Langfuse as `completionStartTime`. The
schema is ready for a streaming path later.

Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` to export the same traces
through Langfuse's ingestion API. `LANGFUSE_BASEURL` defaults to
`https://cloud.langfuse.com`. Export failures are logged as a status only and
never block a chat response.

Example line (values abbreviated):

```json
{"type":"llm_trace","version":1,"id":"…","timestamp":"2026-11-15T10:00:00.000Z","source":"node","name":"shanaya.llm.chat","operation":"chat","provider":{"id":"groq","label":"Groq"},"requestedModel":"llama-3.3-70b-versatile","model":"openai/gpt-oss-120b","status":"success","streaming":false,"latency":{"timeToFirstByteMs":250,"timeToFirstTokenMs":null,"totalMs":900,"streaming":false},"usage":{"promptTokens":100,"completionTokens":20,"totalTokens":120},"attempts":[{"model":"llama-3.3-70b-versatile","errorType":"Error","httpStatus":429,"durationMs":120}],"fallbacks":[{"fromModel":"llama-3.3-70b-versatile","toModel":"openai/gpt-oss-120b","reason":"rate_limited","errorType":"Error","httpStatus":429,"durationMs":120}],"error":null}
```

`logs/` is gitignored. Do not ship these files in a release artifact if the
deployment shares a machine with other tenants; they contain provider/model
metadata but no conversation text.

## Audit monitor

`scripts/audit_monitor.py` reads the hash-chained HITL log written by
`backend/audit_logger.py` (default `logs/shanaya_audit.jsonl`).

```bash
python3 scripts/audit_monitor.py                    # today, human-readable
python3 scripts/audit_monitor.py --all              # every day in the log
python3 scripts/audit_monitor.py --date 2026-11-15  # one UTC day
python3 scripts/audit_monitor.py --all --json       # machine-readable
python3 scripts/audit_monitor.py --follow --interval 2
```

It reports records, proposed tool calls, HITL approvals, user rejections,
automatic rejections (invalid arguments, non-allowlisted tools, or missing
approval channels) grouped as cancellations, expirations, executions and
execution errors, the most-used tools, rejection reasons, and per-day chain
failures. A missing log is an empty trail (exit 0), so it is safe from cron on a
fresh install. Exit status is `1` when the hash chain is invalid, which makes it
suitable for alerting.

Run it after deployments and on a daily schedule. A `hash_mismatch`,
`broken_previous_hash`, `missing_hash`, `invalid_sequence`, or `partial_record`
issue means the audit file was edited, truncated, or written incorrectly.

## Agent health

`GET /api/health/agent` is authenticated like other API routes (send
`Authorization: Bearer <SHANAYA_API_TOKEN>`). It probes two operator-managed
targets in parallel:

- `PYTHON_FALLBACK_URL` → `GET /api/health`, ready when the body reports
  `status: "ok"`;
- the Ollama provider base URL (`OLLAMA_BASE_URL`) → `GET /api/tags`, ready
  when the configured `OLLAMA_MODEL` appears in the model list.

`HEALTH_CHECK_TIMEOUT_MS` clamps each probe between 500 ms and 5 s (default
2500 ms). The route returns `200` when at least one target is ready and `503`
when neither is. Each check includes `reachable`, `ready`, `latencyMs`, and a
short error category (`timeout`, `unreachable`, `model_missing`,
`unexpected_response`, `invalid_configuration`). No credentials, prompts, or
model names beyond the configured one are returned.

Use this endpoint for uptime checks that should distinguish "API is up" from
"local agent is actually usable". Do not use `/api/health` for that purpose; it
only describes the primary cloud provider.

## In-app feedback

The chat header has a feedback button. The modal captures only:

- the user's message and category (`bug`, `idea`, `privacy`, `other`);
- app version (`__SHANAYA_APP_VERSION__`, injected from `client/package.json`);
- platform (`iOS`, `Android`, `Web`, `Desktop`);
- coarse inference mode (`Cloud` or `Local`) plus the detailed mode for triage.

It never sends an IP address, account id, User-Agent, device identifier, or chat
transcript. The server validates an allow-listed schema, never reads `req.ip`
or the User-Agent, and never logs the feedback text.

Configure at least one delivery channel in `server/.env`:

```bash
FEEDBACK_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…
MONGODB_URI=mongodb+srv://…
MONGODB_DB=shanaya
MONGODB_FEEDBACK_COLLECTION=feedback
```

If both are set, both are attempted; the request succeeds when at least one
delivers. With neither, `/api/feedback` returns `503`. Discord URLs must be
HTTPS without embedded credentials. Feedback is rate limited per API token by
`SHANAYA_RATE_LIMIT_FEEDBACK_MAX` (default 10 per window).

For MongoDB, create a least-privilege user that can only `insert` into the
feedback collection. The stored document contains `schemaVersion`, `id`,
`receivedAt`, `message`, `appVersion`, `platform`, `inferenceMode`, optional
`modeDetail`, `category`, and `source: "in-app"`.

## First-run onboarding and mode selection

On first launch, `App.tsx` checks `localStorage["shanaya.onboarding.v1"]` and
shows `Onboarding.tsx` before the landing page. The three steps are:

1. **Privacy architecture** — local vs cloud inference, in-memory keys, no
   training on chats, HITL control.
2. **Inference setup** — Groq key and optional server token, or a local path
   (native GGUF download, browser WebLLM, or Ollama).
3. **HITL explanation** — proposals, approve/reject, expiry, audit trail.

Completing setup starts the companion directly with the chosen
`initialMode`; skipping marks onboarding as seen and returns to the landing
page. Either way the flag is written, so setup does not nag on every visit.
Clearing site storage re-enables onboarding. Credentials remain in page memory
only; they are never written to `localStorage`.

## Launch checklist

1. Generate `SHANAYA_API_TOKEN` with `openssl rand -hex 32`; set it in
   `server/.env` and share it with users out of band.
2. Set `SENTRY_DSN` and `VITE_SENTRY_DSN` for separate API and browser
   projects. Use distinct environments/releases per deployment.
3. Decide whether LLM traces stay local. If Langfuse is enabled, confirm the
   project's data region and retention policy.
4. Configure a feedback channel and send one test note from each platform you
   ship.
5. Point uptime monitoring at `/api/health` (process up) and
   `/api/health/agent` (local agent usable), authenticated as needed.
6. Schedule `scripts/audit_monitor.py --all --json` daily and alert on exit
   code `1` or any `integrity.failures` entry.
7. Run `npm test --prefix client`, `npm test --prefix server`,
   `python -m pytest backend/tests`, and `npm run build --prefix client`.
8. Verify `logs/llm_traces.jsonl` and Sentry events contain no prompt text,
   keys, Authorization values, or `/Users/…` paths before announcing launch.
