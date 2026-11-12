import { crc32, deflateSync } from "node:zlib";
import { decodeScreenshot } from "./score.mjs";

function pngChunk(type, bytes) {
  const chunk = Buffer.alloc(bytes.length + 12);
  chunk.writeUInt32BE(bytes.length);
  chunk.write(type, 4);
  bytes.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

export function encodeRegionPng(width, height, channels, rows) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 1 })), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function cropViewport(bytes, box) {
  const image = decodeScreenshot(bytes);
  const { x, y, width, height } = box;
  if (x + width > image.width || y + height > image.height) throw new Error("Section extends outside the captured viewport");
  const { channels } = image;
  const stride = width * channels + 1;
  const rows = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const start = ((row + y) * image.width + x) * channels;
    image.pixels.copy(rows, row * stride + 1, start, start + width * channels);
  }
  return encodeRegionPng(width, height, channels, rows);
}
