# HANNAH Operations Runbook

**Version:** 1.0<br>
**Last updated:** 15 November 2026<br>
**Owner:** HANNAH on-call / platform operator<br>
**Applies to:** the Express API in `server/`, the React/Capacitor client in `client/`, the optional Python fallback in `backend/`, and the optional eBPF monitor in `ebpf/`

This runbook is the operating procedure for launch and steady-state support. It covers provider health, zero-downtime API-key rotation, Sentry triage, audit-log analysis for rejected HITL tool calls, content-report review, and routine maintenance.

> **Before launch:** fill in the on-call names, paging tool, status-page URL, hosting project, secret-manager paths, and legal/security contacts in the tables below. Keep this document in the incident channel and update it after every P0/P1.

## 1. Service map and first response

| Component | Where it runs | Health signal | Owner |
| --- | --- | --- | --- |
| Web client / PWA | Vercel static service or any static host | Browser Sentry, uptime probe on `/` | Client on-call |
| Express API | Vercel service or Node 20+ host | `GET /api/health` | API on-call |
| Local-agent probes | Inside Express | `GET /api/health/agent` | API on-call |
| Python fallback | Loopback or private service | `GET /api/health/agent` → `checks.pythonFallback` | Python on-call |
| Ollama | Operator/user host | `GET /api/health/agent` → `checks.ollama` | Platform on-call |
| Cloud providers | Groq, OpenAI, Anthropic, others | `/api/models?provider=<id>`, LLM traces, provider status pages | API on-call |
| HITL audit log | `logs/hannah_audit.jsonl` | `scripts/audit_monitor.py` exit code | Security on-call |
| Content reports | `logs/content_reports.jsonl` | Weekly review; write failures in API logs | Trust & safety |
| Sentry | Browser, Express, FastAPI | Sentry issue stream and alerts | On-call |
| Billing | Apple/Google/RevenueCat/Stripe | Store dashboards; entitlement checks | Product/finance |

**First response checklist:**

1. Acknowledge the alert and open an incident channel.
2. Check `GET /api/health` and `GET /api/health/agent` with the production token.
3. Check the host’s error rate and the latest deployment/release.
4. Check Sentry for new issues in the current release.
5. Check the provider status page if the failure is provider-specific.
6. Decide: rollback, disable a feature, fail over to local, or mitigate forward.
7. Communicate status to users if the impact is visible.
8. Preserve evidence before deleting logs or rotating credentials.

## 2. Monitoring LLM provider health

HANNAH has three complementary health signals. Do not rely on a single endpoint.

### 2.1 `/api/health` — API process and primary cloud readiness

This endpoint is **unauthenticated** and intentionally minimal:

```bash
curl -fsS https://api.hannah.app/api/health | jq
```

Example:

```json
{
  "status": "ok",
  "provider": "Groq",
  "ready": true
}
```

What it means:

- `status: "ok"` means the Express process is responding.
- `provider` is the configured default cloud provider label.
- `ready: true` means the server has a provider credential (or a local provider) and at least one model configured.

What it does **not** prove:

- That the provider key is valid.
- That the provider is reachable.
- That the configured model still exists.
- That a chat request will succeed.

Use `/api/models` for a live credential/model check.

### 2.2 `/api/health/agent` — Python fallback and Ollama readiness

This endpoint is **authenticated** with the deployment bearer token:

```bash
export HANNAH_API_TOKEN='...'   # from the secret manager, never commit it
curl -fsS \
  -H "Authorization: Bearer $HANNAH_API_TOKEN" \
  https://api.hannah.app/api/health/agent | jq
```

The route returns HTTP `200` when at least one target is ready and `503` when neither is. The body mirrors the status:

```json
{
  "status": "degraded",
  "httpStatus": 200,
  "checkedAt": "2026-11-15T10:00:00.000Z",
  "checks": {
    "pythonFallback": {
      "configured": true,
      "reachable": true,
      "ready": true,
      "statusCode": 200,
      "url": "http://127.0.0.1:8000",
      "latencyMs": 12
    },
    "ollama": {
      "configured": true,
      "reachable": true,
      "ready": false,
      "statusCode": 200,
      "baseUrl": "http://localhost:11434",
      "model": "qwen3:8b",
      "modelPresent": false,
      "error": "model_missing",
      "latencyMs": 8
    }
  }
}
```

Status meanings:

| `status` | HTTP | Meaning | Alert |
| --- | --- | --- | --- |
| `ok` | 200 | Both Python fallback and Ollama are ready | None |
| `degraded` | 200 | Exactly one target is ready | Ticket if it persists >10 minutes |
| `unavailable` | 503 | Neither target is ready | Page API on-call; check local services |

Error categories:

- `timeout` — probe exceeded `HEALTH_CHECK_TIMEOUT_MS` (500–5000 ms, default 2500 ms).
- `unreachable` — connection refused, DNS failure, or network error.
- `model_missing` — Ollama is reachable but `OLLAMA_MODEL` is absent from `/api/tags`.
- `unexpected_response` — reachable but not the expected shape/status.
- `invalid_configuration` — the configured URL is invalid.

**Privacy:** the health response contains no credentials, prompts, or user data. It may expose configured model names and local URLs, so keep the endpoint authenticated and do not publish the response publicly.

### 2.3 `/api/models` — live provider canary

Use this for Groq, OpenAI, Anthropic, and other configured providers. It performs a live provider request and returns the model list.

```bash
for provider in groq openai anthropic; do
  printf '%-10s ' "$provider"
  curl -sS -o /tmp/hannah-models.json -w '%{http_code}\n' \
    -H "Authorization: Bearer $HANNAH_API_TOKEN" \
    "https://api.hannah.app/api/models?provider=$provider"
  jq -r '.error // (.provider + " · " + (.models | length | tostring) + " models")' /tmp/hannah-models.json
done
```

Interpretation:

| Result | Meaning | Action |
| --- | --- | --- |
| `200` with models | Credential and endpoint work | None |
| `401` / `403` | Provider rejected the key | Rotate/validate the key; P1 |
| `429` | Provider rate limit | Check traffic; P2 unless sustained |
| `5xx` | Provider outage or gateway error | Check provider status; P1 if sustained |
| Timeout | Network or provider latency | Check egress, DNS, provider status; P1 |
| `503` “Configure …” | No credential configured | Expected if provider is not enabled |

**Provider status pages:** subscribe to Groq, OpenAI, Anthropic, and hosting status updates. A provider incident is not automatically a HANNAH incident, but it becomes one when the default provider is unavailable and local fallback is not usable.

### 2.4 Synthetic chat canary

Run this every 5–15 minutes from a trusted monitor, or manually during an incident. It sends a harmless prompt and a small token budget. Do not send user data.

```bash
curl -fsS -X POST https://api.hannah.app/api/chat \
  -H "Authorization: Bearer $HANNAH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"cloud","messages":[{"role":"user","content":"Reply with OK."}]}' \
  | jq '{reply: .reply, provider: .provider, model: .model}'
```

If the response is empty, 5xx, or times out, follow the provider playbook. A synthetic canary consumes tokens; keep the cadence modest and exclude it from user-facing rate-limit dashboards.

### 2.5 LLM trace metrics

`logs/llm_traces.jsonl` contains metadata only: provider, model, status, latency, token counts, retries, and fallbacks. It never contains prompt or completion text.

```bash
# Recent failures
jq -r 'select(.status != "success") |
  [.timestamp, .provider.id, .model, .status, (.error // "-")] | @tsv' \
  logs/llm_traces.jsonl | tail -50

# Success, fallback, and error counts
jq -s '{
  total: length,
  success: (map(select(.status == "success")) | length),
  errors: (map(select(.status != "success")) | length),
  withFallback: (map(select((.fallbacks // []) | length > 0)) | length)
}' logs/llm_traces.jsonl

# p95 total latency by provider (requires jq 1.6+)
jq -s 'group_by(.provider.id) | map({
  provider: .[0].provider.id,
  count: length,
  p95ms: (map(.latency.totalMs) | sort | .[(length * 0.95 | floor)])
})' logs/llm_traces.jsonl
```

### 2.6 Monitoring thresholds

| Signal | Warning | Page | Runbook action |
| --- | --- | --- | --- |
| `/api/health` non-200 | 1 failure | 3 consecutive failures | Restart/rollback API; check hosting |
| `/api/health` `ready:false` | 5 minutes | 15 minutes | Validate provider key/models |
| `/api/health/agent` 503 | 1 minute | 5 minutes | Check Python fallback and Ollama |
| `/api/health/agent` degraded | 10 minutes | 30 minutes | Fix the failing local target |
| `/api/models?provider=groq` non-200 | 2 failures | 5 failures or 401/403 | Rotate/validate key; check status page |
| API 5xx rate | >2% for 5 min | >10% for 5 min | Inspect Sentry; rollback if release-correlated |
| Chat p95 latency | >15 s for 10 min | >30 s for 10 min | Check provider latency and fallback rate |
| Fallback rate | >20% for 15 min | >50% for 10 min | Provider issue or key problem |
| New Sentry P0 | Immediate | Immediate | Follow P0 checklist |
| Audit chain failure | Immediate | Immediate | Treat as security incident; preserve evidence |

### 2.7 Uptime monitor configuration

Create two monitors:

1. **API process:** `GET https://api.hannah.app/api/health`, every 60 s, 3 retries, alert on non-200 or `status != "ok"`.
2. **Local agent:** `GET https://api.hannah.app/api/health/agent` with `Authorization: Bearer <token>`, every 60 s, 3 retries, alert on 503 or `status == "unavailable"`. Warn on `degraded` for 10 minutes.

Store the monitor’s bearer token in the monitor’s secret store, not in the URL or a public dashboard. Rotate it with the API token.

## 3. Zero-downtime API-key rotation (Groq, OpenAI)

### 3.1 Why a rolling deployment is required

The Express server reads one key per provider from its environment (`GROQ_API_KEY`, `OPENAI_API_KEY`). It does not hot-reload a second key. Zero-downtime rotation therefore happens at the deployment layer:

- Run at least two API instances/revisions behind a load balancer, or use the hosting platform’s rolling/gradual deployment.
- Put the new key in the new revision while old revisions keep the old key.
- Shift traffic gradually, verify the new revision, then drain the old revision.
- Revoke the old key only after the new key has served production traffic successfully.

With a single process and no load balancer, a restart causes a brief gap. Schedule it in a maintenance window or accept the gap; do not claim zero downtime for a topology that cannot provide it.

### 3.2 Groq rotation procedure

**Preconditions:** access to the Groq console, the hosting secret manager, the deployment dashboard, and the monitoring dashboard. Have a second operator available for production changes.

1. **Create the new key.** In the Groq console, create a key labeled `hannah-prod-YYYY-MM-DD-<operator>`. Do not reuse a key from another environment.
2. **Store it in the secret manager.** Write the new value to the production secret path. Do not paste it into chat, tickets, shell history, CI logs, or a `VITE_*` variable. If you must use a shell, read it from the secret manager into an environment variable and disable history:
   ```bash
   set +o history
   export GROQ_API_KEY="$(secret-tool lookup service hannah key groq-prod-next)"
   ```
3. **Deploy a canary revision.** Set `GROQ_API_KEY` on the new revision only. Keep the old revision on the old key. Do not shift 100% of traffic yet.
4. **Verify the new revision.** Send the canary to the new revision or use a provider-specific probe:
   ```bash
   curl -fsS -H "Authorization: Bearer $HANNAH_API_TOKEN" \
     "https://canary.api.hannah.app/api/models?provider=groq" | jq '.provider, (.models | length)'
   ```
   Then run the synthetic chat canary against the canary host:
   ```bash
   curl -fsS -X POST https://canary.api.hannah.app/api/chat \
     -H "Authorization: Bearer $HANNAH_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"mode":"cloud","messages":[{"role":"user","content":"Reply with OK."}]}' | jq '.reply'
   ```
5. **Watch the canary for 5–10 minutes.** Check 401/403/429/5xx rates, p95 latency, fallback rate, and Sentry. A `401`/`403` means the new key is wrong or lacks access; stop and roll back the revision.
6. **Shift traffic gradually.** Move 10% → 50% → 100% in steps. Keep the old revision warm until the new revision has handled at least one full traffic cycle and the error rate is normal.
7. **Drain and remove the old revision.** Confirm the old key is no longer used in any running instance, cron job, MCP process, local developer shell, or CI secret.
8. **Revoke the old Groq key.** Do this only after the new key is fully serving traffic. Label the revocation date in the console.
9. **Record the rotation.** Update the key inventory with the new key ID (not the secret), creation date, operator, verification time, and revocation time.
10. **Monitor for 24 hours.** Watch for delayed failures from background jobs, MCP clients, or a forgotten service that still uses the old key.

### 3.3 OpenAI rotation procedure

The same procedure applies with `OPENAI_API_KEY` and `provider=openai`:

1. Create a new project-scoped key with the minimum required permissions.
2. Store it in the secret manager.
3. Deploy a canary revision with the new key.
4. Verify `GET /api/models?provider=openai` and a synthetic chat.
5. Shift traffic gradually.
6. Revoke the old key after the new key is stable.
7. Record the rotation.

If OpenAI is configured only as a fallback or is not enabled in production, rotate it in staging first and confirm the provider is not silently used by a cron, MCP process, or desktop agent.

### 3.4 Emergency rotation (suspected leak)

If a key may have leaked — in a screenshot, log, commit, issue, chat, or public build:

1. **Revoke the key first.** Do not wait for a replacement to be deployed. A short provider outage is better than an active leak.
2. **Deploy the replacement** through the canary procedure above.
3. **Search for exposure:** Git history, CI logs, Sentry events, Discord, issue trackers, build artifacts, and `client/dist`. Do not reproduce the key in the incident channel; use the last four characters or a hash.
4. **Check provider usage** for unexpected spend, models, or regions. Groq/OpenAI dashboards show usage; export a snapshot before changing anything.
5. **Rotate adjacent secrets** if the leak could have exposed them: `ANTHROPIC_API_KEY`, `HANNAH_API_TOKEN`, `PINECALL_TOKEN_URL` credentials, `MCP_API_TOKEN`, `SENTRY_DSN` (not secret, but rotate if abused), and database credentials.
6. **Preserve evidence** and open a P0 security incident. If personal data may have been accessed, follow the legal breach-notification timeline (for example, 72 hours under GDPR where applicable).
7. **Postmortem within 48 hours.** Add a prevention item: secret scanning, pre-commit hook, CI check, narrower key scope, or removal of the key from the client.

### 3.5 Key inventory template

| Secret | Provider/project | Key ID / label | Created | Last rotated | Owner | Next rotation | Revoked |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GROQ_API_KEY` | Groq production | `hannah-prod-2026-11-15` | 2026-11-15 | 2026-11-15 | API on-call | 2027-02-15 | — |
| `OPENAI_API_KEY` | OpenAI production | — | — | — | API on-call | Quarterly | — |
| `ANTHROPIC_API_KEY` | Anthropic desktop/MobileClaw | — | — | — | API on-call | Quarterly | — |
| `HANNAH_API_TOKEN` | HANNAH API | — | — | — | Security | Quarterly or on leak | — |
| `MCP_API_TOKEN` | MCP HTTP | — | — | — | Security | Quarterly | — |

Rotate quarterly, after any operator departure, and immediately after a suspected exposure. Use provider-side key expiration where available.

### 3.6 Rollback

If the new key fails verification:

1. Stop the traffic shift.
2. Point traffic back to the old revision/key.
3. Confirm `/api/models` and the synthetic chat recover.
4. Keep the failed key disabled; do not delete it until you have captured the error and provider response.
5. Record the failure in the incident ticket. A `401` usually means a copy/paste or scope problem; a `429` may mean the new key has a different quota.

## 4. Sentry error triage

### 4.1 Severity definitions

| Severity | Definition | Examples | Acknowledge | Mitigate | Owner |
| --- | --- | --- | --- | --- | --- |
| **P0** | Crash, security, data exposure, auth bypass, destructive action without confirmation, payment/entitlement bypass, audit-chain failure | API crash loop; bearer token bypass; key in a Sentry event; prompt text in logs; tool executes without approval; Premium unlocked without a verified purchase; audit hash mismatch | 5 minutes | 15 minutes | Incident commander + security |
| **P1** | Major feature broken or severely degraded for many users | Chat 5xx >10%; voice unavailable; reports not writing; provider key rejected; login/token validation broken; desktop agent stuck | 30 minutes | 4 hours | Feature owner |
| **P2** | Cosmetic or low-impact issue | Typo, alignment, non-blocking animation glitch, documentation error | 1 business day | Next planned release | Feature owner |

When in doubt, escalate up, not down. A P1 with a credible security or data-exposure angle becomes P0.

### 4.2 Triage workflow

1. **Acknowledge the alert** in Sentry and the incident channel. Assign an owner.
2. **Scope it:** environment, release, platform, browser/OS, route, affected users, first/last seen, and whether it is increasing.
3. **Check release correlation:** did the issue start with the latest deploy? If yes, rollback is usually the fastest mitigation.
4. **Reproduce with a harmless test account/prompt.** Never paste a user’s chat into Sentry, Slack, or a ticket.
5. **Check privacy:** if the event contains a prompt, reply, key, Authorization header, IP, or local path, treat it as P0 data exposure, delete/redact the event, and rotate any exposed credential.
6. **Mitigate:** rollback, disable the feature, switch the default provider, increase a timeout, or fix forward. Prefer the smallest safe change.
7. **Verify:** run the relevant synthetic check, `/api/health/agent`, `/api/models`, and a chat canary.
8. **Communicate:** update the status page/internal channel at detection, mitigation, and resolution.
9. **Postmortem:** for P0/P1, write a timeline, root cause, impact, detection gap, and prevention items within 48 hours (P0) or 5 business days (P1).

### 4.3 Useful Sentry searches

```text
is:unresolved level:error environment:production
release:hannah-client@1.0.0
release:hannah-server@1.0.0
event.type:error !message:"Failed to fetch"
transaction:/api/chat
transaction:/api/agent
url:*/api/report-content*
```

Create alert rules for:

- Any new issue in a production release at `error` or `fatal`.
- Error rate >2% for 5 minutes on `/api/chat`, `/api/agent`, `/api/desktop/computer`, or `/api/report-content`.
- A new issue with `security` or `auth` in the title.
- Crash-free sessions below 99.5% (if session tracking is enabled).
- Any event containing `gsk_`, `sk-`, `Bearer `, `/Users/`, `prompt`, or `messages` after scrubbing (this indicates a scrubber regression).

### 4.4 P0 checklist

- [ ] Page the incident commander and security on-call.
- [ ] Stop the bleeding: rollback, disable the feature, or revoke the credential.
- [ ] Preserve logs and evidence; do not delete the Sentry event or audit file.
- [ ] Determine whether personal data, credentials, or conversation content was exposed.
- [ ] Rotate exposed keys and invalidate sessions/tokens.
- [ ] Notify legal/privacy within the required timeline if personal data was involved.
- [ ] Publish a user-facing status update if the impact is visible.
- [ ] Write the postmortem within 48 hours.
- [ ] Add a regression test or monitoring check.

### 4.5 P1 checklist

- [ ] Confirm the affected feature and user impact.
- [ ] Check the latest release and provider status.
- [ ] Roll back if release-correlated; otherwise apply the smallest fix.
- [ ] Verify with the canary and the health endpoints.
- [ ] Update the status page if the impact lasts more than 15 minutes.
- [ ] Open a follow-up ticket for the root cause.

### 4.6 P2 checklist

- [ ] Confirm it is not a symptom of a larger issue.
- [ ] Add it to the next sprint with a screenshot and reproduction steps.
- [ ] Group duplicates by fingerprint rather than closing them individually.
- [ ] No page, no emergency deploy.

### 4.7 Communication templates

**Initial:** “We’re investigating an issue affecting [feature] for some users. Local inference remains available. We’ll update again in 30 minutes.”

**Mitigated:** “The issue affecting [feature] has been mitigated. We’re monitoring for recurrence. No action is required from users.”

**Resolved:** “The issue is resolved. [Brief cause.] We’re completing a review and will publish prevention steps.”

**Security:** “We identified and contained a security issue affecting [scope]. We have rotated affected credentials and are notifying affected users as required. Do not share credentials or private conversations in public channels.”

## 5. Analyzing `hannah_audit.jsonl` for rejected HITL tool calls

### 5.1 What the log is

`logs/hannah_audit.jsonl` is written by the optional Python backend (`backend/audit_logger.py`) for security-sensitive tool actions. It is append-only, hash-chained, owner-only, and redacted. The Node client’s device-tool confirmations are separate and are not written to this file.

Each record includes:

- `sequence`, `timestamp`, `action`, optional `tool`, `status`, optional `details`, `previous_hash`, and `hash`.
- Actions such as `tool_proposed`, `tool_approved`, `tool_rejected`, `tool_expired`, `tool_result`.
- Rejection statuses such as `user_rejected`, `invalid_arguments`, `tool_not_allowlisted`, `approval_channel_missing`, `approval_channel_send_failed`, `approval_channel_disconnected`, and `parallel_tool_calls_disabled`.

The `details` object is redacted by key name (`api_key`, `token`, `password`, `secret`, `authorization`, `credential`, `session_id`, `cookie`, and similar). Do not add prompt text or user payloads to `details`.

### 5.2 Verify integrity first

Always verify the chain before drawing conclusions. A modified, truncated, or reordered log invalidates the analysis.

```bash
cd /path/to/hannah
python3 scripts/audit_monitor.py --all --json > /tmp/hannah-audit.json
echo "exit=$?"
jq '.integrity' /tmp/hannah-audit.json
```

- Exit `0` and `integrity.ok: true` → safe to analyze.
- Exit `1` or any `integrity.failures` → **P0 security incident**. Preserve the file, do not edit it, and investigate write permissions, disk corruption, deployment scripts, and anyone with filesystem access. Restore from a trusted backup only after preserving the original.

For a live view during an incident:

```bash
python3 scripts/audit_monitor.py --follow --interval 2
```

### 5.3 Top rejected tools (jq)

```bash
LOG=logs/hannah_audit.jsonl

# All rejections: tool + reason
jq -r 'select(.action == "tool_rejected") |
  [(.tool // "unknown"), (.status // "unknown")] | @tsv' "$LOG" \
  | sort | uniq -c | sort -nr | head -20

# User rejections only, by tool
jq -r 'select(.action == "tool_rejected" and .status == "user_rejected") |
  (.tool // "unknown")' "$LOG" \
  | sort | uniq -c | sort -nr | head -20

# Automatic rejections, by reason
jq -r 'select(.action == "tool_rejected" and .status != "user_rejected") |
  (.status // "unknown")' "$LOG" \
  | sort | uniq -c | sort -nr
```

### 5.4 Rejection rate by tool (Python)

The monitor reports total proposals and rejection reasons, but not the per-tool rejection rate. Use this snippet:

```python
import collections
import json

LOG = "logs/hannah_audit.jsonl"
proposed = collections.Counter()
rejected = collections.Counter()
reasons = collections.Counter()

with open(LOG, encoding="utf-8") as handle:
    for line in handle:
        record = json.loads(line)
        tool = record.get("tool") or "unknown"
        if record.get("action") == "tool_proposed":
            proposed[tool] += 1
        elif record.get("action") == "tool_rejected":
            rejected[tool] += 1
            reasons[record.get("status") or "unknown"] += 1

print(f"{'tool':32} {'rejected':>8} {'proposed':>8} {'rate':>7}")
for tool, count in rejected.most_common(15):
    total = proposed[tool]
    rate = (count / total) if total else 0
    print(f"{tool:32} {count:8} {total:8} {rate:7.1%}")

print("\nRejection reasons:")
for reason, count in reasons.most_common():
    print(f"  {reason}: {count}")
```

### 5.5 Interpretation playbook

| Pattern | Likely cause | Action |
| --- | --- | --- |
| High `user_rejected` on one tool | The action is too risky, poorly explained, or too frequent | Improve the confirmation copy, reduce scope, add a preview, or stop proposing it |
| High `invalid_arguments` | Tool schema is unclear or the model is guessing | Tighten the schema/description, add examples, validate before proposing |
| High `tool_not_allowlisted` | The model hallucinates a tool or a prompt-injection attempt is succeeding | Check the tool list, prompt rules, and input screening; treat repeated attempts as a security signal |
| High `approval_channel_missing` / `send_failed` | The approval WebSocket is not connected or the client is offline | Fix the approval transport; this is a P1 feature break |
| High `approval_channel_disconnected` | The user closed the app or lost the connection | Expected at some rate; investigate if it spikes |
| High `tool_expired` | Approval timeout is too short or notifications are not visible | Tune the timeout and notification UX |
| High `parallel_tool_calls_disabled` | The model repeatedly proposes multiple tools at once | Adjust the system prompt and tool-call parsing; not a user error |
| `tool_result` errors | The approved tool failed at execution | Inspect `error_type`; fix the tool or its environment |
| Chain failure | Tampering, truncation, or a write bug | P0 security incident; preserve evidence |

**Practical thresholds for a weekly review:**

- A tool with ≥20 proposals and a user-rejection rate >40% needs a UX or scope review.
- `invalid_arguments` >10% of a tool’s proposals needs a schema/prompt fix.
- Any `approval_channel_missing` or `approval_channel_send_failed` is a P1 until resolved.
- A spike in `tool_not_allowlisted` should trigger a prompt-injection review.
- A chain failure is always P0.

### 5.6 Weekly trust-and-safety report template

```text
Week: YYYY-MM-DD to YYYY-MM-DD
Audit records: N
Chain integrity: OK / FAILED (details)
Tool proposals: N
User rejections: N (rate)
Automatic rejections: N
Top rejected tools: tool (count, rate), ...
Top rejection reasons: reason (count), ...
Tool execution errors: N
Notable prompt-injection or allowlist attempts: ...
Actions: ...
Owner / due date: ...
```

Store the report without raw prompts or user payloads. The audit log is metadata-only; keep it that way.

## 6. Content-report review

AI content reports are appended to `logs/content_reports.jsonl` (override with `CONTENT_REPORT_LOG`). Each line contains only `schemaVersion`, `id`, `receivedAt`, `messageId`, `reason`, `appVersion`, `platform`, optional `modeDetail`, and `source`.

```bash
LOG=logs/content_reports.jsonl
test -f "$LOG" || { echo "No content reports yet"; exit 0; }

# Counts by reason
jq -s 'group_by(.reason) | map({reason: .[0].reason, count: length}) | sort_by(-.count)' "$LOG"

# Newest reports
jq -s 'sort_by(.receivedAt) | reverse | .[:20]' "$LOG"

# Reports by platform and app version
jq -s 'group_by(.platform) | map({platform: .[0].platform, count: length})' "$LOG"
```

Review cadence: **daily during launch week**, then weekly. Triage:

- **Harmful/sexual:** review the message ID against the provider/model and, if the user consents, the conversation context. Do not request or store the reply text in the report log. Escalate to P0 if the content involves CSAM or imminent harm; follow legal reporting obligations.
- **Misinformation:** identify the model/provider and whether a system-prompt or model change caused it. Add a regression test if reproducible.
- **Other:** product feedback; route to the product backlog.
- **Repeated reports on one model:** consider disabling that model or provider until reviewed.

Write failures return HTTP `500` and log a generic error without the report body. Alert on repeated failures. Do not add message text to this log to “improve” review; the metadata-only design is intentional.

## 7. Routine operations schedule

### Daily

- [ ] Check `/api/health` and `/api/health/agent`.
- [ ] Review new Sentry P0/P1 issues.
- [ ] Review `logs/content_reports.jsonl` during launch week.
- [ ] Confirm the API error rate and provider fallback rate are normal.
- [ ] Check disk space for `logs/` and model caches.

### Weekly

- [ ] Run `python3 scripts/audit_monitor.py --all --json`; investigate any chain failure.
- [ ] Run the rejection-rate report and update the trust-and-safety summary.
- [ ] Review provider usage and spend against budget.
- [ ] Review 429 rates and adjust rate limits only with evidence.
- [ ] Check dependency advisories and plan upgrades.
- [ ] Verify backups of audit, content-report, and feedback stores.

### Monthly

- [ ] Rotate `HANNAH_API_TOKEN` and MCP tokens if the policy requires monthly rotation; otherwise confirm quarterly schedule.
- [ ] Review Sentry retention and scrubber tests.
- [ ] Review privacy policy, provider list, and Data Safety mapping against the shipped build.
- [ ] Test deletion requests end to end.
- [ ] Review access to the hosting dashboard, secret manager, and provider consoles.

### Quarterly

- [ ] Rotate Groq, OpenAI, Anthropic, and other provider keys.
- [ ] Review incident postmortems and close prevention items.
- [ ] Run a restore drill from backup.
- [ ] Re-run the launch compliance checklist.
- [ ] Review pricing, entitlements, and store metadata.

## 8. Backup, retention, and privacy operations

| Data | Backup | Retention | Notes |
| --- | --- | --- | --- |
| `hannah_audit.jsonl` | Daily encrypted copy to write-once/immutable storage | Per security policy; at least 1 year | Verify chain after restore; never edit the original |
| `content_reports.jsonl` | Daily encrypted copy | 12 months | Metadata only; no reply text |
| Feedback (Discord/MongoDB) | Provider backup/export | 24 months target | Contains user text; restrict access |
| Sentry events | Provider retention | 30–90 days typical | Scrubbed; no prompts or keys |
| LLM traces | Optional | 30 days | Metadata only; rotate/delete |
| Server logs | Hosting provider | 30 days or less | Method/path/status/latency; no bodies |
| Billing records | Store/RevenueCat | Legal requirement | Do not delete tax records early |

Access to logs is least-privilege. Do not download production logs to a personal laptop. Do not paste log lines containing keys, tokens, prompts, or user text into tickets. If a secret appears in a log, rotate it and treat it as a P0 exposure.

## 9. Incident response quick reference

1. **Declare:** severity, incident commander, channel, start time.
2. **Contain:** rollback, disable feature, revoke key, block abusive traffic.
3. **Assess:** user impact, data impact, legal/regulatory impact.
4. **Communicate:** internal update every 30 minutes for P0/P1; external status page if user-visible.
5. **Recover:** verify health, canary, and provider checks.
6. **Review:** timeline, root cause, detection gap, prevention, owner, due date.
7. **Close:** update this runbook and the monitoring/alert rules.

### Rollback checklist

- [ ] Identify the last known-good release.
- [ ] Roll back the API and client together if the contract changed.
- [ ] Verify `/api/health`, `/api/health/agent`, `/api/models`, and a chat canary.
- [ ] Check Sentry for new errors in the rolled-back release.
- [ ] Confirm content reports and feedback still write.
- [ ] Announce the rollback and the follow-up plan.

## 10. Runbook maintenance

- Review this document monthly and after every P0/P1.
- Update endpoint names, environment variables, dashboards, and contacts when they change.
- Add a regression check for every incident that could have been detected earlier.
- Keep the privacy rule visible: telemetry and logs describe operations, never conversations.
