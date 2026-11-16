# Milestone 1.5 — API security hotfix

**Status:** Implemented and verified at the source/build level.

## Changes

- Added server-only HANNAH_API_TOKEN validation. Production refuses to load without a non-empty 32–512 character token; development protected routes return 503 when the server token is not configured.
- Required a Bearer token for every Express /api route except /api/health. The token is SHA-256 hashed and compared with timingSafeEqual. Authentication runs before JSON body parsing.
- Added configurable fixed-window, per-token limits for chat (30/minute), agent (60/minute), and desktop computer use (20/minute), with Retry-After and RateLimit response headers.
- Added a landing-page field for users to enter the server token. It is held in page memory for the current session and cleared when returning Home; it is not stored or included in the Vite bundle.
- Updated primary client API requests and server-side MCP-to-API calls to send the bearer token. The token is not forwarded to the separate Python model-step fallback.
- Updated server configuration examples, README, API integration guide, and AUDIT.md. Added Node built-in security tests; no dependency was added.

## Verification

- npm test --prefix server — passed, 7 tests:
  - health remains available without a bearer token
  - all API paths except health reject unauthenticated requests
  - a valid bearer token can call protected endpoints
  - an incorrect bearer token is rejected
  - chat requests are rate limited per bearer token
  - agent and desktop routes have independent token rate limits
  - production refuses to load without a valid API token
- npm run build --prefix client — passed TypeScript build and Vite production build.
- git diff --check — passed.

The client build emitted existing dependency-comment and large-chunk warnings; the build completed successfully.

## Not tested

- Live Vercel deployment, service-to-service MCP calls, or physical-device interaction with the token-entry flow.
- Rate-limit coordination across multiple Node/Vercel instances. Counters are in process memory, so each instance enforces its own window.
- Browser manual verification of token entry, expiry/rotation, and re-entry. The production client bundle compiled successfully.

## Remaining deployment constraint

The API token is a shared credential for trusted users, not a per-user identity. Anyone given the token can extract and reuse it. Rotate it to revoke all clients. Multi-instance production deployments should enforce quotas with a shared store or trusted upstream limiter.
