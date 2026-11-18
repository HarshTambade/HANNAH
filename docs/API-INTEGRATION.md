# HANNAH API Integration Guide

This guide explains how to run, configure, and integrate with the HANNAH Express API. The API is the server-side boundary for cloud inference, Ollama, agent tool calls, text-to-speech proxying, desktop computer use, Pinecall token exchange, and optional MCP access.

## Base URL

Local development:

```text
http://localhost:3001
```

In production, use the HTTPS API origin or the same-origin `/api` path exposed by Vercel. Never expose provider credentials in client-side `VITE_*` variables.

## Start the API

All /api routes except /api/health require Authorization: Bearer <HANNAH_API_TOKEN>. Generate a random value with openssl rand -hex 32, configure it only in the server environment, and give it to trusted app users out of band. The browser app asks for the token each page session and keeps it in memory only. Never put it in a Vite client variable. Use HTTPS for remote clients. The public health route remains available without a token.

Default fixed-window limits are 30 chat, 60 agent, and 20 desktop-computer requests per token per 60 seconds. Configure them with HANNAH_RATE_LIMIT_CHAT_MAX, HANNAH_RATE_LIMIT_AGENT_MAX, HANNAH_RATE_LIMIT_DESKTOP_MAX, and HANNAH_RATE_LIMIT_WINDOW_MS. Counters are process-local; use a shared or upstream limiter across multiple instances.

```bash
npm install --prefix server
cp server/.env.example server/.env
npm run dev:server
```

Health check:

```bash
curl http://localhost:3001/api/health
```

## Configuration

Minimum cloud configuration:

```dotenv
PORT=3001
HOST=127.0.0.1
CLIENT_ORIGIN=http://localhost:5173
HANNAH_API_TOKEN=replace_with_a_random_value_of_at_least_32_characters
GROQ_API_KEY=replace_with_your_groq_api_key
GROQ_MODEL=openai/gpt-oss-120b
GROQ_MODEL_FALLBACKS=openai/gpt-oss-20b,llama-3.1-8b-instant
HANNAH_DEFAULT_PROVIDER=groq
```

Important variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | HTTP port; defaults to `3001`. |
| `HOST` | No | Bind address; defaults to `127.0.0.1`. |
| `CLIENT_ORIGIN` | No | Comma-separated browser origins allowed by CORS. |
| `GROQ_API_KEY` | No | Server-side Groq credential. |
| `GROQ_MODEL` | No | Primary cloud model. |
| `GROQ_MODEL_FALLBACKS` | No | Comma-separated fallback models. |
| `HANNAH_DEFAULT_PROVIDER` | No | Provider ID used by default; defaults to `groq`. |
| `<PROVIDER>_API_KEY` | For a hosted provider | Server-side key, such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`. |
| `<PROVIDER>_MODEL` / `<PROVIDER>_MODELS` | No | Preferred model and optional comma-separated fallbacks. |
| `<PROVIDER>_BASE_URL` | No | Optional OpenAI-compatible endpoint override for a configured provider. |
| `CUSTOM_BASE_URL` / `CUSTOM_API_KEY` | For a custom gateway | OpenAI-compatible gateway URL; the key is optional when the endpoint does not require authentication. Remote URLs must use HTTPS. |
| `CLOUD_API_URL` / `CLOUD_API_KEY` | Legacy | Preserved aliases for the custom gateway; the custom gateway becomes default when these are used. |
| `OLLAMA_BASE_URL` | No | Ollama server URL; defaults to `http://localhost:11434`. |
| `OLLAMA_MODEL` | No | Ollama model used by `mode: "ollama"`. |
| `CLOUD_REQUEST_TIMEOUT_MS` | No | Cloud request timeout, clamped to 3–120 seconds. |
| `MITHI_TTS_URL` | No | Optional Mithi `/synthesize` service URL. |
| `PINECALL_TOKEN_URL` | No | Trusted server-side Pinecall token issuer. |
| `ANTHROPIC_API_KEY` | No | Enables Anthropic chat, Python provider fallback, and Electron desktop computer use. |
| `ANTHROPIC_DESKTOP_MODEL` | No | Model for the Electron computer-toolset route; falls back to `ANTHROPIC_MODEL`. |
| `MCP_ENABLED` | No | Enables the authenticated `/mcp` endpoint when `true`. |
| `MCP_API_TOKEN` | No | Bearer token of at least 32 characters for remote MCP. |

The Python agent fallback also tries Groq first, then configured Anthropic and OpenAI-compatible providers, followed by local inference. It accepts provider-specific `*_API_KEY`, `*_BASE_URL`, `*_MODEL`, and `*_MODELS` variables, plus `CUSTOM_BASE_URL` and a custom model ID for a gateway.

## Common response conventions

JSON endpoints return an object with an `error` field for failures:

```json
{
  "error": "A human-readable explanation"
}
```

Callers should handle:

- `400`: invalid request body, unsupported mode, or invalid credential format.
- `401`/`403`: rejected provider credential or missing MCP authorization.
- `502`: upstream provider, TTS, Pinecall, or MCP failure.
- `503`: a required integration is not configured.

## Endpoints

### `GET /api/health`

Returns API and provider readiness without returning credentials:

```json
{
  "status": "ok",
  "provider": "Groq",
  "ready": true
}
```

Use this for deployment checks and client status indicators. `ready: false` means the server is reachable but cloud credentials or models are not configured.

### `GET /api/providers`

Lists provider IDs, display names, protocols, and credential availability. It does not return API keys or provider base URLs. Groq is listed for visitors who enter a session key.

### `GET /api/models`

Lists models for a selected provider. The server discovers models from the provider when supported and falls back to configured or catalog model IDs:

```text
GET /api/models?provider=groq
```

```json
{
  "provider": "Groq",
  "providerId": "groq",
  "defaultModel": "openai/gpt-oss-120b",
  "models": ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]
}
```

### `POST /api/chat`

The simple conversation endpoint. `messages` must contain 1–40 user or assistant messages, each with non-empty content of at most 4,000 characters.

```bash
curl -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_HANNAH_API_TOKEN' \
  -d '{
    "mode": "cloud",
    "messages": [
      {"role": "user", "content": "Give me a short welcome."}
    ]
  }'
```

Successful response:

```json
{
  "reply": "Welcome. I am HANNAH, and I am glad you are here.",
  "emotion": "happy"
}
```

Supported modes:

- `cloud`: Groq by default, or any configured provider in the server catalog. OpenAI-compatible APIs, Anthropic Messages, and Ollama use their matching adapters.
- `ollama`: the configured local Ollama server.
- WebLLM and native llama.cpp inference run directly in the client and do not use this endpoint.

For a private installation, a caller may provide a temporary Groq key with `x-groq-api-key`. It is forwarded only to the official Groq HTTPS API. Other provider keys remain on the server. Do not collect or transmit user keys through an untrusted public deployment; prefer a server-side secret manager.

### `POST /api/agent`

Runs one agent step and returns text and/or tool calls. The client executes approved tools and submits the result in a later step.

```json
{
  "mode": "cloud",
  "provider": "groq",
  "model": "openai/gpt-oss-120b",
  "messages": [
    {"role": "user", "content": "What is the weather workflow?"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_status",
        "description": "Read the current application status.",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": false}
      }
    }
  ]
}
```

Response shape:

```json
{
  "message": {
    "content": "I can check that.",
    "tool_calls": []
  }
}
```

Tools are bounded and validated by the client. Sensitive actions must remain confirmation-gated.

### `POST /api/tts`

Proxies validated text to Mithi and returns `audio/wav`. The supported language values are `en-US`, `hi-IN`, and `mr-IN`.

```bash
curl -X POST http://localhost:3001/api/tts \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_HANNAH_API_TOKEN' \
  -d '{"text":"नमस्ते, मैं शनाया हूँ।","language":"hi-IN"}' \
  --output reply.wav
```

If `MITHI_TTS_URL` is not configured, the endpoint returns `503`; the client can fall back to the installed system voice.

### `GET /api/pinecall/token`

Fetches short-lived call credentials from the trusted `PINECALL_TOKEN_URL`. The browser never receives the Pinecall API key. The issuer must return:

```json
{
  "token": "short-lived-token",
  "server": "pinecall-server.example",
  "expires_in": 3600
}
```

### `POST /api/desktop/computer`

Uses the server-side Anthropic computer tool for the Electron desktop bridge. It requires `ANTHROPIC_API_KEY`, accepts validated user/assistant messages, and should only be called by a trusted Electron client with confirmation UI.

### `POST /mcp`

Available only when `MCP_ENABLED=true`. Send:

```http
Authorization: Bearer <MCP_API_TOKEN>
```

The token must be at least 32 characters. The endpoint exposes the `hannah_chat`, `hannah_status`, and `hannah_models` MCP tools. Keep it private and use HTTPS in production.

## Frontend integration

Use same-origin URLs when the client and API share a domain:

```ts
const response = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mode: "cloud",
    messages: [{ role: "user", content: "Hello, HANNAH!" }],
  }),
});

if (!response.ok) {
  const failure = await response.json().catch(() => ({ error: "API request failed." }));
  throw new Error(failure.error || "API request failed.");
}

const result: { reply: string; emotion: string } = await response.json();
```

For a separate frontend origin, set `VITE_API_BASE_URL` and include that exact origin in `CLIENT_ORIGIN`.

## The `hannah` command-line tool

`cli/hannah.mjs` talks to any HANNAH server from a terminal. It has no dependencies (Node 20+). Run it with `node cli/hannah.mjs …`, or install it with `npm install -g ./cli` to get `hannah`.

| Command | What it does |
| --- | --- |
| `hannah login --server https://… --email you@example.com` | Signs in to your account; it asks for the password, or reads it with `--password-stdin`. Uses `POST /api/account/login` with `x-hannah-session: bearer`. |
| `hannah login --groq-key gsk_…` | Uses a Groq key for chat only. It's sent as `x-groq-api-key`, and the server sends it only to Groq. |
| `hannah login --token hk_…` | Uses a developer key or the operator token. |
| `hannah status` | Shows the server's health, who you're signed in as, and the database state. |
| `hannah ask "…"` | Asks one question and streams the answer (`POST /v1/chat/completions`, `model: "auto"`, `stream: true`). |
| `hannah chat` | Starts a conversation in the terminal. `/clear` starts over; `/exit` or Ctrl+D leaves. |
| `hannah workflows` | Lists your workflows with their last run. |
| `hannah run <id> [--published]` | Runs a workflow (the draft, or the published version) and prints each step as it finishes. It exits non-zero if the run fails. |
| `hannah channels` | Lists your chat apps, who's paired, and who's asking to chat. |
| `hannah logout` | Forgets the saved credentials. |

Credentials are saved in `~/.config/hannah/config.json` (or `$HANNAH_CONFIG`), readable only by you (0600). They're never printed. `cd cli && npm test` runs the tool against the real server.

## Build a plugin

A HANNAH plugin is a **remote MCP server**: the same thing HANNAH's connectors are. Anything you can put behind an https URL that speaks the [Model Context Protocol](https://modelcontextprotocol.io) over Streamable HTTP becomes a set of tools HANNAH can use.

- **The person adds it themselves:** Marketplace → Connectors → **Add a custom connector**, with its URL and, optionally, a token. HANNAH sends the token as `Authorization: Bearer …`.
- **Where it runs:** each tool call goes through HANNAH's server (`server/connectors.js`, `POST /api/connectors/rpc`) using `server/mcp-client.js`.
- **Approval:** every call asks the person first.
- **Tokens:** they stay in that person's browser.
- **Address:** it must be public https. Private and internal addresses are refused unless a self-hosted server sets `WORKFLOW_ALLOW_PRIVATE_NETWORK=true`.

**Start from the example:** `examples/hannah-plugin/server.mjs` is a complete plugin with no dependencies, offering two tools, `word_count` and `current_time`.

```sh
cd examples/hannah-plugin
PORT=8787 PLUGIN_TOKEN=$(openssl rand -hex 24) node server.mjs   # http://127.0.0.1:8787/mcp
npm test   # HANNAH's own MCP client lists and calls its tools
```

**What a plugin must do:**
1. **Accept the MCP messages** as JSON-RPC 2.0 over `POST` to one URL: `initialize`, the `notifications/initialized` notification, `tools/list` and `tools/call`.
2. **Sessions (optional):** return an `Mcp-Session-Id` header from `initialize`. Answer **404** for an unknown session, so HANNAH starts a new one.
3. **Describe each tool** with a `name`, a `description` and a JSON Schema `inputSchema` of type `object`. Mark tools that only read with `annotations.readOnlyHint: true`.
4. **Report failures:** a tool that fails because of its input returns `isError: true` with a message, not a protocol error. HANNAH shows the message.
5. **Authenticate:** require a bearer token. Compare it in constant time.
6. **Check `Origin`:** if a request has an `Origin` header you don't expect, refuse it with 403. That stops web pages reaching a plugin on a private network (DNS rebinding), and the MCP specification requires it of HTTP servers.
7. **Serve it over https:** behind any TLS proxy. HANNAH reads at most 50 tools and 8,000 characters of each result.

**Signing in instead of a token:** plugins that need each person's own account can use OAuth, as the vendor connectors do (Linear, Notion…). Publish protected-resource metadata (RFC 9728) and authorization-server metadata (RFC 8414), with dynamic client registration and PKCE. HANNAH's connector sign-in follows the MCP authorization specification, so no HANNAH-side changes are needed.

**For skills (instructions, not code):** marketplace packages in `shared/marketplace-catalog.json` are signed with `server/scripts/sign-skill.js`. A plugin is the way to add new *abilities*; a skill is the way to add new *instructions*.

## Security checklist

- Keep `server/.env` out of Git and rotate any credential that has been pasted into chat, screenshots, commits, logs, or issue comments.
- Never put `GROQ_API_KEY`, `CLOUD_API_KEY`, `ANTHROPIC_API_KEY`, `PINECALL_TOKEN_URL` credentials, or `MCP_API_TOKEN` in `VITE_*`.
- Use HTTPS for production API, MCP, token issuer, and TTS URLs.
- Restrict `CLIENT_ORIGIN` to exact trusted origins.
- Express authentication and per-token limits are implemented. Keep usage quotas and request observability as deployment-level follow-up work.
- Do not log request bodies or conversation content by default.
