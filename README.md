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

For a different local root, set `LOUIS_CODEX_DIR` before running the installer. Run `sh uninstall.sh` to remove local Louis files and keep a backup.

## App behavior

The app controls animation timing and may skip the first-use wave. Selecting Louis again may not replay that wave.

## Make changes

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and package builds. Agent instructions are in [AGENTS.md](AGENTS.md).

## Licenses and security

Software uses [0BSD](LICENSE). Artwork uses [CC0 1.0](LICENSE-ARTWORK). Dependency licenses remain separate.

See [LICENSES.md](LICENSES.md) for file coverage and [SECURITY.md](SECURITY.md) to report a security issue.
