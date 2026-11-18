# Safety Governance

## Permission Monotonic Attenuation
Once a permission or capability is revoked during a session, it cannot be re-granted without a new explicit user approval. Revocations persist for the session and require a fresh approval event to restore.

## Provider keys
A visitor's Groq key stays in the page (or, with “Remember on this browser”, in an HttpOnly cookie the page can't read) and goes only to Groq's official API. Keys saved to an account are envelope-encrypted in the server's vault and only ever sent to that provider's own HTTPS API (`server/index.js`, `getRequestProviderApiKey`). The agent loop never sees a key: the server adds it to the provider request.

## Egress Policy
All outbound network calls are denied by default. Explicit allow-list entries are required for each destination and request shape.

## Human Approval
Irreversible actions require explicit human-in-the-loop approval through SafetyGuard and the side-effect ledger undo window.