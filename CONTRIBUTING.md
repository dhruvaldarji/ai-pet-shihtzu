# Contributing

Describe the problem and the change you want to make. Keep each change small. Include the checks you ran and their results.

## Setup

Use Bun 1.3.10 and WebP 1.6.0. You also need `zip`, `unzip`, a POSIX shell, and a SHA256 command. A macOS Brewfile is included.

```sh
bun install --frozen-lockfile
bun run check:setup
bun test tools --timeout 30000
```

## Build a package

The builder copies the sprite sheet without redrawing or recompressing it. Supply the hash from `SOURCE_INPUT.json`.

```sh
bun run build -- --atlas assets/atlas.webp --sha256 919fb8346bb1e45ecffedf88b0621edf9f7ce3e982fee34d8f24b331fe6c5bc1 --out dist/louis --id louis
```

The output contains the runtime ZIP, checksums, and a build record. Building does not install or select a pet.

Use `--id louis-motion-preview` and a new output folder for a separate local test package. Use temporary folders for installer tests.

## Artwork changes

Show the complete frames before and after the change. Include a full animation loop with native timing.

Check head size, coat colors, paw placement, body attachment, and repeat transitions. Keep still body parts stable between frames. Use synthetic images for code tests.

Do not add private reference photographs or personal information. Check rights before adding outside material.

## Pull requests

Explain what changed, why it changed, and how you checked it. Use Conventional Commits. Update the relevant documentation when behavior changes.

Run the affected tests. Run `bun audit --audit-level=high` when changing dependencies. Test results do not replace artwork or live display review.

Software contributions use 0BSD. Artwork contributions use CC0 1.0. Third-party material keeps its own terms and needs clear attribution where required.
