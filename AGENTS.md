# Agent instructions

Use concise, simple English. Explain the next action before making changes. Report verified results and any remaining user step.

## When the user says "install pet"

1. Identify the intended app and pet. Check whether it uses local files or a cloud pet. Do not infer this from the app name alone.
2. Prefer a published release ZIP with its published checksum. Verify that checksum and the extracted `SHA256SUMS` before installation. Reject changed or unlisted files.
3. If no suitable release is available, build the chosen source commit. Use frozen dependencies and the atlas hash in `SOURCE_INPUT.json`.
4. Keep other pets unchanged. Record the existing target and save a complete backup before replacing it. Ask only if the intended target is unclear.
5. Use a supported installation method for the actual app. This repository does not currently claim cloud compatibility for its v2 sheet; do not upload it based only on generic host support.
6. Verify the selected pet's source after installation. Report only what the checks establish. A local file write does not prove cloud delivery or visible playback.

### Local pets

Use the bundled installer for the intended local root. Root precedence is `LOUIS_CODEX_DIR`, then `CODEX_HOME`, then `~/.codex`. Use the same root for installation and removal. Identical payloads are a no-op; changed payloads retain custom files and a complete backup. Do not bypass a lifecycle lock or automatically remove a stale lock.

Read back the installed `pet.json` and sprite sheet. Compare them with the package. Confirm the selected local pet when the app provides that capability.

If selection cannot be checked, state that the local files are installed and give the one remaining selection step.

### Cloud pets

The current v2 sheet's cloud upload and native direct-link flows are unverified. Do not offer upload as a fallback for failed local installation. First establish the actual host's format requirements and obtain separate acceptance for the artifact and flow.

For an existing cloud pet, use its stable ID and preserve its name, description, and other pets unless the user requests changes. Do not create a duplicate to refresh an existing pet.

Read back the selected ID and download its fresh sprite sheet when supported. Compare decoded pixels with the package; cloud encoding can change file bytes. Do not treat local files or saved cache values as proof of the selected cloud source.

If compatibility or a supported update is unavailable, stop that flow and report the limitation. Do not create a duplicate, use private APIs, or edit app caches. Repository instructions do not perform unattended updates.

## Development

- Read the GitHub issue, dependencies, and acceptance criteria before starting. Issues are the shared backlog for local and remote work; link the implementation PR as described in [CONTRIBUTING.md](CONTRIBUTING.md).
- Use Bun and the frozen lockfile. Run checks for the behavior you change.
- Keep installation tests in temporary folders. Do not use the user's active pet folder for tests.
- Build from an explicit atlas and expected SHA256. Never package synthetic test images as Louis.
- Preserve smooth edges, coat colors, body attachment, head size, and native timing when changing artwork.
- Compare complete frames and animation loops with the existing artwork. Technical checks do not replace visual or live review.
- Keep personal photos, identities, local paths, credentials, and private records out of shared files.
- Use Conventional Commits. Do not push, publish, change visibility, or rewrite remote history without authorization.
- Keep one final commit per PR to `main`, with test evidence and explicit untested limitations. When authorized to consolidate, use force-with-lease on the PR branch only. Merge and publication still need owner approval.
- Keep the software and artwork licenses separate. Preserve third-party license terms.
