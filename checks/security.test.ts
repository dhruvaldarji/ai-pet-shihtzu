import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const oldScannerDigest = "cce7d0d6a9c682ad201165a9fbca50246d28bd900a90ccf2c1f6b62669572f00";
const canary = ["ghp", "0123456789abcdefghijklmnopqrstuvwxyz"].join("_");
const canaryText = `token = "${canary}"\n`;
const failureMessage =
  "Security checks failed; inspect privately. No findings or paths are printed.";
const successMessage =
  "Security checks passed: fetched history, tracked files, action pins and approved media";
const workspaces: string[] = [];

type ProcessResult = { exitCode: number; stdout: string; stderr: string };

function run(argv: string[], options: { cwd?: string; stdin?: Buffer } = {}): ProcessResult {
  const result = Bun.spawnSync(argv, { ...options, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(root: string, ...args: string[]) {
  const result = run(["git", "-C", root, ...args]);
  if (result.exitCode !== 0) throw new Error("Temporary security fixture Git command failed");
  return result.stdout;
}

function commit(root: string, message: string, files: string[]) {
  git(root, "add", "--", ...files);
  git(root, "commit", "-m", message);
}

async function createFixture(name: string) {
  const workspace = await mkdtemp(join(tmpdir(), `louis-security-${name}-`));
  workspaces.push(workspace);
  const template = join(workspace, "empty-template"),
    source = join(workspace, "source");
  await mkdir(template, { mode: 0o700 });
  const clone = run(["git", "clone", "--no-hardlinks", `--template=${template}`, repo, source]);
  if (clone.exitCode !== 0) throw new Error("Cannot create temporary security fixture");
  await copyFile(join(repo, "tools/security.ts"), join(source, "tools/security.ts"));
  await symlink(join(repo, "node_modules"), join(source, "node_modules"));
  await mkdir(join(source, ".quality-bin"), { mode: 0o700 });
  await symlink(join(repo, ".quality-bin/gitleaks"), join(source, ".quality-bin/gitleaks"));
  git(source, "config", "user.name", "Security Fixture");
  git(source, "config", "user.email", "security-fixture@users.noreply.github.com");
  git(source, "config", "commit.gpgsign", "false");
  return source;
}

async function addCommit(root: string, path: string, contents: string, message: string) {
  await writeFile(join(root, path), contents);
  commit(root, message, [path]);
  return git(root, "rev-parse", "HEAD").trim();
}

function runScanner(root: string) {
  return run([process.execPath, "tools/security.ts"], { cwd: root });
}

function emittedOnly(
  result: ProcessResult,
  exitCode: number,
  stream: "stdout" | "stderr",
  message: string,
) {
  const other = stream === "stdout" ? result.stderr : result.stdout;
  return result.exitCode === exitCode && result[stream] === `${message}\n` && other === "";
}

async function state(root: string) {
  const ignore = await readFile(join(root, ".gitleaksignore"));
  const diff = git(root, "diff", "--binary", "HEAD");
  const staged = git(root, "diff", "--cached", "--binary");
  const status = git(root, "status", "--porcelain=v1");
  const head = git(root, "rev-parse", "HEAD");
  return createHash("sha256")
    .update(`${head}\0${status}\0${createHash("sha256").update(ignore).digest("hex")}`)
    .update(createHash("sha256").update(diff).digest("hex"))
    .update(createHash("sha256").update(staged).digest("hex"))
    .digest("hex");
}

async function legacyScanner() {
  const source = await readFile(join(repo, "checks/fixtures/security-2662.ts.txt"), "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  expect(digest === oldScannerDigest).toBe(true);
  return source;
}

afterAll(async () => {
  await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
});

test("history scan isolates source ignores and includes non-HEAD refs", async () => {
  const source = await createFixture("refs");
  git(source, "switch", "-c", "scanner-clean");
  const harmlessIgnore = `${"0".repeat(40)}:unrelated.txt:github-pat:1\n`;
  await addCommit(source, ".gitleaksignore", harmlessIgnore, "test: add harmless ignore entry");
  expect(emittedOnly(await runScanner(source), 0, "stdout", successMessage)).toBe(true);

  git(source, "switch", "-c", "scanner-canary");
  const canaryCommit = await addCommit(
    source,
    "scanner-canary.txt",
    canaryText,
    "test: add scanner canary",
  );
  git(source, "switch", "scanner-clean");
  expect(git(source, "ls-tree", "HEAD", "scanner-canary.txt").trim() === "").toBe(true);

  const beforeRefScan = await state(source);
  const refScan = await runScanner(source);
  expect(emittedOnly(refScan, 1, "stderr", failureMessage)).toBe(true);
  expect(beforeRefScan === (await state(source))).toBe(true);

  const fingerprint = `${canaryCommit}:scanner-canary.txt:github-pat:1\n`;
  await addCommit(
    source,
    ".gitleaksignore",
    fingerprint,
    "test: suppress synthetic history canary",
  );
  const beforeIgnoredScan = await state(source);
  const ignoredScan = await runScanner(source);
  expect(emittedOnly(ignoredScan, 1, "stderr", failureMessage)).toBe(true);
  expect(beforeIgnoredScan === (await state(source))).toBe(true);

  await writeFile(join(source, "tools/security.ts"), await legacyScanner());
  expect(emittedOnly(await runScanner(source), 0, "stdout", successMessage)).toBe(true);
});

test("history scan includes canaries introduced only by merge commits", async () => {
  const source = await createFixture("merge");
  const base = git(source, "rev-parse", "HEAD").trim();
  git(source, "switch", "-c", "merge-first", base);
  const firstParent = await addCommit(
    source,
    "first-parent.txt",
    "A clean first-parent change.\n",
    "test: add first clean parent",
  );
  git(source, "switch", "-c", "merge-second", base);
  const secondParent = await addCommit(
    source,
    "second-parent.txt",
    "A clean second-parent change.\n",
    "test: add second clean parent",
  );
  git(source, "switch", "merge-first");

  expect(emittedOnly(await runScanner(source), 0, "stdout", successMessage)).toBe(true);
  git(source, "merge", "--no-ff", "--no-commit", "merge-second");
  await writeFile(join(source, "scanner-canary.txt"), canaryText);
  git(source, "add", "--", "scanner-canary.txt");
  git(source, "commit", "-m", "test: add merge-only scanner canary");

  const parents = git(source, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/);
  expect(parents.length === 3 && parents[1] === firstParent && parents[2] === secondParent).toBe(
    true,
  );
  const absentFromParents = parents.slice(1).every((parent) => {
    const result = run(["git", "-C", source, "cat-file", "-e", `${parent}:scanner-canary.txt`]);
    return result.exitCode !== 0;
  });
  expect(absentFromParents).toBe(true);
  expect(emittedOnly(await runScanner(source), 1, "stderr", failureMessage)).toBe(true);

  await writeFile(join(source, "tools/security.ts"), await legacyScanner());
  expect(emittedOnly(await runScanner(source), 0, "stdout", successMessage)).toBe(true);
});
