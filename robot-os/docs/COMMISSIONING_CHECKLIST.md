# HANNAH Robot OS — Commissioning Checklist (Template)

Status: TEMPLATE. Must be completed by qualified operator for physical hardware. No item is complete without evidence.

## Pre-power / physical
- [ ] Robot chassis, wiring, power, and E-stop inspected by qualified person.
- [ ] Physical E-stop circuit tested and independent of software.
- [ ] Motor driver/controller power ratings verified against datasheets.
- [ ] Battery/power limits and fusing verified.

## OS install
- [ ] Signed HANNAH Robot OS image verified (checksum/signature).
- [ ] Image flashed to target media with approved procedure.
- [ ] First boot completed; admin account created; SSH/remote access hardened.
- [ ] Device enrolled with parent HANNAH OS (identity key stored securely).

## Hardware validation
- [ ] Hardware profile selected matches actual hardware revision.
- [ ] Motor controller identity, firmware, interface verified.
- [ ] Encoders report valid feedback at rest and during controlled motion.
- [ ] Required sensors detected, calibrated, timestamped, and healthy.
- [ ] Watchdog timeout causes safe stop.

## Safety validation
- [ ] Command TTL expiry rejects stale commands.
- [ ] Speed/acceleration/joint limits enforced.
- [ ] E-stop latches and blocks motion enable until cleared by approved procedure.
- [ ] Network loss causes safe stop per policy.
- [ ] AI/UI cannot issue raw actuator commands.

## Navigation/manipulation (if enabled)
- [ ] Map/localization validated in controlled area.
- [ ] Obstacle detection stops/avoids per policy.
- [ ] Mission cancel/pause/resume/abort tested.
- [ ] Arm workspace/collision limits validated.

## Evidence
- Operator:
- Date:
- Robot ID/serial:
- Profile ID/version:
- Logs/artifacts:
- Result: PASS / FAIL / BLOCKED
