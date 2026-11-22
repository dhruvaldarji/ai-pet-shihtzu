#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import {
  RELEASE_ASSET_NAMES,
  compareStableVersions,
  parseStableVersion,
  validateReleaseCatalog,
} from "./release";
import type { ValidatedRelease } from "./release";
import { contract } from "./pet";

const repo = resolve(import.meta.dir, "..");
const dist = join(repo, "dist");
const source = join(repo, "site");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export type SiteMode = "preview" | "production";
export type SiteBuildOptions = { catalog?: string; out?: string; mode?: SiteMode };
type Catalog = Awaited<ReturnType<typeof validateReleaseCatalog>>;

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escaped[character] ?? character;
  });
}

export function nativeInstallCandidate(version: string) {
  parseStableVersion(version);
  const parameters = new URLSearchParams({
    name: "Louis",
    imageUrl: `https://louis.dhruvaldarji.com/releases/${version}/spritesheet.webp`,
    spriteVersionNumber: "2",
  });
  return `codex://pets/install?${parameters.toString()}`;
}

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function exists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectory(path: string, create: boolean, created: string[] = []) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat = await exists(current);
    if (!stat && create) {
      await mkdir(current, { mode: 0o755 });
      created.push(current);
      stat = await lstat(current);
    }
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Site paths must use ordinary directories");
  }
}

async function ordinaryFile(path: string) {
  const parent = join(path, "..");
  await ensureDirectory(parent, false);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Site inputs must be ordinary files");
  return readFile(path);
}

function checksum(release: ValidatedRelease, name: string) {
  const bytes = release.files.get(name);
  if (!bytes) throw new Error("Verified release is incomplete");
  return sha(bytes);
}

function releaseRows(releases: ValidatedRelease[]) {
  return [...releases]
    .sort((left, right) => compareStableVersions(left.manifest.version, right.manifest.version))
    .map((release) => {
      const version = escapeHtml(release.manifest.version);
      const commit = escapeHtml(release.manifest.sourceCommit);
      const root = `./releases/${version}`;
      const links = [
        ["Package ZIP", "louis.zip"],
        ["Sprite sheet", "spritesheet.webp"],
        ["Pet metadata", "pet.json"],
        ["Animation preview", "preview.gif"],
        ["Package README", "README.md"],
        ["Release notes", "RELEASE_NOTES.md"],
        ["Manifest", "release.json"],
        ["Checksums", "SHA256SUMS"],
        ["Software license", "LICENSE"],
        ["Artwork license", "LICENSE-ARTWORK"],
      ]
        .map(([label, file]) => `<li><a href="${root}/${file}">${label}</a></li>`)
        .join("\n              ");
      return `<li>
            <h3>${version}</h3>
            <p>Source commit <a href="https://github.com/dhruvaldarji/ai-pet-shihtzu/commit/${commit}"><code>${commit}</code></a></p>
            <p>release.json SHA256 <code>${checksum(release, "release.json")}</code></p>
            <ul class="release-links">
              ${links}
            </ul>
          </li>`;
    })
    .join("\n          ");
}

async function renderedIndex(catalog: Catalog, mode: SiteMode) {
  const selected = catalog.releases.find(
    (release) => release.manifest.version === catalog.latest.version,
  );
  if (!selected) throw new Error("Selected release is missing from the verified catalog");
  let html = (await ordinaryFile(join(source, "index.html"))).toString("utf8");
  const version = escapeHtml(selected.manifest.version);
  const commit = escapeHtml(selected.manifest.sourceCommit);
  const replacements: Record<string, string> = {
    "{{PREVIEW_BANNER}}":
      mode === "preview"
        ? '<p class="preview-banner" role="status">Preview only — artifacts are not published.</p>'
        : "",
    "{{ZIP_URL}}": `./releases/${version}/louis.zip`,
    "{{ANIMATION_URL}}": `./releases/${version}/preview.gif`,
    "{{VERSION}}": version,
    "{{SOURCE_URL}}": `https://github.com/dhruvaldarji/ai-pet-shihtzu/commit/${commit}`,
    "{{SOURCE_COMMIT}}": commit,
    "{{RELEASE_SHA256}}": checksum(selected, "release.json"),
    "{{RELEASE_ROWS}}": releaseRows(catalog.releases),
  };
  for (const [placeholder, value] of Object.entries(replacements))
    html = html.replaceAll(placeholder, value);
  if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error("Site template contains an unresolved field");
  return html;
}

async function posterFor(release: ValidatedRelease) {
  const sprite = release.files.get("spritesheet.webp");
  if (!sprite) throw new Error("Selected release has no sprite sheet");
  const layout = (await contract()).layout;
  return sharp(sprite)
    .extract({ left: 0, top: 0, width: layout.cellWidth, height: layout.cellHeight })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

function siteMetadata(catalog: Catalog, mode: SiteMode) {
  const selected = catalog.releases.find(
    (release) => release.manifest.version === catalog.latest.version,
  );
  if (!selected) throw new Error("Selected release is missing from the verified catalog");
  const releases = [...catalog.releases]
    .sort((left, right) => compareStableVersions(left.manifest.version, right.manifest.version))
    .map((release) => ({
      version: release.manifest.version,
      sourceCommit: release.manifest.sourceCommit,
      releaseJsonSha256: checksum(release, "release.json"),
      sha256SumsSha256: checksum(release, "SHA256SUMS"),
    }));
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode,
        selected: {
          version: selected.manifest.version,
          sourceCommit: selected.manifest.sourceCommit,
          releaseJsonSha256: checksum(selected, "release.json"),
          sha256SumsSha256: checksum(selected, "SHA256SUMS"),
          spritesheetSha256: checksum(selected, "spritesheet.webp"),
        },
        compatibility: selected.manifest.compatibility,
        nativeInstall: {
          enabled: false,
          status: "unverified",
          candidateUrl: nativeInstallCandidate(selected.manifest.version),
        },
        releases,
      },
      null,
      2,
    )}\n`,
  );
}

async function expectedFiles(catalog: Catalog, mode: SiteMode) {
  const selected = catalog.releases.find(
    (release) => release.manifest.version === catalog.latest.version,
  );
  if (!selected) throw new Error("Selected release is missing from the verified catalog");
  const files = new Map<string, Buffer>();
  files.set("index.html", Buffer.from(await renderedIndex(catalog, mode)));
  files.set("404.html", await ordinaryFile(join(source, "404.html")));
  files.set("styles.css", await ordinaryFile(join(source, "styles.css")));
  files.set("poster.png", await posterFor(selected));
  files.set("site.json", siteMetadata(catalog, mode));
  files.set("releases/latest.json", catalog.latestBytes);
  for (const release of catalog.releases) {
    for (const name of RELEASE_ASSET_NAMES) {
      const bytes = release.files.get(name);
      if (!bytes) throw new Error("Verified release is incomplete");
      files.set(`releases/${release.manifest.version}/${name}`, bytes);
    }
  }
  return files;
}

async function collectFiles(directory: string) {
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();
  const visit = async (current: string, prefix: string) => {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Site output cannot contain symbolic links");
      if (stat.isDirectory()) {
        const child = prefix ? `${prefix}/${name}` : name;
        directories.add(child);
        await visit(path, child);
      } else if (stat.isFile())
        files.set(prefix ? `${prefix}/${name}` : name, await readFile(path));
      else throw new Error("Site output contains an unsupported entry");
    }
  };
  await visit(directory, "");
  return { files, directories };
}

async function matchesOutput(directory: string, expected: Map<string, Buffer>) {
  const actual = await collectFiles(directory);
  const expectedDirectories = new Set<string>();
  for (const name of expected.keys()) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index++)
      expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  if (
    actual.files.size !== expected.size ||
    actual.directories.size !== expectedDirectories.size ||
    [...expectedDirectories].some((name) => !actual.directories.has(name))
  )
    return false;
  for (const [name, bytes] of expected) if (!actual.files.get(name)?.equals(bytes)) return false;
  return true;
}

async function writeStage(directory: string, files: Map<string, Buffer>) {
  await mkdir(directory, { mode: 0o755 });
  for (const [name, bytes] of files) {
    const path = join(directory, name);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o755 });
    await writeFile(path, bytes, { flag: "wx", mode: 0o644 });
  }
}

export async function buildStaticSite(options: SiteBuildOptions = {}) {
  const mode = options.mode ?? "preview";
  if (mode !== "preview" && mode !== "production") throw new Error("Invalid site mode");
  const catalogDirectory = resolve(repo, options.catalog ?? "dist/releases");
  const outputDirectory = resolve(repo, options.out ?? "dist/site");
  if (
    outputDirectory === dist ||
    !within(dist, outputDirectory) ||
    !within(dist, catalogDirectory) ||
    within(catalogDirectory, outputDirectory) ||
    within(outputDirectory, catalogDirectory) ||
    within(source, outputDirectory) ||
    within(outputDirectory, source)
  ) {
    throw new Error("Site output must be a separate path below dist");
  }
  const catalog = await validateReleaseCatalog(catalogDirectory);
  const expected = await expectedFiles(catalog, mode);
  const createdParents: string[] = [];
  const stage = join(dist, `.site-stage-${randomUUID()}`);
  try {
    await ensureDirectory(join(outputDirectory, ".."), true, createdParents);
    const existing = await exists(outputDirectory);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink())
        throw new Error("Existing site output is not an ordinary directory");
      if (!(await matchesOutput(outputDirectory, expected)))
        throw new Error("Existing site output differs; refusing to overwrite it");
      return { mode, releaseCount: catalog.releases.length, unchanged: true };
    }
    await writeStage(stage, expected);
    if (!(await matchesOutput(stage, expected)))
      throw new Error("Staged site output failed verification");
    await rename(stage, outputDirectory);
    return { mode, releaseCount: catalog.releases.length, unchanged: false };
  } finally {
    await rm(stage, { recursive: true, force: true });
    for (const path of createdParents.reverse()) await rmdir(path).catch(() => {});
  }
}

function parseArguments(args: string[]): SiteBuildOptions {
  if (args[0] === "--") args.shift();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--catalog", "--out", "--mode"].includes(name) || !value || values.has(name))
      throw new Error("Invalid site arguments");
    values.set(name, value);
  }
  const mode = values.get("--mode") ?? "preview";
  if (mode !== "preview" && mode !== "production") throw new Error("Invalid site mode");
  return { catalog: values.get("--catalog"), out: values.get("--out"), mode };
}

if (import.meta.main) {
  try {
    const result = await buildStaticSite(parseArguments(process.argv.slice(2)));
    console.log(
      `Prepared ${result.mode} static site with ${result.releaseCount} verified release(s).`,
    );
  } catch {
    console.error("Static site build failed; inspect the catalog and output state privately.");
    process.exitCode = 1;
  }
}
