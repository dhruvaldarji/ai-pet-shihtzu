#!/bin/sh
set -eu

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

for command_name in curl tar gzip xz uname mktemp chmod cp mv mkdir rm; do
  require_command "$command_name"
done

if command -v sha256sum >/dev/null 2>&1; then
  sha256_command=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  sha256_command=shasum
elif command -v sha256 >/dev/null 2>&1; then
  sha256_command=sha256
else
  die "Required command not found: sha256sum, shasum, or sha256"
fi

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH='' cd "$script_dir/.." && pwd)
quality_dir="$repo_root/.quality-bin"
staged_actionlint="$quality_dir/.actionlint.$$"
staged_shellcheck="$quality_dir/.shellcheck.$$"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/louis-quality-tools.XXXXXX")

cleanup() {
  rm -rf "$tmp_dir"
  rm -f "$staged_actionlint" "$staged_shellcheck"
}

trap cleanup 0
trap 'exit 1' HUP INT TERM

system=$(uname -s)
machine=$(uname -m)
case "$system:$machine" in
  Linux:x86_64|Linux:amd64)
    os=linux
    actionlint_arch=amd64
    shellcheck_arch=x86_64
    actionlint_sha=023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757
    shellcheck_sha=6c881ab0698e4e6ea235245f22832860544f17ba386442fe7e9d629f8cbedf87
    ;;
  Linux:aarch64|Linux:arm64)
    os=linux
    actionlint_arch=arm64
    shellcheck_arch=aarch64
    actionlint_sha=401942f9c24ed71e4fe71b76c7d638f66d8633575c4016efd2977ce7c28317d0
    shellcheck_sha=324a7e89de8fa2aed0d0c28f3dab59cf84c6d74264022c00c22af665ed1a09bb
    ;;
  Darwin:x86_64|Darwin:amd64)
    os=darwin
    actionlint_arch=amd64
    shellcheck_arch=x86_64
    actionlint_sha=28e5de5a05fc558474f638323d736d822fff183d2d492f0aecb2b73cc44584f5
    shellcheck_sha=ef27684f23279d112d8ad84e0823642e43f838993bbb8c0963db9b58a90464c2
    ;;
  Darwin:arm64|Darwin:aarch64)
    os=darwin
    actionlint_arch=arm64
    shellcheck_arch=aarch64
    actionlint_sha=2693315b9093aeacb4ebd91a993fea54fc215057bf0da2659056b4bc033873db
    shellcheck_sha=bbd2f14826328eee7679da7221f2bc3afb011f6a928b848c80c321f6046ddf81
    ;;
  *)
    die "Unsupported quality-tool platform: $system $machine"
    ;;
esac

actionlint_archive="actionlint_1.7.7_${os}_${actionlint_arch}.tar.gz"
shellcheck_archive="shellcheck-v0.10.0.${os}.${shellcheck_arch}.tar.xz"
actionlint_url="https://github.com/rhysd/actionlint/releases/download/v1.7.7/$actionlint_archive"
shellcheck_url="https://github.com/koalaman/shellcheck/releases/download/v0.10.0/$shellcheck_archive"

curl --fail --location --proto '=https' --tlsv1.2 --output "$tmp_dir/$actionlint_archive" "$actionlint_url"
curl --fail --location --proto '=https' --tlsv1.2 --output "$tmp_dir/$shellcheck_archive" "$shellcheck_url"

file_sha256() {
  case "$sha256_command" in
    sha256sum)
      output=$(sha256sum "$1")
      ;;
    shasum)
      output=$(shasum -a 256 "$1")
      ;;
    sha256)
      output=$(sha256 -q "$1")
      ;;
  esac
  printf '%s\n' "${output%% *}"
}

verify_sha256() {
  actual_sha=$(file_sha256 "$1")
  [ "$actual_sha" = "$2" ] || die "SHA256 mismatch for $(basename "$1")"
}

verify_sha256 "$tmp_dir/$actionlint_archive" "$actionlint_sha"
verify_sha256 "$tmp_dir/$shellcheck_archive" "$shellcheck_sha"

mkdir "$tmp_dir/actionlint" "$tmp_dir/shellcheck"
tar -xzf "$tmp_dir/$actionlint_archive" -C "$tmp_dir/actionlint" actionlint
tar -xJf "$tmp_dir/$shellcheck_archive" -C "$tmp_dir/shellcheck" "shellcheck-v0.10.0/shellcheck"
chmod 755 "$tmp_dir/actionlint/actionlint" "$tmp_dir/shellcheck/shellcheck-v0.10.0/shellcheck"

mkdir -p "$quality_dir"
cp "$tmp_dir/actionlint/actionlint" "$staged_actionlint"
cp "$tmp_dir/shellcheck/shellcheck-v0.10.0/shellcheck" "$staged_shellcheck"
chmod 755 "$staged_actionlint" "$staged_shellcheck"
mv -f "$staged_actionlint" "$quality_dir/actionlint"
mv -f "$staged_shellcheck" "$quality_dir/shellcheck"

printf '%s\n' 'Installed pinned ShellCheck 0.10.0 and actionlint 1.7.7.'
