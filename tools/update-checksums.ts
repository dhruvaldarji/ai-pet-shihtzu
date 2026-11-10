#!/usr/bin/env bun
/** Refresh the explicit runtime allowlist after a reviewed local change. */
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runtimeFileNames } from "./package";

export async function updateChecksums(root = resolve(import.meta.dir, "..")) {
  const lines = [];
  const names = await runtimeFileNames(root);
  for (const name of names.filter((name) => name !== "SHA256SUMS")) {
    const path = join(root, name),
      stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe runtime file: ${name}`);
    const bytes = await readFile(path);
    if (bytes.length === 0) throw new Error(`Empty runtime file: ${name}`);
    lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  }
  const output = join(root, "SHA256SUMS");
  const outputStat = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (outputStat && (!outputStat.isFile() || outputStat.isSymbolicLink()))
    throw new Error("Unsafe checksum output: SHA256SUMS");
  await writeFile(output, lines.join("\n") + "\n");
  return { output, files: lines.length };
}
if (import.meta.main) console.log(JSON.stringify(await updateChecksums(), null, 2));
