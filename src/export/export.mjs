import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { writeGuide } from "./guide.mjs";
import { writeEvidence } from "./evidence.mjs";
import { writeSceneEvidence } from "./scenes.mjs";
import { writeDesign } from "./design.mjs";
import { imageReferences } from "./image-references.mjs";
import { imageCoverage, imagePlan, recoverImages, verifyExportImages } from "./images.mjs";

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

function rewriteHtml(source, aliases) {
  const flight = /(<script\b[^>]*>\s*self\.__next_f\.push\(\s*\[\s*)([0-3])(\s*,\s*("(?:[^"\\]|\\.)*"))?(\s*\]\s*\)\s*;?\s*<\/script\s*>)/gi;
  const segments = [...source.matchAll(flight)].map((match) => ({ match }));
  let pending = [];

  function flush() {
    const text = pending.map(({ value }) => value).join("");
    const rewritten = rewrite(text, aliases);
    if (rewritten !== text && rewritten.length === text.length) {
      let offset = 0;
      for (const segment of pending) {
        const end = offset + segment.value.length;
        const value = rewritten.slice(offset, end);
        if (value !== segment.value) segment.replacement = JSON.stringify(value).replaceAll("<", "\\u003c");
        offset = end;
      }
    }
    pending = [];
  }

  for (const segment of segments) {
    const [, , type, , literal] = segment.match;
    if (type === "1" && literal) {
      try {
        segment.value = JSON.parse(literal);
        pending.push(segment);
        continue;
      } catch {
        // Keep unrecognized script literals intact.
      }
    }
    flush();
  }
  flush();

  // Flight rows can carry byte lengths and URLs can straddle the script pushes.
  // Rewrite complete text runs while preserving push boundaries and non-text payloads.
  let cursor = 0;
  const output = [];
  for (const { match, replacement } of segments) {
    const [script, prefix, type, argument, literal, suffix] = match;
    output.push(rewrite(source.slice(cursor, match.index), aliases));
    output.push(replacement === undefined ? script :
      prefix + type + argument.slice(0, -literal.length) + replacement + suffix);
    cursor = match.index + script.length;
  }
  output.push(rewrite(source.slice(cursor), aliases));
  return output.join("");
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

export async function exportProject(recording, requestedOutput, { recover = true } = {}) {
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
  await mkdir(dirname(output), { recursive: true });
  try {
    await mkdir(output);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Export destination already exists: ${output}. Choose a new destination to export again.`, { cause: error });
  }
  await mkdir(join(output, "resources"));
  const documents = new Map();
  const references = new Set();
  const captured = new Set();
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.body)) throw new Error("Invalid response body filename");
    if (entry.status !== 200 || entry.range) continue;
    const type = typeOf(entry);
    if (type.startsWith("image/") && entry.bytes > 0) captured.add(entry.url);
    if (!/^text\/(?:html|css)(?:;|$)/i.test(type)) continue;
    const source = await readFile(join(folder, "bodies", entry.body), "utf8");
    documents.set(entry, source);
    imageReferences(source, entry.url, type, (url) => references.add(url));
  }
  const downloads = imagePlan(references, captured);
  const { recovered, failed } = await recoverImages([...new Set(downloads.values())], start, origins.keys(), recover, isTracking);
  const images = imageCoverage(references, captured, downloads, recovered, failed);
  for (const { entry } of recovered.values()) {
    entries.push(entry);
    const { origin } = new URL(entry.url);
    if (!origins.has(origin)) origins.set(origin, `/__archive/origin-${origins.size}`);
  }
  const aliases = aliasesFor(origins);
  const imageRoutes = new Map(images.filter(({ status }) => status !== "missing").map((image) => {
    image.route = routeFor(new URL(image.url), origins);
    return [image.url, image.route];
  }));
  const routes = [];
  const files = new Map();
  for (const [index, entry] of entries.entries()) {
    const url = new URL(entry.url);
    const type = typeOf(entry);
    const route = routeFor(url, origins);
    const variants = routeVariants(url, route, aliases);
    const location = entry.headers.find(({ name }) => name.toLowerCase() === "location")?.value;
    if (entry.status >= 300) {
      if (location && !recovered.has(entry.url)) {
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
    const recoveredBytes = entry.recoveredAtExport ? recovered.get(entry.url).bytes : null;
    if (textual.test(type) && !entry.range) {
      const document = documents.get(entry);
      const original = document === undefined ? recoveredBytes?.toString("utf8") ?? await readFile(source, "utf8")
        : imageReferences(document, entry.url, type, undefined, (url) => imageRoutes.get(url));
      // Origin rewriting changes the scripts and stylesheet integrity hashes.
      const content = type.startsWith("text/html")
        ? rewriteHtml(original, aliases).replace(/\s+integrity=(?:"[^"]*"|'[^']*')/gi, "")
        : rewrite(original, aliases);
      await writeFile(destination, content);
    } else if (recoveredBytes) await writeFile(destination, recoveredBytes);
    else await copyFile(source, destination);
    files.set(entry, file);
    const contentRange = entry.headers.find(({ name }) => name.toLowerCase() === "content-range")?.value;
    for (const variant of new Set([...variants, ...variants.map((path) => rewrite(path, aliases))])) {
      routes.push({ route: variant, file, type, status: entry.status, range: entry.range, contentRange });
    }
  }
  const entryRoute = routeFor(start, origins);
  await writeFile(join(output, "routes.json"), JSON.stringify({ entry: entryRoute, routes }, null, 2));
  await copyFile(new URL("../preview/serve.mjs", import.meta.url), join(output, "serve.mjs"));
  await copyFile(new URL("../preview/responsive-image.mjs", import.meta.url), join(output, "responsive-image.mjs"));
  await copyFile(new URL("../preview/preview-motion.js", import.meta.url), join(output, "preview-motion.js"));
  await verifyExportImages(output, images);
  const scenes = await writeSceneEvidence(output, archive, files, routes);
  const agentGuide = await readFile(new URL("./export-agents.md", import.meta.url), "utf8");
  await writeFile(join(output, "AGENTS.md"), agentGuide + (scenes
    ? "\n## Animated backgrounds and scenes\n\nRead the [scene integration guide](guide/scenes.md) for the captured\nscene, runtime, dependencies, host styles, and initialization options.\n"
    : ""));
  const evidenceArchive = { ...archive, responses: [...archive.responses, ...[...recovered.values()].map(({ entry }) => entry)] };
  await writeEvidence(folder, output, evidenceArchive, files, scenes, images);
  await writeGuide(folder, output, { packaged: true, scenes });
  await writeDesign(output, archive, scenes);
  await writeFile(join(output, "README.md"),
    "# Exported page\n\nRun `node serve.mjs` and open the printed URL.\n\n" +
    "Use the [design reference](design.md) to extend the style across pages. Start with the [page map](guide/page.md), [agent manifest](manifest/agent.json), and [integration guide](AGENTS.md) to implement a recorded section. " +
    (scenes ? "For animated backgrounds and Canvas evidence, see the [scene guide](guide/scenes.md). " : "") +
    "See the [image coverage report](manifest/images.json) for recorded, recovered, and missing images. The preview uses local resources. Missing routes return HTTP 404. Confirm you have permission before redistributing captured content.\n");
  return { output, count: routes.length, entry: entryRoute,
    images: { recovered: recovered.size, verified: images.filter(({ verified }) => verified).length,
      total: images.length } };
}
