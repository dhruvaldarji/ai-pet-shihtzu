import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validatePreview, validateWebp } from "./media";

const repo = resolve(import.meta.dir, "..");
const approvedMedia = new Set([
  "assets/atlas.webp",
  "fixtures/runtime/spritesheet.webp",
  "fixtures/runtime/preview.gif",
]);

export function checkTrackedPaths(paths: string[]) {
  for (const path of paths) {
    const segments = path.split("/");
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      segments.some((segment) => segment === "." || segment === "..") ||
      /(?:^|\/)(?:private|pet-backups|node_modules|dist|\.quality-bin)(?:\/|$)/i.test(path) ||
      /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519)$/i.test(path) ||
      /\.(?:pem|key|p12|pfx|zip|tar|gz)$/i.test(path)
    ) {
      throw new Error("Tracked-file privacy policy failed");
    }
    if (
      /\.(?:webp|gif|png|jpe?g|heic|tiff?|bmp|svg|ico)$/i.test(path) &&
      !approvedMedia.has(path)
    ) {
      throw new Error("Unapproved tracked media");
    }
  }
}

export function checkActionPins(workflow: unknown) {
  const seen = new Set<object>();
  function visit(value: unknown) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "uses" &&
        (typeof child !== "string" || !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(child))
      ) {
        throw new Error("Workflow actions must use full commit SHA pins");
      }
      visit(child);
    }
  }
  visit(workflow);
}

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Cannot inspect release source tree");
  return result.stdout.toString();
}

export async function checkSourceSecurity(root = repo) {
  const paths = git(root, "ls-files", "-z").split("\0").filter(Boolean);
  checkTrackedPaths(paths);
  for (const path of paths) {
    const pathOnDisk = join(root, path);
    const info = await lstat(pathOnDisk);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Tracked sources must be ordinary files");
    if (path.startsWith(".github/workflows/") && /\.ya?ml$/.test(path)) {
      checkActionPins(Bun.YAML.parse(await readFile(pathOnDisk, "utf8")));
    }
    if (approvedMedia.has(path)) {
      const bytes = await readFile(pathOnDisk);
      if (path.endsWith(".webp")) await validateWebp(bytes);
      else await validatePreview(bytes);
    }
  }
  const source = JSON.parse(await readFile(join(root, "SOURCE_INPUT.json"), "utf8")) as {
    version?: unknown;
    atlas?: { path?: unknown; sha256?: unknown };
  };
  if (
    source.version !== 1 ||
    source.atlas?.path !== "assets/atlas.webp" ||
    typeof source.atlas.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.atlas.sha256)
  ) {
    throw new Error("Invalid production source binding");
  }
  const atlas = await readFile(join(root, "assets/atlas.webp"));
  const digest = createHash("sha256").update(atlas).digest("hex");
  if (
    digest !== source.atlas.sha256 ||
    atlas.equals(await readFile(join(root, "fixtures/runtime/spritesheet.webp")))
  ) {
    throw new Error("Production source hash or fixture boundary failed");
  }
}
