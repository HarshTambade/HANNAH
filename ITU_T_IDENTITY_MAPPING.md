# ITU-T Agentic Identity Mapping (X.aiidm Forward Compatibility)

This document maps Shanaya's native identity profile to the ITU-T Focus Group on Trust and Identity for Humans and Agentic AI canonical data model.

## Mapping table

| Shanaya field | ITU-T X.aiidm field | Notes |
|---|---|---|
| `name` | `identityId` component | Derived as `shanaya:<uuid>` |
| `version` | Not directly mapped | Carried in presentation metadata |
| `tools` | `capabilities` | Tool names mapped to capability URIs |
| `specialists` | `delegationChain` | Specialist agent IDs in delegation chain |
| `memoryQuery` | `capabilities` | Included as `memory_query` capability |
| `strictness` | `autonomySpectrum` | permissive→assisted, balanced→supervised, strict→autonomous |
| Guardian rules | `governanceBindings` | HITL, persona kernel, egress policy bindings |
| Persona kernel | `intent` | Core character and relational anchors |
| Audit log entries | Trust evidence log | Immutable audit trail referenced by identity |

## Governance bindings

Shanaya binds the following governance controls to its ITU-T identity:

1. `HITL_for_irreversible_actions` — no file delete, message send, or shell command without explicit user approval.
2. `persona_kernel_immutable` — core traits cannot be modified by the agent; only explicit user action.
3. `egress_policy_deny_by_default` — all outbound network calls denied unless allow-listed.

## Forward compatibility

When the ITU-T reference architecture is finalized (Paris November 2026, Geneva January 2027), Shanaya will:
- Adopt the canonical `identityId` format.
- Publish capability advertisements at `/.well-known/pap.json` aligned with AIPF.
- Present verifiable credentials for agent-to-agent authorization.