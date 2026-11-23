#!/usr/bin/env bash
# QEMU smoke boot template. Needs a kernel, initrd and rootfs image supplied by
# the caller. Prints the serial console and passes if the READY marker appears.
set -euo pipefail

KERNEL="${1:-}"
INITRD="${2:-}"
ROOTFS="${3:-}"
for f in "${KERNEL}" "${INITRD}" "${ROOTFS}"; do
  if [[ -z "${f}" || ! -f "${f}" ]]; then echo "Usage: $0 <kernel> <initrd> <rootfs-img>" >&2; exit 2; fi
done
if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then echo "missing qemu-system-x86_64" >&2; exit 3; fi

LOG="$(mktemp)"
timeout "${QEMU_TIMEOUT_S:-120}" qemu-system-x86_64 \
  -m 1024 -smp 2 -nographic -no-reboot \
  -kernel "${KERNEL}" -initrd "${INITRD}" \
  -append "console=ttyS0 root=/dev/sda1 rw systemd.unit=hannah-robot-os.target" \
  -drive file="${ROOTFS}",format=raw 2>&1 | tee "${LOG}" || true

if grep -q "HANNAH Robot OS READY" "${LOG}"; then
  echo "QEMU smoke: READY marker seen"
  exit 0
fi
echo "QEMU smoke: READY marker not seen (no boot claim made)" >&2
exit 1
