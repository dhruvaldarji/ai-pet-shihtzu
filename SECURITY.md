# Security

This is a small hobby project. Reports and fixes are handled on a best-effort basis, with no guaranteed response time or supported-version window.

Use **Report a vulnerability** in the repository's Security tab when that option is available.

If it is unavailable, you may open an issue asking how to contact the maintainer privately. Include no vulnerability details, affected users, private logs, or secrets. Wait for a private route before sharing sensitive information. There is no dedicated security mailbox.

Keep credentials, personal photos, local paths, and exploit details out of public reports. A private report should name the release, platform, and steps needed to reproduce the problem.

Install files from a trusted source. SHA256 checksums detect changed files; they do not prove who published them.

The local installer checks package files and keeps backups. Review scripts before running them and keep backups private. Current cloud compatibility is unverified; local installation does not establish cloud delivery.

## Automated checks and limits

`bun run setup:security` installs Gitleaks 8.24.3 from its official release archives, verified against pinned upstream SHA256 checksums. `bun run check:security` requires a non-shallow checkout, then scans a temporary bare mirror of its locally fetched refs. The mirror uses an empty Git template, keeps all refs and HEAD, and is scanned with `--all --full-history --diff-merges=first-parent` so merge commits include their first-parent changes. Gitleaks runs from the temporary directory with an explicit empty ignore file, separate from the source worktree and its `.gitleaksignore`. It uses default Gitleaks rules and ignores inline allow comments and environment-provided scanner configurations. A generated, nonfunctional token canary must be detected before the history scan is trusted.

Scanner output is captured and discarded, with redaction enabled as an extra precaution. CI prints only a generic result, never findings, file paths, commit metadata, or scanner reports. Inspect a failed scan privately; never paste raw diagnostic output into an issue or PR. No scan reports or source snapshots are uploaded.

The same command rejects tracked private/environment/key/archive paths, unapproved image paths and symlinks. Approved production and fixture media pass the existing strict container/metadata validators, and production artwork must match `SOURCE_INPUT.json` and differ from synthetic fixtures. Workflow action references must be full commit SHA pins. Existing package tests reject private-home paths and secret markers in the runtime allowlist; production CI validates only the explicitly built Louis payload.

These checks do not prove the absence of private content. They cannot establish artwork rights, inspect visible personal details in pixels, discover every secret format, or scan refs unavailable to the local clone, unreachable commits, PR text, issues, wikis, Actions logs/artifacts, or external hosting. History scanning does not include uncommitted files. Fixture assets are test-only, never a release source. A changed approved atlas/hash or new media path still needs human review. Publication requires the separate owner-approved launch checklist.

`bun run check:dependencies` fails on reported high/critical dependency advisories. Weekly Dependabot PRs propose Bun and action updates; no auto-merge is configured. Review updates, preserve full action pins, run normal checks, and keep the single-commit policy. Audit databases and scanners have blind spots; passing is not a security guarantee.
