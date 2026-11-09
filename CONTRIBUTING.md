# Contributing

Use an issue to report a bug or suggest a change. Remove private details from logs, screenshots, and examples before you post.

Describe the problem and the change you want to make. Keep each change small. Include the checks you ran and their results.

## Pick an issue

[GitHub Issues](https://github.com/dhruvaldarji/ai-pet-shihtzu/issues) are the source of truth for both local contributors and remote agents. Milestones group phases, parent issues group workstreams, and small implementation issues define each PR's scope. Read the issue's dependencies and acceptance criteria before starting; discuss substantial changes there first. Do not maintain a competing local backlog.

One focused implementation issue should map to one PR targeting `main`. Link it with `Closes #number` when the PR completes the issue. Use `Refs #number` for partial work and explain what remains.

## Setup

Use Bun 1.3.10. You also need `zip`, `unzip`, a POSIX shell, and a SHA256 command. Image processing uses the pinned Sharp dependency installed by Bun; separate WebP CLI tools are not required.

```sh
bun install --frozen-lockfile
bun run check:setup
bun test tools --timeout 30000
bun run check:production
```

## Build a package

The builder copies the sprite sheet without redrawing or recompressing it. Supply the hash from `SOURCE_INPUT.json`.

```sh
bun run build -- --atlas assets/atlas.webp --sha256 919fb8346bb1e45ecffedf88b0621edf9f7ce3e982fee34d8f24b331fe6c5bc1 --out dist/louis --id louis
```

The output contains the runtime ZIP, checksums, and a build record. Building does not install or select a pet.

Builds and direct packaging require both nonblank license texts. Runtime media is
validated at both entry points: static WebP artwork without embedded metadata,
and a fully decodable GIF preview without comments or custom application data.
Accepted sprite bytes are copied unchanged. Generated preview sidecars use a
relative filename and remain outside the runtime ZIP.

Synthetic transport tests explicitly use the API-only `allowUnlicensedFixtures`
option. Never use that option for a release; neither CLI exposes it. The privacy
checks are safeguards, not proof that artwork or free text contains no private data.

Use `--id louis-motion-preview` and a new output folder for a separate local test package. Use temporary folders for installer tests.

## Production artifact checks

`bun run check:production` reads the production atlas path and hash from `SOURCE_INPUT.json`. It rejects a changed atlas, a fixture path, or the known synthetic fixture bytes, then builds Louis twice from separate fresh temporary source roots. It compares ZIP bytes and saved build records, checks the exact extracted allowlist, verifies both license texts and checksums, and exercises local install, repeated install, update, uninstall, and restore in a temporary root. No package is uploaded or published; temporary outputs are removed after the check.

The `production-artifact` CI job runs on Ubuntu 24.04 and macOS 15. Reproducibility is checked within each platform, not between operating systems. The existing `test` job keeps synthetic regression tests and dependency auditing on Ubuntu. Windows and native app playback are not verified by these jobs. Passing CI does not approve artwork rights, a changed source hash, or publication; those still need maintainer review.

## Artwork changes

Show the complete frames before and after the change. Include a full animation loop with native timing.

Check head size, coat colors, paw placement, body attachment, and repeat transitions. Keep still body parts stable between frames. Use synthetic images for code tests.

Do not add private reference photographs or personal information. Check rights before adding outside material.

## Pull requests

Submit all changes through a pull request. Fork the repository and create a branch for your change. Do not push changes directly to main.

Use a Conventional Commit title, such as `fix: correct the install path`. Explain what changed, why it changed, and how you checked it. Update the relevant documentation when behavior changes.

Keep exactly one Conventional Commit in the final PR. Before merge, squash any intermediate commits and push the PR branch with `--force-with-lease`, never plain `--force`. Coordinate first if someone else is using that branch. Never rewrite `main`.

Wait for `test` and both `production-artifact` checks to pass. Resolve each review thread before merge.

Include exact commands, results, and anything not tested. Run `git diff --check` as well as affected tests. For user-facing guidance, check links and ensure generated package instructions agree with the source documentation. For app claims, record the tested app/version and platform; local filesystem tests alone do not prove playback. Maintainer approval is required to merge or publish; passing CI is not approval.

Run the affected tests. Run `bun audit --audit-level=high` when changing dependencies. Test results do not replace artwork or live display review.

Software contributions use 0BSD. Artwork contributions use CC0 1.0. Third-party material keeps its own terms and needs clear attribution where required.

Be kind and constructive; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report security issues using [SECURITY.md](SECURITY.md), not a public bug report. See [MAINTAINERS.md](MAINTAINERS.md) for release responsibilities.
