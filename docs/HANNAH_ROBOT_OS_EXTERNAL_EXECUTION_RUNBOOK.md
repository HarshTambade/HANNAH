# HANNAH Robot OS — External Execution Runbook (RB2–RB6)

Updated: 2026-11-23

This runbook is for the owner/operator who has the build environment, keys, reviewer and credentials. **Do not paste secrets into chat, issues, logs or this document.** Nothing here is complete until the named evidence artifact exists and is attached to the tracker.

## Shared rules

- Run only on a trusted Linux host or CI runner; do not run image builds on a workstation you cannot afford to wipe.
- Flashing/booting physical media, changing bootloaders, powering motors and production deployment require explicit human approval each time.
- Keep evidence separate by level: build log, VM boot log, ROS2/Gazebo log, review report, signing verification log, live AI test log. Never mark a simulated result as physical validation.

---

## RB2 — Linux build host, image build and boot

**Owner provides:** Ubuntu 24.04 build host or self-hosted CI runner with `docker`, `debootstrap`, `qemu-utils`, `qemu-system-x86_64` (and `qemu-system-aarch64` for ARM profiles), root/sudo, and enough disk space.

### Steps

```bash
# On the Linux build host
cd <repo>
python3 robot-os/tools/validate_manifests.py
bash -n robot-os/images/scripts/*.sh
sudo env OUT=/tmp/hannah-rootfs.tar.gz bash robot-os/images/scripts/build-dev-rootfs.sh /tmp/hannah-rootfs
ls -lh /tmp/hannah-rootfs.tar.gz
```

For a boot smoke test, supply a kernel/initrd/rootfs image to:

```bash
bash robot-os/images/scripts/qemu-smoke.sh <kernel> <initrd> <rootfs.img>
```

CI equivalent: `.github/workflows/robot-os-image-ci.yml` on an Ubuntu runner.

### Evidence required

- `RB2-build.log` with rootfs archive checksum.
- `RB2-qemu-boot.log` containing `HANNAH Robot OS READY`.
- Exact profile ID, package versions and git commit SHA.
- Physical flashing/boot is a **separate** approval and commissioning record.

---

## RB3 — ROS 2 Jazzy / Gazebo / Nav2 runtime

**Owner provides:** Linux environment with ROS 2 Jazzy, `colcon`, Gazebo Harmonic, Nav2, or a self-hosted runner/container that can pull `ros:jazzy-ros-base`.

### Steps

```bash
# Build the skeleton hardware interface package
cd robot-os/ros2/hannah_robot_os_hardware
colcon build --packages-select hannah_robot_os_hardware

# Existing robotics acceptance target (written, not yet run):
# see robotics/Dockerfile.gazebo and robotics/tools/gazebo_check.sh
docker build -f robotics/Dockerfile.gazebo -t hannah-gazebo .
docker run --rm hannah-gazebo
```

CI equivalents: `.github/workflows/robot-os-ros2-ci.yml`, `robot-os/ros2/Dockerfile.ros2-ci`.

### Evidence required

- `RB3-colcon-build.log`.
- `RB3-gazebo-acceptance.log` showing Nav2/Gazebo scenario results.
- Any parameter changes made to `ros2_control.diffdrive.yaml` or launch files.
- Simulation result label: **Gazebo/Nav2 simulation**, not physical hardware.

---

## RB4 — Independent security and safety review

**Owner provides:** an independent reviewer who did not write this code, plus a qualified functional-safety assessor for the intended robot category.

### Scope to hand over

- `HANNAH_ROBOT_OS_SECURITY.md`, `docs/robotics/SAFETY_GATEWAY.md`, `robotics/ros2_ws/VERSIONS.yaml`.
- Signed envelope and command protocols: `server/robotics/robot_os_auth.js`, `robot_os_commands.js`, `robot-os/src/hannah_robot_os/network/command_guard.py`.
- Safety-critical boundaries: safety gateway, motor manager, command expiry/watchdog, capability allow-list, approval-gated actions.
- Threat model: forged/replayed commands, prompt injection, unsafe profiles/manuals, update rollback, DDS exposure.

### Evidence required

- `RB4-security-review.pdf` with findings and severity.
- `RB4-safety-assessment.pdf` with applicable standards for the robot category (e.g. ISO 12100, ISO 13849, IEC 60204-1, ISO 3691-4 or ISO 10218 as applicable).
- Explicit statement of independence and reviewer qualifications.
- No HANNAH safety certification claim unless the assessor and regulator process supports it.

---

## RB5 — Production signing keys / HSM

**Owner provides:** production root/intermediate signing keys in an HSM/KMS or offline secure store, a release policy, key IDs and trusted-signer allow-list. **Never send private keys here.**

### Steps

1. Define key hierarchy: offline root -> release signing key -> per-image/per-package signature.
2. Store public keys/trusted signer IDs in the release configuration and `HANNAH_ROBOT_OS_BRIDGE_*` allow-lists where applicable.
3. Configure CI secrets (names only, not values): `HANNAH_SIGNING_KEY_ID`, `HANNAH_SIGNING_PUBLIC_KEY`, `HANNAH_RELEASE_SIGNER`.
4. Sign image manifests/update manifests; verify with `robot-os/src/hannah_robot_os/updates/manifest.py` and the release verifier.
5. Record rotation and revocation procedure.

### Evidence required

- `RB5-signing-verification.log` showing a valid signature accepted and a tampered artifact rejected.
- Signed manifest with key ID/signer identity.
- Key custody and rotation policy document.
- The current code only checks signature presence/hash/signer; real cryptographic verification must be wired to the production key infrastructure before a signed-release claim.

---

## RB6 — Live AI model credentials

**Owner provides:** provider credentials in the server's secure secret store/vault, plus authorization to enable live tests. Do not paste keys into chat.

### Steps

1. Configure the chosen provider key in the existing HANNAH secret/vault path (for example the provider used by the Model Gateway).
2. Enable live tests with the project's existing switch (e.g. `HANNAH_LIVE_TESTS=1`) in the test environment.
3. Run the existing robot agent/tool tests that were previously scripted, now against the live provider.
4. Redact all keys and provider responses containing personal data from logs.

### Evidence required

- `RB6-live-agent.log` showing real model-driven intent selection and tool calls.
- Record of which provider/model was used, with costs/latency if available.
- Confirmation that safety/permission checks still ran; a live model must never bypass the Action Engine or Safety Gateway.

---

## Handoff checklist

When the resources are actually provisioned, provide only non-secret references:

- Runner labels or host alias for RB2/RB3.
- Key IDs and signer identities for RB5 (never private keys).
- Reviewer/assessor names and engagement scope for RB4.
- Secret names/vault paths and the live-test flag value for RB6.

Then each blocker can be executed and marked VERIFIED only with its evidence artifact. Until then, RB2–RB6 remain `BLOCKED_EXTERNAL_DEPENDENCY`.
