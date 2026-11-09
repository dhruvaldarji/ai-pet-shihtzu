import { afterAll, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../tools/build";
import { OPTIONAL_RUNTIME_FILES, packageRuntime, RUNTIME_FILES } from "../tools/package";

const repo = resolve(import.meta.dir, "..");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const names = [...RUNTIME_FILES, ...OPTIONAL_RUNTIME_FILES].sort();
type SourceInput = { version: number; atlas: { path: string; sha256: string } };
let workspace: string;
const sourceRoots: string[] = [];
let input: SourceInput;
let atlas: Buffer;
let fixture: Buffer;

async function ordinary(path: string) {
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), "Source must be an ordinary file");
  const bytes = await readFile(path);
  assert(bytes.length > 0, "Source must not be empty");
  return bytes;
}

function verifyBinding(candidate: SourceInput, bytes: Buffer) {
  assert(candidate?.version === 1 && candidate.atlas?.path === "assets/atlas.webp", "Production atlas path must be assets/atlas.webp");
  assert(typeof candidate.atlas.sha256 === "string" && /^[a-f0-9]{64}$/.test(candidate.atlas.sha256), "Production atlas hash is required");
  assert.equal(hash(bytes), candidate.atlas.sha256, "Production atlas SHA256 mismatch");
  assert(!bytes.equals(fixture), "Synthetic fixture cannot be the production atlas");
}

async function run(argv: string[], env: Record<string, string | undefined> = process.env) {
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  // Do not include installer output containing temporary home paths in shared logs.
  assert.equal(code, 0, `${argv[0]} failed during production verification`);
  return stdout;
}

beforeAll(async () => {
  input = JSON.parse((await ordinary(join(repo, "SOURCE_INPUT.json"))).toString());
  const assets = await lstat(join(repo, "assets"));
  assert(assets.isDirectory() && !assets.isSymbolicLink(), "Production assets must be an ordinary directory");
  atlas = await ordinary(join(repo, "assets/atlas.webp"));
  fixture = await ordinary(join(repo, "fixtures/runtime/spritesheet.webp"));
  verifyBinding(input, atlas);
  workspace = await mkdtemp(join(tmpdir(), "louis-production-"));
  const sources = await Promise.all([".gitignore", "install.sh", "uninstall.sh", ...OPTIONAL_RUNTIME_FILES].map(async name => ({ name, bytes: await ordinary(join(repo, name)) })));
  for (const label of ["first-source", "second-source"]) {
    const root = join(workspace, label);
    sourceRoots.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, input.atlas.path), atlas);
    for (const { name, bytes } of sources) await writeFile(join(root, name), bytes);
  }
});

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

test("production binding rejects stale hashes, fixture paths, and fixture bytes", () => {
  expect(() => verifyBinding({ ...input, atlas: { ...input.atlas, sha256: "0".repeat(64) } }, atlas)).toThrow("SHA256 mismatch");
  expect(() => verifyBinding({ ...input, atlas: { path: "fixtures/runtime/spritesheet.webp", sha256: hash(fixture) } }, fixture)).toThrow("atlas path");
  expect(() => verifyBinding({ ...input, atlas: { ...input.atlas, sha256: hash(fixture) } }, fixture)).toThrow("Synthetic fixture");
});

test("manifest-bound Louis builds reproducibly and survives a temporary local lifecycle", async () => {
  const options = { atlas: input.atlas.path, sha256: input.atlas.sha256, id: "louis" as const, out: "dist/build" };
  const first = await buildRuntime({ ...options, root: sourceRoots[0] });
  const second = await buildRuntime({ ...options, root: sourceRoots[1] });
  const firstOut = join(sourceRoots[0], options.out), secondOut = join(sourceRoots[1], options.out);
  expect(first).toEqual(second);
  const record = await ordinary(join(firstOut, "build.json"));
  expect(record).toEqual(await ordinary(join(secondOut, "build.json")));
  expect(JSON.parse(record.toString())).toEqual(first);
  expect(first.licensePresent).toBe(true);
  expect(first.licenseFiles).toEqual([...OPTIONAL_RUNTIME_FILES]);
  expect(first.installed).toBe(false);
  expect(first.published).toBe(false);
  expect(first.artworkAccepted).toBe(false);
  const zip = join(firstOut, "louis.zip");
  const zipBytes = await ordinary(zip);
  expect(zipBytes).toEqual(await ordinary(join(secondOut, "louis.zip")));
  expect(hash(zipBytes)).toBe(first.archiveSha256);

  // Check entry names before extraction, then reuse the package validator on readback.
  const entries = (await run(["unzip", "-Z", "-1", zip])).trimEnd().split(/\r?\n/).sort();
  expect(entries).toEqual(names);
  const extracted = join(workspace, "extracted");
  await run(["unzip", "-q", zip, "-d", extracted]);
  expect((await readdir(extracted)).sort()).toEqual(names);
  for (const name of names) {
    expect(await ordinary(join(extracted, name))).toEqual(await ordinary(join(firstOut, "runtime", name)));
  }
  for (const name of OPTIONAL_RUNTIME_FILES) {
    expect(await ordinary(join(extracted, name))).toEqual(await ordinary(join(repo, name)));
  }
  expect(await ordinary(join(extracted, "spritesheet.webp"))).toEqual(atlas);
  const repacked = await packageRuntime(join(workspace, "readback.zip"), extracted, { petId: "louis" });
  expect(repacked.archiveSha256).toBe(first.archiveSha256);
  expect(repacked.manifest).toEqual(first.payload);

  const root = join(workspace, "local-root"), target = join(root, "pets/louis");
  const home = join(workspace, "home"), other = join(root, "pets/other/keep.txt");
  await mkdir(home);
  await mkdir(join(root, "pets/other"), { recursive: true });
  await writeFile(other, "Keep this unrelated pet unchanged.\n");
  const sentinel = await readFile(other);
  const environment = { ...process.env, HOME: home, CODEX_HOME: root, LOUIS_CODEX_DIR: root };
  async function lifecycle(script: "install.sh" | "uninstall.sh") {
    await run(["sh", join(extracted, script)], environment);
    expect(await readFile(other)).toEqual(sentinel);
  }
  async function payload(folder: string) {
    return Promise.all(["pet.json", "spritesheet.webp"].map(async name => hash(await ordinary(join(folder, name)))));
  }
  async function backups() { return (await readdir(join(root, "pet-backups"))).sort(); }
  const expected = await payload(extracted);
  await lifecycle("install.sh");
  expect(await payload(target)).toEqual(expected);
  await lifecycle("install.sh");
  expect(await payload(target)).toEqual(expected);

  const pet = JSON.parse((await readFile(join(target, "pet.json"))).toString());
  await writeFile(join(target, "pet.json"), JSON.stringify({ ...pet, description: "Previous local installation." }) + "\n");
  const previous = await payload(target), beforeUpdate = await backups();
  await lifecycle("install.sh");
  expect(await payload(target)).toEqual(expected);
  const updateBackups = (await backups()).filter(name => !beforeUpdate.includes(name));
  expect(updateBackups).toHaveLength(1);
  expect(await payload(join(root, "pet-backups", updateBackups[0], "louis"))).toEqual(previous);

  const beforeRemove = await backups();
  await lifecycle("uninstall.sh");
  expect(await lstat(target).catch(() => null)).toBeNull();
  const removalBackups = (await backups()).filter(name => !beforeRemove.includes(name));
  expect(removalBackups).toHaveLength(1);
  const removed = join(root, "pet-backups", removalBackups[0], "louis");
  expect(await payload(removed)).toEqual(expected);
  const afterRemove = await backups();
  await lifecycle("uninstall.sh");
  expect(await backups()).toEqual(afterRemove);
  await cp(removed, target, { recursive: true, force: false, errorOnExist: true });
  expect(await payload(target)).toEqual(expected);
  expect(await payload(removed)).toEqual(expected);
  expect(await readFile(other)).toEqual(sentinel);
});
