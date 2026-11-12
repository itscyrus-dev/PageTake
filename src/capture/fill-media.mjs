import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digest, headersForReplay, maxArchiveBytes, maxResourceBytes, publicUrl } from "./archive.mjs";

const mediaType = /^(?:video|audio)\//i;
const header = (entry, name) => entry.headers.find((item) => item.name.toLowerCase() === name)?.value;
const strongTag = /^"[^"]*"$/;

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

async function fetchMedia(url, headers) {
  const signal = AbortSignal.timeout(20000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { headers: { "accept-encoding": "identity", ...headers }, redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location || !URL.canParse(location, url)) throw new Error("Invalid media redirect");
    url = publicUrl(new URL(location, url));
    if (!url) throw new Error("Media redirected to a credentialed or signed URL");
  }
  throw new Error("Too many media redirects");
}

async function readResponse(response, limit) {
  try {
    if (!mediaType.test(response.headers.get("content-type") ?? "")) throw new Error("Origin did not return audio or video");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") throw new Error("Origin returned an encoded media response");
    if (Number(response.headers.get("content-length")) > limit) throw new Error("Media response exceeds capture limits");
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.byteLength;
      if (length > limit) throw new Error("Media response exceeds capture limits");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (!response.body?.locked) await response.body?.cancel().catch(() => {});
    throw error;
  }
}

async function loadParts(entries, folder) {
  const parts = [];
  for (const entry of entries) {
    const range = parseContentRange(header(entry, "content-range"));
    if (!range || !/^[a-f0-9]{64}$/.test(entry.body)) throw new Error("Invalid recorded media range");
    if (range.total > maxResourceBytes) throw new Error("Media exceeds the per-resource capture limit");
    const bytes = await readFile(join(folder, "bodies", entry.body));
    if (bytes.length !== range.end - range.start + 1 || digest(bytes) !== entry.body) {
      throw new Error("Recorded media body does not match its range");
    }
    parts.push({ ...range, bytes, etag: header(entry, "etag") });
  }
  return parts.sort((a, b) => a.start - b.start);
}

function planRanges(parts) {
  const total = parts[0].total;
  const tags = new Set(parts.map(({ etag }) => etag).filter(Boolean));
  if (tags.size > 1 || parts.some((part) => part.total !== total)) throw new Error("Recorded media has conflicting versions");
  const [etag] = tags;
  const validator = strongTag.test(etag ?? "") && parts.every((part) => part.etag === etag) ? etag : null;
  let covered = 0;
  const gaps = [];
  const bytes = Buffer.alloc(total);
  for (const part of parts) {
    if (part.start > covered) gaps.push({ start: covered, end: part.start - 1 });
    const overlap = Math.max(0, Math.min(covered - part.start, part.bytes.length));
    if (!bytes.subarray(part.start, part.start + overlap).equals(part.bytes.subarray(0, overlap))) {
      throw new Error("Recorded media ranges disagree on overlapping bytes");
    }
    part.bytes.copy(bytes, part.start);
    covered = Math.max(covered, part.end + 1);
  }
  if (covered < total) gaps.push({ start: covered, end: total - 1 });
  return { bytes, gaps, validator };
}

function checkFull(bytes, parts, total) {
  if (!bytes.length || (total !== undefined && bytes.length !== total)) throw new Error("Origin media length has changed");
  for (const part of parts) {
    if (!bytes.subarray(part.start, part.end + 1).equals(part.bytes)) throw new Error("Origin media differs from recorded bytes");
  }
}

async function fillResource(url, entries, folder, budget) {
  const parts = await loadParts(entries, folder);
  const planned = parts.length ? planRanges(parts) : null;
  if (planned && planned.bytes.length > budget) throw new Error("Media exceeds the remaining archive budget");

  if (!planned || (!planned.validator && (planned.gaps.length || parts.length > 1))) {
    const response = await fetchMedia(url);
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Origin returned HTTP ${response.status}`);
    }
    const bytes = await readResponse(response, Math.min(maxResourceBytes, budget, planned?.bytes.length ?? maxResourceBytes));
    checkFull(bytes, parts, planned?.bytes.length);
    return { bytes, headers: headersForReplay(Object.fromEntries(response.headers)), downloaded: bytes.length };
  }

  const { bytes, gaps, validator } = planned;
  let downloaded = 0;
  for (const { start, end } of gaps) {
    const response = await fetchMedia(url, { range: `bytes=${start}-${end}`, "if-range": validator });
    const range = parseContentRange(response.headers.get("content-range"));
    const full = response.status === 200;
    if (response.headers.get("etag") !== validator ||
        (!full && (response.status !== 206 || range?.start !== start || range.end !== end || range.total !== bytes.length))) {
      await response.body?.cancel();
      throw new Error("Origin did not return the recorded version and requested byte range");
    }
    const chunk = await readResponse(response, full ? bytes.length : end - start + 1);
    downloaded += chunk.length;
    if (full) {
      checkFull(chunk, parts, bytes.length);
      return { bytes: chunk, headers: entries[0].headers, downloaded };
    }
    if (chunk.length !== end - start + 1) throw new Error("Origin returned an incomplete byte range");
    chunk.copy(bytes, start);
  }
  return { bytes, headers: entries[0].headers, downloaded };
}

export async function fillMedia(recording, additional = []) {
  const folder = resolve(recording);
  const manifest = join(folder, "manifest.json");
  const lock = join(folder, ".fill-media");
  const pending = join(lock, "manifest.json");
  await mkdir(lock);
  try {
    const archive = JSON.parse(await readFile(manifest, "utf8"));
    if (archive.version !== 1 || !Array.isArray(archive.responses)) throw new Error("Unsupported capture manifest");
    const groups = new Map();
    const complete = new Set();
    const bodies = new Map();
    for (const entry of archive.responses) {
      if (entry.status === 200 && !entry.range && mediaType.test(header(entry, "content-type") ?? "")) complete.add(entry.url);
      if (entry.status === 206 && mediaType.test(header(entry, "content-type") ?? "")) {
        const group = groups.get(entry.url) ?? [];
        group.push(entry);
        groups.set(entry.url, group);
      }
      bodies.set(entry.body, entry.bytes);
    }
    for (const input of additional) {
      const url = publicUrl(input);
      const observed = url && (archive.motion?.media?.some(({ source }) => source === url) ||
        archive.networkIssues?.some((entry) => entry.url === url && entry.range));
      if (!observed && !groups.has(url) && !complete.has(url)) throw new Error("Additional media URL was not observed in the recording");
      if (!groups.has(url)) groups.set(url, []);
    }

    const result = { repaired: [], failed: [] };
    const replaced = new Set();
    const responses = [];
    let storedBytes = archive.storedBytes ?? [...bodies.values()].reduce((sum, bytes) => sum + bytes, 0);
    for (const [url, entries] of groups) {
      if (complete.has(url)) continue;
      try {
        if (publicUrl(url) !== url) throw new Error("Media URL contains credentials or a signature");
        const { bytes, headers, downloaded } = await fillResource(url, entries, folder, maxArchiveBytes - storedBytes);
        const body = digest(bytes);
        try {
          await writeFile(join(folder, "bodies", body), bytes, { flag: "wx" });
          storedBytes += bytes.length;
        } catch (error) {
          if (error.code !== "EEXIST" || digest(await readFile(join(folder, "bodies", body))) !== body) throw error;
        }
        responses.push({ url, range: "", status: 200, body, bytes: bytes.length,
          headers: headers.filter(({ name }) => !/^content-range$/i.test(name)) });
        replaced.add(url);
        result.repaired.push({ url, bytes: bytes.length, downloaded, recordedAt: new Date().toISOString() });
      } catch (error) {
        result.failed.push({ url, reason: error.message });
      }
    }
    if (replaced.size) {
      archive.responses = archive.responses.filter((entry) => !(entry.status === 206 && replaced.has(entry.url)));
      archive.responses.push(...responses);
      archive.storedBytes = storedBytes;
      archive.mediaRepairs = [...(archive.mediaRepairs ?? []), ...result.repaired];
      await writeFile(pending, JSON.stringify(archive, null, 2));
      await rename(pending, manifest);
    }
    return result;
  } finally {
    await unlink(pending).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(lock);
  }
}
