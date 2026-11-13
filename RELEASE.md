# Release preparation

The initial release policy accepts stable versions only: `vMAJOR.MINOR.PATCH`,
with no leading zeroes, prerelease suffix, or build metadata. A local preparation
uses a clean source commit at `HEAD`; a feature-branch commit is allowed for
testing. The manual workflow additionally requires the source to be reachable
from fetched `main`.

```sh
bun run release:prepare -- --version v1.2.3 --source "$(git rev-parse HEAD)"
```

The builder validates the pinned Bun and Sharp versions, the production atlas
path and hash in `SOURCE_INPUT.json`, fixture separation, and both license
texts. It makes two independent builds from temporary roots containing only
the reviewed production inputs, compares complete build receipts and output
bytes, then validates the runtime ZIP and release directory. It does not install
anything or make network requests.

Each `dist/releases/<version>/` directory contains exactly these eight runtime
data files: `louis.zip`, `spritesheet.webp`, `pet.json`, `preview.gif`,
`README.md`, `RELEASE_NOTES.md`, `LICENSE`, and `LICENSE-ARTWORK`. It also
contains `release.json` and an outer `SHA256SUMS`. The manifest identifies the
source commit, atlas hash, license IDs, compatibility limits, and immutable
future GitHub download URLs. The outer checksum file covers those eight files
and `release.json`; it does not checksum itself. The runtime ZIP has its own
internal `SHA256SUMS`. These checksums detect changed bytes, not publisher
identity. Source-bound Actions evidence is not a cryptographic signature.

The workflow is available only by manual dispatch from the canonical
repository's `main` branch. Its default `dry-run` mode prepares a short-lived,
allowlisted artifact without publishing it. `draft` mode uses the separate
`release-approval` environment. The repository owner must configure that
environment with at least one required reviewer; the helper checks that rule
again before API operations and fails closed if it is missing. The code does
not create or change the environment. Draft creation leaves the release
unpublished. Only the owner decides whether to publish it.

Preparation is immutable. An identical source/version rerun verifies the
existing bytes and is a no-op; changed or unexpected bytes are never replaced.
A failed draft upload can be retried: the helper verifies every existing
asset, then resumes only missing assets. It never deletes or overwrites an
asset or publishes a release. Use a new stable version for changed bytes.
`dist/releases/latest.json` is a monotonic discovery pointer, not an updater;
no code polls it or downloads updates. A future Cloudflare mirror may copy the
same immutable bytes and derive a separate catalog.

The canonical URLs recorded in manifests are future metadata, not live
downloads. No public release URL is currently available. Before publication,
the owner must review GitHub immutable-release and workflow-permission settings
under [issue #11](https://github.com/dhruvaldarji/ai-pet-shihtzu/issues/11).
GitHub artifact attestations and signing are not implemented or claimed. Any
future attestation work needs separately approved `id-token` and attestation
write permissions; the current workflow grants neither.

Compatibility claims remain limited: local scripts target POSIX systems;
native playback and direct installation are unverified; Windows installation
and web/cloud upload are unsupported. Preparation and checks do not prove
artwork rights, native playback, or a published download.
