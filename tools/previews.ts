import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contract, preview } from "./pet";

const root = resolve(import.meta.dir, "..");
const defaultOutputDir = join(root, "assets/previews");

type SourceInput = { atlas: { path: string; sha256: string } };
type GenerateOptions = { outputDir?: string; checkOnly?: boolean };
type ArtifactSummary = Record<string, { gifBytes: number; manifestBytes: number }>;

async function approvedAtlas() {
  const source = JSON.parse(await readFile(join(root, "SOURCE_INPUT.json"), "utf8")) as SourceInput;
  if (source.atlas?.path !== "assets/atlas.webp" || !/^[a-f0-9]{64}$/.test(source.atlas.sha256)) {
    throw new Error("SOURCE_INPUT.json must bind assets/atlas.webp to a SHA256");
  }

  const atlasPath = join(root, source.atlas.path);
  const actual = createHash("sha256")
    .update(await readFile(atlasPath))
    .digest("hex");
  if (actual !== source.atlas.sha256)
    throw new Error("Approved atlas SHA256 does not match SOURCE_INPUT.json");
  return atlasPath;
}

function validateStateNames(states: Awaited<ReturnType<typeof contract>>["states"]) {
  if (!states.length) throw new Error("Animation contract does not define preview states");
  const seen = new Set<string>();
  for (const state of states) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(state.name) ||
      state.name === "gaze" ||
      seen.has(state.name)
    ) {
      throw new Error("Animation contract contains an invalid or duplicate preview state name");
    }
    seen.add(state.name);
  }
}

export async function generatePreviews(options: GenerateOptions = {}): Promise<ArtifactSummary> {
  const outputDir = options.outputDir ?? defaultOutputDir;
  const states = (await contract()).states;
  validateStateNames(states);
  const atlasPath = await approvedAtlas();

  let renderDir = outputDir;
  let temporaryDir: string | undefined;
  if (options.checkOnly) {
    temporaryDir = await mkdtemp(join(tmpdir(), "louis-previews-"));
    renderDir = temporaryDir;
  }

  try {
    await mkdir(renderDir, { recursive: true });
    const result: ArtifactSummary = {};
    for (const state of states) {
      const filename = `${state.name}.gif`;
      const renderedGif = join(renderDir, filename);
      await preview(atlasPath, state.name, renderedGif);

      const artifacts = [
        { generated: renderedGif, committed: join(outputDir, filename), suffix: "GIF" },
        {
          generated: `${renderedGif}.json`,
          committed: join(outputDir, `${filename}.json`),
          suffix: "manifest",
        },
      ];
      const sizes: number[] = [];
      for (const artifact of artifacts) {
        const generated = await readFile(artifact.generated);
        sizes.push(generated.length);
        if (options.checkOnly) {
          const committed = await readFile(artifact.committed).catch(() => undefined);
          if (!committed?.equals(generated))
            throw new Error(
              `Preview ${artifact.suffix} is missing or stale for ${state.name}; run bun run previews`,
            );
        }
      }
      result[state.name] = { gifBytes: sizes[0], manifestBytes: sizes[1] };
    }
    return result;
  } finally {
    if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
      throw new Error("Usage: bun tools/previews.ts [--check]");
    const result = await generatePreviews({ checkOnly: args[0] === "--check" });
    console.log(
      JSON.stringify(
        { mode: args[0] === "--check" ? "checked" : "generated", artifacts: result },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
