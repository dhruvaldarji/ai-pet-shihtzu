#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
/** Check the documented build environment. Does not install or edit anything. */
import sharp from "sharp";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const checks: { name: string; expected: string; actual: string; pass: boolean }[] = [];
const check = (name: string, expected: string, actual: string) =>
  checks.push({ name, expected, actual, pass: expected === actual });
check("Bun", pkg.packageManager.replace(/^bun@/, ""), Bun.version);
check("sharp", pkg.dependencies.sharp, sharp.versions.sharp);
for (const name of ["zip", "unzip", "sh"])
  check(name, "available", Bun.which(name) ? "available" : "missing");
check(
  "SHA256 utility",
  "available",
  Bun.which("shasum") || Bun.which("sha256sum") ? "available" : "missing",
);
const input = Buffer.from([255, 240, 225, 255, 10, 20, 30, 0]);
const png = await sharp(input, { raw: { width: 2, height: 1, channels: 4 } })
  .png()
  .toBuffer();
check(
  "RGBA PNG round trip",
  "exact",
  input.equals(await sharp(png).raw().toBuffer()) ? "exact" : "changed",
);
console.log(JSON.stringify({ pass: checks.every((c) => c.pass), checks }, null, 2));
if (checks.some((c) => !c.pass)) process.exitCode = 1;
