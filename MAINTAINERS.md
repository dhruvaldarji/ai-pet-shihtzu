# Maintainers and releases

The [repository owner](https://github.com/dhruvaldarji/ai-pet-shihtzu) makes final scope, merge, and release decisions. Contributors are welcome; this is a hobby project, with no support SLA or promised release schedule.

Use GitHub Issues for decisions and planned work. Use PRs to `main` for changes, with one final Conventional Commit, test evidence, passing applicable checks, and resolved review feedback. Automation and agents must not merge, publish, change repository visibility, or deploy without explicit owner approval.

## Before a public release

- Review source, history, documentation, artwork permissions, and output files for private material. Keep the 0BSD software and CC0 artwork terms separate.
- Build from a chosen commit and the explicit atlas hash in `SOURCE_INPUT.json`, using frozen dependencies. Verify reproducibility, the package allowlist, license texts, and checksums. Never release synthetic test images.
- Test installation, update, uninstall, and restore in temporary roots. State platform/app versions actually tested and distinguish file checks from native playback. Do not advertise unsupported cloud upload.
- Publish a versioned ZIP, its checksum, source commit, and release notes only after owner approval. Do not replace bytes at an existing release version; publish a new version for changes.
- Deploy only the verified public outputs, with separate approval. Never deploy the full repository or a developer workspace. Recheck downloads and hashes after publication.

These are release expectations, not a claim that release automation or a public website already exists. Optional GitHub private vulnerability reporting can be enabled when the repository is public; no dedicated mailbox is required. Keep [security guidance](SECURITY.md) accurate about the route available.
