import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkActionPins, checkSourceSecurity, checkTrackedPaths } from "./release-source-guard";

const repo = resolve(import.meta.dir, "..");

async function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Release source guard fixture setup failed");
}

test("release source paths allow an empty list and only approved media", () => {
  expect(() => checkTrackedPaths([])).not.toThrow();
  expect(() =>
    checkTrackedPaths([
      "README.md",
      "assets/atlas.webp",
      "fixtures/runtime/spritesheet.webp",
      "fixtures/runtime/preview.gif",
    ]),
  ).not.toThrow();
});

test("release source paths reject private, traversal, archive, and unapproved media paths", () => {
  for (const path of [
    "private/photo.jpg",
    ".env",
    "local/.env.production",
    "cert.key",
    "dist/package.zip",
    "assets/photo.png",
    "../outside.txt",
    "assets\\outside.webp",
  ]) {
    expect(() => checkTrackedPaths([path])).toThrow();
  }
});

test("release source workflows require full commit SHA pins", () => {
  const pin = "a".repeat(40);
  expect(() =>
    checkActionPins(Bun.YAML.parse(`jobs: {test: {steps: [{uses: actions/checkout@${pin}}]}}`)),
  ).not.toThrow();
  for (const uses of ["actions/checkout@v4", "actions/checkout@abcd", "./local-action"]) {
    expect(() =>
      checkActionPins(Bun.YAML.parse(`jobs: {test: {steps: [{uses: ${uses}}]}}`)),
    ).toThrow("full commit SHA");
  }
  expect(() =>
    checkActionPins(
      Bun.YAML.parse(
        "base: &action {uses: actions/checkout@main}\njobs: {test: {steps: [*action]}}",
      ),
    ),
  ).toThrow("full commit SHA");
});

test("release source guard accepts this repository and rejects linked or invalid approved media", async () => {
  await checkSourceSecurity(repo);

  const temporaryParent = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryParent, "louis-release-source-guard-"));
  try {
    await git(root, "init", "--quiet", "--initial-branch=main");
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "atlas-data"), "synthetic fixture\n");
    await symlink(join(root, "assets", "atlas-data"), join(root, "assets", "atlas.webp"));
    await git(root, "add", "assets/atlas-data", "assets/atlas.webp");
    await expect(checkSourceSecurity(root)).rejects.toThrow("ordinary files");

    await git(root, "rm", "--cached", "assets/atlas.webp");
    await rm(join(root, "assets", "atlas.webp"));
    await writeFile(join(root, "assets", "atlas.webp"), "not a webp\n");
    await git(root, "add", "assets/atlas.webp");
    await expect(checkSourceSecurity(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
