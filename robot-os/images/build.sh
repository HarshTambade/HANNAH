#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-}"
if [[ "${PROFILE}" == "--profile" ]]; then
  PROFILE="${2:-}"
fi

if [[ -z "${PROFILE}" ]]; then
  echo "Usage: $0 --profile <profile-id>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES="$ROOT/image-profiles/profiles.json"

python3 "$ROOT/tools/validate_manifests.py"

if ! python3 - "$PROFILES" "$PROFILE" <<'PY'
import json,sys
p=json.load(open(sys.argv[1]))
pid=sys.argv[2]
ids=[x['id'] for x in p.get('profiles',[])]
sys.exit(0 if pid in ids else 3)
PY
then
  echo "Unknown profile: $PROFILE" >&2
  exit 3
fi

echo "Profile manifest validated: $PROFILE"
echo "Checking build dependencies..."
for cmd in docker podman ubuntu-image snapcraft mkfs.ext4 qemu-system-x86_64; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "  found: $cmd"
  else
    echo "  missing: $cmd"
  fi
done

echo ""
echo "No image build executed by this script in the current environment unless required build tools and target definitions are present."
echo "This script currently validates manifests and reports build prerequisites. Full image build requires Linux build host/CI (RB2)."
exit 0
