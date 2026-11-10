#!/bin/sh
set -eu

repo_root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
destination="$repo_root/.quality-bin"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/louis-security-tools.XXXXXX")
staged="$destination/.gitleaks.$$"
trap 'rm -rf "$temporary"; rm -f "$staged"' 0
trap 'exit 1' HUP INT TERM

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64)
    platform=linux_x64
    expected=9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c ;;
  Linux:aarch64|Linux:arm64)
    platform=linux_arm64
    expected=5f2edbe1f49f7b920f9e06e90759947d3c5dfc16f752fb93aaafc17e9d14cf07 ;;
  Darwin:x86_64|Darwin:amd64)
    platform=darwin_x64
    expected=41c44ae8ad1d6eef57d4526ad0fd67d8129eee9a856f55c2b3b9395fd3d9ec0f ;;
  Darwin:arm64|Darwin:aarch64)
    platform=darwin_arm64
    expected=b90f13bb8c90ab72083d9b0c842e39dafb82c0e5c3f872f407366b7a58909013 ;;
  *) printf '%s\n' 'Unsupported security-tool platform' >&2; exit 1 ;;
esac

archive="$temporary/gitleaks.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$archive" "https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_${platform}.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum < "$archive")
elif command -v shasum >/dev/null 2>&1; then
  digest=$(shasum -a 256 < "$archive")
else
  printf '%s\n' 'A SHA256 utility is required' >&2
  exit 1
fi
[ "${digest%% *}" = "$expected" ] || { printf '%s\n' 'Gitleaks SHA256 mismatch' >&2; exit 1; }
tar -xzf "$archive" -C "$temporary" gitleaks
mkdir -p "$destination"
cp "$temporary/gitleaks" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$destination/gitleaks"
printf '%s\n' 'Installed pinned Gitleaks 8.24.3.'
