import { expect, test } from "bun:test";
import sharp from "sharp";
import { validateWebp } from "./media";

type WebpChunk = { name: string; data: Buffer; record: Buffer };

function chunks(bytes: Buffer) {
  const result: WebpChunk[] = [];
  for (let offset = 12; offset < bytes.length;) {
    const name = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    result.push({
      name,
      data: Buffer.from(bytes.subarray(offset + 8, offset + 8 + length)),
      record: Buffer.from(bytes.subarray(offset, end)),
    });
    offset = end;
  }
  return result;
}

function chunkRecord(name: string, data: Buffer, padding = 0) {
  const record = Buffer.alloc(8 + data.length + (data.length % 2));
  record.write(name, 0, "latin1");
  record.writeUInt32LE(data.length, 4);
  data.copy(record, 8);
  if (data.length % 2) record[record.length - 1] = padding;
  return record;
}

function webp(records: Buffer[]) {
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.write("WEBP", 8, "latin1");
  const bytes = Buffer.concat([header, ...records]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
}

async function generatedWebp(alpha: boolean, lossless = false) {
  const background = alpha
    ? { r: 80, g: 130, b: 190, alpha: 0.5 }
    : { r: 80, g: 130, b: 190 };
  return sharp({
    create: { width: 16, height: 16, channels: alpha ? 4 : 3, background },
  }).webp({ lossless }).toBuffer();
}

test("accepts a lossy extended WebP with alpha", async () => {
  const bytes = await generatedWebp(true);
  const parsed = chunks(bytes);
  expect(parsed.map(chunk => chunk.name)).toEqual(["VP8X", "ALPH", "VP8 "]);
  await expect(validateWebp(bytes)).resolves.toBeUndefined();
});

test("rejects ALPH after the VP8 bitstream", async () => {
  const parsed = chunks(await generatedWebp(true));
  const vp8x = parsed.find(chunk => chunk.name === "VP8X")!;
  const alpha = parsed.find(chunk => chunk.name === "ALPH")!;
  const vp8 = parsed.find(chunk => chunk.name === "VP8 ")!;
  await expect(validateWebp(webp([vp8x.record, vp8.record, alpha.record])))
    .rejects.toThrow("Atlas contains embedded metadata or unsupported WebP chunks");
});

test("rejects ALPH with VP8L", async () => {
  const lossy = chunks(await generatedWebp(true));
  const lossless = chunks(await generatedWebp(true, true));
  const vp8x = lossy.find(chunk => chunk.name === "VP8X")!;
  const alpha = lossy.find(chunk => chunk.name === "ALPH")!;
  const vp8l = lossless.find(chunk => chunk.name === "VP8L")!;
  await expect(validateWebp(webp([vp8x.record, alpha.record, vp8l.record])))
    .rejects.toThrow("Atlas contains embedded metadata or unsupported WebP chunks");
});

test("rejects invalid VP8X flags, canvas, padding, and chunk bounds", async () => {
  const parsed = chunks(await generatedWebp(true));
  const vp8x = parsed.find(chunk => chunk.name === "VP8X")!;
  const alpha = parsed.find(chunk => chunk.name === "ALPH")!;
  const vp8 = parsed.find(chunk => chunk.name === "VP8 ")!;

  const unsupportedFlag = Buffer.from(vp8x.record);
  unsupportedFlag[8] |= 0x04;
  await expect(validateWebp(webp([unsupportedFlag, alpha.record, vp8.record])))
    .rejects.toThrow("Atlas contains embedded metadata or unsupported WebP chunks");

  const reservedByte = Buffer.from(vp8x.record);
  reservedByte[9] = 1;
  await expect(validateWebp(webp([reservedByte, alpha.record, vp8.record])))
    .rejects.toThrow("Atlas contains embedded metadata or unsupported WebP chunks");

  const wrongLength = chunkRecord("VP8X", Buffer.concat([vp8x.data, Buffer.from([0])]));
  await expect(validateWebp(webp([wrongLength, alpha.record, vp8.record])))
    .rejects.toThrow("Atlas contains embedded metadata or unsupported WebP chunks");

  const missingAlphaFlag = Buffer.from(vp8x.record);
  missingAlphaFlag[8] &= ~0x10;
  await expect(validateWebp(webp([missingAlphaFlag, alpha.record, vp8.record])))
    .rejects.toThrow("Atlas contains embedded metadata or unsupported WebP chunks");

  const wrongCanvas = Buffer.from(vp8x.record);
  wrongCanvas.writeUIntLE(wrongCanvas.readUIntLE(12, 3) + 1, 12, 3);
  await expect(validateWebp(webp([wrongCanvas, alpha.record, vp8.record])))
    .rejects.toThrow("Atlas contains embedded metadata or unsupported WebP chunks");

  const wrongPadding = chunkRecord("ALPH", Buffer.from([0]), 1);
  await expect(validateWebp(webp([vp8x.record, wrongPadding, vp8.record])))
    .rejects.toThrow("Invalid WebP chunk");

  const oversized = Buffer.from(alpha.record);
  oversized.writeUInt32LE(0xffffffff, 4);
  await expect(validateWebp(webp([vp8x.record, oversized, vp8.record])))
    .rejects.toThrow("Truncated WebP chunk");
});
