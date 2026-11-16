#!/usr/bin/env bash
# Collect the platform packages built by CI into one folder with stable names
# (the website's download links use them), keep electron-updater working, and
# write SHA256SUMS.
#
#   scripts/stage-release-assets.sh <downloaded-artifacts-dir> <output-dir>
#
# Required: the desktop installers and the Android APK. Optional, included
# only when their signing credentials exist: the Android App Bundle (Play
# upload key) and the iOS IPA (Apple distribution signing). What was signed is
# written to <output-dir>/../SIGNING_STATUS for the release notes.
set -euo pipefail

input="${1:?artifacts directory}"
output="${2:?output directory}"
mkdir -p "$output"
status_file="$(dirname "$output")/SIGNING_STATUS"
: > "$status_file"
renames="$(mktemp)"
trap 'rm -f "$renames"' EXIT

# First matching file, skipping the unpacked app folders electron-builder leaves next to installers.
first() {
  find "$1" -type f -iname "$2" ! -path '*-unpacked/*' ! -path '*/mac*/HANNAH.app/*' -print 2>/dev/null | sort | head -n 1
}

stage() {
  local root="$1" pattern="$2" name="$3" required="$4" source
  source="$(first "$root" "$pattern")"
  if [ -z "$source" ]; then
    if [ "$required" = "required" ]; then
      echo "Missing required release package: $pattern under $root" >&2
      exit 1
    fi
    return 1
  fi
  cp "$source" "$output/$name"
  printf '%s\t%s\n' "$(basename "$source")" "$name" >> "$renames"
  echo "  $name  <-  $(basename "$source")"
}

dir_for() { find "$input" -maxdepth 1 -type d -name "$1" -print -quit; }
mac="$(dir_for 'hannah-electron-macos*')"
win="$(dir_for 'hannah-electron-windows*')"
linux="$(dir_for 'hannah-electron-ubuntu*')"
android="$input/hannah-android"
ios="$input/hannah-ios-archive"
for dir in "$mac" "$win" "$linux" "$android"; do
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    echo "Missing a platform build artifact (macOS, Windows, Linux or Android)." >&2
    exit 1
  fi
done

echo "Staging release packages:"
stage "$mac" '*arm64*.dmg' 'HANNAH-macOS-AppleSilicon.dmg' required
stage "$mac" '*x64*.dmg' 'HANNAH-macOS-Intel.dmg' required
stage "$win" '*-win-*.exe' 'HANNAH-Windows.exe' required
stage "$linux" '*.AppImage' 'HANNAH-Linux.AppImage' required
stage "$linux" '*.deb' 'HANNAH-Linux.deb' required

# The release-signed APK when the Play keystore exists, otherwise the debug-signed build.
if stage "$android" '*-release.apk' 'HANNAH-Android.apk' optional; then
  echo "android=release-signed" >> "$status_file"
else
  stage "$android" '*-debug.apk' 'HANNAH-Android.apk' required
  echo "android=debug-signed" >> "$status_file"
fi
if stage "$android" '*.aab' 'HANNAH-Android.aab' optional; then echo "aab=yes" >> "$status_file"; else echo "aab=no" >> "$status_file"; fi
if [ -d "$ios" ] && stage "$ios" '*.ipa' 'HANNAH-iOS.ipa' optional; then echo "ios=signed" >> "$status_file"; else echo "ios=none" >> "$status_file"; fi

# electron-updater: macOS updates from the zip files, Windows and Linux from the
# installers. Publish the manifests with renamed files, plus the zips and the
# blockmaps (for delta updates) under names that match.
for root in "$mac" "$win" "$linux"; do
  while IFS= read -r file; do cp "$file" "$output/"; done < <(find "$root" -maxdepth 3 -type f \( -name 'latest*.yml' -o -iname '*-mac-*.zip' -o -iname '*-mac-*.zip.blockmap' \))
  while IFS=$'\t' read -r original renamed; do
    blockmap="$(find "$root" -maxdepth 3 -type f -name "$original.blockmap" -print -quit)"
    [ -n "$blockmap" ] && cp "$blockmap" "$output/$renamed.blockmap"
  done < "$renames"
done
for manifest in latest.yml latest-mac.yml latest-linux.yml; do
  if [ ! -f "$output/$manifest" ]; then
    echo "Missing electron-updater manifest: $manifest" >&2
    exit 1
  fi
  while IFS=$'\t' read -r original renamed; do
    ORIGINAL="$original" RENAMED="$renamed" perl -pi -e 's/(?<![\w.-])\Q$ENV{ORIGINAL}\E(?![\w.-])/$ENV{RENAMED}/g' "$output/$manifest"
  done < "$renames"
  # Staged rollout (docs/CANARY_RELEASE.md): desktop updates reach 10% of installs first.
  if ! grep -q '^stagingPercentage:' "$output/$manifest"; then printf 'stagingPercentage: 10\n' >> "$output/$manifest"; fi
done

if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
(cd "$output" && find . -maxdepth 1 -type f ! -name SHA256SUMS | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r file; do "${sum[@]}" "$file"; done > SHA256SUMS)
echo "Wrote SHA256SUMS for $(wc -l < "$output/SHA256SUMS") files."
cat "$status_file"
