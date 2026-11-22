import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packageRuntime } from "../tools/package";
import { validateReleaseDirectory } from "../tools/release";

const repo = resolve(import.meta.dir, "..");
const VERSION = "v1.0.0";
const OLDER_VERSION = "v0.9.9";
const ZIP_NAME = `louis-${VERSION}.zip`;
const VERSION_FILES = [
  "LICENSE",
  "LICENSE-ARTWORK",
  "README.md",
  "RELEASE_NOTES.md",
  "SHA256SUMS",
  ZIP_NAME,
  "pet.json",
  "preview.gif",
  "release.json",
  "spritesheet.webp",
];
const ZIP_FILES = [
  ".gitignore",
  "README.md",
  "RELEASE_NOTES.md",
  "pet.json",
  "spritesheet.webp",
  "preview.gif",
  "install.sh",
  "uninstall.sh",
  "LICENSE",
  "LICENSE-ARTWORK",
  "SHA256SUMS",
];
const OUTPUT_FILES = [
  ZIP_NAME,
  "spritesheet.webp",
  "pet.json",
  "preview.gif",
  "README.md",
  "RELEASE_NOTES.md",
  "LICENSE",
  "LICENSE-ARTWORK",
];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("release workflow uploads the version directory and latest pointer to the draft input path", async () => {
  const workflowText = await readFile(join(repo, ".github/workflows/release.yml"), "utf8");
  const workflow = Bun.YAML.parse(workflowText) as {
    jobs?: Record<
      string,
      {
        steps?: Array<{
          uses?: string;
          name?: string;
          run?: string;
          with?: Record<string, unknown>;
        }>;
      }
    >;
  };
  const buildSteps = workflow.jobs?.build?.steps ?? [];
  const draftSteps = workflow.jobs?.draft?.steps ?? [];
  const buildCommands = buildSteps.map((step) => step.run);
  for (const command of [
    "bun install --frozen-lockfile",
    "bun run check:setup",
    "bun test tools --timeout 30000",
    "bun run check:production",
    "bun audit --audit-level=high",
    "bun run check:release",
  ]) {
    expect(buildCommands).toContain(command);
  }
  const upload = buildSteps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const download = draftSteps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  const operation = draftSteps.find(
    (step) => step.name === "Create or resume an unpublished draft",
  );
  const expressionStart = ["$", "{{"].join("");
  const expressionEnd = "}}";
  expect(upload?.with?.path).toBe(
    `dist/releases/${expressionStart} needs.validate.outputs.version ${expressionEnd}/\ndist/releases/latest.json\n`,
  );
  expect(download?.with?.path).toBe(
    `${expressionStart} runner.temp ${expressionEnd}/release-artifact`,
  );
  expect(operation?.run).toContain('--directory "$RUNNER_TEMP/release-artifact/$RELEASE_VERSION"');

  const ciWorkflow = Bun.YAML.parse(
    await readFile(join(repo, ".github/workflows/ci.yml"), "utf8"),
  ) as {
    jobs?: Record<
      string,
      { strategy?: { matrix?: { os?: string[] } }; steps?: Array<{ run?: string }> }
    >;
  };
  expect(ciWorkflow.jobs?.["release-artifact"]?.strategy?.matrix?.os).toEqual([
    "ubuntu-24.04",
    "macos-15",
  ]);
  const ciReleaseCommands = (ciWorkflow.jobs?.["release-artifact"]?.steps ?? []).map(
    (step) => step.run,
  );
  for (const command of [
    "bun install --frozen-lockfile",
    "bun run check:setup",
    "bun test tools --timeout 30000",
    "bun run check:production",
    "bun audit --audit-level=high",
    "bun run check:release",
  ]) {
    expect(ciReleaseCommands).toContain(command);
  }
});

test("release jobs verify checkout-fetched main without persisted credentials", async () => {
  const workflowText = await readFile(join(repo, ".github/workflows/release.yml"), "utf8");
  const workflow = Bun.YAML.parse(workflowText) as {
    jobs?: Record<
      string,
      {
        steps?: Array<{
          uses?: string;
          name?: string;
          run?: string;
          with?: Record<string, unknown>;
        }>;
      }
    >;
  };
  for (const jobName of ["build", "draft"]) {
    const steps = workflow.jobs?.[jobName]?.steps ?? [];
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    const verification = steps.find((step) => step.name === "Verify selected source is on main");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(verification?.run).toContain("git show-ref --verify --quiet refs/remotes/origin/main");
    expect(verification?.run).toContain(
      'git merge-base --is-ancestor "$RELEASE_SOURCE" refs/remotes/origin/main',
    );
    expect(verification?.run).not.toContain("git fetch");
  }
});

type CommandResult = { code: number; stdout: string; stderr: string };

async function run(args: string[], cwd: string): Promise<CommandResult> {
  let processHandle: Bun.ReadableSubprocess;
  try {
    processHandle = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    throw new Error("A local release test command could not start");
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { code, stdout, stderr };
}

async function git(root: string, ...args: string[]) {
  const result = await run(["git", "-C", root, ...args], repo);
  if (result.code !== 0) throw new Error("A local release test Git operation failed");
  return result.stdout.trim();
}

async function cloneSource(parent: string, name: string) {
  const root = join(parent, name);
  const source = await git(repo, "rev-parse", "HEAD");
  const clone = await run(
    ["git", "clone", "--no-hardlinks", "--quiet", "--no-checkout", repo, root],
    repo,
  );
  if (clone.code !== 0) throw new Error("A temporary release source clone could not be created");
  await git(root, "fetch", "--quiet", "--no-tags", repo, source);
  await git(root, "checkout", "--quiet", "--detach", source);
  await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  await appendFile(join(root, ".git/info/exclude"), "\n/node_modules\n");
  return { root, source };
}

async function prepare(root: string, source: string, version = VERSION) {
  return run(
    [process.execPath, join(root, "tools/release.ts"), "--version", version, "--source", source],
    root,
  );
}

async function fileTree(root: string) {
  const files = new Map<string, Buffer>();
  async function visit(directory: string, prefix: string) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw new Error("A release test output unexpectedly contains a link");
      if (stat.isDirectory()) await visit(path, relative);
      else files.set(relative, await readFile(path));
    }
  }
  await visit(root, "");
  return files;
}

function expectSameTree(left: ReadonlyMap<string, Buffer>, right: ReadonlyMap<string, Buffer>) {
  expect([...left.keys()]).toEqual([...right.keys()]);
  for (const [name, bytes] of left) expect(right.get(name)?.equals(bytes)).toBe(true);
}

async function commitFixture(root: string, paths: string[], message: string) {
  await git(root, "add", ...paths);
  const result = await run(
    [
      "git",
      "-C",
      root,
      "-c",
      "user.name=Release Fixture",
      "-c",
      "user.email=12345678+release-fixture@users.noreply.github.com",
      "commit",
      "--quiet",
      "-m",
      message,
    ],
    repo,
  );
  if (result.code !== 0) throw new Error("A local release test fixture could not be committed");
  return git(root, "rev-parse", "HEAD");
}

async function expectSanitizedFailure(result: CommandResult) {
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "Release preparation failed; inspect local source and catalog state privately.\n",
  );
  expect(result.stderr).not.toContain(repo);
}

async function repackageRuntime(
  temporary: string,
  sourceDirectory: string,
  name: string,
  mutate: (extracted: string) => Promise<void>,
) {
  const directory = join(temporary, name, VERSION);
  await mkdir(directory, { recursive: true });
  for (const file of VERSION_FILES)
    await copyFile(join(sourceDirectory, file), join(directory, file));

  const extracted = join(temporary, `${name}-extracted`);
  await mkdir(extracted);
  const extraction = await run(
    ["unzip", "-q", join(sourceDirectory, ZIP_NAME), "-d", extracted],
    temporary,
  );
  expect(extraction.code).toBe(0);
  await mutate(extracted);

  const archive = join(temporary, `${name}.zip`);
  const zipped = await run(["zip", "-q", "-X", archive, ...ZIP_FILES], extracted);
  expect(zipped.code).toBe(0);
  await copyFile(archive, join(directory, ZIP_NAME));

  const manifestPath = join(directory, "release.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    assets: Array<{ name: string; sha256: string; size: number }>;
  };
  const zipAsset = manifest.assets.find((asset) => asset.name === ZIP_NAME);
  if (!zipAsset) throw new Error("Release test fixture lacks a ZIP descriptor");
  const archiveBytes = await readFile(join(directory, ZIP_NAME));
  zipAsset.sha256 = sha256(archiveBytes);
  zipAsset.size = archiveBytes.length;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const checksumNames = [...OUTPUT_FILES, "release.json"].sort();
  const checksums = await Promise.all(
    checksumNames.map(async (file) => {
      const bytes = await readFile(join(directory, file));
      return `${sha256(bytes)}  ${file}`;
    }),
  );
  await writeFile(join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  return { directory, extracted, archive };
}

test("release CLI is reproducible, immutable, and bound to clean production source", async () => {
  const temporaryParent = await realpath(tmpdir());
  const temporary = await mkdtemp(join(temporaryParent, "louis-release-integration-"));
  try {
    const first = await cloneSource(temporary, "first");
    const firstRun = await prepare(first.root, first.source);
    expect(firstRun).toEqual({
      code: 0,
      stdout: `Prepared immutable release ${VERSION}.\n`,
      stderr: "",
    });

    const second = await cloneSource(temporary, "second");
    const secondRun = await prepare(second.root, second.source);
    expect(secondRun).toEqual(firstRun);

    const firstReleases = join(first.root, "dist/releases");
    const secondReleases = join(second.root, "dist/releases");
    const firstVersion = join(firstReleases, VERSION);
    const secondVersion = join(secondReleases, VERSION);
    expect((await readdir(firstReleases)).sort()).toContain("latest.json");
    expect(JSON.parse(await readFile(join(firstReleases, "latest.json"), "utf8")).version).toBe(
      VERSION,
    );
    expect([...(await readdir(firstVersion)).sort()]).toEqual(VERSION_FILES);
    expectSameTree(await fileTree(firstVersion), await fileTree(secondVersion));

    const manifest = JSON.parse(await readFile(join(firstVersion, "release.json"), "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      version: VERSION,
      sourceCommit: first.source,
      atlasSha256: sha256(await readFile(join(first.root, "assets/atlas.webp"))),
      licenseIds: { software: "0BSD", artwork: "CC0-1.0" },
      compatibility: {
        spriteVersionNumber: 2,
        localScripts: "POSIX",
        nativePlayback: "unverified",
        directInstall: "unverified",
        webCloud: "unsupported",
      },
    });
    expect(manifest.assets.map((asset: { name: string }) => asset.name)).toEqual(
      [...OUTPUT_FILES].sort(),
    );
    for (const asset of manifest.assets as Array<{
      name: string;
      sha256: string;
      size: number;
      url: string;
    }>) {
      const bytes = await readFile(join(firstVersion, asset.name));
      expect(asset.sha256).toBe(sha256(bytes));
      expect(asset.size).toBe(bytes.length);
      expect(asset.url).toBe(
        `https://github.com/dhruvaldarji/ai-pet-shihtzu/releases/download/${VERSION}/${asset.name}`,
      );
    }

    const badUrlDirectory = join(temporary, "bad-url", VERSION);
    await mkdir(badUrlDirectory, { recursive: true });
    for (const name of VERSION_FILES)
      await copyFile(join(firstVersion, name), join(badUrlDirectory, name));
    const badUrlManifest = JSON.parse(
      await readFile(join(badUrlDirectory, "release.json"), "utf8"),
    );
    badUrlManifest.assets[0].url = "https://attacker.example/changed-artifact";
    await writeFile(
      join(badUrlDirectory, "release.json"),
      `${JSON.stringify(badUrlManifest, null, 2)}\n`,
    );
    const checksumNames = [...OUTPUT_FILES, "release.json"].sort();
    await writeFile(
      join(badUrlDirectory, "SHA256SUMS"),
      `${(
        await Promise.all(
          checksumNames.map(
            async (name) => `${sha256(await readFile(join(badUrlDirectory, name)))}  ${name}`,
          ),
        )
      ).join("\n")}\n`,
    );
    await expect(
      validateReleaseDirectory(badUrlDirectory, {
        version: VERSION,
        sourceCommit: first.source,
      }),
    ).rejects.toThrow("asset descriptor is invalid");

    const unsortedDirectory = join(temporary, "unsorted-sums", VERSION);
    await mkdir(unsortedDirectory, { recursive: true });
    for (const name of VERSION_FILES)
      await copyFile(join(firstVersion, name), join(unsortedDirectory, name));
    const sortedLines = (await readFile(join(unsortedDirectory, "SHA256SUMS"), "utf8"))
      .trimEnd()
      .split("\n");
    await writeFile(join(unsortedDirectory, "SHA256SUMS"), `${sortedLines.reverse().join("\n")}\n`);
    await expect(
      validateReleaseDirectory(unsortedDirectory, {
        version: VERSION,
        sourceCommit: first.source,
      }),
    ).rejects.toThrow("allowlist");

    const sumsLines = (await readFile(join(firstVersion, "SHA256SUMS"), "utf8"))
      .trimEnd()
      .split("\n");
    expect(sumsLines.map((line) => line.slice(66))).toEqual(
      [...OUTPUT_FILES, "release.json"].sort(),
    );
    for (const line of sumsLines) {
      const [hash, name] = line.split("  ");
      expect(hash).toBe(sha256(await readFile(join(firstVersion, name))));
    }

    const zip = join(firstVersion, ZIP_NAME);
    const listed = await run(["unzip", "-Z", "-1", zip], first.root);
    expect(listed.code).toBe(0);
    expect(listed.stdout.trimEnd().split(/\r?\n/)).toEqual(ZIP_FILES);
    const extracted = join(temporary, "release-zip-readback");
    await mkdir(extracted);
    const extraction = await run(["unzip", "-q", zip, "-d", extracted], first.root);
    expect(extraction.code).toBe(0);
    expect((await readdir(extracted)).sort()).toEqual([...ZIP_FILES].sort());
    for (const name of ZIP_FILES) {
      const expected =
        name === "SHA256SUMS"
          ? await readFile(join(extracted, name))
          : OUTPUT_FILES.includes(name)
            ? await readFile(join(firstVersion, name))
            : await readFile(join(first.root, name));
      expect((await readFile(join(extracted, name))).equals(expected)).toBe(true);
    }
    const innerSums = (await readFile(join(extracted, "SHA256SUMS"), "utf8")).trimEnd().split("\n");
    const innerChecksumNames = innerSums.map((line) => line.slice(66));
    expect(innerChecksumNames).toEqual(ZIP_FILES.filter((name) => name !== "SHA256SUMS"));
    expect(innerChecksumNames).not.toEqual([...innerChecksumNames].sort());

    const tmpdirAlias = join(temporary, "system-tmp-alias");
    await symlink(temporary, tmpdirAlias, "dir");
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = tmpdirAlias;
    try {
      expect(tmpdir()).toBe(tmpdirAlias);
      const validated = await validateReleaseDirectory(firstVersion, {
        version: VERSION,
        sourceCommit: first.source,
      });
      expect(validated.manifest.version).toBe(VERSION);
      expect(
        validated.files.get(ZIP_NAME)?.equals(await readFile(join(firstVersion, ZIP_NAME))),
      ).toBe(true);
      const linkedVersion = join(temporary, "linked-version");
      await symlink(firstVersion, linkedVersion, "dir");
      await expect(
        validateReleaseDirectory(linkedVersion, {
          version: VERSION,
          sourceCommit: first.source,
        }),
      ).rejects.toThrow("ordinary directories");
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await rm(tmpdirAlias);
    }

    const invalidInstallerRelease = await repackageRuntime(
      temporary,
      firstVersion,
      "invalid-runtime-installer",
      async (forgedExtracted) => {
        const installerPath = join(forgedExtracted, "install.sh");
        const installer = await readFile(installerPath, "utf8");
        const invalidInstaller = installer.replace(
          /^louis_target="\$louis_pets\/louis"$/m,
          'louis_target="$louis_pets/attacker"',
        );
        expect(invalidInstaller).not.toBe(installer);
        await writeFile(installerPath, invalidInstaller);
        const runtimeChecksums = await Promise.all(
          ZIP_FILES.filter((name) => name !== "SHA256SUMS").map(async (name) => {
            const bytes = await readFile(join(forgedExtracted, name));
            return `${sha256(bytes)}  ${name}`;
          }),
        );
        await writeFile(join(forgedExtracted, "SHA256SUMS"), `${runtimeChecksums.join("\n")}\n`);
      },
    );
    const repackedInvalid = join(temporary, "rejected-runtime.zip");
    await expect(
      packageRuntime(repackedInvalid, invalidInstallerRelease.extracted, { petId: "louis" }),
    ).rejects.toThrow("install.sh target does not match pet ID louis");
    await expect(
      validateReleaseDirectory(invalidInstallerRelease.directory, {
        version: VERSION,
        sourceCommit: first.source,
      }),
    ).rejects.toThrow("install.sh target does not match pet ID louis");

    const duplicateChecksums = await repackageRuntime(
      temporary,
      firstVersion,
      "duplicate-inner-checksums",
      async (forgedExtracted) => {
        const checksumPath = join(forgedExtracted, "SHA256SUMS");
        const lines = (await readFile(checksumPath, "utf8")).trimEnd().split("\n");
        await writeFile(checksumPath, `${[...lines, lines[0]].join("\n")}\n`);
      },
    );
    await expect(
      validateReleaseDirectory(duplicateChecksums.directory, {
        version: VERSION,
        sourceCommit: first.source,
      }),
    ).rejects.toThrow("SHA256SUMS has an invalid or duplicate entry");

    const changedChecksum = await repackageRuntime(
      temporary,
      firstVersion,
      "changed-inner-checksum",
      async (forgedExtracted) => {
        const checksumPath = join(forgedExtracted, "SHA256SUMS");
        const lines = (await readFile(checksumPath, "utf8")).trimEnd().split("\n");
        const firstName = lines[0]?.slice(66);
        if (!firstName) throw new Error("Runtime test checksum entry is missing");
        lines[0] = `${"0".repeat(64)}  ${firstName}`;
        await writeFile(checksumPath, `${lines.join("\n")}\n`);
      },
    );
    await expect(
      validateReleaseDirectory(changedChecksum.directory, {
        version: VERSION,
        sourceCommit: first.source,
      }),
    ).rejects.toThrow("SHA256SUMS mismatch");

    const latestPath = join(firstReleases, "latest.json");
    const latestBeforeOlder = await readFile(latestPath);
    const olderRun = await prepare(first.root, first.source, OLDER_VERSION);
    expect(olderRun.code).toBe(0);
    expect(await readFile(latestPath)).toEqual(latestBeforeOlder);
    expect((await readdir(firstReleases)).sort()).toContain(OLDER_VERSION);

    const beforeRerun = await fileTree(firstVersion);
    const rerun = await prepare(first.root, first.source);
    expect(rerun).toEqual(firstRun);
    expectSameTree(beforeRerun, await fileTree(firstVersion));
    expect(await readFile(latestPath)).toEqual(latestBeforeOlder);

    const tamperedPath = join(firstVersion, "README.md");
    await writeFile(tamperedPath, "tampered immutable bytes\n");
    const tamperedBytes = await readFile(tamperedPath);
    await expectSanitizedFailure(await prepare(first.root, first.source));
    expect(await readFile(tamperedPath)).toEqual(tamperedBytes);

    await expectSanitizedFailure(await prepare(first.root, "a".repeat(39)));

    const dirty = await cloneSource(temporary, "dirty");
    await writeFile(join(dirty.root, "dirty-source-marker.txt"), "uncommitted\n");
    await expectSanitizedFailure(await prepare(dirty.root, dirty.source));

    const badHash = await cloneSource(temporary, "bad-hash");
    const sourceInputPath = join(badHash.root, "SOURCE_INPUT.json");
    const sourceInput = JSON.parse(await readFile(sourceInputPath, "utf8"));
    sourceInput.atlas.sha256 = "0".repeat(64);
    await writeFile(sourceInputPath, `${JSON.stringify(sourceInput, null, 2)}\n`);
    const badHashCommit = await commitFixture(
      badHash.root,
      ["SOURCE_INPUT.json"],
      "test: corrupt release source hash",
    );
    await expectSanitizedFailure(await prepare(badHash.root, badHashCommit));

    const fixture = await cloneSource(temporary, "fixture-atlas");
    const fixtureAtlas = await readFile(join(fixture.root, "fixtures/runtime/spritesheet.webp"));
    await writeFile(join(fixture.root, "assets/atlas.webp"), fixtureAtlas);
    const fixtureInputPath = join(fixture.root, "SOURCE_INPUT.json");
    const fixtureInput = JSON.parse(await readFile(fixtureInputPath, "utf8"));
    fixtureInput.atlas.sha256 = sha256(fixtureAtlas);
    await writeFile(fixtureInputPath, `${JSON.stringify(fixtureInput, null, 2)}\n`);
    const fixtureCommit = await commitFixture(
      fixture.root,
      ["assets/atlas.webp", "SOURCE_INPUT.json"],
      "test: bind release source to fixture atlas",
    );
    await expectSanitizedFailure(await prepare(fixture.root, fixtureCommit));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 240_000);
