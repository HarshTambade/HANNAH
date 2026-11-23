# HANNAH ROBOT OS — Security

Updated: 2026-11-23

## Security posture

HANNAH Robot OS treats AI outputs, manuals, packages, drivers, network messages, and external agent instructions as untrusted input. Physical safety is enforced by deterministic local controls; cloud/LLM/UI are never sole safety controllers.

## Controls (target / implementation status)

| Control | Status | Notes |
|---|---|---|
| Device identity and secure enrollment | IN_PROGRESS | Signed enrollment tokens, per-device keys, vault/keystore |
| Authentication/authorization | IN_PROGRESS | Reuse HANNAH permissions; local capability checks |
| Signed commands with expiry/nonce | IMPLEMENTED (existing robotics) | Extend to motor/controller commands |
| Signed updates/packages/profiles | IN_PROGRESS | Manifest format and verification tooling |
| Credential isolation | IN_PROGRESS | systemd users, file perms, no secrets in AI context |
| Encrypted communication | IN_PROGRESS | TLS for API; no public ROS2 DDS |
| Audit logs | IN_PROGRESS | Local append-only audit events |
| Secure boot/signed OS images | BLOCKED_EXTERNAL_DEPENDENCY | Platform-specific; Ubuntu Core/board support |
| Privilege separation | IN_PROGRESS | Separate service users; safety gateway minimal deps |
| Recovery/rollback | IN_PROGRESS | A/B or transactional update design |
| Signed Robot OS bridge envelopes | IMPLEMENTED (unit tested) | HMAC over robot/time/envelope/kind/payload hash; clock skew, signature-before-replay, known-secret checks; opt-in feature flag; idempotent durable storage with account scoping |
| Signed Robot OS admin commands | IMPLEMENTED (unit tested) | HMAC over id/robot/capability/times/nonce/params hash; cross-language Python/JS fixture test; expiry + replay guard; capability allow-list; local safety state refusal; actions require explicit human approval (`standing: false`) |

## Threats considered

- Malicious manual/profile/package inducing unsafe config.
- Replay/forged robot commands.
- Network exposure of ROS2 DDS.
- AI prompt injection causing unauthorized hardware action.
- Compromised non-safety service affecting motion.
- Unsafe update leaving robot in unknown state.

## Mandatory safety rules

- No raw PWM/torque/joint actuator commands from AI/UI/cloud directly.
- Physical E-stop is independent hardware; software stop button is not E-stop.
- Communication loss/watchdog timeout => safe stop policy.
- Command expiry and nonce required for motion commands.
- No safety certification claimed.

## Standards mapping (engineering input required)

| Robot category | Relevant standards to assess |
|---|---|
| Mobile robots/AMR | ISO 3691-4, ISO 12100, ISO 13849, IEC 62443 |
| Industrial arms/cobots | ISO 10218, ISO/TS 15066, ISO 13849 |
| Service robots | ISO 13482, IEC 61508 where applicable |
| Machinery electrical/safety | IEC 60204-1, ISO 13850 |

Independent safety assessment is required before any safety claim.
