import sharp from "sharp";

export async function validateWebp(bytes: Buffer) {
  if (
    bytes.length < 12 ||
    bytes.toString("latin1", 0, 4) !== "RIFF" ||
    bytes.toString("latin1", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    throw new Error("Atlas must be a complete static WebP");
  }
  const allowed = new Set(["VP8X", "ALPH", "VP8 ", "VP8L"]);
  const chunks: { name: string; data: Buffer }[] = [];
  for (let offset = 12; offset < bytes.length; ) {
    if (offset + 8 > bytes.length) throw new Error("Invalid WebP chunk");
    const name = bytes.toString("latin1", offset, offset + 4),
      length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8,
      end = start + length,
      next = end + (length % 2);
    if (end > bytes.length || next > bytes.length) throw new Error("Truncated WebP chunk");
    if (length % 2 && bytes[end] !== 0) throw new Error("Invalid WebP chunk");
    if (!allowed.has(name))
      throw new Error("Atlas contains embedded metadata or unsupported WebP chunks");
    chunks.push({ name, data: bytes.subarray(start, end) });
    offset = next;
  }

  const extended = chunks[0]?.name === "VP8X",
    lossless = chunks.find((chunk) => chunk.name === "VP8L") !== undefined;
  const hasAlphaChunk = chunks.some((chunk) => chunk.name === "ALPH");
  const expected = lossless
    ? extended
      ? ["VP8X", "VP8L"]
      : ["VP8L"]
    : extended
      ? ["VP8X", ...(hasAlphaChunk ? ["ALPH"] : []), "VP8 "]
      : ["VP8 "];
  const bitstreams = chunks.filter((chunk) => chunk.name === "VP8 " || chunk.name === "VP8L");
  if (
    bitstreams.length !== 1 ||
    chunks.length !== expected.length ||
    chunks.some((chunk, index) => chunk.name !== expected[index])
  ) {
    throw new Error("Atlas contains embedded metadata or unsupported WebP chunks");
  }

  const vp8x = extended ? chunks[0] : undefined;
  let canvas: { width: number; height: number; alpha: boolean } | undefined;
  if (vp8x) {
    const data = vp8x.data;
    if (
      data.length !== 10 ||
      (data[0] & 0xef) !== 0 ||
      data[1] !== 0 ||
      data[2] !== 0 ||
      data[3] !== 0
    ) {
      throw new Error("Atlas contains embedded metadata or unsupported WebP chunks");
    }
    canvas = {
      width: data.readUIntLE(4, 3) + 1,
      height: data.readUIntLE(7, 3) + 1,
      alpha: (data[0] & 0x10) !== 0,
    };
  }

  const bitstream = bitstreams[0],
    data = bitstream.data;
  let width: number,
    height: number,
    bitstreamAlpha = false;
  if (bitstream.name === "VP8L") {
    if (data.length < 5 || data[0] !== 0x2f)
      throw new Error("Atlas must be a complete static WebP");
    const header = data.readUInt32LE(1);
    if (header >>> 29 !== 0)
      throw new Error("Atlas contains embedded metadata or unsupported WebP chunks");
    width = (header & 0x3fff) + 1;
    height = ((header >>> 14) & 0x3fff) + 1;
    bitstreamAlpha = (header & 0x10000000) !== 0;
  } else {
    if (
      data.length < 10 ||
      (data[0] & 0x11) !== 0x10 ||
      ((data[0] >>> 1) & 7) > 3 ||
      data[3] !== 0x9d ||
      data[4] !== 0x01 ||
      data[5] !== 0x2a
    ) {
      throw new Error("Atlas must be a complete static WebP");
    }
    width = data.readUInt16LE(6) & 0x3fff;
    height = data.readUInt16LE(8) & 0x3fff;
    if (!width || !height) throw new Error("Atlas must be a complete static WebP");
  }
  if (
    canvas &&
    (canvas.width !== width ||
      canvas.height !== height ||
      canvas.alpha !== (bitstream.name === "VP8L" ? bitstreamAlpha : hasAlphaChunk))
  ) {
    throw new Error("Atlas contains embedded metadata or unsupported WebP chunks");
  }

  const metadata = await sharp(bytes, { failOn: "warning" }).metadata();
  if (
    metadata.format !== "webp" ||
    (metadata.pages ?? 1) !== 1 ||
    metadata.width !== width ||
    metadata.height !== height
  )
    throw new Error("Atlas must be a static WebP");
  if (metadata.exif || metadata.xmp || metadata.iptc || metadata.icc)
    throw new Error("Atlas contains embedded metadata");
}

/** Allow only image data, frame controls and the standard looping extension. */
export async function validatePreview(bytes: Buffer) {
  const invalid = () => new Error("Preview must be a complete GIF without embedded metadata");
  if (bytes.length < 13 || !["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6)))
    throw invalid();
  let offset = 13,
    frames = 0;
  const take = (length: number) => {
    const start = offset;
    offset += length;
    if (offset > bytes.length) throw invalid();
    return bytes.subarray(start, offset);
  };
  const blocks = () => {
    let size: number;
    do {
      size = take(1)[0];
      take(size);
    } while (size);
  };
  if (bytes[10] & 0x80) take(3 * (1 << ((bytes[10] & 7) + 1)));
  let complete = false;
  while (offset < bytes.length) {
    const tag = take(1)[0];
    if (tag === 0x3b) {
      complete = true;
      break;
    }
    if (tag === 0x2c) {
      const descriptor = take(9);
      if (descriptor[8] & 0x80) take(3 * (1 << ((descriptor[8] & 7) + 1)));
      take(1);
      blocks();
      frames++;
    } else if (tag === 0x21) {
      const extension = take(1)[0];
      if (extension === 0xf9) {
        if (take(1)[0] !== 4) throw invalid();
        take(4);
        if (take(1)[0] !== 0) throw invalid();
      } else if (extension === 0xff) {
        if (take(1)[0] !== 11 || take(11).toString("latin1") !== "NETSCAPE2.0") throw invalid();
        const loop = take(5);
        if (loop[0] !== 3 || loop[1] !== 1 || loop[4] !== 0) throw invalid();
      } else throw invalid();
    } else throw invalid();
  }
  if (!complete || !frames || offset !== bytes.length) throw invalid();
  const image = sharp(bytes, {
    animated: true,
    failOn: "warning",
    limitInputPixels: 64 * 1024 * 1024,
  });
  const metadata = await image.metadata();
  if (metadata.format !== "gif" || (metadata.pages ?? 1) !== frames) throw invalid();
  await image.raw().toBuffer();
}
