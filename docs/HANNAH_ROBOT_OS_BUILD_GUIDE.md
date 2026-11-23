# HANNAH ROBOT OS — Build Guide

Updated: 2026-11-23  
Status: INITIAL. Build definitions are being created; no image build/boot has been validated in this environment.

## Prerequisites

- Linux build host (Ubuntu 24.04 recommended) or CI runner.
- Docker/Podman for containerized builds.
- For Ubuntu image builds: `ubuntu-image`, `snapcraft` as needed.
- For Yocto: required host packages, disk space, board layer.
- Python 3.11+, Node 20+, git.
- QEMU for boot smoke tests (optional but recommended).

## Repository layout

- `robot-os/images/` - image profiles, manifests, build scripts.
- `robot-os/services/` - systemd units and service configs.
- `robot-os/src/hannah_robot_os/` - Python OS services/managers.
- `robot-os/config/` - default configs, hardware profiles, safety limits.
- `robot-os/tests/` - unit/integration/sim tests.
- `robot-os/tools/` - build/check/manifest tools.

## Dev build (target)

```bash
# From repo root
python3 robot-os/tools/validate_manifests.py
python3 -m pytest robot-os/tests -q
./robot-os/images/build.sh --profile robotos-dev-x86_64
```

## Image build scripts

- `robot-os/images/scripts/build-dev-rootfs.sh` - debootstrap Ubuntu 24.04 rootfs, copy Robot OS, install units, create firstboot; requires Linux + root + debootstrap.
- `robot-os/images/scripts/enable-services.sh` - enable systemd units inside a rootfs/chroot.
- `robot-os/images/scripts/qemu-smoke.sh` - boot supplied kernel/initrd/rootfs in QEMU and check for the `HANNAH Robot OS READY` marker.
- `robot-os/systemd/hannah-firstboot.service` + `/usr/sbin/hannah-firstboot` - first boot setup; `hannah-robot-os ready` prints the marker only when required service status files report ready.

## Image build status

No image build executed in current session. macOS dev environment lacks Docker/QEMU/snapcraft/Yocto/debootstrap. Scripts are syntax-checked; CI workflow `robot-os-image-ci.yml` is defined for an Ubuntu runner. No boot claim is made without QEMU/hardware evidence.

## Flash/install (planned)

1. Build image artifact.
2. Verify checksum/signature.
3. Flash to target media using approved tool.
4. Boot target hardware.
5. Complete first-boot wizard and enrollment.
6. Run commissioning checklist before enabling motion.

## Recovery

- A/B slot or transactional rollback (profile-dependent).
- Recovery mode boots minimal services + diagnostics + update rollback.
- Never auto-flash firmware without explicit approval.
