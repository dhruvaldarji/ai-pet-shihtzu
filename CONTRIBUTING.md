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
bun run setup:quality
bun run check:quality
bun test tools --timeout 30000
bun run check:production
```

Quality tooling is pinned to Biome 2.2.6, TypeScript 5.9.3, `@types/bun` 1.3.10, ShellCheck 0.10.0, and actionlint 1.7.7. `bun run setup:quality` downloads the ShellCheck and actionlint binaries into the ignored `.quality-bin/` directory; it requires `curl`, `tar`, `gzip`, `xz`, `mktemp`, and a SHA256 utility (`sha256sum`, `shasum`, or `sha256`). No system-wide install or elevated permission is used.

The ShellCheck and actionlint versions and artifact hashes are pinned in `tools/install-quality-tools.sh`. actionlint hashes come from its official release checksum file. ShellCheck hashes are pinned from the official HTTPS release archives; upstream does not publish a checksum or signature for those archives, so the pinned hashes are not represented as upstream signatures.

Biome formats and lints `tools/**/*.ts`, `checks/**/*.ts`, root JSON files, and `tools/*.json`. It intentionally excludes assets, fixtures, and generated `dist/` output. TypeScript checks the same source and test trees without emitting files. ShellCheck checks the installer scripts and quality-tool installer; actionlint checks GitHub workflows and uses the pinned ShellCheck binary for embedded shell.

## Build a package

See [RELEASE.md](RELEASE.md) for the stable-only immutable release builder,
manual dry-run/draft workflow, owner protection requirements, and compatibility
limits. `bun run check:release` runs the release CLI integration checks in
temporary full-source clones; it is also an independent read-only CI job.

Before requesting review, run `bun run setup:security`, `bun run check:security-history`, `bun run check:security`, and `bun run check:dependencies` as well as quality and package checks. Fetch full history before the security scan (CI uses `fetch-depth: 0`). The history regression test uses temporary local clones and the pinned scanner; Gitleaks downloads use the same platform support and local `.quality-bin/` directory as quality tools. See [SECURITY.md](SECURITY.md) for mirror isolation, redaction, and coverage limits. Never upload a raw scan report. Dependency and action updates go through ordinary reviewed PRs; automated updates are proposals, not merge approval.

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

## Static site checks

See [SITE.md](SITE.md) for the offline builder. It validates the complete release
catalog before copying files, produces preview output by default, and refuses
to replace changed output. `bun run check:site` exercises both modes with
production artwork in isolated temporary roots. It does not publish or deploy
the site.

## Artwork changes

Show the complete frames before and after the change. Include a full animation loop with native timing.

Check head size, coat colors, paw placement, body attachment, and repeat transitions. Keep still body parts stable between frames. Use synthetic images for code tests.

Do not add private reference photographs or personal information. Check rights before adding outside material.

## Pull requests

Submit all changes through a pull request. Fork the repository and create a branch for your change. Do not push changes directly to main.

Use a Conventional Commit title, such as `fix: correct the install path`. Explain what changed, why it changed, and how you checked it. Update the relevant documentation when behavior changes.

Keep exactly one Conventional Commit in the final PR. Before merge, squash any intermediate commits and push the PR branch with `--force-with-lease`, never plain `--force`. Coordinate first if someone else is using that branch. Never rewrite `main`.

Owner-approved stacks land bottom-up into `main`. The bottom PR targets `main`; each upper layer targets the preceding PR branch and contains exactly one commit relative to that base. Only GitHub's native stacked-PR support manages restacking. For ordinary linked PRs, retargeting an upper PR after squash-merging its lower layer does not rewrite its branch; explicitly restack it onto `main`. Do not merge an upper layer until its base is `main`, its range is exactly one Conventional Commit, and fresh checks and review have passed. Recheck every final head before merging.

The `pr-policy` workflow uses `pull_request_target` in the trusted default-branch context with only `contents: read` to inspect PR metadata through GitHub's compare API. It does not check out or execute PR code. The workflow becomes active for PRs only after its definition lands on the default branch; the introducing PR tests its exact embedded script with mocked API responses rather than claiming a remote run.

The read-only `pr-policy` check validates both the PR title and actual commit subject, counts commits relative to the PR base, and rejects merge commits. It reruns on pushes and title/base edits. To reproduce locally, save a GitHub pull-request event JSON, fetch the complete base/head history, and run `GITHUB_EVENT_PATH=/path/to/event.json bun run check:pr`. Never commit that event file. This check does not rewrite branches or approve merges; requiring it in branch protection is a separate owner-approved launch setting.

Source CI runs on all PR base branches and pushes to `main`, not both branch pushes and PR events. Superseded runs are cancelled per PR; the required `test` status remains unchanged.

Wait for `test`, `quality`, `security`, and both `production-artifact` checks to pass. Resolve each review thread before merge.

Include exact commands, results, and anything not tested. Run `git diff --check` as well as affected tests. For user-facing guidance, check links and ensure generated package instructions agree with the source documentation. For app claims, record the tested app/version and platform; local filesystem tests alone do not prove playback. Maintainer approval is required to merge or publish; passing CI is not approval.

Run the affected tests. Run `bun audit --audit-level=high` when changing dependencies. Test results do not replace artwork or live display review.

Software contributions use 0BSD. Artwork contributions use CC0 1.0. Third-party material keeps its own terms and needs clear attribution where required.

Be kind and constructive; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report security issues using [SECURITY.md](SECURITY.md), not a public bug report. See [MAINTAINERS.md](MAINTAINERS.md) for release responsibilities.
