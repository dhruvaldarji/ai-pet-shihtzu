import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { buildRuntime } from "./build";
import { RUNTIME_FILES } from "./package";
import { updateChecksums } from "./update-checksums";

// Build and extract a licensed ZIP, then exercise only temporary local roots.
for (const id of ["louis", "louis-motion-preview"] as const)
  test("licensed built ZIP installs and rejects bad artwork terms without mutation: " +
    id, async () => {
    const sourceRoot = await mkdtemp(join(dir, "licensed-build-")),
      projectRoot = join(import.meta.dir, "..");
    for (const name of [".gitignore", "install.sh", "uninstall.sh", "LICENSE", "LICENSE-ARTWORK"])
      await copyFile(join(projectRoot, name), join(sourceRoot, name));
    await copyFile(join(repo, "spritesheet.webp"), join(sourceRoot, "input.webp"));
    await buildRuntime({
      root: sourceRoot,
      atlas: "input.webp",
      sha256: sha(await readFile(join(sourceRoot, "input.webp"))),
      out: "dist/review",
      id,
    });
    const source = join(sourceRoot, "extracted"),
      zip = join(sourceRoot, "dist/review", id + ".zip");
    const extraction = Bun.spawn(["unzip", "-q", zip, "-d", source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await extraction.exited).toBe(0);
    const readme = await readFile(join(source, "README.md"), "utf8");
    expect(readme).toContain(
      `The target is \`<root>/pets/${id}\`; root precedence is \`LOUIS_CODEX_DIR\`, then \`CODEX_HOME\`, then \`$HOME/.codex\`.`,
    );
    expect(readme).toContain("Use the first nonempty value and the same root for every operation.");
    const root = join(sourceRoot, "local-target"),
      target = join(root, "pets", id),
      other = id === "louis" ? "louis-motion-preview" : "louis";
    await mkdir(join(root, "pets", other), { recursive: true });
    await writeFile(join(root, "pets", other, "protected.bin"), Buffer.from([0, 42, 255, 9]));
    await mkdir(join(root, "pets", "unrelated"));
    await writeFile(join(root, "pets", "unrelated", "protected.bin"), Buffer.from([7, 128, 0, 4]));
    const protectedOther = await treeHashes(join(root, "pets", other)),
      protectedUnrelated = await treeHashes(join(root, "pets", "unrelated"));
    const result = await runScript(source, root, "install.sh");
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(join(target, "pet.json"), "utf8")).id).toBe(id);
    expect(await treeHashes(target)).toEqual({
      "pet.json": sha(await readFile(join(source, "pet.json"))),
      "spritesheet.webp": sha(await readFile(join(source, "spritesheet.webp"))),
    });
    expect(await treeHashes(join(root, "pets", other))).toEqual(protectedOther);
    expect(await treeHashes(join(root, "pets", "unrelated"))).toEqual(protectedUnrelated);
    const before = await treeHashes(root),
      artPath = join(source, "LICENSE-ARTWORK"),
      terms = await readFile(artPath);
    for (const invalid of ["missing", "empty", "tampered", "linked"]) {
      await rm(artPath);
      if (invalid === "empty") await writeFile(artPath, "");
      if (invalid === "tampered")
        await writeFile(artPath, Buffer.concat([terms, Buffer.from("\nchanged\n")]));
      if (invalid === "linked") await symlink(join(sourceRoot, "LICENSE-ARTWORK"), artPath);
      const rejected = await runScript(source, root, "install.sh");
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("LICENSE-ARTWORK");
      expect(await treeHashes(root)).toEqual(before);
      if (invalid !== "missing") await rm(artPath);
      await writeFile(artPath, terms);
    }
  }, 30000);

const repo = join(import.meta.dir, "../fixtures/runtime");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "louis-install-test-"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// Synthetic, distinct payloads test file transport and recovery, not sprite rendering.
async function writePayload(source: string, version: number) {
  await writeFile(
    join(source, "pet.json"),
    JSON.stringify({ id: "louis", description: `Fixture version ${version}.` }) + "\n",
  );
  await writeFile(
    join(source, "spritesheet.webp"),
    Buffer.from([0, 255, version, 128, 42, version + 1]),
  );
  await updateChecksums(source);
}

async function fixture(sourceName = "source", rootName = "codex") {
  const base = await mkdtemp(join(dir, "case-")),
    source = join(base, sourceName),
    root = join(base, rootName);
  await mkdir(source);
  for (const name of RUNTIME_FILES.filter((name) => name !== "SHA256SUMS")) {
    const from =
      name === "install.sh" || name === "uninstall.sh"
        ? join(import.meta.dir, "..", name)
        : join(repo, name);
    await copyFile(from, join(source, name));
  }
  await writePayload(source, 1);
  return { source, root, target: join(root, "pets", "louis") };
}

async function runScript(
  source: string,
  root: string,
  name: "install.sh" | "uninstall.sh",
  env: Record<string, string> = {},
) {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    LOUIS_CODEX_DIR: root,
    ...env,
  };
  const selected =
    environment.LOUIS_CODEX_DIR || environment.CODEX_HOME || join(environment.HOME!, ".codex");
  const local = relative(dir, resolve(selected));
  if (!local || local === ".." || local.startsWith(`..${sep}`) || local.startsWith(sep))
    throw new Error("Test target is outside its temporary root");
  const proc = Bun.spawn([Bun.which("sh")!, join(source, name)], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function treeHashes(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = join(prefix, name),
      stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Unexpected link in fixture: ${path}`);
    if (stat.isDirectory()) {
      result[path] = "directory";
      Object.assign(result, await treeHashes(root, path));
    } else if (stat.isFile()) result[path] = sha(await readFile(join(root, path)));
    else throw new Error(`Unexpected file type in fixture: ${path}`);
  }
  return result;
}

async function treeModes(root: string, prefix = ""): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = join(prefix, name),
      stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Unexpected link in fixture: ${path}`);
    result[path] = stat.mode & 0o777;
    if (stat.isDirectory()) Object.assign(result, await treeModes(root, path));
    else if (!stat.isFile()) throw new Error(`Unexpected file type in fixture: ${path}`);
  }
  return result;
}

async function backupFolders(root: string) {
  return (await readdir(join(root, "pet-backups")))
    .sort()
    .filter((name) => name.startsWith("louis-"));
}

async function restoreTempPermissions(path: string) {
  const stat = await lstat(path).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await restoreTempPermissions(join(path, name));
  } else if (stat.isFile()) await chmod(path, 0o600);
}

test("fresh install, update, uninstall and both restores preserve complete payload hashes", async () => {
  const { source, root, target } = await fixture();
  const sourceV1 = {
    "pet.json": sha(await readFile(join(source, "pet.json"))),
    "spritesheet.webp": sha(await readFile(join(source, "spritesheet.webp"))),
  };
  expect((await runScript(source, root, "install.sh")).code).toBe(0);
  expect(await treeHashes(target)).toEqual(sourceV1);
  expect(await backupFolders(root)).toEqual([]);

  // Preserve additions in an existing pet folder, not only the two shipped files.
  await mkdir(join(target, "notes"));
  await writeFile(join(target, "notes", "custom.bin"), Buffer.from([9, 0, 8, 255, 7]));
  const installedV1 = await treeHashes(target);
  await writePayload(source, 2);
  const sourceV2 = {
    ...installedV1,
    "pet.json": sha(await readFile(join(source, "pet.json"))),
    "spritesheet.webp": sha(await readFile(join(source, "spritesheet.webp"))),
  };
  expect(sourceV2["pet.json"]).not.toBe(sourceV1["pet.json"]);
  expect(sourceV2["spritesheet.webp"]).not.toBe(sourceV1["spritesheet.webp"]);
  expect((await runScript(source, root, "install.sh")).code).toBe(0);
  expect(await treeHashes(target)).toEqual(sourceV2);
  const updatedBackups = await backupFolders(root);
  expect(updatedBackups).toHaveLength(1);
  const replaced = join(root, "pet-backups", updatedBackups[0], "louis");
  expect(await treeHashes(replaced)).toEqual(installedV1);

  expect((await runScript(source, root, "uninstall.sh")).code).toBe(0);
  expect(await lstat(target).catch(() => null)).toBeNull();
  const removedNames = (await backupFolders(root)).filter((name) => !updatedBackups.includes(name));
  expect(removedNames).toHaveLength(1);
  const removed = join(root, "pet-backups", removedNames[0], "louis");
  expect(await treeHashes(removed)).toEqual(sourceV2);
  expect(await treeHashes(replaced)).toEqual(installedV1);

  // README restore method: copy the chosen backup's louis folder into pets/.
  await cp(removed, target, { recursive: true, force: false, errorOnExist: true });
  expect(await treeHashes(target)).toEqual(sourceV2);
  expect(await treeHashes(removed)).toEqual(sourceV2);
  expect((await runScript(source, root, "uninstall.sh")).code).toBe(0);
  await cp(replaced, target, { recursive: true, force: false, errorOnExist: true });
  expect(await treeHashes(target)).toEqual(installedV1);
  expect(await treeHashes(replaced)).toEqual(installedV1);
  expect(await treeHashes(removed)).toEqual(sourceV2);
});

test("install and uninstall reject a symlink target without changing its contents", async () => {
  const { source, root, target } = await fixture();
  const protectedFolder = join(root, "protected");
  await mkdir(protectedFolder, { recursive: true });
  await writeFile(join(protectedFolder, "keep.bin"), Buffer.from([0, 17, 255, 64]));
  const before = await treeHashes(protectedFolder);
  await mkdir(join(root, "pets"));
  await symlink(protectedFolder, target);
  for (const name of ["install.sh", "uninstall.sh"] as const) {
    const result = await runScript(source, root, name);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("symbolic link");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await treeHashes(protectedFolder)).toEqual(before);
  }
});

async function existingFixture() {
  const f = await fixture();
  await mkdir(join(f.target, "notes"), { recursive: true });
  await writeFile(join(f.target, "pet.json"), '{"id":"louis","customized":true}\n');
  await writeFile(join(f.target, "notes/custom.bin"), Buffer.from([7, 0, 255, 8]));
  return { ...f, before: await treeHashes(f.root) };
}

for (const name of ["pet.json", "spritesheet.webp", "README.md"])
  test(`changed ${name} is rejected before touching an existing installation`, async () => {
    const { source, root, before } = await existingFixture();
    await writeFile(
      join(source, name),
      Buffer.concat([await readFile(join(source, name)), Buffer.from("changed after packaging")]),
    );
    const result = await runScript(source, root, "install.sh");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Package checksum mismatch: ${name}`);
    expect(await treeHashes(root)).toEqual(before);
  });

const invalidLedgers: Record<string, (body: string) => string> = {
  empty: () => "",
  "missing entry": (body) =>
    body
      .split("\n")
      .filter((line) => !line.endsWith("  pet.json"))
      .join("\n"),
  "duplicate entry": (body) => body + body.split("\n")[0] + "\n",
  "unknown file": (body) => body + "a".repeat(64) + "  private.txt\n",
  "invalid hash": (body) => "g" + body.slice(1),
  "short hash": (body) => body.slice(1),
  "wrong separator": (body) => body.replace("  pet.json", " pet.json"),
  "path traversal": (body) => body.replace("  pet.json", "  ../pet.json"),
  comment: (body) => "# checksum file\n" + body,
};
for (const [label, change] of Object.entries(invalidLedgers))
  test(`invalid checksum ledger (${label}) leaves the entire installation root unchanged`, async () => {
    const { source, root, before } = await existingFixture();
    await writeFile(
      join(source, "SHA256SUMS"),
      change(await readFile(join(source, "SHA256SUMS"), "utf8")),
    );
    const result = await runScript(source, root, "install.sh");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("SHA256SUMS");
    expect(await treeHashes(root)).toEqual(before);
  });

test("missing and linked checksum ledgers reject before any installation write", async () => {
  const { source, root, before } = await existingFixture(),
    ledger = await readFile(join(source, "SHA256SUMS"));
  await rm(join(source, "SHA256SUMS"));
  expect((await runScript(source, root, "install.sh")).code).toBe(1);
  expect(await treeHashes(root)).toEqual(before);
  await writeFile(join(source, "external-sums"), ledger);
  await symlink(join(source, "external-sums"), join(source, "SHA256SUMS"));
  expect((await runScript(source, root, "install.sh")).code).toBe(1);
  expect(await treeHashes(root)).toEqual(before);
});

test("optional license pair requires coverage, matching bytes and ordinary files", async () => {
  const { source, root, before } = await existingFixture();
  await writeFile(join(source, "LICENSE"), "Synthetic fixture license only.\n");
  expect((await runScript(source, root, "install.sh")).code).toBe(1);
  expect(await treeHashes(root)).toEqual(before);
  await writeFile(join(source, "LICENSE-ARTWORK"), "Synthetic artwork terms only.\n");
  expect((await runScript(source, root, "install.sh")).code).toBe(1);
  expect(await treeHashes(root)).toEqual(before);
  await updateChecksums(source);
  await writeFile(join(source, "LICENSE"), "Changed license.\n");
  expect((await runScript(source, root, "install.sh")).stderr).toContain(
    "Package checksum mismatch: LICENSE",
  );
  expect(await treeHashes(root)).toEqual(before);
  await updateChecksums(source);
  await rm(join(source, "LICENSE"));
  expect((await runScript(source, root, "install.sh")).code).toBe(1);
  expect(await treeHashes(root)).toEqual(before);
  await symlink(join(source, "missing-license"), join(source, "LICENSE"));
  expect((await runScript(source, root, "install.sh")).stderr).toContain(
    "linked package file: LICENSE",
  );
  expect(await treeHashes(root)).toEqual(before);
  await rm(join(source, "LICENSE"));
  await writeFile(join(source, "LICENSE"), "Synthetic fixture license only.\n");
  await updateChecksums(source);
  expect((await runScript(source, root, "install.sh")).code).toBe(0);
});

test("missing hash tools refuse installation and sha256sum fallback installs verified bytes", async () => {
  const { source, root, target } = await fixture("source\\escaped", "codex\nwrapped"),
    bin = join(source, "test-bin");
  await mkdir(bin);
  for (const name of [
    "dirname",
    "cat",
    "awk",
    "mkdir",
    "mktemp",
    "cp",
    "mv",
    "date",
    "rm",
    "rmdir",
  ])
    await symlink(Bun.which(name)!, join(bin, name));
  const absent = await runScript(source, root, "install.sh", { PATH: bin });
  expect(absent.code).toBe(1);
  expect(absent.stderr).toContain("A SHA256 tool is required");
  expect(await lstat(root).catch(() => null)).toBeNull();
  const nativeSha = Bun.which("sha256sum");
  if (nativeSha) await symlink(nativeSha, join(bin, "sha256sum"));
  else {
    const shasum = Bun.which("shasum")!;
    await writeFile(
      join(bin, "sha256sum"),
      `#!/bin/sh\nexec '${shasum.replaceAll("'", "'\\''")}' -a 256 "$@"\n`,
      { mode: 0o755 },
    );
  }
  expect((await runScript(source, root, "install.sh", { PATH: bin })).code).toBe(0);
  expect(await readFile(join(target, "spritesheet.webp"))).toEqual(
    await readFile(join(source, "spritesheet.webp")),
  );
});

for (const suffix of ["\\escaped", "\nwrapped"])
  test(`checksum verification supports extraction and install paths containing ${JSON.stringify(suffix)}`, async () => {
    const { source, root, target } = await fixture(`source${suffix}`, `codex${suffix}`);
    const result = await runScript(source, root, "install.sh");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(await readFile(join(target, "pet.json"))).toEqual(
      await readFile(join(source, "pet.json")),
    );
    expect(await readFile(join(target, "spritesheet.webp"))).toEqual(
      await readFile(join(source, "spritesheet.webp")),
    );
  });

test("identical installs preserve custom files without staging or new backups", async () => {
  const { source, root, target } = await fixture();
  expect((await runScript(source, root, "install.sh")).code).toBe(0);
  await writeFile(join(target, "custom.txt"), "keep this note\n");
  const before = await treeHashes(root);
  const result = await runScript(source, root, "install.sh");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("already up to date");
  expect(await treeHashes(root)).toEqual(before);
  expect(await backupFolders(root)).toEqual([]);
  await writeFile(join(source, "README.md"), "tampered package documentation\n");
  expect((await runScript(source, root, "install.sh")).code).toBe(1);
  expect(await treeHashes(root)).toEqual(before);
});

for (const selected of ["override", "codex", "home"])
  test(`install and uninstall respect ${selected} root precedence`, async () => {
    const { source, root } = await fixture();
    const home = join(root, "home"),
      codex = join(root, "codex-home"),
      override = join(root, "override");
    const env = {
      HOME: home,
      CODEX_HOME: selected === "home" ? "" : codex,
      LOUIS_CODEX_DIR: selected === "override" ? override : "",
    };
    const expected =
      selected === "override" ? override : selected === "codex" ? codex : join(home, ".codex");
    expect((await runScript(source, root, "install.sh", env)).code).toBe(0);
    expect(await readFile(join(expected, "pets/louis/pet.json"))).toEqual(
      await readFile(join(source, "pet.json")),
    );
    expect((await runScript(source, root, "uninstall.sh", env)).code).toBe(0);
    const before = await treeHashes(root);
    expect((await runScript(source, root, "uninstall.sh", env)).code).toBe(0);
    expect(await treeHashes(root)).toEqual(before);
    expect(await backupFolders(expected)).toHaveLength(1);
  });

test("canonical root aliases share the same installation", async () => {
  const { source, root, target } = await fixture(),
    alias = join(root, "../root-alias");
  await mkdir(root);
  await symlink(root, alias);
  expect((await runScript(source, alias, "install.sh")).code).toBe(0);
  const before = await treeHashes(root);
  expect((await runScript(source, root, "install.sh")).stdout).toContain("already up to date");
  expect(await treeHashes(root)).toEqual(before);
  expect((await runScript(source, alias, "uninstall.sh")).code).toBe(0);
  expect(await lstat(target).catch(() => null)).toBeNull();
});

for (const parent of ["pets", "pet-backups"])
  test(`linked ${parent} is rejected by both lifecycle scripts`, async () => {
    const { source, root } = await fixture(),
      outside = join(root, "../protected");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "unchanged\n");
    const before = await treeHashes(outside);
    await symlink(outside, join(root, parent));
    for (const name of ["install.sh", "uninstall.sh"] as const) {
      const result = await runScript(source, root, name);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Managed parent is a symbolic link");
      expect(await treeHashes(outside)).toEqual(before);
      expect((await lstat(join(root, parent))).isSymbolicLink()).toBe(true);
      expect(await lstat(join(root, ".louis-lock")).catch(() => null)).toBeNull();
    }
  });

test("both lifecycle scripts refuse and preserve an existing per-pet lock", async () => {
  const { source, root } = await fixture();
  expect((await runScript(source, root, "install.sh")).code).toBe(0);
  await mkdir(join(root, ".louis-lock"));
  const before = await treeHashes(root);
  for (const name of ["install.sh", "uninstall.sh"] as const) {
    const result = await runScript(source, root, name);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("operation may be running");
    expect(await treeHashes(root)).toEqual(before);
  }
});

test("failed staged promotion restores the complete previous pet and releases the lock", async () => {
  const { source, root, target } = await fixture(),
    bin = join(source, "fail-bin");
  expect((await runScript(source, root, "install.sh")).code).toBe(0);
  await writeFile(join(target, "custom.txt"), "keep during rollback\n");
  const before = await treeHashes(target);
  await writePayload(source, 2);
  await mkdir(bin);
  await writeFile(
    join(bin, "mv"),
    `#!/bin/sh\ncase "$1" in */.louis-install.*) echo 'injected promotion failure' >&2; exit 1;; esac\nexec '${Bun.which("mv")!}' "$@"\n`,
    { mode: 0o755 },
  );
  const result = await runScript(source, root, "install.sh", {
    PATH: `${bin}:${process.env.PATH}`,
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Previous Louis restored");
  expect(await treeHashes(target)).toEqual(before);
  expect(await backupFolders(root)).toEqual([]);
  expect(await lstat(join(root, ".louis-lock")).catch(() => null)).toBeNull();
  expect(
    (await readdir(join(root, "pets"))).filter((name) => name.startsWith(".louis-install.")),
  ).toHaveLength(1);
  expect((await runScript(source, root, "install.sh")).code).toBe(0);
  expect(await readFile(join(target, "custom.txt"), "utf8")).toBe("keep during rollback\n");
});

test("updates a read-only pet root while preserving custom modes and complete backup", async () => {
  expect(process.getuid?.()).not.toBe(0);
  const { source, root, target } = await fixture();
  expect((await runScript(source, root, "install.sh")).code).toBe(0);
  const customDir = join(target, "custom"),
    customFile = join(customDir, "note.bin");
  const customBytes = Buffer.from([0, 17, 255, 64]);
  await mkdir(customDir);
  await writeFile(customFile, customBytes);
  const probeRoot = join(root, "mv-probe"),
    probeSourceParent = join(probeRoot, "source"),
    probeDestinationParent = join(probeRoot, "destination");
  try {
    await chmod(customFile, 0o400);
    await chmod(customDir, 0o500);
    await chmod(target, 0o555);
    const oldTree = await treeHashes(target);
    const oldModes = await treeModes(target);
    await writePayload(source, 2);
    await mkdir(probeSourceParent, { recursive: true });
    await mkdir(probeDestinationParent, { recursive: true });
    const probeSource = join(probeSourceParent, "louis"),
      probeDestination = join(probeDestinationParent, "louis");
    await mkdir(probeSource);
    await writeFile(join(probeSource, "marker"), "probe\n");
    await chmod(probeSource, 0o555);
    const mv = Bun.which("mv");
    if (!mv) throw new Error("mv is required for the lifecycle test");
    const probe = Bun.spawn([mv, probeSource, probeDestination], {
      env: { ...process.env, LC_ALL: "C" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [probeStdout, probeStderr, probeCode] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    const readonlyMoveSupported = probeCode === 0;
    if (!readonlyMoveSupported) expect(probeStderr).toContain("Permission denied");
    expect(probeStdout).toBe("");
    await restoreTempPermissions(probeRoot);
    await rm(probeRoot, { recursive: true, force: true });
    const result = await runScript(source, root, "install.sh", { LC_ALL: "C" });
    const updatedTree = {
      ...oldTree,
      "pet.json": sha(await readFile(join(source, "pet.json"))),
      "spritesheet.webp": sha(await readFile(join(source, "spritesheet.webp"))),
    };
    if (readonlyMoveSupported) {
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(await treeHashes(target)).toEqual(updatedTree);
      expect(await readFile(customFile)).toEqual(customBytes);
      expect((await lstat(target)).mode & 0o777).toBe(0o555);
      expect((await lstat(customDir)).mode & 0o777).toBe(0o500);
      expect((await lstat(customFile)).mode & 0o777).toBe(0o400);
      const backups = await backupFolders(root);
      expect(backups).toHaveLength(1);
      const backup = join(root, "pet-backups", backups[0], "louis");
      expect(await treeHashes(backup)).toEqual(oldTree);
      expect(await treeModes(backup)).toEqual(oldModes);
    } else {
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Permission denied");
      expect(result.stderr).toContain(target);
      expect(result.stderr).toContain(join(root, "pet-backups"));
      expect(result.stderr).not.toContain("rm:");
      expect(result.stderr).not.toContain("cp:");
      expect(result.stderr).toContain("Unfinished install files kept at:");
      expect(await treeHashes(target)).toEqual(oldTree);
      expect(await treeModes(target)).toEqual(oldModes);
      expect(await readFile(customFile)).toEqual(customBytes);
      const backups = await backupFolders(root);
      expect(backups).toHaveLength(1);
      expect(
        await lstat(join(root, "pet-backups", backups[0], "louis")).catch(() => null),
      ).toBeNull();
      const stages = (await readdir(join(root, "pets"))).filter((name) =>
        name.startsWith(".louis-install."),
      );
      expect(stages).toHaveLength(1);
      const stage = join(root, "pets", stages[0]);
      expect(await treeHashes(stage)).toEqual(updatedTree);
      expect((await lstat(stage)).mode & 0o777).toBe(0o555);
      expect(await readFile(join(stage, "custom", "note.bin"))).toEqual(customBytes);
      expect((await lstat(join(stage, "custom"))).mode & 0o777).toBe(0o500);
      expect((await lstat(join(stage, "custom", "note.bin"))).mode & 0o777).toBe(0o400);
    }
    expect(await lstat(join(root, ".louis-lock")).catch(() => null)).toBeNull();
  } finally {
    await restoreTempPermissions(probeRoot);
    await rm(probeRoot, { recursive: true, force: true });
    for (const name of await readdir(join(root, "pets")).catch(() => [])) {
      if (name === "louis" || name.startsWith(".louis-install."))
        await restoreTempPermissions(join(root, "pets", name));
    }
    for (const name of await backupFolders(root).catch(() => []))
      await restoreTempPermissions(join(root, "pet-backups", name, "louis"));
  }
});
