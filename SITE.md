# Static site catalog

The site builder creates a local, static catalog from verified versioned release
directories. It makes no network requests and does not publish or deploy files.
The output is allowlisted and contains only the two HTML pages, CSS, a lossless
poster crop, `site.json`, and validated release bytes.

Prepare a release catalog first, then build the default preview:

```sh
bun run site:build -- --catalog dist/releases --out dist/site --mode preview
```

`--catalog` and `--out` must remain below the repository's `dist/` directory and
must not overlap. `--out` defaults to `dist/site`; `--mode` defaults to
`preview`. Preview output says “Preview only — artifacts are not published.”
`production` mode builds neutral catalog output only; it does not attest to
publication, deployment, or native app acceptance. An identical existing output
is a no-op; changed or unrelated output is never overwritten. Use a different
new output directory for a new build mode.

The catalog pointer `releases/latest.json` is discovery metadata, not an updater.
Every release link uses its explicit versioned local mirror path. The native
install candidate is recorded in `site.json` for review only: the page exposes no
active native link and the Install Louis button stays disabled. Local POSIX
installation, updates, uninstall, and restore are documented on the page;
Windows installation and web/cloud upload remain unsupported, and native
playback/direct installation remain unverified.

Run `bun run check:site` for the real-artwork temporary-root integration check.
It prepares isolated release artifacts, checks both site modes and repeated
build behavior, and never writes to an active pet directory. CI runs this as a
read-only job; there is no site deployment or upload step.
