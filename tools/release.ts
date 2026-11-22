#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { buildRuntime } from "./build";
import { packageRuntime } from "./package";
import { checkSourceSecurity } from "./release-source-guard";
import { contract, decode, validateAtlas } from "./pet";

const repo = resolve(import.meta.dir, "..");
const SOURCE_INPUT = "SOURCE_INPUT.json";
const STATIC_OUTPUT_FILES = [
  "spritesheet.webp",
  "pet.json",
  "preview.gif",
  "README.md",
  "RELEASE_NOTES.md",
  "LICENSE",
  "LICENSE-ARTWORK",
] as const;
const MANIFEST_FILES = ["release.json", "SHA256SUMS"] as const;
const RUNTIME_ARCHIVE_FILES = [
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
const COMPATIBILITY = {
  spriteVersionNumber: 2,
  localScripts: "POSIX",
  nativePlayback: "unverified",
  directInstall: "unverified",
  webCloud: "unsupported",
} as const;
const LICENSE_IDS = { software: "0BSD", artwork: "CC0-1.0" } as const;
const VERSION_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function releaseZipName(version: string) {
  parseStableVersion(version);
  return `louis-${version}.zip`;
}

export function releaseDataNames(version: string) {
  return [releaseZipName(version), ...STATIC_OUTPUT_FILES];
}

export function releaseAssetNames(version: string) {
  return [...releaseDataNames(version), ...MANIFEST_FILES].sort();
}

function releaseChecksumNames(version: string) {
  return [...releaseDataNames(version), "release.json"].sort();
}

export type ReleaseAsset = {
  name: string;
  sha256: string;
  size: number;
  url: string;
};

export type ReleaseManifest = {
  schemaVersion: 1;
  version: string;
  sourceCommit: string;
  atlasSha256: string;
  licenseIds: typeof LICENSE_IDS;
  compatibility: typeof COMPATIBILITY;
  assets: ReleaseAsset[];
};

export type ValidatedRelease = {
  directory: string;
  manifest: ReleaseManifest;
  files: ReadonlyMap<string, Buffer>;
};

export type ReleaseSourceBinding = {
  sourceCommit: string;
  atlasSha256: string;
  softwareLicenseSha256: string;
  artworkLicenseSha256: string;
};
type PrepareOptions = { version: string; source: string; root?: string };
type LatestPointer = {
  schemaVersion: 1;
  version: string;
  sourceCommit: string;
  compatibility: typeof COMPATIBILITY;
  releaseJson: { url: string; sha256: string };
  checksums: { url: string; sha256: string };
};

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const releaseUrl = (version: string, name: string) =>
  `https://github.com/dhruvaldarji/ai-pet-shihtzu/releases/download/${version}/${name}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function requiredMapFile(files: ReadonlyMap<string, Buffer>, name: string) {
  const value = files.get(name);
  if (!value) throw new Error("A required release file is missing");
  return value;
}

export function parseStableVersion(version: string): [bigint, bigint, bigint] {
  const match = VERSION_PATTERN.exec(version);
  if (!match || match[0] !== version)
    throw new Error("Version must be a stable vMAJOR.MINOR.PATCH release");
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

export function compareStableVersions(left: string, right: string): number {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

async function statOrNull(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function ensureDirectory(path: string, create: boolean) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat = await statOrNull(current);
    if (!stat && create) {
      await mkdir(current, { mode: 0o755 });
      stat = await lstat(current);
    }
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Release directories must be ordinary directories");
  }
}

async function readOrdinary(path: string) {
  await ensureDirectory(join(path, ".."), false);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Release inputs must be ordinary files");
  const bytes = await readFile(path);
  if (bytes.length === 0) throw new Error("Release inputs must not be empty");
  return bytes;
}

function runCaptured(argv: string[], cwd?: string) {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("A local release verification command failed");
  return result.stdout.toString();
}

function git(root: string, ...args: string[]) {
  return runCaptured(["git", "-C", root, ...args]);
}

export async function validateReleaseSourceBinding(
  root: string,
  expectedSource: string,
): Promise<ReleaseSourceBinding> {
  if (!SHA_PATTERN.test(expectedSource))
    throw new Error("Source commit must be a full lowercase SHA");
  const head = git(root, "rev-parse", "HEAD").trim();
  if (head !== expectedSource) throw new Error("Source commit must equal HEAD");
  if (git(root, "status", "--porcelain=v1", "--untracked-files=all"))
    throw new Error("Release source tree must be clean");

  const packageJson = JSON.parse(
    (await readOrdinary(join(root, "package.json"))).toString("utf8"),
  ) as {
    packageManager?: unknown;
    engines?: { bun?: unknown };
    dependencies?: { sharp?: unknown };
  };
  if (
    packageJson.packageManager !== `bun@${Bun.version}` ||
    packageJson.engines?.bun !== Bun.version ||
    packageJson.dependencies?.sharp !== sharp.versions.sharp
  ) {
    throw new Error("Pinned Bun or Sharp version does not match the build environment");
  }

  await checkSourceSecurity(root);
  const source = JSON.parse((await readOrdinary(join(root, SOURCE_INPUT))).toString("utf8")) as {
    version?: unknown;
    atlas?: { path?: unknown; sha256?: unknown };
    license?: {
      software?: unknown;
      artwork?: unknown;
      softwareText?: unknown;
      artworkText?: unknown;
    };
  };
  if (
    source.version !== 1 ||
    source.atlas?.path !== "assets/atlas.webp" ||
    typeof source.atlas.sha256 !== "string" ||
    !HASH_PATTERN.test(source.atlas.sha256) ||
    source.license?.software !== LICENSE_IDS.software ||
    source.license?.artwork !== LICENSE_IDS.artwork ||
    source.license?.softwareText !== "LICENSE" ||
    source.license?.artworkText !== "LICENSE-ARTWORK"
  ) {
    throw new Error("Production source or license binding is invalid");
  }
  const atlas = await readOrdinary(join(root, "assets/atlas.webp"));
  if (digest(atlas) !== source.atlas.sha256)
    throw new Error("Production atlas hash does not match");
  const fixture = await readOrdinary(join(root, "fixtures/runtime/spritesheet.webp"));
  if (atlas.equals(fixture)) throw new Error("Production atlas cannot use fixture bytes");
  const animation = await contract();
  const decoded = await decode(atlas, animation);
  if (!validateAtlas(decoded, animation).valid) throw new Error("Production atlas is invalid");
  const licenses: Buffer[] = [];
  for (const name of ["LICENSE", "LICENSE-ARTWORK"]) {
    const license = await readOrdinary(join(root, name));
    if (!license.toString("utf8").trim()) throw new Error("Production license text is required");
    licenses.push(license);
  }
  return {
    sourceCommit: head,
    atlasSha256: source.atlas.sha256,
    softwareLicenseSha256: digest(licenses[0]),
    artworkLicenseSha256: digest(licenses[1]),
  };
}

async function copyBuildInputs(root: string, destination: string, binding: ReleaseSourceBinding) {
  await ensureDirectory(destination, false);
  await mkdir(join(destination, "assets"));
  for (const name of [
    ".gitignore",
    "install.sh",
    "uninstall.sh",
    "LICENSE",
    "LICENSE-ARTWORK",
    "assets/atlas.webp",
  ]) {
    const sourcePath = join(root, name);
    const bytes = await readOrdinary(sourcePath);
    if (name === "assets/atlas.webp" && digest(bytes) !== binding.atlasSha256)
      throw new Error("Production atlas changed during release preparation");
    await writeFile(join(destination, name), bytes, { flag: "wx", mode: 0o644 });
  }
}

async function treeBytes(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  async function visit(current: string, prefix: string) {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Build output cannot contain links");
      const relativeName = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) await visit(path, relativeName);
      else if (stat.isFile()) result.set(relativeName, await readFile(path));
      else throw new Error("Build output contains an unsupported file type");
    }
  }
  await visit(root, "");
  return result;
}

function sameTree(left: ReadonlyMap<string, Buffer>, right: ReadonlyMap<string, Buffer>) {
  if (left.size !== right.size) return false;
  for (const [name, bytes] of left) if (!right.get(name)?.equals(bytes)) return false;
  return true;
}

async function reproducibleBuild(root: string, binding: ReleaseSourceBinding, stage: string) {
  const workspaces = [
    await mkdtemp(join(stage, ".build-first-")),
    await mkdtemp(join(stage, ".build-second-")),
  ];
  const sources = await Promise.all(
    workspaces.map(async (workspace) => {
      const source = join(workspace, "source");
      await mkdir(source);
      await copyBuildInputs(root, source, binding);
      return source;
    }),
  );
  const options = {
    atlas: "assets/atlas.webp",
    sha256: binding.atlasSha256,
    id: "louis" as const,
  };
  const receipts = await Promise.all(
    sources.map((source) => buildRuntime({ ...options, out: "dist/build", root: source })),
  );
  const [firstReceipt, secondReceipt] = receipts;
  const [firstTree, secondTree] = await Promise.all(
    sources.map((source) => treeBytes(join(source, "dist/build"))),
  );
  if (!firstReceipt || !secondReceipt || !firstTree || !secondTree)
    throw new Error("Independent release build output is incomplete");
  if (!jsonBytes(firstReceipt).equals(jsonBytes(secondReceipt)))
    throw new Error("Independent release builds produced different receipts");
  if (!sameTree(firstTree, secondTree))
    throw new Error("Independent release builds produced different files");
  const firstSource = sources[0];
  if (!firstSource) throw new Error("Independent release build source is missing");
  return { root: join(firstSource, "dist/build"), receipt: firstReceipt };
}

function checksumText(files: ReadonlyMap<string, Buffer>, names: readonly string[]) {
  return `${[...names]
    .sort()
    .map((name) => {
      const bytes = files.get(name);
      if (!bytes) throw new Error("A required release file is missing");
      return `${digest(bytes)}  ${name}`;
    })
    .join("\n")}\n`;
}

function assetDescriptor(version: string, name: string, bytes: Buffer): ReleaseAsset {
  return { name, sha256: digest(bytes), size: bytes.length, url: releaseUrl(version, name) };
}

function createLatest(
  manifest: ReleaseManifest,
  releaseBytes: Buffer,
  sumsBytes: Buffer,
): LatestPointer {
  return {
    schemaVersion: 1,
    version: manifest.version,
    sourceCommit: manifest.sourceCommit,
    compatibility: COMPATIBILITY,
    releaseJson: {
      url: releaseUrl(manifest.version, "release.json"),
      sha256: digest(releaseBytes),
    },
    checksums: {
      url: releaseUrl(manifest.version, "SHA256SUMS"),
      sha256: digest(sumsBytes),
    },
  };
}

function parseChecksums(body: string, names: readonly string[]) {
  if (!body.endsWith("\n")) throw new Error("Checksum file is not canonical");
  const lines = body.slice(0, -1).split("\n");
  const map = new Map<string, string>();
  const namesInFile: string[] = [];
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}([^/\\\r\n]+)$/.exec(line);
    if (!match || map.has(match[2])) throw new Error("Checksum file has invalid entries");
    map.set(match[2], match[1]);
    namesInFile.push(match[2]);
  }
  const expected = [...names].sort();
  if (JSON.stringify(namesInFile) !== JSON.stringify(expected))
    throw new Error("Checksum file does not match the release allowlist");
  return map;
}

function validateManifest(value: unknown, directory: string): ReleaseManifest {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "version",
      "sourceCommit",
      "atlasSha256",
      "licenseIds",
      "compatibility",
      "assets",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    typeof value.sourceCommit !== "string" ||
    !SHA_PATTERN.test(value.sourceCommit) ||
    typeof value.atlasSha256 !== "string" ||
    !HASH_PATTERN.test(value.atlasSha256) ||
    !isRecord(value.licenseIds) ||
    !exactKeys(value.licenseIds, ["software", "artwork"]) ||
    value.licenseIds.software !== LICENSE_IDS.software ||
    value.licenseIds.artwork !== LICENSE_IDS.artwork ||
    !isRecord(value.compatibility) ||
    JSON.stringify(value.compatibility) !== JSON.stringify(COMPATIBILITY) ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("Release manifest schema is invalid");
  }
  parseStableVersion(value.version);
  if (basename(directory) !== value.version) throw new Error("Release directory version mismatch");
  const expectedNames = [...releaseDataNames(value.version)].sort();
  if (value.assets.length !== expectedNames.length)
    throw new Error("Release asset manifest is incomplete");
  for (const [index, item] of value.assets.entries()) {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["name", "sha256", "size", "url"]) ||
      typeof item.name !== "string" ||
      item.name !== expectedNames[index] ||
      typeof item.sha256 !== "string" ||
      !HASH_PATTERN.test(item.sha256) ||
      typeof item.size !== "number" ||
      !Number.isSafeInteger(item.size) ||
      item.size < 1 ||
      item.url !== releaseUrl(value.version, item.name)
    ) {
      throw new Error("Release asset descriptor is invalid");
    }
  }
  return {
    schemaVersion: 1,
    version: value.version,
    sourceCommit: value.sourceCommit,
    atlasSha256: value.atlasSha256,
    licenseIds: LICENSE_IDS,
    compatibility: COMPATIBILITY,
    assets: value.assets.map((item) => {
      const asset = item as Record<string, unknown>;
      return {
        name: asset.name as string,
        sha256: asset.sha256 as string,
        size: asset.size as number,
        url: asset.url as string,
      };
    }),
  };
}

async function verifyRuntimeArchive(
  zipPath: string,
  outerFiles: ReadonlyMap<string, Buffer>,
  version: string,
) {
  const listing = runCaptured(["unzip", "-Z", "-1", zipPath]);
  const entries = listing.trimEnd().split(/\r?\n/);
  if (JSON.stringify(entries) !== JSON.stringify(RUNTIME_ARCHIVE_FILES))
    throw new Error("Runtime ZIP entries differ from the reviewed allowlist");
  const workspace = await mkdtemp(join(await realpath(tmpdir()), "louis-release-zip-"));
  try {
    const extracted = join(workspace, "extracted");
    await mkdir(extracted);
    runCaptured(["unzip", "-q", zipPath, "-d", extracted]);
    if (
      JSON.stringify((await readdir(extracted)).sort()) !==
      JSON.stringify([...RUNTIME_ARCHIVE_FILES].sort())
    ) {
      throw new Error("Extracted runtime ZIP entries differ from the allowlist");
    }
    const files = new Map<string, Buffer>();
    for (const name of RUNTIME_ARCHIVE_FILES) {
      const bytes = await readOrdinary(join(extracted, name));
      files.set(name, bytes);
    }
    const zipName = releaseZipName(version);
    for (const name of releaseDataNames(version)) {
      if (
        name !== zipName &&
        !requiredMapFile(files, name).equals(requiredMapFile(outerFiles, name))
      )
        throw new Error("Standalone release asset differs from the runtime ZIP");
    }
    const repacked = join(workspace, "validated-runtime.zip");
    await packageRuntime(repacked, extracted, { petId: "louis" });
    if (!(await readFile(repacked)).equals(await readFile(zipPath)))
      throw new Error("Runtime ZIP differs from the validated canonical package");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function validateReleaseDirectory(
  directory: string,
  expected: {
    version?: string;
    sourceCommit?: string;
    atlasSha256?: string;
    softwareLicenseSha256?: string;
    artworkLicenseSha256?: string;
  } = {},
): Promise<ValidatedRelease> {
  const root = resolve(directory);
  await ensureDirectory(root, false);
  const version = basename(root);
  parseStableVersion(version);
  const releaseFiles = releaseAssetNames(version);
  const names = (await readdir(root)).sort();
  if (JSON.stringify(names) !== JSON.stringify(releaseFiles))
    throw new Error("Release directory does not match the exact allowlist");
  const files = new Map<string, Buffer>();
  for (const name of releaseFiles) files.set(name, await readOrdinary(join(root, name)));
  const manifestBytes = requiredMapFile(files, "release.json");
  const manifestValue = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  const manifest = validateManifest(manifestValue, root);
  if (
    (expected.version !== undefined && manifest.version !== expected.version) ||
    (expected.sourceCommit !== undefined && manifest.sourceCommit !== expected.sourceCommit) ||
    (expected.atlasSha256 !== undefined && manifest.atlasSha256 !== expected.atlasSha256) ||
    (expected.softwareLicenseSha256 !== undefined &&
      digest(requiredMapFile(files, "LICENSE")) !== expected.softwareLicenseSha256) ||
    (expected.artworkLicenseSha256 !== undefined &&
      digest(requiredMapFile(files, "LICENSE-ARTWORK")) !== expected.artworkLicenseSha256)
  ) {
    throw new Error("Release source or version differs from the requested values");
  }
  if (!jsonBytes(manifest).equals(manifestBytes))
    throw new Error("Release manifest is not canonical");
  const outerSums = requiredMapFile(files, "SHA256SUMS").toString("utf8");
  const checksumFiles = releaseChecksumNames(manifest.version);
  const checksums = parseChecksums(outerSums, checksumFiles);
  for (const name of checksumFiles) {
    const bytes = requiredMapFile(files, name);
    if (digest(bytes) !== checksums.get(name)) throw new Error("Release checksum mismatch");
  }
  for (const descriptor of manifest.assets) {
    const bytes = requiredMapFile(files, descriptor.name);
    if (
      bytes.length !== descriptor.size ||
      digest(bytes) !== descriptor.sha256 ||
      (descriptor.name === "spritesheet.webp" && descriptor.sha256 !== manifest.atlasSha256)
    ) {
      throw new Error("Release asset does not match its manifest");
    }
  }
  for (const name of ["LICENSE", "LICENSE-ARTWORK"]) {
    if (!requiredMapFile(files, name).toString("utf8").trim())
      throw new Error("Release license is empty");
  }
  await verifyRuntimeArchive(join(root, releaseZipName(manifest.version)), files, manifest.version);
  return { directory: root, manifest, files };
}

async function buildVersionFiles(
  buildRoot: string,
  source: ReleaseSourceBinding,
  version: string,
  stagingDirectory: string,
) {
  const runtime = join(buildRoot, "runtime");
  const files = new Map<string, Buffer>();
  const outputFiles = releaseDataNames(version);
  const releaseFiles = releaseAssetNames(version);
  files.set(releaseZipName(version), await readOrdinary(join(buildRoot, "louis.zip")));
  for (const name of outputFiles.slice(1))
    files.set(name, await readOrdinary(join(runtime, name)));
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    version,
    sourceCommit: source.sourceCommit,
    atlasSha256: source.atlasSha256,
    licenseIds: LICENSE_IDS,
    compatibility: COMPATIBILITY,
    assets: [...outputFiles]
      .sort()
      .map((name) => assetDescriptor(version, name, requiredMapFile(files, name))),
  };
  const releaseBytes = jsonBytes(manifest);
  files.set("release.json", releaseBytes);
  const sumsBytes = Buffer.from(checksumText(files, releaseChecksumNames(version)));
  files.set("SHA256SUMS", sumsBytes);
  await mkdir(stagingDirectory, { mode: 0o755 });
  for (const name of releaseFiles)
    await writeFile(join(stagingDirectory, name), requiredMapFile(files, name), {
      flag: "wx",
      mode: 0o644,
    });
  await validateReleaseDirectory(stagingDirectory, {
    version,
    sourceCommit: source.sourceCommit,
  });
  return { manifest, releaseBytes, sumsBytes, files };
}

async function latestForDirectory(directory: string, version: string) {
  const release = await validateReleaseDirectory(directory, { version });
  const latest = createLatest(
    release.manifest,
    requiredMapFile(release.files, "release.json"),
    requiredMapFile(release.files, "SHA256SUMS"),
  );
  return { latest, bytes: jsonBytes(latest), sourceCommit: release.manifest.sourceCommit };
}

async function readLatestPointer(releasesDirectory: string): Promise<LatestPointer | null> {
  const path = join(releasesDirectory, "latest.json");
  const stat = await statOrNull(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Latest pointer must be an ordinary file");
  const bytes = await readFile(path);
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "version",
      "sourceCommit",
      "compatibility",
      "releaseJson",
      "checksums",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    typeof value.sourceCommit !== "string" ||
    !SHA_PATTERN.test(value.sourceCommit) ||
    JSON.stringify(value.compatibility) !== JSON.stringify(COMPATIBILITY) ||
    !isRecord(value.releaseJson) ||
    !exactKeys(value.releaseJson, ["url", "sha256"]) ||
    value.releaseJson.url !== releaseUrl(value.version, "release.json") ||
    typeof value.releaseJson.sha256 !== "string" ||
    !HASH_PATTERN.test(value.releaseJson.sha256) ||
    !isRecord(value.checksums) ||
    !exactKeys(value.checksums, ["url", "sha256"]) ||
    value.checksums.url !== releaseUrl(value.version, "SHA256SUMS") ||
    typeof value.checksums.sha256 !== "string" ||
    !HASH_PATTERN.test(value.checksums.sha256)
  ) {
    throw new Error("Latest pointer schema is invalid");
  }
  parseStableVersion(value.version);
  const pointer: LatestPointer = {
    schemaVersion: 1,
    version: value.version,
    sourceCommit: value.sourceCommit,
    compatibility: COMPATIBILITY,
    releaseJson: {
      url: value.releaseJson.url as string,
      sha256: value.releaseJson.sha256 as string,
    },
    checksums: {
      url: value.checksums.url as string,
      sha256: value.checksums.sha256 as string,
    },
  };
  if (!jsonBytes(pointer).equals(bytes)) throw new Error("Latest pointer is not canonical");
  const versionDirectory = join(releasesDirectory, pointer.version);
  const verified = await latestForDirectory(versionDirectory, pointer.version);
  if (verified.sourceCommit !== pointer.sourceCommit || !verified.bytes.equals(bytes))
    throw new Error("Latest pointer does not match its immutable release");
  return pointer;
}

export async function prepareRelease(options: PrepareOptions) {
  const root = resolve(options.root ?? repo);
  parseStableVersion(options.version);
  if (!SHA_PATTERN.test(options.source))
    throw new Error("Source commit must be a full lowercase SHA");
  await ensureDirectory(root, false);
  const binding = await validateReleaseSourceBinding(root, options.source);
  const releasesDirectory = join(root, "dist/releases");
  await ensureDirectory(releasesDirectory, true);
  const lock = join(releasesDirectory, ".prepare.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error("Release catalog is locked by another preparation");
  }
  const stage = join(releasesDirectory, `.stage-${randomUUID()}`);
  try {
    await mkdir(stage, { mode: 0o700 });
    const build = await reproducibleBuild(root, binding, stage);
    const stagedVersion = join(stage, options.version);
    const candidate = await buildVersionFiles(build.root, binding, options.version, stagedVersion);
    if (
      git(root, "rev-parse", "HEAD").trim() !== binding.sourceCommit ||
      git(root, "status", "--porcelain=v1", "--untracked-files=all")
    ) {
      throw new Error("Release source changed during preparation");
    }
    const existingLatest = await readLatestPointer(releasesDirectory);
    const finalVersion = join(releasesDirectory, options.version);
    const existing = await statOrNull(finalVersion);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink())
        throw new Error("Existing release version is not an ordinary directory");
      const verified = await validateReleaseDirectory(finalVersion, {
        version: options.version,
        sourceCommit: binding.sourceCommit,
      });
      if (!sameTree(candidate.files, verified.files))
        throw new Error("Existing immutable release differs from the requested build");
      await rm(stagedVersion, { recursive: true, force: true });
    } else {
      await rename(stagedVersion, finalVersion);
    }

    let latestUpdated = false;
    const currentVersion = existingLatest?.version;
    const compare = currentVersion ? compareStableVersions(options.version, currentVersion) : 1;
    if (compare > 0) {
      const pointer = createLatest(candidate.manifest, candidate.releaseBytes, candidate.sumsBytes);
      const pointerPath = join(stage, "latest.json");
      await writeFile(pointerPath, jsonBytes(pointer), { flag: "wx", mode: 0o644 });
      await rename(pointerPath, join(releasesDirectory, "latest.json"));
      latestUpdated = true;
    } else if (compare === 0 && existingLatest) {
      const expected = createLatest(
        candidate.manifest,
        candidate.releaseBytes,
        candidate.sumsBytes,
      );
      if (!jsonBytes(expected).equals(jsonBytes(existingLatest)))
        throw new Error("Latest pointer conflicts with the immutable release");
    }
    return { version: options.version, sourceCommit: binding.sourceCommit, latestUpdated };
  } finally {
    try {
      await rm(stage, { recursive: true, force: true });
    } finally {
      await rmdir(lock);
    }
  }
}

function parseArguments(args: string[]) {
  if (args[0] === "--") args.shift();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--version", "--source"].includes(name) || !value || values.has(name))
      throw new Error("Invalid release preparation arguments");
    values.set(name, value);
  }
  if (values.size !== 2) throw new Error("Both version and source are required");
  const version = values.get("--version");
  const source = values.get("--source");
  if (!version || !source) throw new Error("Both version and source are required");
  return { version, source };
}

if (import.meta.main) {
  try {
    const result = await prepareRelease(parseArguments(process.argv.slice(2)));
    console.log(`Prepared immutable release ${result.version}.`);
  } catch {
    console.error("Release preparation failed; inspect local source and catalog state privately.");
    process.exitCode = 1;
  }
}
