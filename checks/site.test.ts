import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdtemp,
  realpath,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { RELEASE_ASSET_NAMES, validateReleaseSourceBinding } from "../tools/release";
import { contract } from "../tools/pet";

const repository = join(import.meta.dir, "..");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let temporary: string;
let root: string;
let sourceCommit: string;
let sourceCloneClean: boolean;
let sourceCloneContainsSentinel: boolean;

function run(args: string[], cwd: string) {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function succeed(args: string[], cwd: string) {
  const result = run(args, cwd);
  if (result.code !== 0) throw new Error(`Local site fixture command failed: ${result.stderr}`);
  return result;
}

function git(root: string, ...args: string[]) {
  const result = run(["git", "-C", root, ...args], repository);
  if (result.code !== 0) throw new Error("A local site test Git operation failed");
  return result.stdout.trim();
}

function siteCommand(...args: string[]) {
  return run([process.execPath, join(root, "tools/site.ts"), ...args], root);
}

async function cloneSource(parent: string, name: string) {
  const root = join(parent, name);
  const source = git(repository, "rev-parse", "HEAD");
  const clone = run(
    ["git", "clone", "--no-hardlinks", "--quiet", "--no-checkout", repository, root],
    repository,
  );
  if (clone.code !== 0) throw new Error("A temporary site source clone could not be created");
  git(root, "fetch", "--quiet", "--no-tags", repository, source);
  git(root, "checkout", "--quiet", "--detach", source);
  await symlink(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  await symlink(join(repository, ".quality-bin"), join(root, ".quality-bin"), "dir");
  await appendFile(join(root, ".git/info/exclude"), "\n/node_modules\n/.quality-bin\n");
  return { root, source };
}

function inspectHtml(html: string) {
  const result = {
    anchors: [] as string[],
    images: [] as {
      alt: string | null;
      width: string | null;
      height: string | null;
      src: string | null;
    }[],
    disabledButtons: 0,
    openDetails: 0,
    main: 0,
    mainTabIndex: null as string | null,
    navigation: 0,
    stylesheets: [] as string[],
    scripts: 0,
    summaries: [] as string[],
  };
  const transformed = new HTMLRewriter()
    .on("main#main", {
      element(element) {
        result.main++;
        result.mainTabIndex = element.getAttribute("tabindex");
      },
    })
    .on("nav[aria-label]", {
      element() {
        result.navigation++;
      },
    })
    .on("link[rel=stylesheet]", {
      element(element) {
        result.stylesheets.push(element.getAttribute("href") ?? "");
      },
    })
    .on("summary", {
      text(text) {
        result.summaries.push(text.text);
      },
    })
    .on("a[href]", {
      element(element) {
        result.anchors.push(element.getAttribute("href") ?? "");
      },
    })
    .on("img", {
      element(element) {
        result.images.push({
          alt: element.getAttribute("alt"),
          width: element.getAttribute("width"),
          height: element.getAttribute("height"),
          src: element.getAttribute("src"),
        });
      },
    })
    .on("button[disabled]", {
      element() {
        result.disabledButtons++;
      },
    })
    .on("details[open]", {
      element() {
        result.openDetails++;
      },
    })
    .on("script", {
      element() {
        result.scripts++;
      },
    })
    .transform(html);
  if (typeof transformed !== "string") throw new Error("HTML inventory did not produce text");
  return result;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("Test output unexpectedly contains a symlink");
    const item = prefix ? `${prefix}/${name}` : name;
    if (stat.isDirectory()) result.push(...(await listFiles(path, item)));
    else result.push(item);
  }
  return result;
}

beforeAll(async () => {
  temporary = await mkdtemp(join(await realpath(tmpdir()), "louis-site-check-"));
  const sentinelName = `louis-site-untracked-sentinel-${randomUUID()}.txt`;
  const sentinel = join(repository, sentinelName);
  await writeFile(sentinel, "local site test sentinel\n", { flag: "wx" });
  try {
    const clone = await cloneSource(temporary, "repo");
    root = clone.root;
    sourceCommit = clone.source;
    sourceCloneClean = git(root, "status", "--porcelain=v1", "--untracked-files=all") === "";
    sourceCloneContainsSentinel = await Bun.file(join(root, sentinelName)).exists();
  } finally {
    await unlink(sentinel);
  }
});

afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test("source fixture checks out committed HEAD without copying an untracked sentinel", () => {
  expect(git(root, "rev-parse", "HEAD")).toBe(sourceCommit);
  expect(sourceCloneClean).toBe(true);
  expect(sourceCloneContainsSentinel).toBe(false);
});

test("real release catalog builds deterministic preview and production sites from verified artwork", async () => {
  const sourceCommit = succeed(["git", "rev-parse", "HEAD"], root).stdout.trim();
  const binding = await validateReleaseSourceBinding(root, sourceCommit);
  expect(binding.sourceCommit).toBe(sourceCommit);
  const catalog = join(root, "dist/releases");
  const versions = ["v1.2.3", "v1.2.4"];
  let earlierPointer: Buffer | undefined;
  for (const version of versions) {
    succeed(
      [
        process.execPath,
        join(root, "tools/release.ts"),
        "--version",
        version,
        "--source",
        sourceCommit,
      ],
      root,
    );
    if (version === versions[0])
      earlierPointer = await Bun.file(join(catalog, "latest.json"))
        .bytes()
        .then((b) => Buffer.from(b));
  }

  const atlasPath = join(root, "assets/atlas.webp");
  const atlasBefore = digest(await Bun.file(atlasPath).bytes());
  const latestBytes = Buffer.from(await Bun.file(join(catalog, "latest.json")).bytes());
  const previewOut = join(root, "dist/site");
  const firstBuild = siteCommand();
  expect(firstBuild.code).toBe(0);
  expect(firstBuild.stdout).toBe("Prepared preview static site with 2 verified release(s).\n");

  const latestVersion = versions[1];
  const sourceRelease = join(catalog, latestVersion);
  const outputReleases = join(previewOut, "releases");
  expect((await readdir(previewOut)).sort()).toEqual([
    "404.html",
    "index.html",
    "poster.png",
    "releases",
    "site.json",
    "styles.css",
  ]);
  expect((await readdir(outputReleases)).sort()).toEqual([...versions, "latest.json"].sort());
  expect((await readdir(join(outputReleases, latestVersion))).sort()).toEqual([
    ...RELEASE_ASSET_NAMES,
  ]);
  const expectedOutputFiles = [
    "404.html",
    "index.html",
    "poster.png",
    "site.json",
    "styles.css",
    "releases/latest.json",
    ...versions.flatMap((version) =>
      RELEASE_ASSET_NAMES.map((name) => `releases/${version}/${name}`),
    ),
  ].sort();
  expect(await listFiles(previewOut)).toEqual(expectedOutputFiles);
  for (const version of versions) {
    for (const name of RELEASE_ASSET_NAMES) {
      const original = await Bun.file(join(catalog, version, name)).bytes();
      const copied = await Bun.file(join(outputReleases, version, name)).bytes();
      expect(Buffer.from(copied).equals(Buffer.from(original))).toBe(true);
    }
  }
  expect(
    Buffer.from(await Bun.file(join(outputReleases, "latest.json")).bytes()).equals(latestBytes),
  ).toBe(true);

  const metadata = JSON.parse(await Bun.file(join(previewOut, "site.json")).text()) as {
    schemaVersion: number;
    mode: string;
    selected: {
      version: string;
      sourceCommit: string;
      releaseJsonSha256: string;
      sha256SumsSha256: string;
      spritesheetSha256: string;
    };
    compatibility: Record<string, string | number>;
    nativeInstall: { enabled: boolean; status: string; candidateUrl: string };
    releases: {
      version: string;
      sourceCommit: string;
      releaseJsonSha256: string;
      sha256SumsSha256: string;
    }[];
  };
  expect(metadata.schemaVersion).toBe(1);
  expect(metadata.mode).toBe("preview");
  expect(metadata.selected.version).toBe(latestVersion);
  expect(metadata.selected.sourceCommit).toBe(sourceCommit);
  expect(metadata.releases.map((release) => release.version)).toEqual(versions);
  for (const release of metadata.releases) {
    expect(release.releaseJsonSha256).toBe(
      digest(await Bun.file(join(catalog, release.version, "release.json")).bytes()),
    );
    expect(release.sha256SumsSha256).toBe(
      digest(await Bun.file(join(catalog, release.version, "SHA256SUMS")).bytes()),
    );
  }
  const selectedManifest = JSON.parse(await Bun.file(join(sourceRelease, "release.json")).text());
  expect(metadata.compatibility).toEqual(selectedManifest.compatibility);
  expect(metadata.nativeInstall).toMatchObject({ enabled: false, status: "unverified" });
  const candidate = new URL(metadata.nativeInstall.candidateUrl);
  expect(candidate.protocol).toBe("codex:");
  expect(candidate.searchParams.get("name")).toBe("Louis");
  expect(candidate.searchParams.get("imageUrl")).toBe(
    `https://louis.dhruvaldarji.com/releases/${latestVersion}/spritesheet.webp`,
  );
  expect(candidate.searchParams.get("spriteVersionNumber")).toBe("2");

  const html = await Bun.file(join(previewOut, "index.html")).text();
  expect(html).toContain("Preview only — artifacts are not published.");
  expect(html).toContain("Louis rules the day with tiny acts of mischief and very important naps.");
  const inventory = inspectHtml(html);
  expect(inventory.main).toBe(1);
  expect(inventory.mainTabIndex).toBe("-1");
  expect(inventory.navigation).toBe(1);
  expect(inventory.summaries).toContain("Show animation preview (close this panel to hide it)");
  expect(inventory.disabledButtons).toBe(1);
  expect(inventory.openDetails).toBe(0);
  expect(inventory.scripts).toBe(0);
  expect(
    inventory.images.every((image) => image.alt && image.width === "192" && image.height === "208"),
  ).toBe(true);
  expect(inventory.anchors.some((href) => href.startsWith("codex:"))).toBe(false);
  expect(inventory.anchors).toContain("#main");
  expect(inventory.images.map((image) => image.src)).toContain(
    `./releases/${latestVersion}/preview.gif`,
  );
  expect(inventory.images.some((image) => image.src?.endsWith("latest/spritesheet.webp"))).toBe(
    false,
  );
  const versionedArtifacts = inventory.anchors.filter((href) =>
    RELEASE_ASSET_NAMES.some((name) => href.endsWith(`/${name}`)),
  );
  expect(versionedArtifacts.length).toBeGreaterThan(0);
  for (const version of versions) {
    for (const name of RELEASE_ASSET_NAMES)
      expect(inventory.anchors).toContain(`./releases/${version}/${name}`);
  }
  expect(
    versionedArtifacts.every((href) =>
      versions.some((version) => href.startsWith(`./releases/${version}/`)),
    ),
  ).toBe(true);
  expect(inventory.anchors).toContain(
    `https://github.com/dhruvaldarji/ai-pet-shihtzu/commit/${sourceCommit}`,
  );
  expect(inventory.anchors).toContain("./releases/latest.json");

  const notFound = inspectHtml(await Bun.file(join(previewOut, "404.html")).text());
  expect(notFound.main).toBe(1);
  expect(notFound.mainTabIndex).toBe("-1");
  expect(notFound.stylesheets).toEqual(["/styles.css"]);
  expect(notFound.anchors).toContain("#main");
  const nestedMissingUrl = new URL(
    `https://louis.dhruvaldarji.com/releases/${latestVersion}/missing`,
  );
  for (const stylesheet of notFound.stylesheets)
    expect(new URL(stylesheet, nestedMissingUrl).pathname).toBe("/styles.css");
  const homeLinks = notFound.anchors.filter((href) => href === "/");
  expect(homeLinks.length).toBe(2);
  for (const href of homeLinks) expect(new URL(href, nestedMissingUrl).pathname).toBe("/");

  const layout = (await contract()).layout;
  const sprite = await Bun.file(join(sourceRelease, "spritesheet.webp")).bytes();
  const spriteHash = digest(sprite);
  expect(metadata.selected.spritesheetSha256).toBe(spriteHash);
  const expectedPixels = await sharp(sprite)
    .extract({ left: 0, top: 0, width: layout.cellWidth, height: layout.cellHeight })
    .ensureAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  const poster = await Bun.file(join(previewOut, "poster.png")).bytes();
  const actualPixels = await sharp(poster).ensureAlpha().toColourspace("srgb").raw().toBuffer();
  expect(actualPixels.equals(expectedPixels)).toBe(true);
  expect(digest(await Bun.file(join(sourceRelease, "spritesheet.webp")).bytes())).toBe(spriteHash);
  expect(digest(await Bun.file(atlasPath).bytes())).toBe(atlasBefore);

  const css = await Bun.file(join(previewOut, "styles.css")).text();
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain(".animation[open] .animated-preview");
  expect(css).toContain(".animation[open] .still-preview");
  const beforeNoop = await listFiles(previewOut);
  const secondBuild = siteCommand();
  expect(secondBuild.code).toBe(0);
  expect(await listFiles(previewOut)).toEqual(beforeNoop);

  const productionOut = join(root, "dist/site-production");
  const productionBuild = siteCommand("--mode", "production", "--out", "dist/site-production");
  expect(productionBuild.code).toBe(0);
  expect(await Bun.file(join(productionOut, "site.json")).text()).toContain('"mode": "production"');
  expect(await Bun.file(join(productionOut, "index.html")).text()).not.toContain(
    "Preview only — artifacts are not published.",
  );

  const dirtyCatalog = join(catalog, ".stage-interrupted");
  await writeFile(dirtyCatalog, "marker");
  const markerFailure = siteCommand("--out", "dist/site-marker-failure");
  expect(markerFailure.code).toBe(1);
  expect(markerFailure.stderr).toBe(
    "Static site build failed; inspect the catalog and output state privately.\n",
  );
  expect(await Bun.file(join(root, "dist/site-marker-failure")).exists()).toBe(false);
  await rm(dirtyCatalog);

  const symlinkEntry = join(catalog, "v9.9.9");
  await symlink(join(catalog, versions[0]), symlinkEntry, "dir");
  expect(siteCommand("--out", "dist/site-symlink-failure").code).toBe(1);
  await unlink(symlinkEntry);

  const catalogAlias = join(root, "dist/releases-alias");
  await symlink(catalog, catalogAlias, "dir");
  expect(
    siteCommand("--catalog", "dist/releases-alias", "--out", "dist/site-alias-failure").code,
  ).toBe(1);
  await unlink(catalogAlias);

  const staleLatest = join(catalog, "latest.json");
  if (!earlierPointer) throw new Error("Test release pointer was not captured");
  await writeFile(staleLatest, earlierPointer);
  const staleFailure = siteCommand("--out", "dist/site-stale-failure");
  expect(staleFailure.code).toBe(1);
  expect(await Bun.file(join(root, "dist/site-stale-failure")).exists()).toBe(false);
  await writeFile(staleLatest, latestBytes);

  const tamperedFile = join(catalog, versions[0], "README.md");
  const originalReadme = await Bun.file(tamperedFile).bytes();
  await writeFile(
    tamperedFile,
    Buffer.concat([Buffer.from(originalReadme), Buffer.from("tampered\n")]),
  );
  expect(siteCommand("--out", "dist/site-tampered-failure").code).toBe(1);
  expect(await Bun.file(join(root, "dist/site-tampered-failure")).exists()).toBe(false);
  await writeFile(tamperedFile, originalReadme);

  expect(siteCommand("--out", "dist/releases/overlap").code).toBe(1);
  const changedOutput = join(previewOut, "index.html");
  await writeFile(changedOutput, "unrelated output\n");
  const mismatch = siteCommand();
  expect(mismatch.code).toBe(1);
  expect(mismatch.stderr).toBe(
    "Static site build failed; inspect the catalog and output state privately.\n",
  );
  expect(await Bun.file(changedOutput).text()).toBe("unrelated output\n");
}, 240000);
