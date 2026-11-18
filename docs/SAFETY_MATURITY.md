# Safety Maturity (Replit Agent Habitat 0-3)

| Dimension | Score | Notes |
| --- | --- | --- |
| Sandbox isolation | 2 | Workspace-scoped files and allow-listed shell commands. |
| Network isolation | 1 | No general egress policy. Workflow HTTP steps and page reads block private and metadata addresses; other outbound calls go only to configured providers. |
| Credential handling | 2 | Keys are encrypted in the server vault and added by the server; the app's agent loop never sees them. |
| Policy enforcement | 1 | Allow-list exists; needs broader coverage. |
| Human approval | 3 | HITL approvals and side-effect undo window. |
| Audit | 2 | Audit logger records tool decisions. |

Lowest-scoring dimension: network isolation and policy enforcement (score 1). Next priority: one egress check for every outbound call.