#!/usr/bin/env bash
# Boot a HANNAH Robot OS UEFI disk image headless in QEMU and pass only when
# the image says it is ready on its serial console:
#
#   HANNAH Robot OS READY            (hannah-robot-os ready: required services report ready)
#   HANNAH-BOOT-CHECK: hannah-robot-os.target active
#   HANNAH-BOOT-CHECK: PASS ...
#
#   qemu-smoke.sh <disk.raw> [--arch x86_64|aarch64] [--log FILE] [--timeout SECONDS]
#
# The image is opened read-only (QEMU snapshot), so the file is unchanged.
# Uses KVM when /dev/kvm is usable, otherwise software emulation (slow).
# Needs qemu-system-<arch> and UEFI firmware (OVMF for x86_64, AAVMF for aarch64).
set -euo pipefail

IMAGE=""
ARCH=x86_64
LOG=""
TIMEOUT="${QEMU_TIMEOUT_S:-900}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) ARCH="${2:-}"; shift 2 ;;
    --log) LOG="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" >&2; exit 2 ;;
    *) IMAGE="$1"; shift ;;
  esac
done

if [[ -z "$IMAGE" || ! -f "$IMAGE" ]]; then
  echo "Usage: $0 <disk.raw> [--arch x86_64|aarch64] [--log FILE] [--timeout SECONDS]" >&2
  exit 2
fi
LOG="${LOG:-$(mktemp)}"
: > "$LOG"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

first_file() {
  local f
  for f in "$@"; do
    if [[ -f "$f" ]]; then echo "$f"; return 0; fi
  done
  return 1
}

ACCEL=tcg
if [[ -r /dev/kvm && -w /dev/kvm && "$(uname -m)" == "$ARCH" ]]; then ACCEL=kvm; fi

case "$ARCH" in
  x86_64)
    QEMU=qemu-system-x86_64
    CODE="$(first_file /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_CODE.fd /usr/share/edk2/ovmf/OVMF_CODE.fd)" || { echo "missing OVMF firmware (apt install ovmf)" >&2; exit 3; }
    VARS="$(first_file /usr/share/OVMF/OVMF_VARS_4M.fd /usr/share/OVMF/OVMF_VARS.fd /usr/share/edk2/ovmf/OVMF_VARS.fd)" || { echo "missing OVMF vars" >&2; exit 3; }
    MACHINE=(-machine "q35,accel=$ACCEL" -device i6300esb)
    if [[ "$ACCEL" == kvm ]]; then CPU=host; else CPU=max; fi
    ;;
  aarch64)
    QEMU=qemu-system-aarch64
    CODE="$(first_file /usr/share/AAVMF/AAVMF_CODE.fd /usr/share/qemu-efi-aarch64/QEMU_EFI.fd)" || { echo "missing AAVMF firmware (apt install qemu-efi-aarch64)" >&2; exit 3; }
    VARS="$(first_file /usr/share/AAVMF/AAVMF_VARS.fd)" || { echo "missing AAVMF vars" >&2; exit 3; }
    MACHINE=(-machine "virt,accel=$ACCEL")
    if [[ "$ACCEL" == kvm ]]; then CPU=host; else CPU=max; fi
    ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 2 ;;
esac
command -v "$QEMU" >/dev/null 2>&1 || { echo "missing $QEMU" >&2; exit 3; }
cp "$VARS" "$WORK/vars.fd"

echo "Booting $IMAGE ($ARCH, $ACCEL, timeout ${TIMEOUT}s); serial log: $LOG"
"$QEMU" "${MACHINE[@]}" -cpu "$CPU" -m 2048 -smp 2 \
  -display none -monitor none -serial "file:$LOG" -no-reboot \
  -drive "if=pflash,format=raw,unit=0,readonly=on,file=$CODE" \
  -drive "if=pflash,format=raw,unit=1,file=$WORK/vars.fd" \
  -drive "if=virtio,format=raw,file=$IMAGE,snapshot=on" \
  -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
  -device virtio-rng-pci &
QEMU_PID=$!

result=1
reason="timed out after ${TIMEOUT}s"
start=$SECONDS
while (( SECONDS - start < TIMEOUT )); do
  if grep -q "HANNAH-BOOT-CHECK: PASS" "$LOG"; then result=0; reason="PASS seen"; break; fi
  if grep -q "HANNAH-BOOT-CHECK: FAIL" "$LOG"; then reason="the image reported FAIL"; break; fi
  if ! kill -0 "$QEMU_PID" 2>/dev/null; then reason="QEMU exited"; break; fi
  sleep 5
done
kill "$QEMU_PID" 2>/dev/null || true
wait "$QEMU_PID" 2>/dev/null || true

if [[ "$result" == 0 ]]; then
  for marker in "HANNAH Robot OS READY" "HANNAH-BOOT-CHECK: hannah-robot-os.target active"; do
    if ! grep -q "$marker" "$LOG"; then result=1; reason="missing '$marker'"; fi
  done
fi

echo "----- last 120 lines of the serial console -----"
tail -n 120 "$LOG" || true
echo "------------------------------------------------"
if [[ "$result" == 0 ]]; then
  echo "QEMU boot check: PASS ($(grep -m1 'HANNAH-BOOT-CHECK: PASS' "$LOG"))"
else
  echo "QEMU boot check: FAIL ($reason)" >&2
fi
exit "$result"
