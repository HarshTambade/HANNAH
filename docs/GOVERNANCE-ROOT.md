# HANNAH Agentic Governance

## Control Plane Overview

HANNAH implements a multi-layered governance control plane that ensures every agent action is auditable, reversible, and subject to human oversight.

## Governance Layers

### Layer 1: AgentRuntime Policy (Platform-Level)
- Configured at the platform level, not modifiable by the agent.
- Enforces rate limits, tool allow-lists, and data access boundaries.
- PolicyEnforcementLayer is the entry point for all actions.

### Layer 2: GuardianAgent (Supervisor)
- Lightweight supervisor model that evaluates every proposed tool call and proactive action.
- Assesses semantic intent (not just syntax) and detects multi-turn attack patterns.
- Configurable strictness: permissive, balanced, strict.
- Final veto authority; all decisions logged to audit trail with full risk vector.

### Layer 3: CognitiveRiskEngine (CRF 2.0)
- Scores every proposed action against 8 dimensions: epistemic uncertainty, readiness deficit, behavioral vulnerability, consequence severity, intent uncertainty, memory uncertainty, environmental risk, action irreversibility.
- When risk exceeds threshold, the agent suppresses the action entirely (not queued, not confirmation-prompted).
- Suppression logged with reason.

### Layer 4: HITL Gate (Human-in-the-Loop)
- All irreversible actions require explicit user approval.
- SafetyGuard provides confirmation dialogs.
- SideEffectLedger records every action with a 30-second undo window.
- `/api/undo` endpoint allows programmatic undo within the delay window.

### Layer 5: Audit Trail (Tamper-Evident)
- Hash-chained audit log (`hannah_audit.jsonl`).
- Each record includes: sequence number, timestamp, action, tool, status, details, previous_hash, hash.
- Chain integrity verified on startup; broken chain prevents appending.
- Append-only with `O_APPEND` and `O_NOFOLLOW` flags.
- Owner-only file permissions (0o600).
- fsync after every record.

## Governance Flow

```
User Request
    ↓
[AgentRuntime Policy] → rate limit check, tool allow-list
    ↓
[GuardianAgent] → semantic intent assessment, multi-turn detection, veto
    ↓
[CognitiveRiskEngine] → CRF 2.0 risk scoring, threshold check
    ↓
[HITL Gate] → user approval for irreversible actions
    ↓
[SideEffectLedger] → record with delay window
    ↓
[Executor] → execute after delay (unless undone)
    ↓
[Audit Trail] → tamper-evident hash-chained log
```

## Audit Log Integrity

The audit log uses a hash chain where each record's hash depends on the previous record's hash. Any modification, deletion, or reordering of records breaks the chain and is detectable on startup.

### Verification
```python
from backend.audit_logger import AuditLogger
logger = AuditLogger("logs/hannah_audit.jsonl")
# Startup automatically verifies the chain
# If broken: RuntimeError raised, appending refused
```

## Governance Evidence Export

The AgentAccountabilityDashboard provides a "Export Compliance Report" feature that generates a redacted PDF summary of:
- All tool approvals and rejections
- Memory changes (add, update, remove)
- Configuration updates
- Side-effect ledger entries
- Kill switch events

All sensitive data (credentials, user content, URLs) is redacted before export.

## Escalation Paths

1. **Low risk (Tier 1)**: Fully automated with periodic audits.
2. **Medium risk (Tier 2)**: Requires human approval (HITL).
3. **High risk (Tier 3)**: Prohibited entirely.

Tier assignment is configurable per tool and per collective member via TypedRails.

## User Controls

- **Reset to Defaults**: Per-section reset in the Accountability Dashboard.
- **Kill Switch**: Immediate halt of all agent activity with resume button.
- **Permission Revocation**: Revoked permissions cannot be re-granted without new explicit approval.
- **Memory Export/Delete**: Full memory profile export as encrypted archive; individual memory deletion.
- **Persona Reset**: Explicit reset of persona anchors via Accountability Dashboard.

## Compliance

See [REGULATORY_COMPLIANCE.md](./REGULATORY_COMPLIANCE.md) for detailed mapping to FTC, EU AI Act, and Singapore IMDA requirements.
See [RESPONSIBLE_AI.md](./RESPONSIBLE_AI.md) for transparency, limitations, and safety measures.
