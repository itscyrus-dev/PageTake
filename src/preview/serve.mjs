import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? dirname(resolve(process.argv[1])));
const port = Number(process.argv[3] ?? process.env.PORT ?? 4178);
const config = await readFile(join(root, "routes.json"), "utf8").then(JSON.parse).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const byRoute = new Map();
const imageVariants = new Map();
const localOrigin = "http://127.0.0.1";

function responsiveImage(url) {
  const thumbnail = /^(\?imageMogr2(?:\/[^/?&#]+)*\/thumbnail\/)([1-9]\d*)x(?=[/&]|$)/.exec(url.search);
  if (thumbnail) {
    const [match, prefix, pixels] = thumbnail;
    const width = Number(pixels);
    if (!Number.isSafeInteger(width)) return null;
    return { key: url.pathname + prefix + "{width}x" + url.search.slice(match.length), width };
  }
  if (!url.pathname.endsWith("/_next/image")) return null;
  const params = new URLSearchParams(url.searchParams);
  const width = Number(params.get("w"));
  if (!Number.isSafeInteger(width) || width < 1 || !/^\d+$/.test(params.get("w") ?? "") ||
      params.getAll("w").length !== 1 || params.getAll("url").length !== 1 || !params.get("url")) return null;
  params.delete("w");
  params.sort();
  return { key: url.pathname + "?" + params, width };
}
for (const route of config?.routes ?? []) {
  const candidates = byRoute.get(route.route) ?? [];
  candidates.push(route);
  byRoute.set(route.route, candidates);

  if (route.status !== 200 || !route.file || route.range || route.contentRange || !route.type?.startsWith("image/")) continue;
  const variant = responsiveImage(new URL(route.route, localOrigin));
  if (!variant) continue;
  const sizes = imageVariants.get(variant.key) ?? [];
  sizes.push({ width: variant.width, route });
  imageVariants.set(variant.key, sizes);
}
for (const sizes of imageVariants.values()) sizes.sort((a, b) => a.width - b.width);

function recordedImageVariant(url) {
  const variant = responsiveImage(url);
  if (!variant) return undefined;
  const sizes = imageVariants.get(variant.key);
  // Prefer enough pixels for the requested size, or the largest capture available.
  return (sizes?.find(({ width }) => width >= variant.width) ?? sizes?.at(-1))?.route;
}
const stateName = /^[a-z0-9][a-z0-9-]{0,63}$/;

const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".webp": "image/webp",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm",
};
const policy = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; form-action 'self'; object-src 'none'";

function safeFile(name) {
  const path = resolve(root, name);
  if (!path.startsWith(root + sep)) throw new Error("Invalid file path");
  return path;
}

function sliceRange(header, length, recorded) {
  const request = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!request || (!request[1] && !request[2])) return null;
  const existing = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(recorded ?? "");
  const offset = existing ? Number(existing[1]) : 0;
  const maximum = existing ? Number(existing[2]) : length - 1;
  const total = existing ? Number(existing[3]) : length;
  const start = request[1] ? Number(request[1]) : Math.max(0, total - Number(request[2]));
  const end = request[1] && request[2] ? Math.min(Number(request[2]), maximum) : maximum;
  if (start < offset || start > end || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  return { start: start - offset, end: end - offset + 1, header: `bytes ${start}-${end}/${total}` };
}

async function serve(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405).end();
    return;
  }
  const url = new URL(request.url, localOrigin);
  const entry = new URL(config?.entry ?? "/", url.origin);
  const state = url.searchParams.get("state");
  const restore = stateName.test(state ?? "") && state !== entry.searchParams.get("state");
  const preview = (url.pathname === "/" || url.pathname === entry.pathname) &&
    (["speed", "pause", "step"].includes(url.searchParams.get("motion")) || url.searchParams.has("section") || restore);
  const previewParams = new URLSearchParams();
  if (preview) {
    for (const key of ["motion", "speed", "t", "section", "state", "js"]) {
      if (key === "state" && !restore) continue;
      if (!url.searchParams.has(key)) continue;
      previewParams.set(key, url.searchParams.get(key));
      url.searchParams.delete(key);
    }
  }
  const route = preview && url.pathname === entry.pathname ? entry.pathname + entry.search : url.pathname + url.search;
  const needsEntryQuery = [...entry.searchParams].some(([key, value]) =>
    !previewParams.has(key) && !url.searchParams.getAll(key).includes(value));
  if (url.pathname === "/" && config?.entry && config.entry !== "/" &&
      (preview ? entry.pathname !== "/" || needsEntryQuery : route === "/")) {
    for (const [key, value] of previewParams) entry.searchParams.set(key, value);
    response.writeHead(302, { location: entry.pathname + entry.search }).end();
    return;
  }
  if (url.pathname === "/__web-replay/preview-motion.js") {
    const bytes = await readFile(new URL("./preview-motion.js", import.meta.url));
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : bytes);
    return;
  }
  const checkpoint = url.pathname.match(/^\/__web-replay\/states\/([a-z0-9-]+)$/)?.[1];
  if (checkpoint) {
    const { states } = JSON.parse(await readFile(join(root, "manifest", "states.json"), "utf8"));
    const saved = states.find(({ name }) => name === checkpoint);
    if (!saved) throw new Error("State not found");
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify(saved));
    return;
  }
  const candidates = byRoute.get(route) ?? byRoute.get(url.pathname);
  const selected = candidates?.find((item) => item.range === request.headers.range) ??
    candidates?.find((item) => !item.range) ?? candidates?.[0] ?? recordedImageVariant(url);
  if (selected?.location) {
    response.writeHead(selected.status, { location: selected.location }).end();
    return;
  }
  const fallback = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1);
  const file = safeFile(selected?.file ?? fallback);
  if (!(await stat(file)).isFile()) throw new Error("Not a file");
  let bytes = await readFile(file);
  let status = selected?.status ?? 200;
  if (preview && file === join(root, "index.html") && !request.headers.range) {
    const markup = bytes.toString("utf8");
    const stateAttribute = restore ? ` data-state="${state}"` : "";
    const script = `<script src="/__web-replay/preview-motion.js"${stateAttribute}></script>`;
    const head = /<head(?:\s[^>]*)?>/i;
    bytes = Buffer.from(head.test(markup) ? markup.replace(head, "$&" + script) : markup + script);
  }
  const headers = {
    "content-type": selected?.type ?? mime[extname(file)] ?? "application/octet-stream",
    "content-security-policy": policy,
    "cache-control": "no-store",
  };
  if (selected?.contentRange) headers["content-range"] = selected.contentRange;
  if (request.headers.range && request.headers.range !== selected?.range) {
    const slice = sliceRange(request.headers.range, bytes.length, selected?.contentRange);
    if (!slice) {
      const total = selected?.contentRange?.split("/")[1] ?? bytes.length;
      response.writeHead(416, { "content-range": `bytes */${total}` }).end();
      return;
    }
    status = 206;
    headers["content-range"] = slice.header;
    bytes = bytes.subarray(slice.start, slice.end);
  }
  headers["content-length"] = bytes.length;
  response.writeHead(status, headers);
  response.end(request.method === "HEAD" ? undefined : bytes);
}

const server = createServer((request, response) => {
  void serve(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  });
});
server.listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}/`));
