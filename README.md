# Louis

Louis rules the day with tiny acts of mischief and very important naps.

Louis is a small Shih Tzu for your desktop. He naps, runs, follows your cursor, and reacts while you work.

Louis is a hobby pet project, not an official OpenAI product. No plugin is required. Support and updates are best effort.

## Compatibility

- The package uses sprite format v2: 1536 × 2288 pixels, eight columns and eleven rows.
- The local scripts target POSIX environments such as macOS and Linux. Automated file/build checks do not prove native app selection or visible playback.
- Native playback and direct-install links remain unverified. Windows installation and ChatGPT web/cloud upload are not supported by this release guidance; the current sheet has not been accepted for those flows.
- The app controls animation timing and may skip the first-use wave. Selecting Louis again may not replay it.

## Install

Give your Codex agent this prompt:

```text
Install Louis as a local pet from https://github.com/dhruvaldarji/ai-pet-shihtzu. Verify the package and confirm my app and local target first. Do not upload it to a cloud pet.
```

Ask the agent to follow [AGENTS.md](AGENTS.md). This prompt is a request, not a guarantee of app compatibility or automatic installation.

### Manual local installation

Use a versioned ZIP such as `louis-v1.0.0.zip` from [Releases](https://github.com/dhruvaldarji/ai-pet-shihtzu/releases) when one is available. Compare its SHA256 with the published checksum, then extract it and verify its internal `SHA256SUMS`. Checksums detect changed bytes, not publisher identity. If no release is available, [build a chosen source commit](CONTRIBUTING.md#build-a-package); do not install synthetic fixtures or run the source-root installer as if it were a complete package.

Run `sh install.sh` from the extracted package folder. The root is the first nonempty value of `LOUIS_CODEX_DIR`, `CODEX_HOME`, or `$HOME/.codex`; set `LOUIS_CODEX_DIR` explicitly for a different root. Keep that same root for updates and uninstall. The installer checks the package before replacing files and reports the backup location for an existing Louis.

Select Louis in the app if needed and check its appearance. A successful script only establishes local file installation, not visible playback or cloud delivery.

## Local updates and recovery

The local root is the first nonempty value of `LOUIS_CODEX_DIR`, `CODEX_HOME`, or
`$HOME/.codex`. Use the same root for installation, updates, and removal.

To update, verify and extract the new release, then run `sh install.sh` there.
The complete package is checked first. If the installed `pet.json` and sprite
hashes already match, nothing is replaced and no backup is created. Otherwise,
the installer preserves custom files, stages the new payload, and saves the
complete previous pet under `pet-backups/` before replacement. Other pets stay
unchanged. A failed replacement attempts to restore the previous pet; if that
fails, the error identifies the retained backup and staging folder.

Run `sh uninstall.sh` to move Louis into a complete backup. Repeating removal
when Louis is absent is a no-op. To restore, close the app, stop other pet
operations, remove any current Louis with the uninstaller, then copy the chosen backup's `louis`
folder into the root's `pets/` folder. The destination must not already exist
or be a symbolic link. Do not merge folders or overwrite another pet. Keep the
backup until you reopen the app and verify selection and playback.

The explicitly chosen root may resolve through platform or user directory
aliases. Inside it, `pets`, `pet-backups`, and the Louis target must not be
symbolic links. Both scripts use the same per-pet lock and refuse overlapping
operations. After a crash, remove an empty `.louis-lock` directory with `rmdir`
only after confirming no installer or uninstaller is still running. Do not
edit managed folders concurrently with either script.

These are local file operations, not automatic background updates. Select or
refresh Louis in the intended app and check the artwork after an update.

Updates are user-requested. These scripts do not check GitHub, download new releases, or schedule background updates. Installing local files never updates a cloud pet.

## Privacy

The pet payload is artwork and metadata, not executable app code. The bundled build/install scripts contain no telemetry, analytics, or upload calls. Builds read source files and write packages; installation writes local pet files and backups. Backups can contain your custom files: keep them private and remove them manually when no longer needed.

Downloading source/dependencies or releases, using an agent, and running the host app involve separate services and their privacy policies. The no-telemetry statement covers this project's scripts, not those services. Redact personal paths, photos, credentials, and logs before sharing an issue.

## Make changes

Start with [GitHub Issues](https://github.com/dhruvaldarji/ai-pet-shihtzu/issues), the shared backlog for local and remote contributors. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and one-commit PRs, [MAINTAINERS.md](MAINTAINERS.md) for ownership and releases, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations. Agent instructions are in [AGENTS.md](AGENTS.md).

## Licenses and security

Software uses [0BSD](LICENSE). Artwork uses [CC0 1.0](LICENSE-ARTWORK). Dependency licenses remain separate.

See [LICENSES.md](LICENSES.md) for file coverage and [SECURITY.md](SECURITY.md) to report a security issue.
