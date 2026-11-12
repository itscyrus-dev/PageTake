import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { writeGuide } from "./guide.mjs";
import { writeEvidence } from "./evidence.mjs";

const textual = /^(?:text\/|application\/(?:javascript|json|[^;]+\+json)|image\/svg\+xml)/i;
const extensions = {
  "text/html": "html", "text/css": "css", "application/javascript": "js",
  "text/javascript": "js", "application/json": "json", "image/webp": "webp",
  "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "video/mp4": "mp4",
};

function routeFor(url, origins) {
  return (origins.get(url.origin) ?? "") + url.pathname + url.search;
}

function aliasesFor(origins) {
  const aliases = new Map();
  let index = 0;
  for (const origin of origins.keys()) {
    const relative = "//" + new URL(origin).host;
    for (const prefix of [origin, relative]) {
      if (aliases.has(prefix)) continue;
      // Keep origin prefixes the same byte length for streamed HTML.
      const alias = `/_w/${(index++).toString(36)}`.padEnd(prefix.length, "_");
      aliases.set(prefix, alias);
    }
  }
  return aliases;
}

function rewrite(source, aliases) {
  return source.replace(/(?:https?:)?\/\/[a-z0-9.-]+(?::\d+)?(?=\/)/gi, (match) =>
    aliases.get(match) ?? match,
  );
}

function routeVariants(url, route, aliases) {
  return [...new Set([
    route,
    ...[url.origin, "//" + url.host].map((prefix) =>
      aliases.get(prefix) + url.pathname + url.search,
    ),
  ])];
}

function fileName(url, type, index, isMain) {
  if (isMain) return "index.html";
  const name = basename(url.pathname).replace(/[^a-z0-9._-]/gi, "_").slice(-85) || "response";
  const extension = extensions[type.split(";")[0]] ?? "bin";
  const suffixed = name.includes(".") ? name : `${name}.${extension}`;
  return `resources/${String(index).padStart(4, "0")}-${suffixed}`;
}

function typeOf(entry) {
  return entry.headers.find(({ name }) => name.toLowerCase() === "content-type")?.value ?? "application/octet-stream";
}

function isTracking(url) {
  return /(?:^|\.)(?:googletagmanager\.com|doubleclick\.net|googlesyndication\.com|google-analytics\.com|ads-twitter\.com|analytics\.twitter\.com|analytics\.tiktok\.com|ct\.pinterest\.com|bat\.bing\.com|px\.ads\.linkedin\.com|snap\.licdn\.com|connect\.facebook\.net|t\.co)$/i.test(url.hostname);
}

export async function exportProject(recording, requestedOutput) {
  const folder = resolve(recording), output = resolve(requestedOutput);
  const archive = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
  const start = new URL(archive.url);
  const entries = archive.responses.filter((entry) => entry.status >= 200 && entry.status < 400 && !isTracking(new URL(entry.url)));
  const indexEntry = entries.find((entry) => entry.url === start.href && entry.status === 200 && typeOf(entry).startsWith("text/html"));
  if (!indexEntry) throw new Error("Export requires HTTP 200 entry HTML. Record the final URL after redirects.");
  const origins = new Map([[start.origin, ""]]);
  for (const entry of entries) {
    const { origin } = new URL(entry.url);
    if (!origins.has(origin)) origins.set(origin, `/__archive/origin-${origins.size}`);
  }
  await mkdir(output);
  await mkdir(join(output, "resources"));
  const aliases = aliasesFor(origins);
  const routes = [];
  const files = new Map();
  for (const [index, entry] of entries.entries()) {
    if (!/^[a-f0-9]{64}$/.test(entry.body)) throw new Error("Invalid response body filename");
    const url = new URL(entry.url);
    const type = typeOf(entry);
    const route = routeFor(url, origins);
    const variants = routeVariants(url, route, aliases);
    const location = entry.headers.find(({ name }) => name.toLowerCase() === "location")?.value;
    if (entry.status >= 300) {
      if (location) {
        const target = new URL(location, url);
        if (origins.has(target.origin)) {
          for (const variant of variants) routes.push({ route: variant, status: entry.status, location: routeFor(target, origins) });
        }
      }
      continue;
    }
    const file = fileName(url, type, index, entry === indexEntry);
    const source = join(folder, "bodies", entry.body);
    const destination = join(output, file);
    if (textual.test(type) && !entry.range) {
      let content = rewrite(await readFile(source, "utf8"), aliases);
      if (type.startsWith("text/html")) {
        // Origin rewriting changes the scripts and stylesheet integrity hashes.
        content = content.replace(/\s+integrity=(?:"[^"]*"|'[^']*')/gi, "");
      }
      await writeFile(destination, content);
    } else await copyFile(source, destination);
    files.set(entry, file);
    const contentRange = entry.headers.find(({ name }) => name.toLowerCase() === "content-range")?.value;
    for (const variant of variants) routes.push({ route: variant, file, type, status: entry.status, range: entry.range, contentRange });
  }
  const entryRoute = routeFor(start, origins);
  await writeFile(join(output, "routes.json"), JSON.stringify({ entry: entryRoute, routes }, null, 2));
  await copyFile(new URL("../preview/serve.mjs", import.meta.url), join(output, "serve.mjs"));
  await copyFile(new URL("../preview/preview-motion.js", import.meta.url), join(output, "preview-motion.js"));
  await copyFile(new URL("./export-agents.md", import.meta.url), join(output, "AGENTS.md"));
  await writeEvidence(folder, output, archive, files);
  await writeGuide(folder, output, { packaged: true });
  await writeFile(join(output, "README.md"),
    "# Exported page\n\nRun `node serve.mjs` and open the printed URL.\n\n" +
    "Start with the [page map](guide/page.md) and [integration guide](AGENTS.md). " +
    "The browser uses captured resources. Missing routes return HTTP 404. Confirm you have permission before redistributing captured content.\n");
  return { output, count: routes.length, entry: entryRoute };
}
