# Louis

Louis rules the day with tiny acts of mischief and very important naps.

Louis is a small Shih Tzu for your desktop. He naps, runs, follows your cursor, and reacts while you work.

## Install

Give your Codex agent this prompt:

```text
Install pet from https://github.com/dhruvaldarji/ai-pet-shihtzu
```

The agent checks the package and uses supported pet tools when available. A manual step is needed only when those tools cannot complete installation.

## Manual fallback

Use these steps only if the agent cannot complete installation. Download and extract the Louis ZIP from the repository's Releases page.

- **Local Codex pet:** run `sh install.sh` in the extracted folder. The installer saves a backup before replacing existing local Louis files.
- **ChatGPT Work pet:** open Settings, then Pets, then Upload pet. Enter a name and choose `spritesheet.webp`. Select the new pet if needed.

Upload creates a new cloud pet. To change an existing cloud pet, use its supported update tool when available. Installing local files does not update a cloud pet.

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
when Louis is absent is a no-op. To restore, stop other pet operations, remove
any current Louis with the uninstaller, then copy the chosen backup's `louis`
folder into the root's `pets/` folder. The destination must not already exist
or be a symbolic link. Keep the backup until you verify the restored pet.

The explicitly chosen root may resolve through platform or user directory
aliases. Inside it, `pets`, `pet-backups`, and the Louis target must not be
symbolic links. Both scripts use the same per-pet lock and refuse overlapping
operations. After a crash, remove an empty `.louis-lock` directory with `rmdir`
only after confirming no installer or uninstaller is still running. Do not
edit managed folders concurrently with either script.

These are local file operations, not automatic background updates. Select or
refresh Louis in the intended app and check the artwork after an update.

## App behavior

The app controls animation timing and may skip the first-use wave. Selecting Louis again may not replay that wave.

## Make changes

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and package builds. Agent instructions are in [AGENTS.md](AGENTS.md).

## Licenses and security

Software uses [0BSD](LICENSE). Artwork uses [CC0 1.0](LICENSE-ARTWORK). Dependency licenses remain separate.

See [LICENSES.md](LICENSES.md) for file coverage and [SECURITY.md](SECURITY.md) to report a security issue.
