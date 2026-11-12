import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { evidenceFrame } from "../export/evidence.mjs";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function predictor(left, up, diagonal) {
  const guess = left + up - diagonal;
  const distances = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - diagonal)];
  return [left, up, diagonal][distances.indexOf(Math.min(...distances))];
}

/** Read RGB or RGBA pixels from a Chrome screenshot. */
export function decodeScreenshot(bytes) {
  if (!bytes.subarray(0, 8).equals(signature) || bytes.length < 33) throw new Error("Invalid PNG screenshot");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const channels = { 2: 3, 6: 4 }[bytes[25]];
  if (bytes[24] !== 8 || !channels || bytes[28] !== 0 || !width || !height || width * height > 9_000_000) {
    throw new Error("Expected an 8-bit RGB or RGBA Chrome screenshot");
  }
  const chunks = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") break;
    offset += length + 12;
  }
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height });
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const rowStart = row * stride;
    const source = row * (stride + 1);
    const filter = raw[source];
    if (filter > 4) throw new Error("Unsupported PNG filter");
    for (let index = 0; index < stride; index++) {
      const pos = rowStart + index;
      const left = index >= channels ? pixels[pos - channels] : 0;
      const up = row ? pixels[pos - stride] : 0;
      const diagonal = row && index >= channels ? pixels[pos - stride - channels] : 0;
      let adjustment = 0;
      if (filter === 1) adjustment = left;
      if (filter === 2) adjustment = up;
      if (filter === 3) adjustment = (left + up) >> 1;
      if (filter === 4) adjustment = predictor(left, up, diagonal);
      pixels[pos] = raw[source + index + 1] + adjustment;
    }
  }
  return { width, height, channels, pixels };
}

function luminance(image, index) {
  const start = index * image.channels;
  const p = image.pixels;
  return (77 * p[start] + 150 * p[start + 1] + 29 * p[start + 2]) / 256;
}

function compatible(a, b) {
  return a.width === b.width && a.height === b.height;
}

function scorePercent(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 10;
}

/** Compare color and composition using pixel and local structure similarity. */
export function compareScreenshots(reference, candidate) {
  if (!compatible(reference, candidate)) return null;
  let colorError = 0;
  let structure = 0;
  let blocks = 0;
  const { width, height } = reference;
  for (let y = 0; y < height; y += 16) {
    for (let x = 0; x < width; x += 16) {
      let count = 0, sumA = 0, sumB = 0, squareA = 0, squareB = 0, product = 0;
      for (let dy = 0; dy < 16 && y + dy < height; dy += 2) {
        for (let dx = 0; dx < 16 && x + dx < width; dx += 2) {
          const index = (y + dy) * width + x + dx;
          for (let channel = 0; channel < 3; channel++) {
            colorError += Math.abs(reference.pixels[index * reference.channels + channel] - candidate.pixels[index * candidate.channels + channel]);
          }
          const a = luminance(reference, index);
          const b = luminance(candidate, index);
          sumA += a; sumB += b; squareA += a * a; squareB += b * b; product += a * b; count++;
        }
      }
      const a = sumA / count, b = sumB / count;
      const c1 = 6.5025, c2 = 58.5225;
      structure += ((2 * a * b + c1) * (2 * (product / count - a * b) + c2)) /
        ((a * a + b * b + c1) * (squareA / count - a * a + squareB / count - b * b + c2));
      blocks++;
    }
  }
  const pixel = scorePercent(1 - colorError / (Math.ceil(width / 2) * Math.ceil(height / 2) * 765));
  const structural = scorePercent(structure / blocks);
  return { pixel, structural, visual: Math.round((pixel * 0.35 + structural * 0.65) * 10) / 10 };
}

function motionMap(first, second) {
  const cells = [];
  for (let row = 0; row < 12; row++) {
    for (let col = 0; col < 16; col++) {
      let change = 0;
      for (let dy = 0; dy < 6; dy++) {
        for (let dx = 0; dx < 6; dx++) {
          const x = Math.floor((col + (dx + 0.5) / 6) / 16 * first.width);
          const y = Math.floor((row + (dy + 0.5) / 6) / 12 * first.height);
          change += Math.abs(luminance(first, y * first.width + x) - luminance(second, y * first.width + x));
        }
      }
      cells.push(Math.max(0, change / 36 - 2));
    }
  }
  return cells;
}

function motionAgreement(previous, current) {
  if (!compatible(previous.reference, current.reference) || !compatible(previous.candidate, current.candidate)) return null;
  if (Math.abs(current.referenceSample.scrollY - previous.referenceSample.scrollY) > 12) return null;
  if (Math.abs(current.candidateSample.scrollY - previous.candidateSample.scrollY) > 12) return null;
  const reference = motionMap(previous.reference, current.reference);
  const candidate = motionMap(previous.candidate, current.candidate);
  const union = reference.reduce((total, value, i) => total + Math.max(value, candidate[i]), 0);
  if (union < 40) return null;
  const overlap = reference.reduce((total, value, i) => total + Math.min(value, candidate[i]), 0);
  return scorePercent(overlap / union);
}

async function readFrame(folder, sample) {
  if (!evidenceFrame.test(sample?.screenshot ?? "")) return null;
  return decodeScreenshot(await readFile(join(folder, sample.screenshot)));
}

/** Score frames aligned by viewport, scroll position, and time. */
export async function scoreCaptures(referenceDir, candidateDir, referenceSamples, candidateSamples) {
  const frames = [];
  let previous;
  for (const [index, referenceSample] of referenceSamples.entries()) {
    const candidateSample = candidateSamples[index];
    const reason = !candidateSample ? "Candidate frame missing" :
      Math.abs(referenceSample.elapsedMs - candidateSample.elapsedMs) > 300 ? "Sampling times differ by more than 300 ms" :
      Math.abs(referenceSample.scrollY - candidateSample.scrollY) > 24 ? "Scroll positions differ by more than 24 px" : null;
    if (reason) {
      frames.push({ index: index + 1, reason });
      previous = undefined;
      continue;
    }
    const [reference, candidate] = await Promise.all([
      readFrame(referenceDir, referenceSample), readFrame(candidateDir, candidateSample),
    ]);
    if (!reference || !candidate || !compatible(reference, candidate)) {
      frames.push({ index: index + 1, reason: "Screenshots missing or different dimensions" });
      previous = undefined;
      continue;
    }
    const current = { reference, candidate, referenceSample, candidateSample };
    const motion = previous ? motionAgreement(previous, current) : null;
    frames.push({ index: index + 1, ...compareScreenshots(reference, candidate), motion });
    previous = current;
  }
  const average = (key) => {
    const values = frames.map((frame) => frame[key]).filter(Number.isFinite);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : null;
  };
  return { visual: average("visual"), motion: average("motion"), comparable: frames.filter((frame) => !frame.reason).length, total: frames.length, frames };
}
