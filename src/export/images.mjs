import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { BlockList, isIP } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { digest, maxResourceBytes, publicUrl } from "../capture/archive.mjs";
import { responsiveImage } from "../preview/responsive-image.mjs";

const downloadLimit = 256;
const downloadBudget = 64 * 1024 * 1024;
const imageType = /^image\/[a-z0-9.+-]+$/i;
const redirectCodes = new Set([301, 302, 303, 307, 308]);
const nonPublic = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
]) nonPublic.addSubnet(address, prefix, "ipv4");
const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

function variant(href) {
  const url = new URL(href);
  const image = responsiveImage(url);
  return image && { ...image, key: url.origin + image.key };
}

export function imagePlan(references, captured) {
  const available = new Set([...captured].map((href) => variant(href)?.key).filter(Boolean));
  const groups = new Map();
  const direct = [];
  for (const href of references) {
    if (captured.has(href)) continue;
    const image = variant(href);
    if (!image) {
      direct.push(href);
      continue;
    }
    if (available.has(image.key)) continue;
    const items = groups.get(image.key) ?? [];
    items.push({ href, width: image.width });
    groups.set(image.key, items);
  }
  const downloads = new Map();
  for (const items of groups.values()) {
    items.sort((a, b) => a.width - b.width);
    const representative = (items.findLast(({ width }) => width <= 1200) ?? items[0]).href;
    for (const { href } of items) downloads.set(href, representative);
  }
  for (const href of direct) downloads.set(href, href);
  return downloads;
}

export function imageCoverage(references, captured, downloads, recovered, failed) {
  const available = new Set([...captured, ...recovered.keys()].map((href) => variant(href)?.key).filter(Boolean));
  return [...references].map((url) => {
    if (captured.has(url)) return { url, status: "recorded" };
    if (recovered.has(url)) return { url, status: "recovered" };
    if (available.has(variant(url)?.key)) return { url, status: "responsive-variant" };
    return { url, status: "missing", verified: false, reason: failed.get(downloads.get(url)) ?? "Image is unavailable" };
  });
}

async function publicAddress(url, localOrigins, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  if (localOrigins.has(url.origin)) {
    return hostname === "localhost" ? { address: "127.0.0.1", family: 4 } : { address: hostname, family };
  }
  signal.throwIfAborted();
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true });
  signal.throwIfAborted();
  const allowed = addresses.find(({ address, family }) => family === 4
    ? !nonPublic.check(address, "ipv4")
    : globalIPv6.check(address, "ipv6"));
  if (!allowed) throw new Error("Image host is not a public address");
  return allowed;
}

async function requestImage(url, localOrigins, signal) {
  if (!publicUrl(url)) throw new Error("Image URL is private or signed");
  const inner = url.pathname.endsWith("/_next/image") && url.searchParams.get("url");
  if (inner) {
    const source = URL.parse(inner, url);
    if (!source || !publicUrl(source)) throw new Error("Optimizer source is private or signed");
    await publicAddress(source, localOrigins, signal);
  }
  const address = await publicAddress(url, localOrigins, signal);
  const get = url.protocol === "https:" ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const request = get(url, {
      agent: false, signal, headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.5", "accept-encoding": "identity" },
      // Use the address already checked above, including when Node requests all addresses.
      lookup: (_host, options, callback) => options.all
        ? callback(null, [address])
        : callback(null, address.address, address.family),
    }, resolve);
    request.once("error", reject);
  });
}

async function downloadImage(href, localOrigins, budget, deadline) {
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(8000)]);
  let url = new URL(href);
  for (let hop = 0; hop < 5; hop++) {
    const response = await requestImage(url, localOrigins, signal);
    try {
      if (redirectCodes.has(response.statusCode) && response.headers.location) {
        url = new URL(response.headers.location, url);
        continue;
      }
      if (response.statusCode !== 200) throw new Error(`Origin returned HTTP ${response.statusCode}`);
      const type = response.headers["content-type"]?.split(";")[0].trim();
      if (!imageType.test(type ?? "")) throw new Error("Origin did not return an image");
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        throw new Error("Origin returned an encoded image response");
      }
      if (Number(response.headers["content-length"]) > Math.min(maxResourceBytes, budget.remaining)) {
        throw new Error("Image exceeds the download budget");
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        budget.remaining -= chunk.length;
        size += chunk.length;
        if (size > maxResourceBytes || budget.remaining < 0) throw new Error("Image exceeds the download budget");
        chunks.push(chunk);
      }
      if (!size || !response.complete) throw new Error("Origin returned an incomplete image");
      const bytes = Buffer.concat(chunks, size);
      return {
        entry: { url: href, status: 200, range: "", bytes: size, body: digest(bytes),
          headers: [{ name: "content-type", value: type }], recoveredAtExport: true },
        bytes,
      };
    } finally {
      response.destroy();
    }
  }
  throw new Error("Too many image redirects");
}

export async function recoverImages(missing, start, origins, enabled, excluded) {
  const localOrigins = new Set(loopback.has(start.hostname)
    ? [...origins].filter((origin) => loopback.has(new URL(origin).hostname))
    : []);
  const budget = { remaining: downloadBudget };
  const deadline = AbortSignal.timeout(45000);
  const recovered = new Map();
  const failed = new Map();
  const eligible = missing.filter((url) => {
    const reason = !enabled ? "Image recovery disabled" : excluded(new URL(url)) ? "Tracking origin excluded" : null;
    if (reason) failed.set(url, reason);
    return !reason;
  });
  let next = 0;
  async function worker() {
    while (next < eligible.length) {
      const index = next++;
      const url = eligible[index];
      if (index >= downloadLimit || deadline.aborted || budget.remaining <= 0) {
        failed.set(url, "Image recovery budget reached");
        continue;
      }
      try {
        const item = await downloadImage(url, localOrigins, budget, deadline);
        recovered.set(url, item);
      } catch (error) {
        // Native connection errors can include endpoint details.
        failed.set(url, error.code === "ABORT_ERR" ? "Image download timed out" : error.code || error.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, eligible.length) }, worker));
  return { recovered: new Map(missing.filter((url) => recovered.has(url)).map((url) => [url, recovered.get(url)])), failed };
}

export async function verifyExportImages(output, images) {
  const candidates = images.filter(({ route }) => route);
  if (!candidates.length) return;
  const server = spawn(process.execPath, [join(output, "serve.mjs"), output, "0"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const lines = createInterface({ input: server.stdout });
  try {
    const [base] = await Promise.race([
      once(lines, "line", { signal: AbortSignal.timeout(5000) }),
      once(server, "exit").then(() => { throw new Error("Preview server exited before startup"); }),
    ]);
    for (let index = 0; index < candidates.length; index += 24) {
      await Promise.all(candidates.slice(index, index + 24).map(async (image) => {
        try {
          const response = await fetch(new URL(image.route, base), {
            method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(3000),
          });
          const type = response.headers.get("content-type")?.split(";")[0];
          image.verified = response.ok && imageType.test(type ?? "") && Number(response.headers.get("content-length")) > 0;
          if (!image.verified) image.reason = `Preview returned HTTP ${response.status} with ${type ?? "no image type"}`;
        } catch {
          image.verified = false;
          image.reason = "Local preview request failed";
        }
      }));
    }
  } catch {
    for (const image of candidates) {
      image.verified = false;
      image.reason = "Local preview server could not start";
    }
  } finally {
    lines.close();
    if (server.exitCode === null && server.signalCode === null && server.pid) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
  }
}
