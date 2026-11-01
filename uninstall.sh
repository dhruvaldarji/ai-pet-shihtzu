#!/bin/sh
set -eu

louis_root="${LOUIS_CODEX_DIR:-${HOME:?HOME is not set}/.codex}"
louis_target="$louis_root/pets/louis"

if [ -L "$louis_target" ]; then
  printf '%s\n' "Louis is a symbolic link. Remove that link manually if you want to stop using it." >&2
  exit 1
fi
if [ ! -e "$louis_target" ]; then
  printf '%s\n' "Louis is not installed."
  exit 0
fi
if [ ! -d "$louis_target" ]; then
  printf 'The Louis path is not a folder: %s\n' "$louis_target" >&2
  exit 1
fi

mkdir -p "$louis_root/pet-backups"
louis_backup=$(mktemp -d "$louis_root/pet-backups/louis-removed-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
mv "$louis_target" "$louis_backup/louis"
printf 'Removed Louis from the pet folder. Backup saved at: %s\n' "$louis_backup/louis"
