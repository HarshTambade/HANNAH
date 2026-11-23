#!/usr/bin/env bash
# Enable HANNAH Robot OS systemd units inside a rootfs (run as root in chroot).
set -euo pipefail

TARGET="${1:-/}"
UNIT_DIR="${TARGET}/etc/systemd/system"
mkdir -p "${UNIT_DIR}" "${TARGET}/etc/hannah-robot-os" "${TARGET}/var/lib/hannah-robot-os" "${TARGET}/var/log/hannah-robot-os"

if [[ -d /opt/hannah-robot-os/systemd ]]; then
  cp /opt/hannah-robot-os/systemd/*.service "${UNIT_DIR}/" 2>/dev/null || true
  cp /opt/hannah-robot-os/systemd/*.target "${UNIT_DIR}/" 2>/dev/null || true
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable hannah-robot-os.target || true
  systemctl enable hannah-safety-gateway.service || true
  systemctl enable hannah-hardware-manager.service || true
  systemctl enable hannah-motor-controller.service || true
  systemctl enable hannah-sensor-manager.service || true
else
  echo "systemctl not present; units installed but not enabled." >&2
fi
