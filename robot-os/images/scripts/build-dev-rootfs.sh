#!/usr/bin/env bash
# Build a minimal Ubuntu 24.04 (noble) rootfs with HANNAH Robot OS installed.
# Requires Linux + debootstrap + root. This is a build definition/template: no
# image build is claimed until it is executed and validated on a Linux host.
set -euo pipefail

ROOTFS="${1:-/tmp/hannah-robot-os-rootfs}"
SUITE="${SUITE:-noble}"
ARCH="${ARCH:-amd64}"
MIRROR="${MIRROR:-http://archive.ubuntu.com/ubuntu}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script requires Linux (debootstrap/chroot)." >&2
  exit 2
fi
for cmd in debootstrap chroot tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then echo "missing: $cmd" >&2; exit 3; fi
done
if [[ "$(id -u)" != "0" ]]; then echo "Run as root." >&2; exit 4; fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
rm -rf "${ROOTFS}"
mkdir -p "${ROOTFS}"
debootstrap --arch="${ARCH}" "${SUITE}" "${ROOTFS}" "${MIRROR}"

mkdir -p "${ROOTFS}/opt/hannah-robot-os" "${ROOTFS}/etc/hannah-robot-os"
cp -a "${SRC}/." "${ROOTFS}/opt/hannah-robot-os/"
cp "${SRC}/config/default-config.json" "${ROOTFS}/etc/hannah-robot-os/config.json"

chroot "${ROOTFS}" /bin/bash -lc 'apt-get update && apt-get install -y python3 python3-venv ca-certificates systemd && apt-get clean'

cat > "${ROOTFS}/usr/sbin/hannah-firstboot" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# First-boot: set hostname, create operator user, run doctor; enrollment is interactive.
hostnamectl set-hostname hannah-robot 2>/dev/null || true
if ! id -u hannah-ros >/dev/null 2>&1; then useradd -m -s /bin/bash hannah-ros; fi
PYTHONPATH=/opt/hannah-robot-os/src python3 -m hannah_robot_os doctor || true
systemctl disable hannah-firstboot.service 2>/dev/null || true
EOF
chmod +x "${ROOTFS}/usr/sbin/hannah-firstboot"

bash "${SRC}/images/scripts/enable-services.sh" "${ROOTFS}"

OUT="${OUT:-${ROOTFS}.tar.gz}"
tar -C "${ROOTFS}" -czf "${OUT}" .
echo "rootfs archive: ${OUT}"
