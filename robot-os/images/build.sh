#!/usr/bin/env bash
# Build a HANNAH Robot OS disk image for one profile in image-profiles/profiles.json.
#
#   build.sh --profile robotos-dev-x86_64 [--out DIR] [--version X.Y.Z] [--rt]
#            [--splash] [--update-url URL --update-pubring FILE] [--dry-run]
#
# Assembles an mkosi project from images/mkosi/common + images/mkosi/boards/<board>
# + the Robot OS package, units and config, then runs mkosi on it. Building needs
# Linux and mkosi (see images/mkosi/VERSIONS); --dry-run assembles the project
# and prints the mkosi command on any system, macOS included, and builds nothing.
#
# Output: DIR/output/hannah-robot-os_<version>.raw (a GPT disk image), the mkosi
# manifest, and DIR/output/SHA256SUMS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MKOSI_SRC="$ROOT/images/mkosi"

PROFILE=""
OUT=""
VERSION=""
FORCE_RT=0
SPLASH=0
DRY_RUN=0
UPDATE_URL=""
UPDATE_PUBRING=""

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --rt) FORCE_RT=1; shift ;;
    --splash) SPLASH=1; shift ;;
    --update-url) UPDATE_URL="${2:-}"; shift 2 ;;
    --update-pubring) UPDATE_PUBRING="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$PROFILE" ]] || usage

python3 "$ROOT/tools/validate_manifests.py"

# Read the profile's image settings: arch, board, kernel.
IMAGE_VARS="$(python3 - "$ROOT/image-profiles/profiles.json" "$PROFILE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
for p in data["profiles"]:
    if p["id"] == sys.argv[2]:
        img = p["image"]
        print(f'ARCH={img["arch"]}')
        print(f'BOARD={img["board"]}')
        print(f'KERNEL={img["kernel"]}')
        print(f'STATUS={p["status"]}')
        sys.exit(0)
sys.exit(3)
PY
)" || { echo "Unknown profile: $PROFILE" >&2; exit 3; }
ARCH="$(printf '%s\n' "$IMAGE_VARS" | sed -n 's/^ARCH=//p')"
BOARD="$(printf '%s\n' "$IMAGE_VARS" | sed -n 's/^BOARD=//p')"
KERNEL="$(printf '%s\n' "$IMAGE_VARS" | sed -n 's/^KERNEL=//p')"
STATUS="$(printf '%s\n' "$IMAGE_VARS" | sed -n 's/^STATUS=//p')"
if [[ "$FORCE_RT" == 1 ]]; then KERNEL=rt; fi

if [[ -z "$VERSION" ]]; then
  VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/pyproject.toml" | head -n 1)"
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.~+-][A-Za-z0-9.]+)?$ ]]; then
  echo "Invalid version: $VERSION" >&2; exit 2
fi

case "$ARCH" in
  x86-64) DEB_ARCH=amd64; SERIAL="console=tty0 console=ttyS0,115200" ;;
  arm64) DEB_ARCH=arm64; SERIAL="console=tty0 console=ttyAMA0,115200" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 2 ;;
esac
if [[ "$KERNEL" == rt ]]; then KERNEL_PKG="linux-image-rt-$DEB_ARCH"; else KERNEL_PKG="linux-image-$DEB_ARCH"; fi
CMDLINE="$SERIAL"
if [[ "$SPLASH" == 1 ]]; then CMDLINE="$CMDLINE splash"; fi

# Pinned versions.
# shellcheck source=mkosi/VERSIONS
. "$MKOSI_SRC/VERSIONS"

if [[ -n "$UPDATE_URL" ]]; then
  [[ "$UPDATE_URL" == https://* ]] || { echo "--update-url must be https://" >&2; exit 2; }
  [[ -f "$UPDATE_PUBRING" ]] || { echo "--update-url needs --update-pubring FILE (the GPG key updates are signed with)" >&2; exit 2; }
  [[ "$BOARD" == uefi ]] || { echo "signed A/B updates are implemented for the uefi board only" >&2; exit 2; }
fi

OUT="${OUT:-$ROOT/images/out/$PROFILE}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
PROJECT="$OUT/project"
rm -rf "$PROJECT"
mkdir -p "$PROJECT" "$OUT/output"

# --- Assemble the mkosi project ---------------------------------------------
cp -R "$MKOSI_SRC/common/." "$PROJECT/"
cp -R "$MKOSI_SRC/boards/$BOARD/." "$PROJECT/"
for f in "$PROJECT"/mkosi.repart/*.conf; do
  sed "s/@IMAGE_VERSION@/$VERSION/g" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

EXTRA="$PROJECT/mkosi.extra"
mkdir -p "$EXTRA/opt/hannah-robot-os" "$EXTRA/usr/lib/systemd/system" "$EXTRA/etc/hannah-robot-os" "$EXTRA/usr/lib/hannah"
cp -R "$ROOT/src" "$EXTRA/opt/hannah-robot-os/src"
find "$EXTRA/opt/hannah-robot-os/src" -name '__pycache__' -type d -prune -exec rm -rf {} +
find "$EXTRA/opt/hannah-robot-os/src" -name '*.egg-info' -type d -prune -exec rm -rf {} +
cp "$ROOT/README.md" "$ROOT/pyproject.toml" "$EXTRA/opt/hannah-robot-os/"
cp "$ROOT"/systemd/*.service "$ROOT"/systemd/*.target "$ROOT"/systemd/*.timer "$EXTRA/usr/lib/systemd/system/"
python3 - "$ROOT/config/default-config.json" "$PROFILE" "$EXTRA/etc/hannah-robot-os/config.json" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
cfg["profile"] = sys.argv[2]
open(sys.argv[3], "w").write(json.dumps(cfg, indent=2) + "\n")
PY

GIT_COMMIT="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
cat > "$EXTRA/usr/lib/hannah/build-info" <<EOF
HANNAH_PROFILE=$PROFILE
HANNAH_BOARD=$BOARD
HANNAH_ARCH=$ARCH
HANNAH_KERNEL=$KERNEL
HANNAH_IMAGE_VERSION=$VERSION
HANNAH_GIT_COMMIT=$GIT_COMMIT
EOF

if [[ -n "$UPDATE_URL" ]]; then
  mkdir -p "$EXTRA/usr/lib/sysupdate.d" "$EXTRA/usr/lib/systemd"
  for t in "$MKOSI_SRC"/sysupdate/*.transfer.in; do
    name="$(basename "$t" .in)"
    sed -e "s#@UPDATE_URL@#$UPDATE_URL#g" -e "s/@ARCH@/$ARCH/g" "$t" > "$EXTRA/usr/lib/sysupdate.d/$name"
  done
  cp "$UPDATE_PUBRING" "$EXTRA/usr/lib/systemd/import-pubring.gpg"
fi

SEED="$(python3 -c 'import sys, uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, "hannah-robot-os/" + sys.argv[1] + "/" + sys.argv[2]))' "$PROFILE" "$VERSION")"
mkdir -p "$PROJECT/mkosi.conf.d"
{
  echo "# Generated by build.sh for $PROFILE. Do not edit."
  echo "[Distribution]"
  echo "Architecture=$ARCH"
  if [[ -n "${DEBIAN_SNAPSHOT:-}" ]]; then
    echo "Mirror=https://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT/"
  fi
  echo
  echo "[Output]"
  echo "ImageVersion=$VERSION"
  echo "OutputDirectory=$OUT/output"
  echo "Seed=$SEED"
  echo
  echo "[Content]"
  echo "Packages=$KERNEL_PKG"
  if [[ "$BOARD" == uefi ]]; then
    echo "KernelCommandLine=$CMDLINE"
  fi
} > "$PROJECT/mkosi.conf.d/00-build.conf"

MKOSI_CMD=(mkosi --directory "$PROJECT"
  --tools-tree=default
  "--tools-tree-distribution=$TOOLS_TREE_DISTRIBUTION"
  "--tools-tree-release=$TOOLS_TREE_RELEASE"
  --force build)

echo "Profile:  $PROFILE ($STATUS)"
echo "Board:    $BOARD   Arch: $ARCH   Kernel: $KERNEL ($KERNEL_PKG)   Version: $VERSION"
echo "Project:  $PROJECT"
echo "mkosi:    $MKOSI_VERSION pinned (images/mkosi/VERSIONS)"
echo "Command:  ${MKOSI_CMD[*]}"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "Dry run: project assembled, no image built."
  exit 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Building the image needs Linux (mkosi builds with Linux namespaces). Nothing was built; use --dry-run here." >&2
  exit 4
fi
if ! command -v mkosi >/dev/null 2>&1; then
  echo "mkosi is not installed (pinned: $MKOSI_VERSION; see images/mkosi/VERSIONS). Nothing was built." >&2
  exit 4
fi

if git -C "$ROOT" log -1 --format=%ct >/dev/null 2>&1; then
  SOURCE_DATE_EPOCH="$(git -C "$ROOT" log -1 --format=%ct)"
  export SOURCE_DATE_EPOCH
fi

"${MKOSI_CMD[@]}"

cd "$OUT/output"
shopt -s nullglob
files=(hannah-robot-os_"$VERSION"*)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "mkosi finished but wrote no hannah-robot-os_$VERSION* output" >&2
  exit 5
fi
sha256sum "${files[@]}" > SHA256SUMS
cat SHA256SUMS
