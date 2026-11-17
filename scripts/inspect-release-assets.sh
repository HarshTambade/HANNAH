#!/usr/bin/env bash
# Inspect staged release packages before anything is published.
#
#   scripts/inspect-release-assets.sh <assets-dir> [notes-file]
#
# - Every asset is listed in SHA256SUMS and its checksum matches.
# - Archive-type packages (zip, apk, aab, ipa) hold no signing material,
#   environment file or private key (names such as *.p12, *.keystore, .env).
# - The release notes pass the secret scan.
# Disk images, NSIS installers, AppImages and .deb files aren't opened here;
# they're built by CI from the same sources as the archives.
set -euo pipefail

assets="${1:?assets directory}"
notes="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
problems=0

if [ ! -f "$assets/SHA256SUMS" ]; then
  echo "SHA256SUMS is missing from $assets" >&2
  exit 1
fi
for file in "$assets"/*; do
  name="$(basename "$file")"
  [ "$name" = "SHA256SUMS" ] && continue
  if ! grep -q " $name\$" "$assets/SHA256SUMS" && ! grep -q " \*$name\$" "$assets/SHA256SUMS"; then
    echo "::error::$name has no entry in SHA256SUMS"
    problems=$((problems + 1))
  fi
done
(cd "$assets" && sha256sum --check --quiet SHA256SUMS) || { echo "::error::A checksum in SHA256SUMS doesn't match its file"; problems=$((problems + 1)); }

sensitive='\.(p12|pfx|pem|key|keystore|jks|mobileprovision|cer|crt|der|asc|gpg)$|(^|/)\.env(\.|$)|(^|/)(id_rsa|id_ed25519)(\.|$)'
for file in "$assets"/*.zip "$assets"/*.apk "$assets"/*.aab "$assets"/*.ipa; do
  [ -e "$file" ] || continue
  if entries="$(unzip -Z1 "$file" 2>/dev/null)"; then
    if hits="$(printf '%s\n' "$entries" | grep -Ei "$sensitive" | grep -Ev '(^|/)META-INF/[^/]+\.(RSA|DSA|EC|SF)$' || true)" && [ -n "$hits" ]; then
      echo "::error::$(basename "$file") contains files that must never ship:"
      printf '%s\n' "$hits" | sed 's/^/    /'
      problems=$((problems + 1))
    else
      echo "  $(basename "$file"): $(printf '%s\n' "$entries" | wc -l | tr -d ' ') entries, nothing sensitive"
    fi
  else
    echo "::warning::$(basename "$file") couldn't be listed as an archive"
  fi
done

if [ -n "$notes" ] && [ -f "$notes" ]; then
  node "$here/scan-secrets.mjs" --file "$notes" || problems=$((problems + 1))
fi

if [ "$problems" -gt 0 ]; then
  echo "Release inspection found $problems problem(s); nothing was published." >&2
  exit 1
fi
echo "Release inspection passed."
