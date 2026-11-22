# Louis artwork

`atlas.webp` contains Louis's sprite sheet. Each cell is 192 × 208 pixels. The sheet has eight columns and eleven rows.

Use the full sheet when building a pet package. Its SHA256 is recorded in `SOURCE_INPUT.json` at the repository root.

The artwork uses [CC0 1.0](../LICENSE-ARTWORK).

The GIF previews and adjacent JSON manifests in [previews](previews/) are generated from this CC0 atlas with the states and timing in `tools/animation-contract.json`, using the repository's `preview()` renderer. Regenerate them from the repository root with `bun run previews`, and check the committed GIFs and manifests with `bun run check:previews`.

The owner describes Louis as AI-assisted original artwork with no third-party credits required. See [provenance and license coverage](../LICENSES.md#provenance). Do not add private prompts, reference photos, or personal records.
