#!/bin/sh
set -eu

louis_root="${LOUIS_CODEX_DIR:-${CODEX_HOME:-${HOME:?HOME is not set}/.codex}}"
louis_locked=
fail() { printf '%s\n' "$*" >&2; exit 1; }
finish_uninstall() {
  louis_exit=$?
  if [ -n "$louis_locked" ]; then rmdir "$louis_lock" || louis_exit=1; fi
  exit "$louis_exit"
}
trap finish_uninstall EXIT
trap 'exit 1' HUP INT TERM

if [ ! -e "$louis_root" ] && [ ! -L "$louis_root" ]; then
  printf '%s\n' "Louis is not installed."
  exit 0
fi
louis_root=$(CDPATH= cd -P "$louis_root" && printf '%s/' "$PWD")
louis_root=${louis_root%/}
louis_target="$louis_root/pets/louis"
louis_lock="$louis_root/.louis-lock"
check_parents() {
  for louis_parent in "$louis_root/pets" "$louis_root/pet-backups"; do
    [ ! -L "$louis_parent" ] || fail "Managed parent is a symbolic link: $louis_parent"
    [ ! -e "$louis_parent" ] || [ -d "$louis_parent" ] || fail "Managed parent is not a folder: $louis_parent"
  done
}
check_parents
(umask 077; mkdir "$louis_lock") 2>/dev/null || fail "Another Louis operation may be running. Lock: $louis_lock"
louis_locked=1
check_parents

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
