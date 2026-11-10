#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import sharp from "sharp";
import { validateWebp } from "./media";

type State = { name: string; row: number; frames: number; delays: number[] };
type Contract = {
  version: number;
  layout: {
    width: number;
    height: number;
    cellWidth: number;
    cellHeight: number;
    columns: number;
    rows: number;
  };
  states: State[];
  gaze: { rows: number[]; frames: number };
  actionRepeats: number;
  protectedRows: number[];
};
type Atlas = { pixels: Buffer; path: string };
const contractFile = join(import.meta.dir, "animation-contract.json");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function contract(): Promise<Contract> {
  const c = JSON.parse(await readFile(contractFile, "utf8")) as Contract;
  const l = c.layout;
  if (
    c.version !== 1 ||
    l.width !== 1536 ||
    l.height !== 2288 ||
    l.cellWidth !== 192 ||
    l.cellHeight !== 208 ||
    l.columns !== 8 ||
    l.rows !== 11 ||
    !Array.isArray(c.states)
  ) {
    throw new Error("Animation contract has an unsupported layout or version");
  }
  for (const s of c.states) {
    if (
      !Number.isInteger(s.row) ||
      s.row < 0 ||
      s.row > 8 ||
      s.frames < 1 ||
      s.frames > 8 ||
      s.delays.length !== s.frames ||
      s.delays.some((d) => !Number.isInteger(d) || d < 10)
    ) {
      throw new Error(`Invalid animation contract state: ${s.name}`);
    }
  }
  return c;
}

export async function decode(path: string | Buffer, c: Contract): Promise<Atlas> {
  const bytes = typeof path === "string" ? await readFile(path) : path;
  await validateWebp(bytes);
  const label = typeof path === "string" ? path : "atlas buffer";
  const image = sharp(bytes, { failOn: "warning" });
  const meta = await image.metadata();
  if (
    meta.width !== c.layout.width ||
    meta.height !== c.layout.height ||
    (meta.pages && meta.pages !== 1)
  ) {
    throw new Error(`Atlas must be ${c.layout.width}x${c.layout.height}, one page: ${label}`);
  }
  const { data, info } = await image
    .ensureAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || info.width !== c.layout.width || info.height !== c.layout.height) {
    throw new Error(`Unable to decode four-channel RGBA atlas: ${label}`);
  }
  return { pixels: data, path: label };
}

function cell(c: Contract, p: Buffer, row: number, col: number): Buffer {
  const { width, cellWidth, cellHeight } = c.layout;
  const out = Buffer.alloc(cellWidth * cellHeight * 4);
  for (let y = 0; y < cellHeight; y++) {
    const from = ((row * cellHeight + y) * width + col * cellWidth) * 4;
    p.copy(out, y * cellWidth * 4, from, from + cellWidth * 4);
  }
  return out;
}

function occupied(p: Buffer): number {
  let count = 0;
  for (let i = 3; i < p.length; i += 4) if (p[i]) count++;
  return count;
}

export function validateAtlas(a: Atlas, c: Contract) {
  const problems: string[] = [];
  const used = new Set<string>();
  for (const s of c.states) for (let col = 0; col < s.frames; col++) used.add(`${s.row}:${col}`);
  used.add("0:6"); // The idle neutral reserve is required by Codex.
  for (let i = 0; i < c.gaze.frames; i++) {
    const row = c.gaze.rows[Math.floor(i / c.layout.columns)];
    if (row === undefined) throw new Error("Animation contract has too few gaze rows");
    used.add(`${row}:${i % c.layout.columns}`);
  }
  for (let row = 0; row < c.layout.rows; row++)
    for (let col = 0; col < c.layout.columns; col++) {
      const n = occupied(cell(c, a.pixels, row, col));
      const key = `${row}:${col}`;
      if (used.has(key) && n === 0) problems.push(`required cell ${key} is empty`);
      if (!used.has(key) && n !== 0) problems.push(`unused cell ${key} contains ${n} pixels`);
    }
  if (!cell(c, a.pixels, 0, 0).equals(cell(c, a.pixels, 0, 6)))
    problems.push("neutral reserve 0:6 differs from idle frame 0:0");
  for (let i = 0; i < a.pixels.length; i += 4) {
    if (a.pixels[i + 3] === 0 && (a.pixels[i] || a.pixels[i + 1] || a.pixels[i + 2])) {
      problems.push(`hidden RGB at pixel ${i / 4}`);
      break;
    }
  }
  return { valid: problems.length === 0, problems };
}

function requireValid(a: Atlas, c: Contract) {
  const result = validateAtlas(a, c);
  if (!result.valid) throw new Error(`Invalid atlas: ${result.problems.join("; ")}`);
}

export async function preview(atlas: string, stateName: string, output: string, displaySize = 192) {
  const c = await contract();
  const a = await decode(atlas, c);
  requireValid(a, c);
  const state = c.states.find((s) => s.name === stateName);
  let frames: Buffer[],
    delays: number[],
    diagnostic = false;
  const repeats = state && state.row >= 3 ? c.actionRepeats : 1;
  if (state) {
    frames = Array.from({ length: state.frames }, (_, i) => cell(c, a.pixels, state.row, i));
    delays = state.delays;
  } else if (stateName === "gaze") {
    frames = Array.from({ length: c.gaze.frames }, (_, i) =>
      cell(c, a.pixels, c.gaze.rows[Math.floor(i / 8)], i % 8),
    );
    delays = Array(c.gaze.frames).fill(180);
    diagnostic = true;
  } else throw new Error(`Unknown state: ${stateName}`);
  frames = Array.from({ length: repeats }, () => frames).flat();
  delays = Array.from({ length: repeats }, () => delays).flat();
  // GIF delays use centiseconds. All native delays in the contract are divisible by 10.
  if (delays.some((d) => d % 10 !== 0))
    throw new Error("GIF timing requires 10 ms delay increments");
  const width = displaySize;
  if (!Number.isInteger(width) || width < 16 || width > 1024)
    throw new Error("Display size must be 16–1024 pixels");
  const height = Math.round((c.layout.cellHeight * width) / c.layout.cellWidth);
  const pageSize = width * height * 4;
  const pages = Buffer.alloc(pageSize * frames.length);
  for (let i = 0; i < frames.length; i++) {
    const scaled = await sharp(frames[i], {
      raw: { width: c.layout.cellWidth, height: c.layout.cellHeight, channels: 4 },
    })
      .resize(width, height, { kernel: "nearest" })
      .raw()
      .toBuffer();
    scaled.copy(pages, i * pageSize);
  }
  await sharp(pages, {
    raw: { width, height: height * frames.length, channels: 4, pageHeight: height },
  })
    .gif({ delay: delays, loop: 0, dither: 0, keepDuplicateFrames: true })
    .toFile(output);
  const meta = await sharp(output, { animated: true }).metadata();
  if (meta.pages !== frames.length || JSON.stringify(meta.delay) !== JSON.stringify(delays)) {
    throw new Error("GIF readback timing or frame count differs from contract");
  }
  const manifest = {
    output: basename(output),
    state: stateName,
    label: diagnostic ? "gaze diagnostic preview" : "native animation timing preview",
    diagnostic,
    repeats,
    frames: frames.length,
    delaysMs: delays,
    displaySize: [width, height],
    atlasRgbaSha256: digest(a.pixels),
    gifSha256: digest(await readFile(output)),
  };
  const manifestPath = `${output}.json`;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { ...manifest, manifest: resolve(manifestPath) };
}
