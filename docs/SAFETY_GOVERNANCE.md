# Safety Governance

## Permission Monotonic Attenuation
Once a permission or capability is revoked during a session, it cannot be re-granted without a new explicit user approval. Revocations persist for the session and require a fresh approval event to restore.

## Credential Broker
Provider API keys are held by the CredentialBroker and are never exposed to AgentRuntime. All provider calls go through the Broker, which injects credentials at the network boundary and redacts them from responses.

## Egress Policy
All outbound network calls are denied by default. Explicit allow-list entries are required for each destination and request shape.

## Human Approval
Irreversible actions require explicit human-in-the-loop approval through SafetyGuard and the side-effect ledger undo window.