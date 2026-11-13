import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareStableVersions,
  parseStableVersion,
  RELEASE_ASSET_NAMES,
  validateReleaseCatalog,
  validateReleaseDirectory,
} from "./release";

const VERSION = "v1.2.3";
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "louis-release-unit-"));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("stable version parsing rejects ambiguous and non-stable inputs", () => {
  expect(parseStableVersion("v1.2.3")).toEqual([1n, 2n, 3n]);
  for (const value of [
    "",
    "1.2.3",
    "v01.2.3",
    "v1.02.3",
    "v1.2.03",
    "v1.2.3-rc.1",
    "v1.2.3+build.4",
    "v1.2.3/path",
    "v1.2.3 ",
    " v1.2.3",
    "v1.2.3\n",
    "v1.2.3\r\n",
  ]) {
    expect(() => parseStableVersion(value)).toThrow();
  }
});

test("stable versions compare numerically without number overflow", () => {
  expect(compareStableVersions("v2.0.0", "v1.999.999")).toBeGreaterThan(0);
  expect(
    compareStableVersions(
      "v900719925474099300000000.0.0",
      "v900719925474099299999999.999999.999999",
    ),
  ).toBeGreaterThan(0);
  expect(compareStableVersions("v1.2.3", "v1.2.3")).toBe(0);
});

test("release asset names are the exact ten-file version allowlist", () => {
  expect([...RELEASE_ASSET_NAMES]).toEqual([
    "LICENSE",
    "LICENSE-ARTWORK",
    "README.md",
    "RELEASE_NOTES.md",
    "SHA256SUMS",
    "louis.zip",
    "pet.json",
    "preview.gif",
    "release.json",
    "spritesheet.webp",
  ]);
  expect(RELEASE_ASSET_NAMES).not.toContain("latest.json");
});

test("release directory validation rejects missing, symlinked, and unexpected entries", async () => {
  const missing = join(root, "missing", VERSION);
  await expect(validateReleaseDirectory(missing)).rejects.toThrow();

  const target = join(root, "target");
  await mkdir(target);
  await symlink(target, join(root, "linked"), "dir");
  await expect(validateReleaseDirectory(join(root, "linked"))).rejects.toThrow(
    "ordinary directories",
  );

  const directory = join(root, VERSION);
  await mkdir(directory);
  for (const name of RELEASE_ASSET_NAMES)
    await writeFile(join(directory, name), "not a valid release asset\n");
  await writeFile(join(directory, "extra.json"), "unexpected\n");
  await expect(validateReleaseDirectory(directory)).rejects.toThrow("exact allowlist");
});

test("release directory validation rejects an empty or malformed catalog", async () => {
  const directory = join(root, "empty", VERSION);
  await mkdir(directory, { recursive: true });
  await expect(validateReleaseDirectory(directory)).rejects.toThrow("exact allowlist");

  const badVersion = join(root, "v1.02.3");
  await mkdir(badVersion);
  for (const name of RELEASE_ASSET_NAMES) await writeFile(join(badVersion, name), "placeholder\n");
  await expect(validateReleaseDirectory(badVersion)).rejects.toThrow();
});

test("release catalog validation rejects empty catalogs and preparation markers", async () => {
  const empty = join(root, "catalog-empty");
  await mkdir(empty);
  await expect(validateReleaseCatalog(empty)).rejects.toThrow();

  const inProgress = join(root, "catalog-in-progress");
  await mkdir(inProgress);
  await writeFile(join(inProgress, ".prepare.lock"), "");
  await expect(validateReleaseCatalog(inProgress)).rejects.toThrow();
});
