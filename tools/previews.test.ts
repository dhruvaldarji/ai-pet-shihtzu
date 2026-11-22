import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validatePreview } from "./media";
import { contract, preview } from "./pet";
import { generatePreviews } from "./previews";

const root = resolve(import.meta.dir, "..");

function outputDirectory() {
  return mkdtemp(join(tmpdir(), "louis-previews-test-"));
}

test("renders every contract state through preview with deterministic GIFs and manifests", async () => {
  const c = await contract();
  const source = JSON.parse(await readFile(join(root, "SOURCE_INPUT.json"), "utf8"));
  const atlasPath = join(root, source.atlas.path);
  const firstDir = await outputDirectory();
  const secondDir = await outputDirectory();
  try {
    const first = await generatePreviews({ outputDir: firstDir });
    const second = await generatePreviews({ outputDir: secondDir });
    const names = c.states.map((state) => state.name);
    expect(names).toHaveLength(9);
    expect(names).not.toContain("gaze");
    expect(Object.keys(first)).toEqual(names);
    expect(second).toEqual(first);

    for (const state of c.states) {
      const filename = `${state.name}.gif`;
      const gif = await readFile(join(firstDir, filename));
      const manifestBytes = await readFile(join(firstDir, `${filename}.json`));
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      const repeats = state.row >= 3 ? c.actionRepeats : 1;
      expect(gif).toEqual(await readFile(join(secondDir, filename)));
      expect(manifestBytes).toEqual(await readFile(join(secondDir, `${filename}.json`)));
      await validatePreview(gif);
      expect(manifest).toMatchObject({
        output: filename,
        state: state.name,
        diagnostic: false,
        repeats,
        frames: state.frames * repeats,
        delaysMs: Array.from({ length: repeats }, () => state.delays).flat(),
        displaySize: [192, 208],
        gifSha256: createHash("sha256").update(gif).digest("hex"),
      });
      expect(first[state.name]).toEqual({
        gifBytes: gif.length,
        manifestBytes: manifestBytes.length,
      });
    }

    const releasePreview = join(firstDir, "release-preview.gif");
    await preview(atlasPath, "idle", releasePreview);
    expect(await readFile(join(firstDir, "idle.gif"))).toEqual(await readFile(releasePreview));
  } finally {
    await Promise.all([
      rm(firstDir, { recursive: true, force: true }),
      rm(secondDir, { recursive: true, force: true }),
    ]);
  }
});

test("check mode rejects missing or stale GIFs and sidecar manifests", async () => {
  const directory = await outputDirectory();
  try {
    await expect(generatePreviews({ outputDir: directory, checkOnly: true })).rejects.toThrow(
      "missing or stale",
    );
    await generatePreviews({ outputDir: directory });
    await expect(
      generatePreviews({ outputDir: directory, checkOnly: true }),
    ).resolves.toHaveProperty("idle");

    const idleGif = join(directory, "idle.gif");
    await writeFile(idleGif, "stale GIF");
    await expect(generatePreviews({ outputDir: directory, checkOnly: true })).rejects.toThrow(
      "GIF is missing or stale",
    );

    const source = JSON.parse(await readFile(join(root, "SOURCE_INPUT.json"), "utf8"));
    await preview(join(root, source.atlas.path), "idle", idleGif);
    await writeFile(`${idleGif}.json`, "stale manifest");
    await expect(generatePreviews({ outputDir: directory, checkOnly: true })).rejects.toThrow(
      "manifest is missing or stale",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed previews match the production atlas and animation contract", async () => {
  const c = await contract();
  const generated = await generatePreviews({ checkOnly: true });
  expect(Object.keys(generated)).toEqual(c.states.map((state) => state.name));
});
