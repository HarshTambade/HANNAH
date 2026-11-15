# Safety Maturity (Replit Agent Habitat 0-3)

| Dimension | Score | Notes |
| --- | --- | --- |
| Sandbox isolation | 2 | Workspace-scoped files and allow-listed shell commands. |
| Network isolation | 1 | Egress policy scaffold; not yet enforced everywhere. |
| Credential handling | 2 | CredentialBroker separates keys from agent. |
| Policy enforcement | 1 | Allow-list exists; needs broader coverage. |
| Human approval | 3 | HITL approvals and side-effect undo window. |
| Audit | 2 | Audit logger records tool decisions. |

Lowest-scoring dimension: network isolation and policy enforcement (score 1). Next priority: extend EgressPolicy enforcement to all outbound calls.