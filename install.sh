#!/bin/sh
set -eu

louis_source=$(CDPATH='' cd -P "$(dirname "$0")" && pwd)
louis_root="${LOUIS_CODEX_DIR:-${CODEX_HOME:-${HOME:?HOME is not set}/.codex}}"
louis_stage=
louis_backup=
louis_locked=
louis_stage_writable=

fail() { printf '%s\n' "$*" >&2; exit 1; }
finish_install() {
  louis_exit=$?
  if [ -n "$louis_backup" ] && [ -d "$louis_backup/louis" ] && [ ! -e "$louis_target" ] && [ ! -L "$louis_target" ]; then
    if mv "$louis_backup/louis" "$louis_target"; then
      printf 'Previous Louis restored at: %s\n' "$louis_target" >&2
      rmdir "$louis_backup" || :
    else
      printf 'Restore Louis manually from: %s/louis\n' "$louis_backup" >&2
      louis_exit=1
    fi
  fi
  if [ -n "$louis_stage" ] && [ -d "$louis_stage" ]; then
    printf 'Unfinished install files kept at: %s\n' "$louis_stage" >&2
  fi
  if [ -n "$louis_locked" ]; then
    rmdir "$louis_lock" || louis_exit=1
  fi
  exit "$louis_exit"
}
trap finish_install EXIT
trap 'exit 1' HUP INT TERM

# Verify the complete package before creating folders or moving an existing pet.
# Checksums detect changed bytes, not publisher identity or visual acceptance.
# The package builder validates the JSON manifest and native image format.
louis_payload='.gitignore README.md RELEASE_NOTES.md pet.json spritesheet.webp preview.gif install.sh uninstall.sh'
# If either legal text is present, require and verify both before any target mutation.
if [ -e "$louis_source/LICENSE" ] || [ -L "$louis_source/LICENSE" ] ||
   [ -e "$louis_source/LICENSE-ARTWORK" ] || [ -L "$louis_source/LICENSE-ARTWORK" ]; then
  louis_payload="$louis_payload LICENSE LICENSE-ARTWORK"
fi
for louis_file in $louis_payload SHA256SUMS; do
  if [ -L "$louis_source/$louis_file" ] || [ ! -f "$louis_source/$louis_file" ] ||
    [ ! -r "$louis_source/$louis_file" ] || [ ! -s "$louis_source/$louis_file" ]; then
    fail "Missing, empty, unreadable, or linked package file: $louis_file"
  fi
done
louis_sums=$(cat "$louis_source/SHA256SUMS") || fail "Cannot read SHA256SUMS"
printf '%s\n' "$louis_sums" | LC_ALL=C awk -v files="$louis_payload" '
  BEGIN { count=split(files, names, " "); for(i=1;i<=count;i++) required[names[i]]=1 }
  {
    sub(/\r$/, "")
    hash=substr($0,1,64); name=substr($0,67)
    if(length(hash)!=64 || hash ~ /[^0-9a-f]/ || substr($0,65,2)!="  " || !(name in required) || seen[name]++) exit 1
  }
  END { for(name in required) if(!seen[name]) exit 1 }
' || fail "SHA256SUMS must contain exactly one valid entry for each package file"

if command -v shasum >/dev/null 2>&1; then
  louis_hash_tool=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  louis_hash_tool=sha256sum
else
  fail "A SHA256 tool is required: shasum or sha256sum"
fi
package_hash() {
  if [ "$louis_hash_tool" = shasum ]; then
    louis_hash_output=$(shasum -a 256 < "$1") || return 1
  else
    louis_hash_output=$(sha256sum < "$1") || return 1
  fi
  printf '%s\n' "${louis_hash_output%% *}"
}
expected_hash() {
  printf '%s\n' "$louis_sums" | LC_ALL=C awk -v name="$1" '{ sub(/\r$/, ""); if(substr($0,67)==name) print substr($0,1,64) }'
}
for louis_file in $louis_payload; do
  louis_expected=$(expected_hash "$louis_file") || fail "Cannot read checksum for $louis_file"
  louis_actual=$(package_hash "$louis_source/$louis_file") || fail "Cannot hash package file: $louis_file"
  [ "$louis_actual" = "$louis_expected" ] || fail "Package checksum mismatch: $louis_file"
done

mkdir -p "$louis_root"
louis_root=$(CDPATH='' cd -P "$louis_root" && printf '%s/' "$PWD")
louis_root=${louis_root%/}
louis_pets="$louis_root/pets"
louis_target="$louis_pets/louis"
louis_lock="$louis_root/.louis-lock"
check_parents() {
  for louis_parent in "$louis_pets" "$louis_root/pet-backups"; do
    [ ! -L "$louis_parent" ] || fail "Managed parent is a symbolic link: $louis_parent"
    [ ! -e "$louis_parent" ] || [ -d "$louis_parent" ] || fail "Managed parent is not a folder: $louis_parent"
  done
}
check_parents
(umask 077; mkdir "$louis_lock") 2>/dev/null || fail "Another Louis operation may be running. Lock: $louis_lock"
louis_locked=1
check_parents
[ ! -L "$louis_target" ] || fail "Louis is a symbolic link. Save or remove that link before installing."
[ ! -e "$louis_target" ] || [ -d "$louis_target" ] || fail "The Louis path exists but is not a folder: $louis_target"

louis_same=1
for louis_file in pet.json spritesheet.webp; do
  if [ -L "$louis_target/$louis_file" ] || [ ! -f "$louis_target/$louis_file" ]; then
    louis_same=
    break
  fi
  louis_actual=$(package_hash "$louis_target/$louis_file") || fail "Cannot hash installed file: $louis_file"
  louis_expected=$(expected_hash "$louis_file") || fail "Cannot read checksum for $louis_file"
  if [ "$louis_actual" != "$louis_expected" ]; then louis_same=; break; fi
done
if [ -n "$louis_same" ]; then
  printf 'Louis is already up to date at: %s\n' "$louis_target"
  exit 0
fi

mkdir -p "$louis_pets" "$louis_root/pet-backups"
louis_stage=$(mktemp -d "$louis_pets/.louis-install.XXXXXX")
louis_stage_writable=writable
if [ -d "$louis_target" ]; then
  cp -R -P -p "$louis_target/." "$louis_stage/"
  louis_stage_writable=$(find "$louis_stage" -prune -perm -0200 -exec printf writable \;)
  chmod u+w "$louis_stage"
fi
for louis_file in pet.json spritesheet.webp; do
  # Never write through a preserved link or replace a user's directory as payload.
  [ ! -d "$louis_stage/$louis_file" ] || [ -L "$louis_stage/$louis_file" ] || fail "Installed payload path is a folder: $louis_file"
  rm -f "$louis_stage/$louis_file"
  cp "$louis_source/$louis_file" "$louis_stage/$louis_file"
  louis_expected=$(expected_hash "$louis_file") || fail "Cannot read checksum for $louis_file"
  louis_actual=$(package_hash "$louis_stage/$louis_file") || fail "Cannot hash staged file: $louis_file"
  [ "$louis_actual" = "$louis_expected" ] || fail "Staged checksum mismatch: $louis_file"
done
if [ -d "$louis_target" ] && [ -z "$louis_stage_writable" ]; then
  chmod u-w "$louis_stage"
fi

if [ -d "$louis_target" ]; then
  mkdir -p "$louis_root/pet-backups"
  louis_backup=$(mktemp -d "$louis_root/pet-backups/louis-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
  mv "$louis_target" "$louis_backup/louis"
  printf 'Previous Louis saved at: %s\n' "$louis_backup/louis"
fi

mv "$louis_stage" "$louis_target" || fail "Install failed. Louis was not updated."
louis_stage=
printf 'Installed local Louis files at: %s\nThis does not update a ChatGPT Work cloud pet.\nSelect the intended pet and check its artwork on screen.\n' "$louis_target"
