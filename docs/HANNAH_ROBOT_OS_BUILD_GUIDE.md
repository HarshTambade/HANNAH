# HANNAH ROBOT OS — Build Guide

Updated: 2026-11-28  
Status: an mkosi image definition and a CI build-and-boot job exist; no image has been built or booted yet.

## Prerequisites

- Linux build host (Ubuntu 24.04 or Debian 13) with user namespaces, or the CI runner.
- mkosi at the version in `robot-os/images/mkosi/VERSIONS` (v25.3). mkosi builds its own tools tree (Debian trixie), so the host needs little beyond Python 3, apt and `debian-archive-keyring`. No Docker.
- For arm64 on an x86_64 host: `qemu-user-static` and `binfmt-support`.
- For the boot check: `qemu-system-x86` and `ovmf` (or `qemu-system-arm` and `qemu-efi-aarch64`).

## Repository layout

- `robot-os/images/build.sh` - builds one profile; `--dry-run` assembles the mkosi project anywhere and builds nothing.
- `robot-os/images/mkosi/` - `common/` (packages, extra files, postinst and finalize scripts), `boards/uefi` and `boards/rpi` (boot settings and partition layout), `sysupdate/` (update transfer templates), `VERSIONS`.
- `robot-os/images/scripts/qemu-smoke.sh` - boots a UEFI disk image headless and passes on the READY marker.
- `robot-os/systemd/` - the Robot OS units the image installs and enables.
- `robot-os/image-profiles/profiles.json` - the five profiles, each with an `image` block (board, arch, kernel, CI mode).

## Build

```bash
python3 robot-os/tools/validate_manifests.py
python3 -m pytest robot-os/tests -q
./robot-os/images/build.sh --profile robotos-dev-x86_64 --dry-run      # any OS
sudo ./robot-os/images/build.sh --profile robotos-dev-x86_64            # Linux with mkosi
./robot-os/images/scripts/qemu-smoke.sh robot-os/images/out/robotos-dev-x86_64/output/hannah-robot-os_0.1.0.raw
```

Options: `--rt` (PREEMPT_RT kernel), `--version`, `--out`, `--splash` (plymouth boot screen), `--update-url URL --update-pubring FILE` (bake in a signed update source; UEFI only).

## Image build status

No image has been built or booted. The configuration was written on macOS, where mkosi, QEMU and Docker are not available, and is checked there only statically (`robot-os/tests/unit/test_image_config.py`). `.github/workflows/robot-os-image-ci.yml` builds `robotos-dev-x86_64` and boots it in QEMU; until that run passes, treat the image as unverified. arm64 and Raspberry Pi images are built on manual dispatch only. What the image contains and what is not done is in `robot-os/README.md`, "Disk image".

## Flash/install (planned)

1. Build image artifact.
2. Verify checksum/signature.
3. Flash to target media using approved tool.
4. Boot target hardware.
5. Complete first-boot wizard and enrollment.
6. Run commissioning checklist before enabling motion.

## Recovery

- UEFI images: two root slots; systemd-boot boot counting falls back to the previous version when a new one never passes the READY gate (`hannah-boot-ready.service` gates `boot-complete.target`). Not yet exercised.
- Raspberry Pi: slot A only; no automatic fallback.
- Recovery mode boots minimal services + diagnostics + update rollback (state logic only; no recovery boot entry).
- Never auto-flash firmware without explicit approval.
